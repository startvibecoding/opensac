// Ported from internal/serve/openaiapi/responses_run_api.go — the durable
// OpenAI Responses background-run API.
//
// Paths:
//   GET  /api/responses/runs/{localRunID}?session_id={sessionID}
//   POST /api/responses/runs/{localRunID}/cancel?session_id={sessionID}
//   POST /api/responses/runs/{localRunID}/reconnect?session_id={sessionID}
//   POST /api/responses/runs/{localRunID}/abandon?session_id={sessionID}
//   POST /api/responses/runs/{localRunID}/recover?session_id={sessionID}
//
// Deviations: net/http's ResponseWriter is the standard Request/Response pair;
// handlers return the Response instead of writing it. Go buffers the recovery
// re-entry through bufferedHTTPResponse because handlers write into a
// ResponseWriter; here handleSubmitRun returns an immutable Response, so the
// recovery path inspects it directly (same status/JSON contract, no buffering
// type). Go injects the force-agent-loop flag through the request context;
// the port passes it through the SubmitRunOptions bag. `errors.Is` sentinels
// (ErrSessionNotFound, ErrResponsesRuntimeBusy) are matched by identity.
import type { ToolCallBlock } from "../../provider/types.ts";
import { annotateDurableRunError } from "../../agentruntime/run_queries.ts";
import {
  abandonInterruptedToolExecutionRecords,
  acquireMutation,
  getResponseRun,
  listSessionRuns,
  requestToolExecutionRecoveryRecords,
  type ResponseRun,
  type ToolExecutionRecord,
} from "../../session/mod.ts";
import { isTerminalSessionRunStatus } from "../../session/run_status.ts";
import { writeError, writeErrorInfo, writeJSON } from "./auth.ts";
import { sameWorkDir } from "./chat_support.ts";
import { getWorkDir, validateWorkDir } from "./config.ts";
import {
  executionAdmissionError,
  handleSubmitRun,
  type submitRunRequest,
} from "./handler_run_submit.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { finalizeRun } from "./run_manager.ts";
import {
  ErrResponsesRuntimeBusy,
  reattachResponsesBackgroundRun,
  responsesBackgroundFunctionCallsForRun,
} from "./background_run_coordinator.ts";
import { idempotencyKeyFingerprint } from "./events.ts";
import { isTerminalResponsesRunState } from "./session_runtime_snapshot.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import type { Server } from "./server.ts";
import type { SessionRun } from "../../session/run_store.ts";

const GET = "GET";
const POST = "POST";

/** Go's errResponseRunWorkDirNotAllowed sentinel. */
export const errResponseRunWorkDirNotAllowed = new Error(
  "response run work directory is not allowed",
);

/**
 * handleResponsesRunAPI exposes durable OpenAI Responses background runs.
 */
