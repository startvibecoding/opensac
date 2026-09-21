// Translated from internal/serve/openaiapi/background_run_coordinator_test.go —
// the durable Responses background coordinator cluster: the pure archive
// decoders, the terminal-state guards, the result finalizer, the parallel
// tool executor (ordering, idempotency scoping, interruption, live progress),
// the recovered-run monitor, the submit-path dispatch through the coordinator,
// and the polling caps. Canonical Run rows are seeded through the Runtime
// RunStore and queried through agentruntime.GetDurableRun (test-hygiene
// guard); the remote Responses upstream is an in-process mock HttpClient
// (Go's httptest upstream).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { closeAll } from "../../db/mod.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import {
  mockClient,
  type MockRequest,
} from "../../provider/openai/test_helpers.ts";
import { newProviderWithModels } from "../../provider/openai/mod.ts";
import type { ResponsesConfig } from "../../config/settings.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { listSessionRunEvents } from "../../session/session_events.ts";
import {
  claimToolExecutionRecord,
  listResponseRuns,
  saveResponseItem,
  saveResponseRun,
  saveResponseTurn,
} from "../../session/mod.ts";
import { getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { messageText } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { handleSubmitRun } from "./handler_run_submit.ts";
import { RunManager } from "./run_manager.ts";
import { isSuccessfulRunStatus } from "./events.ts";
import {
  backgroundRunMaxDuration,
  defaultBackgroundRunMaxDurationMs,
  executeResponsesBackgroundRunFn,
  executeResponsesBackgroundTools,
  executeResponsesBackgroundToolsWithProgress,
  finalizeResponsesBackgroundResult,
  isTerminalSessionRunState,
  monitorRecoveredResponsesBackgroundRun,
  publishResponsesBackgroundToolEvent,
  responsesBackgroundDetails,
  responsesBackgroundFunctionCallsForRun,
  responsesBackgroundText,
} from "./background_run_coordinator.ts";
import {
  EventToolExecutionEnd,
  EventToolExecutionStart,
} from "../../agent/events.ts";
import type { Tool } from "../../tools/tool.ts";
import type { Agent } from "../../agent/agent.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

/** Routes mock fetches by "METHOD /path" like Go's httptest upstream. */
type UpstreamHandler = (
  method: string,
  path: string,
  body: Record<string, unknown>,
) => Response | Promise<Response>;

function jsonBody(req: MockRequest): Record<string, unknown> {
  try {
    return JSON.parse(req.body || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function installUpstream(server: Server, handler: UpstreamHandler): void {
  const openai = server.provider as unknown as {
    client: { fetch: unknown };
  };
  openai.client = mockClient((req) => {
    const url = new URL(req.url);
    const method = req.init?.method ?? "GET";
    return handler(method.toUpperCase(), url.pathname, jsonBody(req));
  });
}

function responsesModel(): Model {
  return {
    id: "m1",
    name: "Model 1",
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };
}

function newCoordinatorServer(): {
  server: Server;
  model: Model;
  sessionDir: string;
  workDir: string;
} {
  const sessionDir = tempDir("openaiapi-coord-sess-");
  const workDir = tempDir("openaiapi-coord-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: {
      defaultMode: "yolo",
      defaultWorkDir: workDir,
      requestTimeoutSecs: 30,
    } as never,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  const model = responsesModel();
  const p = newProviderWithModels("test-key", "https://api.test/v1", [model]);
  server.provider = p as unknown as Provider;
  server.model = model;
  return { server, model, sessionDir, workDir };
}

function enableResponsesBackground(server: Server): void {
  const p = server.provider as unknown as {
    setUseResponsesAPI(enabled: boolean): void;
    setResponsesConfig(cfg: ResponsesConfig): void;
  };
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ background: true } as ResponsesConfig);
  server.responsesRuns = (
    server.provider as unknown as {
      newResponsesRunManager(sessionDir: string): unknown;
    }
  ).newResponsesRunManager(server.sessionDir()) as never;
  server.runManager = new RunManager(server.sessionDir());
  server.executeResponsesBackgroundRun = executeResponsesBackgroundRunFn(
    server,
  );
}

function submitRequest(sessionID: string, body: string): Request {
  return new Request(`http://localhost/api/sessions/${sessionID}/runs`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(
  predicate: () => boolean,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function seedRunRow(
  sessionDir: string,
  run: {
    id: string;
    sessionId: string;
    workDir: string;
    source: string;
    model: string;
    mode: string;
    status: string;
  },
): void {
  const now = new Date();
  new RunStore(sessionDir).create({
    id: run.id,
    sessionId: run.sessionId,
    intentId: "",
    retryOf: "",
    attempt: 1,
    workDir: run.workDir,
    source: run.source,
    model: run.model,
    mode: run.mode,
    status: run.status,
    startedAt: now,
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
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

// ---------------------------------------------------------------------------
// Pure decoders and guards
// ---------------------------------------------------------------------------

Deno.test("responsesBackgroundTextJoinsOutputText", () => {
  const { text, requiresLocalContinuation } = responsesBackgroundText([
    {
      id: 0,
      sessionId: "s",
      localTurnId: "t",
      responseId: "r",
      itemId: "msg-1",
      outputIndex: 0,
      itemType: "message",
      itemStatus: "",
      itemKey: "",
      sanitizedJson: {
        type: "message",
        content: [
          { type: "output_text", text: "hello " },
          { type: "output_text", text: "world" },
        ],
      },
      createdAt: new Date(),
    },
  ]);
  assertEquals(requiresLocalContinuation, false);
  assertEquals(text, "hello world");
});

Deno.test("responsesBackgroundTextFlagsFunctionCallContinuation", () => {
  const first = responsesBackgroundText([
    {
      id: 0,
      sessionId: "s",
      localTurnId: "t",
      responseId: "r",
      itemId: "call-1",
      outputIndex: 0,
      itemType: "function_call",
      itemStatus: "",
      itemKey: "",
      sanitizedJson: {
        type: "function_call",
        call_id: "call-1",
        name: "write",
        arguments: "{}",
      },
      createdAt: new Date(),
    },
  ]);
  assertEquals(first.requiresLocalContinuation, true);
  let threw = false;
  try {
    responsesBackgroundText([
      {
        id: 0,
        sessionId: "s",
        localTurnId: "t",
        responseId: "r",
        itemId: "computer-1",
        outputIndex: 0,
        itemType: "computer_call",
        itemStatus: "",
        itemKey: "",
        sanitizedJson: {
          type: "computer_call",
          action: { type: "screenshot" },
        },
        createdAt: new Date(),
      },
    ]);
  } catch (err) {
    threw = true;
    assertStringIncludes(
      (err as Error).message,
      "computer use is not supported",
    );
  }
  assert(threw);
});

Deno.test("recoverySkipsCancellingRuns", () => {
  for (
    const state of [
      "completed",
      "incomplete",
      "expired",
      "failed",
      "cancelled",
      "canceled",
      "cancelling",
      "terminalizing",
    ]
  ) {
    assertEquals(isTerminalSessionRunState(state), true, state);
  }
  assertEquals(isTerminalSessionRunState("running"), false);
});

Deno.test("incompleteResponsesRunIsSuccessfulDelivery", () => {
  assertEquals(isSuccessfulRunStatus("completed"), true);
  assertEquals(isSuccessfulRunStatus("incomplete"), false);
  for (const status of ["failed", "cancelled", "expired", "running"]) {
    assertEquals(isSuccessfulRunStatus(status), false, status);
  }
});

Deno.test("responsesBackgroundFunctionCallsLoadCustomInput", () => {
  const sessionDir = tempDir("openaiapi-coord-items-");
  try {
    saveResponseItem(sessionDir, {
      id: 0,
      sessionId: "session-custom",
      localTurnId: "turn-custom",
      responseId: "resp-custom",
      itemId: "custom-1",
      outputIndex: 0,
      itemType: "custom_tool_call",
      itemStatus: "",
      itemKey: "",
      sanitizedJson: {
        id: "custom-1",
        type: "custom_tool_call",
        call_id: "call-custom",
        name: "shell_script",
        input: "echo hello",
      },
      createdAt: new Date(),
    });
    const calls = responsesBackgroundFunctionCallsForRun(
      sessionDir,
      "session-custom",
      "turn-custom",
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].id, "call-custom");
    assertEquals(calls[0].kind, "custom");
    assertEquals(calls[0].input, "echo hello");
    assertEquals(calls[0].arguments, `{"input":"echo hello"}`);
  } finally {
    closeAll();
  }
});

Deno.test("responsesBackgroundDetailsLoadsArchivedUsageAndAttachments", () => {
  const sessionDir = tempDir("openaiapi-coord-details-");
  try {
    saveResponseTurn(sessionDir, {
      id: 0,
      sessionId: "session-details",
      localTurnId: "turn-details",
      messageId: null,
      requestId: "",
      responseId: "",
      previousResponseId: "",
      conversationId: "",
      provider: "openai",
      api: "openai-responses",
      model: "test",
      stateMode: "replay",
      status: "completed",
      incompleteReason: "",
      requestSummary: null,
      responseSummary: {
        usage: { input: 11, output: 7, totalTokens: 18 },
        attachments: [
          { kind: "citation", name: "OpenAI", url: "https://openai.com" },
        ],
      },
      createdAt: new Date(0),
      completedAt: null,
    });
    const { usage, attachments } = responsesBackgroundDetails(
      sessionDir,
      "session-details",
      "turn-details",
    );
    assertEquals(usage?.totalTokens, 18);
    assertEquals(attachments.length, 1);
    assertEquals(attachments[0].url, "https://openai.com");
  } finally {
    closeAll();
  }
});

// ---------------------------------------------------------------------------
// Result finalizer
// ---------------------------------------------------------------------------

Deno.test("finalizeIncompleteBackgroundPreservesOutputAndReason", async () => {
  const { server, sessionDir } = newCoordinatorServer();
  try {
    enableResponsesBackground(server);
    const sess = await getOrCreateSession(
      server,
      "incomplete-background",
      getWorkDir(server.cfg!),
    );
    const runID = "incomplete-run";
    seedRunRow(sessionDir, {
      id: runID,
      sessionId: sess.id,
      workDir: sess.workDir,
      source: "responses_background",
      model: "test",
      mode: "agent",
      status: "running",
    });
    saveResponseTurn(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localTurnId: runID,
      messageId: null,
      requestId: "",
      responseId: "resp-incomplete",
      previousResponseId: "",
      conversationId: "",
      provider: "openai",
      api: "openai-responses",
      model: "test",
      stateMode: "replay",
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      requestSummary: null,
      responseSummary: {
        usage: { input: 4, output: 5, totalTokens: 9 },
        attachments: [{ kind: "file", providerRef: "file_1" }],
      },
      createdAt: new Date(0),
      completedAt: null,
    });
    saveResponseItem(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localTurnId: runID,
      responseId: "resp-incomplete",
      itemId: "msg-incomplete",
      outputIndex: 0,
      itemType: "message",
      itemStatus: "",
      itemKey: "",
      sanitizedJson: {
        type: "message",
        content: [{ type: "output_text", text: "partial result" }],
      },
      createdAt: new Date(),
    });
    const status = await finalizeResponsesBackgroundResult(
      server,
      sess,
      runID,
      "test",
      "agent",
      {
        sessionId: sess.id,
        localRunId: "remote-incomplete",
        localTurnId: runID,
        responseId: "resp-incomplete",
        provider: "openai",
        api: "openai-responses",
        state: "incomplete",
        cancelRequested: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
      false,
    );
    assertEquals(status, "incomplete");
    const messages = sess.manager!.getMessages();
    assert(messages.length > 0);
    assertEquals(messageText(messages[messages.length - 1]), "partial result");
    assertEquals(messages[messages.length - 1].attachments?.length, 1);
    const events = listSessionRunEvents(sessionDir, sess.id);
    const found = events.some((event) => {
      if (event.eventType !== "finished" || event.status !== "incomplete") {
        return false;
      }
      const data = event.data as Record<string, unknown>;
      return data["incompleteReason"] === "max_output_tokens";
    });
    assert(found);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

// ---------------------------------------------------------------------------
// Parallel background tool executor
// ---------------------------------------------------------------------------

interface BackgroundToolHandle extends Tool {
  count(): number;
  started: Promise<void>;
  release(): void;
}

function parallelBackgroundTool(): BackgroundToolHandle {
  let count = 0;
  let resolveStarted: (() => void) | null = null;
  let resolveRelease: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const tool: BackgroundToolHandle = {
    name: () => "parallel_test",
    description: () => "test parallel background execution",
    promptSnippet: () => "test parallel background execution",
    promptGuidelines: () => [],
    parameters: () => ({
      type: "object",
      properties: { index: { type: "integer" } },
    }),
    execute: async (ctx, params) => {
      count++;
      if (count === 2) resolveStarted?.();
      const released = await Promise.race([
        releasePromise.then(() => false),
        new Promise<boolean>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(true), {
            once: true,
          });
        }),
      ]);
      if (released) throw new DOMException("aborted", "AbortError");
      return { text: String(params["index"]) };
    },
    count: () => count,
    started,
    release: () => resolveRelease?.(),
  };
  return tool;
}

function buildBackgroundAgent(
  server: Server,
  sess: Awaited<ReturnType<typeof getOrCreateSession>>,
  tool?: BackgroundToolHandle,
): Agent {
  if (tool) sess.registry!.register(tool);
  return sess.runtime!.buildAgent({
    provider: server.provider,
    providerName: server.providerName,
    model: server.model,
    mode: "yolo",
    settings: server.settings ?? undefined,
  });
}

Deno.test("responsesBackgroundToolsRunParallelAndPreserveOutputOrder", async () => {
  const { server, workDir } = newCoordinatorServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "parallel-background",
      getWorkDir(server.cfg!),
    );
    void workDir;
    const tool = parallelBackgroundTool();
    const backgroundAgent = buildBackgroundAgent(server, sess, tool);
    const calls = [
      { id: "call-1", name: "parallel_test", arguments: `{"index":1}` },
      { id: "call-2", name: "parallel_test", arguments: `{"index":2}` },
    ];
    const execPromise = executeResponsesBackgroundTools(
      server,
      undefined,
      sess,
      backgroundAgent,
      "run-parallel",
      "run-parallel",
      calls,
    );
    // Both calls must start before either finishes.
    const bothStarted = await Promise.race([
      tool.started.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert(bothStarted, "background function calls did not start in parallel");
    tool.release();
    const { outputs, ok } = await execPromise;
    assert(ok);
    assertEquals(outputs?.length, 2);
    assertEquals(messageText(outputs![0]), "1");
    assertEquals(messageText(outputs![1]), "2");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesBackgroundToolsScopeIdempotencyToResponseTurn", async () => {
  const { server } = newCoordinatorServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "turn-scoped-background",
      getWorkDir(server.cfg!),
    );
    const tool = parallelBackgroundTool();
    tool.release();
    const backgroundAgent = buildBackgroundAgent(server, sess, tool);
    const call = {
      id: "reused-call-id",
      name: "parallel_test",
      arguments: `{"index":1}`,
    };
    const first = await executeResponsesBackgroundTools(
      server,
      undefined,
      sess,
      backgroundAgent,
      "webui-run",
      "response-turn-one",
      [call],
    );
    assert(first.ok && first.outputs?.length === 1);
    const second = await executeResponsesBackgroundTools(
      server,
      undefined,
      sess,
      backgroundAgent,
      "webui-run",
      "response-turn-one",
      [call],
    );
    assert(second.ok && second.outputs?.length === 1);
    const third = await executeResponsesBackgroundTools(
      server,
      undefined,
      sess,
      backgroundAgent,
      "webui-run",
      "response-turn-two",
      [call],
    );
    assert(third.ok && third.outputs?.length === 1);
    assertEquals(
      tool.count(),
      2,
      "want 2 executions for separate Responses turns and one same-turn reuse",
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("publishResponsesBackgroundToolEventPreservesInterruptedStatus", async () => {
  const server = new Server({ eventBroker: new EventBroker() });
  const sess = { id: "interrupted-event-session" } as never;
  const { events, cancel } = server.getEventBroker().subscribe(
    (sess as { id: string }).id,
  );
  publishResponsesBackgroundToolEvent(server, sess, null, "run-interrupted", {
    type: EventToolExecutionEnd,
    toolName: "bash",
    toolCallId: "call-1",
    toolExecutionState: "interrupted",
  } as never);
  const timeout = Symbol("timeout");
  const received = await Promise.race([
    (async () => {
      for await (const event of events) return event;
      return undefined;
    })(),
    new Promise<typeof timeout>((resolve) =>
      setTimeout(() => resolve(timeout), 1000)
    ),
  ]);
  cancel();
  assert(received !== undefined && received !== timeout, "timed out");
  const status = (received as { data: { status: string; summary: string } })
    .data;
  assertEquals(status.status, "interrupted");
  assertStringIncludes(status.summary, "explicit confirmation");
});

Deno.test("backgroundToolProgressIsArchivedForChannelReconnect", async () => {
  const { server, sessionDir, workDir } = newCoordinatorServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "channel-progress-archive",
      getWorkDir(server.cfg!),
    );
    void workDir;
    seedRunRow(sessionDir, {
      id: "channel-progress-run",
      sessionId: sess.id,
      workDir: sess.workDir,
      source: "channel:wechat",
      model: server.model!.id,
      mode: "yolo",
      status: "running",
    });
    publishResponsesBackgroundToolEvent(
      server,
      sess,
      null,
      "channel-progress-run",
      {
        type: EventToolExecutionStart,
        toolName: "read",
        toolCallId: "call-read",
      } as never,
    );
    publishResponsesBackgroundToolEvent(
      server,
      sess,
      null,
      "channel-progress-run",
      {
        type: EventToolExecutionEnd,
        toolName: "read",
        toolCallId: "call-read",
        toolResult: "line one\nsecret details",
      } as never,
    );
    const events = listSessionRunEvents(sessionDir, sess.id);
    const progress = events
      .filter((event) => event.eventType === "tool_progress")
      .map((event) => event.data as Record<string, unknown>);
    assertEquals(progress.length, 2);
    assertEquals(progress[0]["status"], "running");
    assertEquals(progress[1]["status"], "completed");
    assertEquals(progress[1]["toolCallId"], "call-read");
    assertEquals(
      String(progress[1]["summary"]).includes("secret details"),
      false,
      "progress summary must be bounded to the first line",
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesBackgroundToolsStopsOnInterruptedExecutionRecord", async () => {
  const { server } = newCoordinatorServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "interrupted-background",
      getWorkDir(server.cfg!),
    );
    const tool = parallelBackgroundTool();
    tool.release();
    const backgroundAgent = buildBackgroundAgent(server, sess, tool);
    const call = {
      id: "call-interrupted",
      name: "parallel_test",
      arguments: `{"index":1}`,
    };
    const argsHash = createHash("sha256").update(`{"index":1}`).digest("hex");
    const keyInput = [
      sess.id,
      "interrupted-run",
      call.id,
      call.name,
      argsHash,
    ].join("\u0000");
    const keyHash = createHash("sha256").update(keyInput).digest("hex");
    const claimed = claimToolExecutionRecord(server.sessionDir(), {
      id: 0,
      sessionId: sess.id,
      localTurnId: "interrupted-run",
      executionKey: `tool:${keyHash}`,
      provider: server.provider!.name(),
      api: server.provider!.api(),
      responseId: "",
      providerCallId: call.id,
      toolKind: "function",
      toolName: call.name,
      argsHash,
      executionState: "running",
      resultSummary: null,
      providerMetadata: null,
      sideEffecting: true,
      createdAt: new Date(),
      completedAt: null,
    });
    assertEquals(claimed.created, true);
    const { outputs, ok } = await executeResponsesBackgroundTools(
      server,
      undefined,
      sess,
      backgroundAgent,
      "interrupted-run",
      "interrupted-run",
      [call],
    );
    assertEquals(ok, false);
    assertEquals(outputs, null);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesBackgroundToolsForwardsLiveProgress", async () => {
  const { server, workDir } = newCoordinatorServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "live-progress",
      workDir,
    );
    const path = `${workDir}/progress.txt`;
    await Deno.writeTextFile(path, "progress");
    const backgroundAgent = buildBackgroundAgent(server, sess);
    const progress: string[] = [];
    const { outputs, ok } = await executeResponsesBackgroundToolsWithProgress(
      server,
      undefined,
      sess,
      backgroundAgent,
      "live-progress-run",
      "live-progress-turn",
      [{
        id: "call-live-progress",
        name: "read",
        arguments: `{"path":"progress.txt"}`,
      }],
      false,
      (text) => progress.push(text),
    );
    assert(ok);
    assertEquals(outputs?.length, 1);
    assert(progress.length >= 2);
    assertStringIncludes(progress[0], "read running");
    assertStringIncludes(progress[progress.length - 1], "read completed");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

// ---------------------------------------------------------------------------
// Recovered-run monitor
// ---------------------------------------------------------------------------

Deno.test("recoverResponsesBackgroundFunctionContinuation", async () => {
  let continuationPosts = 0;
  const { server, model, sessionDir, workDir } = newCoordinatorServer();
  try {
    installUpstream(server, (method, path, body) => {
      if (method === "GET" && path === "/v1/responses/resp-recovery") {
        return Response.json({
          id: "resp-recovery",
          status: "completed",
          output: [
            {
              id: "fc-recovery",
              type: "function_call",
              call_id: "call-recovery",
              name: "read",
              arguments: `{"path":"missing.txt"}`,
            },
          ],
        });
      }
      if (method === "POST" && path === "/v1/responses") {
        continuationPosts++;
        if (continuationPosts === 1) {
          assertEquals(body["previous_response_id"], "resp-recovery");
          return new Response(
            JSON.stringify({
              error: {
                type: "invalid_state",
                message: "response state permission changed",
              },
            }),
            { status: 403 },
          );
        }
        assertEquals(
          "previous_response_id" in body,
          false,
          "replay request unexpectedly carried previous_response_id",
        );
        return Response.json({ id: "resp-recovery-final", status: "queued" });
      }
      if (method === "GET" && path === "/v1/responses/resp-recovery-final") {
        return Response.json({
          id: "resp-recovery-final",
          status: "completed",
          output: [
            {
              id: "msg-recovery-final",
              type: "message",
              content: [{
                type: "output_text",
                text: "recovered continuation",
              }],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);
    const runID = "recover-background-run";
    const sess = await getOrCreateSession(
      server,
      "recover-background-session",
      workDir,
    );
    const now = new Date();
    seedRunRow(sessionDir, {
      id: runID,
      sessionId: sess.id,
      workDir: sess.workDir,
      source: "responses_background",
      model: model.id,
      mode: "yolo",
      status: "running",
    });
    saveResponseRun(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localRunId: "remote-recovery",
      localTurnId: runID,
      messageId: null,
      responseId: "resp-recovery",
      provider: server.provider!.name(),
      api: "openai-responses",
      state: "queued",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    await sess.mu.lock();
    sess.beginRun(runID);
    const localRun = getDurableRun(sessionDir, runID)!;
    await monitorRecoveredResponsesBackgroundRun(
      server,
      sess,
      localRun,
      {
        sessionId: sess.id,
        localRunId: "remote-recovery",
        localTurnId: runID,
        responseId: "resp-recovery",
        provider: server.provider!.name(),
        api: "openai-responses",
        state: "queued",
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
      } as never,
      model,
      () => {},
    );
    const messages = sess.manager!.getMessages();
    console.error(
      "DBG messages:",
      JSON.stringify(
        messages.map((m) => ({ role: m.role, text: messageText(m) })),
        null,
        1,
      ),
    );
    console.error(
      "DBG events:",
      JSON.stringify(
        listSessionRunEvents(sessionDir, sess.id).map((e) => ({
          t: e.eventType,
          s: e.status,
          d: e.data,
        })),
        null,
        1,
      ),
    );
    console.error("DBG run:", JSON.stringify(getDurableRun(sessionDir, runID)));
    console.error(
      "DBG responseRuns:",
      JSON.stringify(listResponseRuns(sessionDir, sess.id, 100)),
    );
    assert(messages.length > 0);
    assertEquals(
      messageText(messages[messages.length - 1]),
      "recovered continuation",
    );
    assertEquals(
      continuationPosts,
      2,
      "want 2 continuation POSTs (state fallback replay)",
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

// ---------------------------------------------------------------------------
// Submit-path dispatch through the coordinator
// ---------------------------------------------------------------------------

async function waitForDurableRun(
  sessionDir: string,
  runId: string,
  status: string,
): Promise<void> {
  await waitFor(() => getDurableRun(sessionDir, runId)?.status === status);
}

Deno.test("submitRunUsesResponsesBackgroundCoordinator", async () => {
  let postCount = 0;
  let getCount = 0;
  const { server, sessionDir } = newCoordinatorServer();
  try {
    installUpstream(server, (method, path) => {
      if (method === "POST" && path === "/v1/responses") {
        postCount++;
        return Response.json({ id: "resp-background", status: "queued" });
      }
      if (method === "GET" && path === "/v1/responses/resp-background") {
        getCount++;
        return Response.json({
          id: "resp-background",
          status: "completed",
          output: [
            {
              id: "msg-background",
              type: "message",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "background complete",
                  annotations: [
                    {
                      type: "url_citation",
                      title: "OpenAI",
                      url: "https://openai.com",
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);
    const response = await handleSubmitRun(
      server,
      submitRequest(
        "responses-background-session",
        `{"message":"run remotely"}`,
      ),
    );
    assertEquals(response.status, 202);
    const accepted = await response.json();
    assert(accepted.runId !== "");
    await waitForDurableRun(sessionDir, accepted.runId, "completed");
    const sess = await getOrCreateSession(
      server,
      "responses-background-session",
      getWorkDir(server.cfg!),
    );
    const messages = sess.manager!.getMessages();
    assertEquals(messages.length, 2);
    assertEquals(messageText(messages[0]), "run remotely");
    assertEquals(messageText(messages[1]), "background complete");
    assertEquals(messages[1].attachments?.length, 1);
    assertEquals(messages[1].attachments![0].kind, "citation");
    assertEquals(messages[1].attachments![0].url, "https://openai.com");
    assertEquals(postCount, 1);
    assert(getCount > 0);
    void sessionDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunReplaysAfterRemoteStatePollFailure", async () => {
  let postCount = 0;
  const { server, sessionDir } = newCoordinatorServer();
  try {
    installUpstream(server, (method, path, body) => {
      if (method === "POST" && path === "/v1/responses") {
        postCount++;
        if (postCount === 1) {
          return Response.json({ id: "resp-expired", status: "queued" });
        }
        assertEquals(
          "previous_response_id" in body,
          false,
          "replay request unexpectedly retained previous_response_id",
        );
        return Response.json({ id: "resp-replayed", status: "queued" });
      }
      if (method === "GET" && path === "/v1/responses/resp-expired") {
        return new Response(
          JSON.stringify({ error: { message: "response expired" } }),
          {
            status: 404,
          },
        );
      }
      if (method === "GET" && path === "/v1/responses/resp-replayed") {
        return Response.json({
          id: "resp-replayed",
          status: "completed",
          output: [
            {
              id: "msg-replayed",
              type: "message",
              content: [{ type: "output_text", text: "replayed background" }],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);
    const response = await handleSubmitRun(
      server,
      submitRequest(
        "responses-background-poll-replay",
        `{"message":"recover poll state"}`,
      ),
    );
    assertEquals(response.status, 202);
    const accepted = await response.json();
    assert(accepted.runId !== "");
    await waitForDurableRun(sessionDir, accepted.runId, "completed");
    const sess = await getOrCreateSession(
      server,
      "responses-background-poll-replay",
      getWorkDir(server.cfg!),
    );
    const messages = sess.manager!.getMessages();
    assertEquals(messages.length, 2);
    assertEquals(messageText(messages[1]), "replayed background");
    assertEquals(postCount, 2);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunContinuesResponsesBackgroundFunctionCall", async () => {
  let postCount = 0;
  const { server, sessionDir } = newCoordinatorServer();
  try {
    installUpstream(server, (method, path, body) => {
      if (method === "POST" && path === "/v1/responses") {
        postCount++;
        if (postCount === 1) {
          return Response.json({
            id: "resp-tool-call",
            status: "completed",
            output: [
              {
                id: "fc-1",
                type: "function_call",
                call_id: "call-1",
                name: "read",
                arguments: `{"path":"missing.txt"}`,
              },
            ],
          });
        }
        assertEquals(body["previous_response_id"], "resp-tool-call");
        const input = body["input"] as Record<string, unknown>[];
        assertEquals(input.length, 1);
        assertEquals(input[0]["type"], "function_call_output");
        assertEquals(input[0]["call_id"], "call-1");
        return Response.json({ id: "resp-final", status: "queued" });
      }
      if (method === "GET" && path === "/v1/responses/resp-final") {
        return Response.json({
          id: "resp-final",
          status: "completed",
          output: [
            {
              id: "msg-final",
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: "continued after tool" }],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);
    const response = await handleSubmitRun(
      server,
      submitRequest(
        "responses-background-function",
        `{"message":"read a file"}`,
      ),
    );
    assertEquals(response.status, 202);
    const accepted = await response.json();
    assert(accepted.runId !== "");
    await waitForDurableRun(sessionDir, accepted.runId, "completed");
    const sess = await getOrCreateSession(
      server,
      "responses-background-function",
      getWorkDir(server.cfg!),
    );
    const messages = sess.manager!.getMessages();
    assert(messages.length >= 4);
    assertEquals(
      messageText(messages[messages.length - 1]),
      "continued after tool",
    );
    assertEquals(postCount, 2);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunContinuesResponsesBackgroundCustomToolCall", async () => {
  let postCount = 0;
  const { server, sessionDir } = newCoordinatorServer();
  try {
    installUpstream(server, (method, path, body) => {
      if (method === "GET" && path === "/v1/responses/resp-custom-final") {
        return Response.json({
          id: "resp-custom-final",
          status: "completed",
          output: [
            {
              id: "msg-custom-final",
              type: "message",
              content: [
                { type: "output_text", text: "continued after custom tool" },
              ],
            },
          ],
        });
      }
      if (method === "POST" && path === "/v1/responses") {
        postCount++;
        if (postCount === 1) {
          return Response.json({
            id: "resp-custom-tool",
            status: "completed",
            output: [
              {
                id: "ctc-1",
                type: "custom_tool_call",
                call_id: "call-custom-1",
                name: "read",
                input: "missing.txt",
              },
            ],
          });
        }
        assertEquals(body["previous_response_id"], "resp-custom-tool");
        const input = body["input"] as Record<string, unknown>[];
        assertEquals(input.length, 1);
        assertEquals(input[0]["type"], "custom_tool_call_output");
        assertEquals(input[0]["call_id"], "call-custom-1");
        return Response.json({ id: "resp-custom-final", status: "queued" });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);
    const response = await handleSubmitRun(
      server,
      submitRequest(
        "responses-background-custom",
        `{"message":"read with custom input"}`,
      ),
    );
    assertEquals(response.status, 202);
    const accepted = await response.json();
    assert(accepted.runId !== "");
    await waitForDurableRun(sessionDir, accepted.runId, "completed");
    assertEquals(postCount, 2);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

// ---------------------------------------------------------------------------
// Polling caps
// ---------------------------------------------------------------------------

Deno.test("backgroundRunMaxDuration", () => {
  assertEquals(
    backgroundRunMaxDuration(null),
    defaultBackgroundRunMaxDurationMs,
  );
  assertEquals(
    backgroundRunMaxDuration(new Server({})),
    defaultBackgroundRunMaxDurationMs,
  );
  const configured = new Server({
    cfg: { backgroundRunMaxSecs: 120 } as never,
  });
  assertEquals(backgroundRunMaxDuration(configured), 120_000);
});
