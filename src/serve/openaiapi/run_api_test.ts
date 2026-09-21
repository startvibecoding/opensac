// Translated from internal/serve/openaiapi/handler_run_submit_test.go — the
// retry/inspection families that run against the run API surface
// (TestRetryRun*, TestGetRun*, TestFindIdempotentRun*, and the external-owner
// cancel conflict). Terminal Runs are seeded through the Runtime RunStore and
// the end-to-end retry uses a scripted provider through the real
// SessionRuntime, exactly like the submit-half tests.
import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { ChatParams, Model, StreamEvent } from "../../provider/types.ts";
import {
  newUserMessage,
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { RuntimeLeaseDAO } from "../../dao/mod.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import type { ErrorInfo } from "../../agentruntime/error_info.ts";
import {
  FailureTransient,
  PhaseModel,
  RetryDecisionRequired,
  RetryUser,
  SideEffectUnknown,
} from "../../agentruntime/error_info.ts";
import { SessionStopOwnedElsewhere } from "../../agentruntime/execution_stop.ts";
import {
  listSessionRunEvents,
  listSessionRunEventsWithSeq,
} from "../../session/session_events.ts";
import { saveExecutionIntent } from "../../session/execution_intent.ts";
import type { ExecutionIntent } from "../../session/execution_intent.ts";
import { openRootDB } from "../../session/root_db.ts";
import { newManager } from "../../session/manager.ts";
import {
  idempotencyKeyFingerprint,
  rawEventData,
  recordSessionRunEvent,
  requestFingerprint,
  retryIdempotencyScope,
} from "./events.ts";
import { ErrIdempotencyKeyConflict, findIdempotentRun } from "./events.ts";
import { handleRunAPI, retryableRunStatus, runAPIResponse } from "./run_api.ts";
import { getRun } from "./run_manager.ts";
import { ErrSessionNotFound, messageText } from "./session_mgr.ts";
import { getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

/** Records chat params and replays one scripted response batch. */
class HistoryRecordingProvider implements Provider {
  readonly model: Model;
  calls: ChatParams[] = [];
  #responses: StreamEvent[][];

  constructor(responses?: StreamEvent[][]) {
    this.model = {
      id: "m1",
      name: "Model 1",
      provider: "history-recording",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 2048,
    };
    this.#responses = responses ?? [[
      { type: streamStart },
      { type: streamTextDelta, textDelta: "ok" },
      { type: streamDone },
    ]];
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push({
      ...params,
      messages: [...params.messages],
    });
    const batch = this.#responses[
      Math.min(this.calls.length - 1, this.#responses.length - 1)
    ];
    for (const event of batch) yield event;
  }

  name(): string {
    return "history-recording";
  }

  api(): string {
    return "openai-chat";
  }

  models(): Model[] {
    return [this.model];
  }

  getModel(id: string): Model | undefined {
    return id === this.model.id ? this.model : undefined;
  }
}

function newTestServer(): {
  server: Server;
  sessionDir: string;
  workDir: string;
} {
  const workDir = tempDir("openaiapi-runapi-cwd-");
  const sessionDir = `${workDir}/sessions`;
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: {
      defaultMode: "yolo",
      defaultWorkDir: workDir,
      requestTimeoutSecs: 30,
    } as never,
    version: "test",
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  return { server, sessionDir, workDir };
}

function newHistoryServer(): {
  server: Server;
  provider: HistoryRecordingProvider;
  sessionDir: string;
  workDir: string;
} {
  const created = newTestServer();
  const provider = new HistoryRecordingProvider();
  created.server.provider = provider;
  created.server.model = provider.model;
  created.server.providerName = provider.name();
  return { ...created, provider };
}

function runAPIRequest(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`http://localhost${path}`, init);
}