export async function handleResponsesRunAPI(
  server: Server,
  request: Request,
): Promise<Response> {
  if (!server) {
    return writeError(503, "API server not ready", "server_error");
  }
  const manager = server.responsesRuns;
  if (!manager) {
    return writeError(
      501,
      "Responses background runs are unavailable for the active provider",
      "capability_error",
    );
  }

  const pathname = new URL(request.url).pathname;
  let path = pathname.startsWith("/api/responses/runs/")
    ? pathname.slice("/api/responses/runs/".length)
    : pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  const parts = path.split("/").filter((s) => s !== "");
  if (parts.length === 0) {
    return writeError(400, "response run ID required", "invalid_request_error");
  }
  const localRunID = parts[0];
  let action = "";
  if (parts.length === 2) action = parts[1];
  if (
    parts.length > 2 ||
    (action !== "" && action !== "cancel" && action !== "reconnect" &&
      action !== "abandon" && action !== "recover")
  ) {
    return writeError(
      400,
      "invalid response run path",
      "invalid_request_error",
    );
  }

  const sessionID = (new URL(request.url).searchParams.get("session_id") ?? "")
    .trim();
  if (sessionID === "") {
    return writeError(400, "session_id is required", "invalid_request_error");
  }
  try {
    authorizeResponseRunSession(server, sessionID);
  } catch (err) {
    let status = 500;
    let errType = "server_error";
    if (err === ErrSessionNotFound) {
      status = 404;
      errType = "not_found";
    } else if (err === errResponseRunWorkDirNotAllowed) {
      status = 403;
      errType = "permission_error";
    }
    return writeError(status, (err as Error).message, errType);
  }

  if (request.method === GET && action === "") {
    let run: ResponseRun | null;
    try {
      run = await manager.get(sessionID, localRunID, undefined);
    } catch (err) {
      return writeError(502, (err as Error).message, "upstream_error");
    }
    if (run === null) {
      return writeError(404, "response run not found", "not_found");
    }
    return writeJSON(200, run);
  }
  if (request.method === POST && action === "cancel") {
    // A durable remote cancel mutates response lineage and must serialize
    // with lifecycle deletion/transfer. A live local monitor owns this lock;
    // callers should use the session stop endpoint first in that window.
    let guard;
    try {
      guard = acquireMutation(server.sessionDir(), sessionID);
    } catch (err) {
      const { status, info } = executionAdmissionError(
        server,
        sessionID,
        err,
      );
      return writeErrorInfo(status, info);
    }
    try {
      try {
        await manager.cancel(sessionID, localRunID, undefined);
      } catch (err) {
        return writeError(502, (err as Error).message, "upstream_error");
      }
      let run: ResponseRun | null;
      try {
        run = await manager.get(sessionID, localRunID, undefined);
      } catch (err) {
        return writeError(502, (err as Error).message, "upstream_error");
      }
      return writeJSON(202, run);
    } finally {
      guard.release();
    }
  }
  if (request.method === POST && action === "reconnect") {
    let run: ResponseRun | null;
    try {
      run = await manager.get(sessionID, localRunID, undefined);
    } catch (err) {
      return writeError(502, (err as Error).message, "upstream_error");
    }
    if (run === null) {
      return writeError(404, "response run not found", "not_found");
    }
    let parent: SessionRun | null;
    try {
      parent = responsesBackgroundParentRun(
        server,
        sessionID,
        run.localTurnId,
      );
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    if (parent === null) {
      return writeError(
        409,
        "response run has no recoverable local background run",
        "conflict_error",
      );
    }
    let reattached: boolean;
    try {
      const [ok, err] = await reattachResponsesBackgroundRun(
        server,
        parent,
        run,
      );
      if (err !== null) throw err;
      reattached = ok;
    } catch (err) {
      if (err === ErrResponsesRuntimeBusy) {
        const { status, info } = executionAdmissionError(
          server,
          sessionID,
          err,
        );
        return writeErrorInfo(status, info);
      }
      return writeError(500, (err as Error).message, "server_error");
    }
    const status = reattached ? 202 : 200;
    return writeJSON(status, { run, reattached });
  }
  if (request.method === POST && action === "abandon") {
    return abandonResponsesRun(server, request, sessionID, localRunID);
  }
  if (request.method === POST && action === "recover") {
    return recoverResponsesRun(server, request, sessionID, localRunID);
  }
  return new Response(null, { status: 405 });
}

async function recoverResponsesRun(
  server: Server,
  request: Request,
  sessionID: string,
  localRunID: string,
): Promise<Response> {
  interface recoveryRequestBody {
    confirm?: boolean;
    toolCallIds?: string[];
  }
  let requestBody: recoveryRequestBody;
  try {
    requestBody = JSON.parse(await request.text()) as recoveryRequestBody;
  } catch (err) {
    return writeError(
      400,
      "invalid JSON: " + (err as Error).message,
      "invalid_request_error",
    );
  }
  const toolCallIDs = requestBody.toolCallIds ?? [];
  if (
    !requestBody.confirm || toolCallIDs.length === 0 || toolCallIDs.length > 32
  ) {
    return writeError(
      400,
      "confirm=true and one to 32 toolCallIds are required",
      "invalid_request_error",
    );
  }
  let run: ResponseRun | null;
  try {
    run = getResponseRun(server.sessionDir(), sessionID, localRunID);
  } catch (err) {
    return writeError(500, (err as Error).message, "server_error");
  }
  if (run === null) {
    return writeError(404, "response run not found", "not_found");
  }
  if (!isTerminalResponsesRunState(run.state)) {
    return writeError(
      409,
      "response run must be terminal before tool recovery",
      "conflict_error",
    );
  }
  let guard;
  try {
    guard = acquireMutation(server.sessionDir(), sessionID);
  } catch {
    return writeError(409, "response run is still active", "conflict_error");
  }
  let released = false;
  try {
    let parentRun: SessionRun | null;
    try {
      parentRun = responsesBackgroundParentRun(
        server,
        sessionID,
        run.localTurnId,
      );
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    const workDir = server.findSessionWorkDir(sessionID).workDir;
    let sess;
    try {
      sess = await getOrCreateSession(server, sessionID, workDir);
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    if (parentRun !== null && sess.activeRunId === parentRun.id) {
      return writeError(
        409,
        "response run is still active",
        "conflict_error",
      );
    }
    if (parentRun === null) {
      return writeError(
        409,
        "parent session run is unavailable",
        "conflict_error",
      );
    }
    if (!isTerminalSessionRunStatus(parentRun.status)) {
      return writeError(
        409,
        "parent session run must be terminal before tool recovery",
        "conflict_error",
      );
    }
    let archivedCalls: ToolCallBlock[];
    try {
      archivedCalls = responsesBackgroundFunctionCallsForRun(
        server.sessionDir(),
        sessionID,
        run.localTurnId,
      );
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    let recoveryRecords: ToolExecutionRecord[];
    let newlyRequested: number;
    try {
      const result = requestToolExecutionRecoveryRecords(
        server.sessionDir(),
        sessionID,
        run.localTurnId,
        toolCallIDs,
      );
      recoveryRecords = result.records;
      newlyRequested = result.count;
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    if (recoveryRecords.length === 0) {
      return writeError(
        409,
        "no interrupted tool calls matched the requested recovery",
        "conflict_error",
      );
    }
    const recoveryMessage = responsesRecoveryAgentMessage(
      parentRun,
      run,
      recoveryRecords,
      archivedCalls,
    );
    const recoveryKey = responsesRecoverySubmissionKey(
      sessionID,
      localRunID,
      recoveryRecords,
    );
    released = true;
    guard.release();

    // A terminal Run is immutable. Recovery is represented by a new user
    // message and a fresh durable Run through the normal submit path, with the
    // local AgentLoop forced for this turn instead of reattaching the completed
    // remote Responses task.
    const payloadRequest: submitRunRequest = {
      message: recoveryMessage,
      provider: run.provider,
      model: parentRun.model,
      mode: parentRun.mode,
      workDir: parentRun.workDir,
      transcript: true,
    };
    const payload = JSON.stringify(payloadRequest);
    const recoveryURL = new URL(request.url);
    recoveryURL.pathname = "/api/sessions/" + sessionID + "/runs";
    recoveryURL.search = "";
    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", recoveryKey);

    const submitted = await handleSubmitRun(
      server,
      new Request(recoveryURL, { method: POST, body: payload, headers }),
      { forceAgentLoop: true },
    );
    if (!submitted.ok) {
      return submitted;
    }
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(await submitted.text()) as Record<
        string,
        unknown
      >;
    } catch {
      return writeError(
        500,
        "recovery run response was invalid",
        "server_error",
      );
    }
    response.run = run;
    response.reattached = false;
    response.recoveryRequested = recoveryRecords.length;
    response.newlyRequested = newlyRequested;
    return writeJSON(submitted.status, response);
  } finally {
    if (!released) guard.release();
  }
}

export function responsesRecoveryAgentMessage(
  parent: SessionRun,
  remote: ResponseRun,
  records: ToolExecutionRecord[],
  calls: ToolCallBlock[],
): string {
  const callByID = new Map<string, ToolCallBlock>();
  for (const call of calls) callByID.set(call.id ?? "", call);
  const lines: string[] = [];
  lines.push(
    "Continue the previous task in a new agent run. The earlier durable run is terminal and must not be resumed.\n",
  );
  lines.push(
    `Previous local run: ${parent.id} (${parent.status})\nPrevious remote response: ${remote.localRunId} (${remote.state})\n`,
  );
  lines.push(
    "The user explicitly confirmed recovery of these interrupted tool calls:",
  );
  for (const record of records) {
    let line = `- ${record.toolName} (call_id: ${record.providerCallId}`;
    const call = callByID.get(record.providerCallId);
    if (call) {
      const args = compactRecoveryArguments(
        typeof call.arguments === "string" ? call.arguments : undefined,
      );
      if (args !== "") line += `, arguments: ${args}`;
    }
    line += ")";
    lines.push(line);
  }
  lines.push(
    "\nInspect the current workspace and any relevant external state before repeating side effects. Retry only the confirmed operations that are still necessary, then continue the original task to a normal terminal result.",
  );
  return lines.join("\n");
}

export function compactRecoveryArguments(
  raw: string | undefined,
): string {
  if (raw === undefined || raw === null || raw === "") return "";
  let compact = raw;
  try {
    compact = JSON.stringify(JSON.parse(raw));
  } catch {
    return "";
  }
  const maxArguments = 16 << 10;
  if (compact.length <= maxArguments) return compact;
  return compact.slice(0, maxArguments) + "...";
}

export function responsesRecoverySubmissionKey(
  sessionID: string,
  localRunID: string,
  records: ToolExecutionRecord[],
): string {
  const callIDs = records.map((record) => record.providerCallId).sort();
  const digest = idempotencyKeyFingerprint(
    sessionID + "\x00" + localRunID + "\x00" + callIDs.join("\x00"),
  ).replace(/^sha256:/, "");
  return "responses-recover-" + digest;
}

async function abandonResponsesRun(
  server: Server,
  _request: Request,
  sessionID: string,
  localRunID: string,
): Promise<Response> {
  let run: ResponseRun | null;
  try {
    run = getResponseRun(server.sessionDir(), sessionID, localRunID);
  } catch (err) {
    return writeError(500, (err as Error).message, "server_error");
  }
  if (run === null) {
    return writeError(404, "response run not found", "not_found");
  }

  // Serializing with the background coordinator prevents abandoning a tool
  // while a live execution can still write a successful result.
  let guard;
  try {
    guard = acquireMutation(server.sessionDir(), sessionID);
  } catch {
    return writeError(
      409,
      "response run is still active; cancel it before abandoning interrupted tools",
      "conflict_error",
    );
  }
  try {
    let parentRun: SessionRun | null;
    try {
      parentRun = responsesBackgroundParentRun(
        server,
        sessionID,
        run.localTurnId,
      );
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    const workDir = server.findSessionWorkDir(sessionID).workDir;
    let sess;
    try {
      sess = await getOrCreateSession(server, sessionID, workDir);
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    if (parentRun !== null && sess.activeRunId === parentRun.id) {
      return writeError(
        409,
        "response run is still active; cancel it before abandoning interrupted tools",
        "conflict_error",
      );
    }

    if (!isTerminalResponsesRunState(run.state)) {
      try {
        await server.responsesRuns!.cancel(sessionID, localRunID, undefined);
      } catch (err) {
        return writeError(502, (err as Error).message, "upstream_error");
      }
    }
    let abandoned: number;
    try {
      abandoned = abandonInterruptedToolExecutionRecords(
        server.sessionDir(),
        sessionID,
        run.localTurnId,
      );
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    if (parentRun !== null) {
      const abandonReason = "abandoned after interrupted tool execution";
      // Durable Run rows are finalized by the canonical ExecutionRuntime.
      // The parent run is already terminal here, so persist the abandon
      // reason through the Runtime annotation boundary instead of relying
      // on the legacy RunManager finalizer, which skips durable-owned rows.
      try {
        annotateDurableRunError(
          server.sessionDir(),
          parentRun.id,
          abandonReason,
        );
      } catch (err) {
        return writeError(500, (err as Error).message, "server_error");
      }
      finalizeRun(server, sess, parentRun.id, "failed", abandonReason);
    }
    return writeJSON(200, {
      run,
      abandonedToolExecutions: abandoned,
      abandonedAt: new Date().toISOString(),
    });
  } finally {
    guard.release();
  }
}

export function responsesBackgroundParentRun(
  server: Server,
  sessionID: string,
  localTurnID: string,
): SessionRun | null {
  if (sessionID === "" || localTurnID === "") return null;
  const runs = listSessionRuns(server.sessionDir(), sessionID, 500);
  let parent: SessionRun | null = null;
  for (const candidate of runs) {
    if (
      candidate.source !== "responses_background" ||
      (candidate.id !== localTurnID &&
        !localTurnID.startsWith(candidate.id + ":"))
    ) {
      continue;
    }
    if (parent === null || candidate.id.length > parent.id.length) {
      parent = candidate;
    }
  }
  return parent;
}

function authorizeResponseRunSession(
  server: Server,
  sessionID: string,
): void {
  const { workDir, found } = server.findSessionWorkDir(sessionID);
  if (!found) throw ErrSessionNotFound;
  if (workDir === "" || sameWorkDir(workDir, getWorkDir(server.cfg!))) {
    return;
  }
  try {
    validateWorkDir(server.cfg!, workDir);
  } catch {
    throw errResponseRunWorkDirNotAllowed;
  }
}