async function waitFor(
  predicate: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface seedRunOptions {
  id: string;
  sessionId: string;
  workDir: string;
  intentId?: string;
  retryOf?: string;
  attempt?: number;
  status?: string;
  error?: string;
  errorInfo?: ErrorInfo;
}

function seedTerminalRun(sessionDir: string, opts: seedRunOptions): void {
  const now = new Date();
  new RunStore(sessionDir).create({
    id: opts.id,
    sessionId: opts.sessionId,
    intentId: opts.intentId ?? "",
    retryOf: opts.retryOf ?? "",
    attempt: opts.attempt ?? 1,
    workDir: opts.workDir,
    source: "webui",
    model: "m1",
    mode: "yolo",
    status: opts.status ?? "failed",
    startedAt: now,
    finishedAt: now,
    error: opts.error ?? "",
    errorInfo: opts.errorInfo ??
      ({ code: "", type: "", message: "" } as unknown as ErrorInfo),
    progress: {} as never,
    usage: null,
    contextUsage: null,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
  });
}

function seedIntent(
  sessionDir: string,
  intent: ExecutionIntent,
): void {
  saveExecutionIntent(sessionDir, intent);
}

// ---------------------------------------------------------------------------

Deno.test("retryRunCreatesLinkedAttemptWithoutDuplicatingUserMessage", async () => {
  const { server, provider, sessionDir, workDir } = newHistoryServer();
  try {
    const sessionID = "linked-retry-session";
    const oldRunID = "run-linked-old";
    const sess = await getOrCreateSession(
      server,
      sessionID,
      getWorkDir(server.cfg!),
    );
    sess.manager!.appendMessage(newUserMessage("retry this request"));
    const intent: ExecutionIntent = {
      id: "intent-linked",
      sessionId: sessionID,
      source: "webui",
      model: "m1",
      mode: "yolo",
      workDir: sess.workDir,
      requestFingerprint: "",
      request: { message: "retry this request", transcript: true },
      policy: { source: "webui", mode: "yolo" },
      createdAt: new Date(),
    };
    seedIntent(sessionDir, intent);
    seedTerminalRun(sessionDir, {
      id: oldRunID,
      sessionId: sessionID,
      workDir: sess.workDir,
      intentId: intent.id,
      error: "The service is temporarily unavailable.",
      errorInfo: {
        code: "provider_unavailable",
        type: "provider_error",
        failureClass: FailureTransient,
        phase: PhaseModel,
        messageKey: "run.error.providerUnavailable",
        message: "The service is temporarily unavailable.",
        retryMode: RetryUser,
        retryable: true,
        runId: oldRunID,
        intentId: intent.id,
      },
    });

    const first = await handleRunAPI(
      server,
      runAPIRequest(`/api/runs/${oldRunID}/retry`, {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": "linked-retry-key" },
      }),
    );
    const firstText = await first.text();
    assertEquals(first.status, 202, firstText);
    const response = JSON.parse(firstText);
    assert(response.runId !== "" && response.runId !== oldRunID);
    assertEquals(response.intentId, intent.id);
    assertEquals(response.attempt, 2);

    await waitFor(() => provider.calls.length > 0);
    const call = provider.calls[0];
    const userCount = call.messages.filter((m) =>
      m.role === "user" && messageText(m) === "retry this request"
    ).length;
    assertEquals(
      userCount,
      1,
      `provider messages duplicated original user request: ${
        JSON.stringify(call.messages.map(messageText))
      }`,
    );
    const old = getRun(server, oldRunID);
    assertEquals(old.status, "failed");
    const linked = getRun(server, response.runId);
    assertEquals(linked.retryOf, oldRunID);
    assertEquals(linked.intentId, intent.id);
    assertEquals(linked.attempt, 2);

    const second = await handleRunAPI(
      server,
      runAPIRequest(`/api/runs/${oldRunID}/retry`, {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": "linked-retry-key" },
      }),
    );
    const secondText = await second.text();
    assertEquals(second.status, 202, secondText);
    const duplicate = JSON.parse(secondText);
    assertEquals(duplicate.runId, response.runId);

    const events = listSessionRunEvents(sessionDir, sessionID);
    let sawStarted = false;
    for (const event of events) {
      if (event.runId !== response.runId || event.eventType !== "started") {
        continue;
      }
      sawStarted = true;
      const data = (event.data ?? {}) as Record<string, unknown>;
      assert(
        !("idempotencyKey" in data),
        `retry start event persisted plaintext idempotency key: ${
          JSON.stringify(data)
        }`,
      );
      assertEquals(
        data.idempotencyKeyHash,
        idempotencyKeyFingerprint("linked-retry-key"),
      );
      assertEquals(
        data.idempotencyScope,
        retryIdempotencyScope(intent.id, oldRunID),
      );
      break;
    }
    assert(sawStarted, `missing retry started event for ${response.runId}`);
    void workDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("retryRunRejectsIdempotencyKeyScopedToAnotherRun", async () => {
  const { server, sessionDir } = newHistoryServer();
  try {
    const sessionID = "retry-idempotency-scope-session";
    const firstRunID = "run-retry-first";
    const secondRunID = "run-retry-second";
    const existingAttemptID = "run-retry-existing";
    const key = "retry-key-scoped";

    const sess = await getOrCreateSession(
      server,
      sessionID,
      getWorkDir(server.cfg!),
    );
    const intent: ExecutionIntent = {
      id: "intent-retry-idempotency",
      sessionId: sessionID,
      source: "webui",
      model: "m1",
      mode: "yolo",
      workDir: sess.workDir,
      requestFingerprint: "",
      request: { message: "retry exactly once" },
      policy: { source: "webui", mode: "yolo" },
      createdAt: new Date(),
    };
    seedIntent(sessionDir, intent);
    for (const runID of [firstRunID, secondRunID, existingAttemptID]) {
      seedTerminalRun(sessionDir, {
        id: runID,
        sessionId: sessionID,
        workDir: sess.workDir,
        intentId: intent.id,
        retryOf: runID === existingAttemptID ? firstRunID : "",
        attempt: runID === existingAttemptID ? 2 : 1,
        error: "The service is temporarily unavailable.",
        errorInfo: {
          code: "provider_unavailable",
          type: "provider_error",
          failureClass: FailureTransient,
          phase: PhaseModel,
          message: "The service is temporarily unavailable.",
          retryMode: RetryUser,
          retryable: true,
          intentId: intent.id,
        },
      });
    }
    recordSessionRunEvent(
      server,
      sess,
      existingAttemptID,
      "started",
      "queued",
      "webui",
      "m1",
      "yolo",
      rawEventData({
        idempotencyKeyHash: idempotencyKeyFingerprint(key),
        idempotencyScope: retryIdempotencyScope(intent.id, firstRunID),
        requestFingerprint: requestFingerprint({
          message: "retry exactly once",
        }),
      }),
    );

    const response = await handleRunAPI(
      server,
      runAPIRequest(`/api/runs/${secondRunID}/retry`, {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": key },
      }),
    );
    const body = await response.text();
    assertEquals(
      response.status,
      409,
      `cross-run retry key reuse = ${response.status} ${body}`,
    );
    assert(body.includes("idempotency"), body);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("getRunReturnsLastEventSeq", async () => {
  const { server, sessionDir } = newHistoryServer();
  try {
    const sessionID = "run-last-event-seq-session";
    const runID = "run-last-event-seq";
    const sess = await getOrCreateSession(
      server,
      sessionID,
      getWorkDir(server.cfg!),
    );
    seedTerminalRun(sessionDir, {
      id: runID,
      sessionId: sessionID,
      workDir: sess.workDir,
      intentId: "intent-last-event-seq",
      status: "running",
    });
    for (const eventType of ["started", "run_retrying"]) {
      recordSessionRunEvent(
        server,
        sess,
        runID,
        eventType,
        "running",
        "webui",
        "m1",
        "yolo",
        undefined,
      );
    }
    const sequenced = listSessionRunEventsWithSeq(sessionDir, sessionID);
    assert(sequenced.length > 0);
    const wantSeq = sequenced[sequenced.length - 1].seq;

    const response = await handleRunAPI(
      server,
      runAPIRequest(`/api/runs/${runID}`),
    );
    const bodyText = await response.text();
    assertEquals(response.status, 200, bodyText);
    const body = JSON.parse(bodyText);
    assertEquals(body.lastEventSeq, wantSeq);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("getRunPreservesStorageFailureAndReturnsSafeAPIError", async () => {
  const sessionDir = tempDir("openaiapi-runapi-storage-");
  Deno.mkdirSync(`${sessionDir}/sessions.db`);
  const server = new Server({ settings: { sessionDir } as never });

  let storageErr: unknown = null;
  try {
    getRun(server, "run-storage-error");
  } catch (err) {
    storageErr = err;
  }
  assert(storageErr !== null);
  assert(
    storageErr !== ErrSessionNotFound,
    "GetRun error must be the underlying storage error",
  );

  const response = await handleRunAPI(
    server,
    runAPIRequest("/api/runs/run-storage-error"),
  );
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error.code, "run_lookup_failed");
  assertEquals(body.error.failureClass, "persistence");
  assertEquals(body.error.retryMode, "reconcile");
  assert(
    !body.error.message.includes(sessionDir) &&
      !body.error.message.includes("sessions.db"),
    `safe lookup message leaked storage path: ${
      JSON.stringify(body.error.message)
    }`,
  );
  closeAll();
});

Deno.test("getRunReadsCanonicalStoreWithoutRunManager", () => {
  const sessionDir = tempDir("openaiapi-runapi-canonical-");
  const startedAt = new Date(Date.now() - 60_000);
  const finishedAt = new Date();
  seedTerminalRun(sessionDir, {
    id: "cross-process-run",
    sessionId: "cross-process-session",
    workDir: tempDir("openaiapi-runapi-work-"),
    status: "completed",
  });
  void startedAt;
  void finishedAt;

  // A fresh Serve process has no in-memory RunManager entry for a Run created
  // by another process. GetRun must still read the canonical Runtime store.
  const server = new Server({ settings: { sessionDir } as never });
  const run = getRun(server, "cross-process-run");
  assertEquals(run.sessionId, "cross-process-session");
  assertEquals(run.status, "completed");
  closeAll();
});

Deno.test("runAPIResponseReturnsCursorReadFailure", () => {
  const sessionDir = tempDir("openaiapi-runapi-cursor-");
  Deno.mkdirSync(`${sessionDir}/sessions.db`);
  let threw = false;
  try {
    runAPIResponse(sessionDir, {
      id: "run-cursor-error",
      sessionId: "session-cursor-error",
      startedAt: new Date(),
      updatedAt: new Date(),
    } as never);
  } catch {
    threw = true;
  }
  assert(
    threw,
    "runAPIResponse unexpectedly accepted an unreadable event store",
  );
  closeAll();
});

Deno.test("retryRunUnknownRunReturnsStructuredSafeError", async () => {
  const { server } = newTestServer();
  try {
    const response = await handleRunAPI(
      server,
      runAPIRequest("/api/runs/run-does-not-exist/retry", {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": "unknown-run-retry-key" },
      }),
    );
    assertEquals(response.status, 404);
    const body = await response.json();
    assertEquals(body.error.code, "run_not_found");
    assertEquals(body.error.messageKey, "run.error.notFound");
    assertEquals(body.error.runId, "run-does-not-exist");
    assert(
      !body.error.message.toLowerCase().includes("session not found"),
      `retry error leaked internal lookup message: ${
        JSON.stringify(body.error.message)
      }`,
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("findIdempotentRunRejectsLegacySubmitKeyForRetry", async () => {
  const { server, sessionDir } = newTestServer();
  try {
    const key = "legacy-submit-key";
    const sess = await getOrCreateSession(
      server,
      "legacy-idempotency-scope-session",
      getWorkDir(server.cfg!),
    );
    recordSessionRunEvent(
      server,
      sess,
      "legacy-submit-run",
      "started",
      "queued",
      "webui",
      "",
      "",
      rawEventData({
        idempotencyKey: key,
        requestFingerprint: "legacy-request",
      }),
    );
    let err: unknown = null;
    try {
      findIdempotentRun(
        sessionDir,
        sess.id,
        key,
        "legacy-request",
        retryIdempotencyScope("intent-legacy", "legacy-submit-run"),
      );
    } catch (e) {
      err = e;
    }
    assert(
      err === ErrIdempotencyKeyConflict,
      `legacy submit key used for retry error = ${err}, want idempotency conflict`,
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("retryRunRequiresConfirmationForUnknownSideEffects", async () => {
  const { server, sessionDir } = newHistoryServer();
  try {
    const sessionID = "retry-confirm-session";
    const runID = "run-confirm";
    const sess = await getOrCreateSession(
      server,
      sessionID,
      getWorkDir(server.cfg!),
    );
    const intent: ExecutionIntent = {
      id: "intent-confirm",
      sessionId: sessionID,
      source: "webui",
      model: "m1",
      mode: "yolo",
      workDir: sess.workDir,
      requestFingerprint: "",
      request: { message: "change something" },
      policy: {},
      createdAt: new Date(),
    };
    seedIntent(sessionDir, intent);
    seedTerminalRun(sessionDir, {
      id: runID,
      sessionId: sessionID,
      workDir: sess.workDir,
      intentId: intent.id,
      errorInfo: {
        code: "provider_unavailable",
        type: "provider_error",
        failureClass: FailureTransient,
        message: "The service is temporarily unavailable.",
        retryMode: RetryDecisionRequired,
        retryable: true,
        sideEffectState: SideEffectUnknown,
        runId: runID,
        intentId: intent.id,
      },
    });
    const response = await handleRunAPI(
      server,
      runAPIRequest(`/api/runs/${runID}/retry`, {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": "confirm-key" },
      }),
    );
    const body = await response.text();
    assertEquals(
      response.status,
      409,
      `unconfirmed retry = ${response.status} ${body}`,
    );
    assert(body.includes("retry_confirmation_required"), body);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("runAPICancelExternalOwnerReturnsStructuredConflict", async () => {
  const sessionDir = tempDir("openaiapi-runapi-external-");
  const mgr = newManager(tempDir("openaiapi-runapi-external-cwd-"), sessionDir);
  mgr.initWithID("external-cancel-session");
  const sessionID = mgr.getHeader()!.id;

  const now = new Date();
  new RunStore(sessionDir).create({
    id: "external-cancel-run",
    sessionId: sessionID,
    intentId: "",
    retryOf: "",
    attempt: 1,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "running",
    startedAt: now,
    finishedAt: null,
    error: "",
    errorInfo: {} as never,
    progress: {} as never,
    usage: null,
    contextUsage: null,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
  });
  const db = openRootDB(sessionDir);
  const epochNow = Math.floor(Date.now() / 1000);
  new RuntimeLeaseDAO(null).insert(db.db!, {
    sessionId: sessionID,
    ownerId: "external-owner",
    ownerPid: 4242,
    ownerKind: "process",
    tokenHash: "external-token",
    epoch: 9,
    runId: "external-cancel-run",
    purpose: "execution",
    state: "active",
    acquiredAt: epochNow,
    heartbeatAt: epochNow,
    expiresAt: epochNow + 60,
    updatedAt: epochNow,
  });

  const server = new Server({ settings: { sessionDir } as never });
  try {
    const response = await handleRunAPI(
      server,
      runAPIRequest("/api/runs/external-cancel-run/cancel", { method: "POST" }),
    );
    const body = await response.text();
    assertEquals(response.status, 409, body);
    const parsed = JSON.parse(body);
    assertEquals(parsed.error.code, SessionStopOwnedElsewhere);
    assertEquals(parsed.error.runId, "external-cancel-run");
    const run = getDurableRun(sessionDir, "external-cancel-run");
    assert(run !== null && run.status === "running", "external run changed");
  } finally {
    closeAll();
  }
});

Deno.test("runAPIMethodNotAllowedAndBadPaths", async () => {
  const { server } = newTestServer();
  try {
    // GET on a cancel path is not allowed.
    const getCancel = await handleRunAPI(
      server,
      runAPIRequest("/api/runs/run-x/cancel"),
    );
    assertEquals(getCancel.status, 405);
    // DELETE writes the bare status code.
    const del = await handleRunAPI(
      server,
      runAPIRequest("/api/runs/run-x", { method: "DELETE" }),
    );
    assertEquals(del.status, 405);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("retryableRunStatusTable", () => {
  for (
    const status of [
      "failed",
      "incomplete",
      "timed_out",
      "expired",
      "cancelled",
      "canceled",
      " FAILED ",
    ]
  ) {
    assert(retryableRunStatus(status), status);
  }
  for (const status of ["completed", "running", "queued", ""]) {
    assert(!retryableRunStatus(status), status);
  }
});
