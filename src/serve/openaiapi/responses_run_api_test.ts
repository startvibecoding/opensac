// Translated from internal/serve/openaiapi/responses_run_api_test.go — the
// Responses background-run HTTP surface: route registration, the abandon and
// recover actions over interrupted tool executions, and the reconnect/cancel
// reattach paths with their shared-runtime conflicts. Canonical Runs are
// seeded through the Runtime RunStore; the remote Responses upstream is an
// in-process mock HttpClient (Go's httptest upstream).
import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { ChatParams, Model, StreamEvent } from "../../provider/types.ts";
import {
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { mockClient } from "../../provider/openai/test_helpers.ts";
import { newProviderWithModels } from "../../provider/openai/mod.ts";
import type { ResponsesConfig } from "../../config/settings.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { isTerminalSessionRunStatus } from "../../session/run_status.ts";
import {
  claimToolExecutionRecord,
  saveResponseItem,
  saveResponseRun,
  saveResponseTurn,
  type ToolExecutionRecord,
} from "../../session/mod.ts";
import {
  acquireMutation,
  acquireRecovery,
} from "../../session/runtime_lock.ts";
import { getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { messageText, SessionPool } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { RunManager } from "./run_manager.ts";
import { registerRoutes, ServeMux } from "./routes.ts";
import { handleResponsesRunAPI } from "./responses_run_api.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

/** Routes mock fetches by "METHOD /path" like Go's httptest upstream. */
type UpstreamHandler = (
  method: string,
  path: string,
) => Response | Promise<Response>;

function installUpstream(server: Server, handler: UpstreamHandler): void {
  const openai = server.provider as unknown as {
    client: { fetch: unknown };
  };
  openai.client = mockClient((req) => {
    const url = new URL(req.url);
    const method = req.init?.method ?? "GET";
    return handler(method.toUpperCase(), url.pathname);
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

function newTestServer(): {
  server: Server;
  sessionDir: string;
  workDir: string;
  model: Model;
} {
  const sessionDir = tempDir("openaiapi-resp-sess-");
  const workDir = tempDir("openaiapi-resp-work-");
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
  const p = newProviderWithModels("test-key", "https://example.invalid/v1", [
    model,
  ]);
  server.provider = p as unknown as Provider;
  server.model = model;
  return { server, sessionDir, workDir, model };
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
}

// ---------------------------------------------------------------------------

Deno.test("registerRoutesResponsesRunAPI", async () => {
  const { server } = newTestServer();
  try {
    const mux = new ServeMux();
    registerRoutes(mux, server, {});

    const response = await mux.dispatch(
      new Request("http://localhost/api/responses/runs/run-1"),
    );
    assert(
      response.status !== 404,
      "Responses run route returned 404; route was not registered",
    );
    assertEquals(
      response.status,
      501,
      "Responses run route status for non-Responses provider",
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("registerRoutesResponsesRunAPIDisabledWithAPI", async () => {
  const { server } = newTestServer();
  try {
    const mux = new ServeMux();
    registerRoutes(mux, server, { disableAPI: true });

    const response = await mux.dispatch(
      new Request("http://localhost/api/responses/runs/run-1"),
    );
    assertEquals(response.status, 404);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesRunAPIAbandonMarksInterruptedToolsWithoutRetry", async () => {
  const { server, sessionDir, model } = newTestServer();
  try {
    enableResponsesBackground(server);
    const sess = await getOrCreateSession(
      server,
      "abandon-session",
      getWorkDir(server.cfg!),
    );
    const now = new Date();
    seedRunRow(sessionDir, {
      id: "abandon-local",
      sessionId: sess.id,
      workDir: sess.workDir,
      source: "responses_background",
      model: model.id,
      mode: "yolo",
      status: "failed",
    });
    saveResponseRun(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localRunId: "abandon-remote",
      localTurnId: "abandon-local",
      messageId: null,
      responseId: "resp-abandon",
      provider: server.provider!.name(),
      api: server.provider!.api(),
      state: "completed",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    const record: ToolExecutionRecord = {
      id: 0,
      sessionId: sess.id,
      localTurnId: "abandon-local",
      executionKey: "abandon-tool",
      provider: server.provider!.name(),
      api: server.provider!.api(),
      responseId: "",
      providerCallId: "call-abandon",
      toolKind: "function",
      toolName: "write",
      argsHash: "args",
      executionState: "running",
      resultSummary: undefined,
      providerMetadata: undefined,
      sideEffecting: false,
      createdAt: now,
      completedAt: null,
    };
    const claimed = claimToolExecutionRecord(sessionDir, record);
    assert(claimed.created, "claim interrupted tool");

    const response = await handleResponsesRunAPI(
      server,
      new Request(
        `http://localhost/api/responses/runs/abandon-remote/abandon?session_id=${sess.id}`,
        { method: "POST" },
      ),
    );
    const bodyText = await response.text();
    assertEquals(response.status, 200, bodyText);
    const body = JSON.parse(bodyText);
    assertEquals(body.abandonedToolExecutions, 1);

    // claimToolExecutionRecord is an idempotent write (INSERT ... ON
    // CONFLICT), not a read-only lookup. The abandon endpoint has released
    // its runtime lease by this point, so inspect the stored record under a
    // fresh short lease just as a recovery caller would.
    let release: () => void = () => {};
    let locked = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const guard = acquireMutation(sessionDir, sess.id);
        release = () => guard.release();
        locked = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert(
      locked,
      "could not acquire runtime lease to inspect abandoned tool record",
    );
    let stored: ToolExecutionRecord;
    try {
      const inspect = claimToolExecutionRecord(sessionDir, record);
      stored = inspect.record;
    } finally {
      release();
    }
    assertEquals(stored.executionState, "abandoned");
    const local = getDurableRun(sessionDir, "abandon-local");
    assert(
      local !== null && local.status === "failed" &&
        local.error === "abandoned after interrupted tool execution",
      `abandoned local run = ${JSON.stringify(local)}`,
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

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

/** Go's recoveryRunDriver test double. */
class RecoveryRunDriver {
  run: unknown;
  constructor(run: unknown) {
    this.run = run;
  }
  start(): Promise<unknown> {
    return Promise.resolve(this.run);
  }
  continue(): Promise<unknown> {
    return Promise.resolve(this.run);
  }
  get(): Promise<unknown> {
    return Promise.resolve({ ...(this.run as Record<string, unknown>) });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("responsesRunAPIRecoverStartsFreshAgentLoopAndPreservesTerminalParent", async () => {
  const { server, sessionDir, workDir, model } = newTestServer();
  try {
    const recording = new HistoryRecordingProvider();
    server.provider = recording;
    server.providerName = recording.name();
    server.model = recording.model;
    server.runManager = new RunManager(sessionDir);
    const sess = await getOrCreateSession(
      server,
      "recover-session",
      getWorkDir(server.cfg!),
    );
    const now = new Date();
    seedRunRow(sessionDir, {
      id: "recover-parent",
      sessionId: sess.id,
      workDir: sess.workDir,
      source: "responses_background",
      model: model.id,
      mode: "yolo",
      status: "failed",
    });
    const remote = {
      id: 0,
      sessionId: sess.id,
      localRunId: "recover-remote",
      localTurnId: "recover-parent",
      messageId: null,
      responseId: "resp-recover",
      provider: recording.name(),
      api: "openai-responses",
      state: "completed",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    saveResponseRun(sessionDir, remote);
    saveResponseItem(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localTurnId: "recover-parent",
      responseId: "resp-recover",
      itemId: "fc-recover",
      outputIndex: 0,
      itemType: "function_call",
      itemStatus: "completed",
      itemKey: "",
      sanitizedJson: {
        id: "fc-recover",
        type: "function_call",
        call_id: "call-recover",
        name: "write",
        arguments: '{"path":"recovered.txt"}',
      },
      createdAt: now,
    });
    const claimed = claimToolExecutionRecord(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localTurnId: "recover-parent",
      executionKey: "recover-tool",
      provider: "test",
      api: "openai-responses",
      responseId: "",
      providerCallId: "call-recover",
      toolKind: "function",
      toolName: "write",
      argsHash: "hash",
      executionState: "running",
      resultSummary: undefined,
      providerMetadata: undefined,
      sideEffecting: true,
      createdAt: now,
      completedAt: null,
    });
    assert(claimed.created, "save interrupted tool");
    server.responsesRuns = new RecoveryRunDriver(remote) as never;

    const response = await handleResponsesRunAPI(
      server,
      new Request(
        `http://localhost/api/responses/runs/recover-remote/recover?session_id=${sess.id}`,
        {
          method: "POST",
          body: '{"confirm":true,"toolCallIds":["call-recover"]}',
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const bodyText = await response.text();
    assertEquals(response.status, 202, bodyText);
    const body = JSON.parse(bodyText);
    assertEquals(body.recoveryRequested, 1);
    assertEquals(body.reattached, false);
    const newRunID = typeof body.runId === "string" ? body.runId : "";
    assert(
      newRunID !== "" && newRunID !== "recover-parent",
      `fresh recovery run ID = ${JSON.stringify(body.runId)}`,
    );
    const parent = getDurableRun(sessionDir, "recover-parent");
    assert(
      parent !== null && parent.status === "failed",
      `terminal parent was mutated: ${JSON.stringify(parent)}`,
    );
    const fresh = getDurableRun(sessionDir, newRunID);
    assert(
      fresh !== null && fresh.id !== parent!.id && fresh.retryOf === "",
      `fresh recovery run = ${JSON.stringify(fresh)}`,
    );
    await waitFor(() => recording.calls.length > 0);
    const messages = recording.calls[0].messages;
    assert(
      messages.length > 0,
      "AgentLoop request did not contain the recovery message",
    );
    const last = messageText(messages[messages.length - 1]);
    for (
      const want of [
        "terminal and must not be resumed",
        "call-recover",
        '{"path":"recovered.txt"}',
      ]
    ) {
      assert(
        last.includes(want),
        `recovery message missing ${JSON.stringify(want)}: ${last}`,
      );
    }
    let completed: string | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = getDurableRun(sessionDir, newRunID);
      if (current !== null && isTerminalSessionRunStatus(current.status)) {
        completed = current.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(
      completed,
      "completed",
      "fresh AgentLoop run did not complete",
    );

    let release: () => void = () => {};
    let locked = false;
    const inspectDeadline = Date.now() + 2000;
    while (Date.now() < inspectDeadline) {
      try {
        const guard = acquireMutation(sessionDir, sess.id);
        release = () => guard.release();
        locked = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert(
      locked,
      "could not acquire runtime lease to inspect recovery record",
    );
    let storedState = "";
    try {
      const inspect = claimToolExecutionRecord(sessionDir, {
        id: 0,
        sessionId: sess.id,
        localTurnId: "recover-parent",
        executionKey: "recover-tool",
        provider: "test",
        api: "openai-responses",
        responseId: "",
        providerCallId: "call-recover",
        toolKind: "function",
        toolName: "write",
        argsHash: "hash",
        executionState: "running",
        resultSummary: undefined,
        providerMetadata: undefined,
        sideEffecting: true,
        createdAt: now,
        completedAt: null,
      });
      storedState = inspect.record.executionState;
    } finally {
      release();
    }
    assertEquals(storedState, "retry_requested");

    // Repeating the same confirmed recovery reconciles to the new Run instead
    // of creating another attempt or touching the terminal parent.
    const repeat = await handleResponsesRunAPI(
      server,
      new Request(
        `http://localhost/api/responses/runs/recover-remote/recover?session_id=${sess.id}`,
        {
          method: "POST",
          body: '{"confirm":true,"toolCallIds":["call-recover"]}',
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const repeatText = await repeat.text();
    assertEquals(repeat.status, 202, repeatText);
    const repeatedBody = JSON.parse(repeatText);
    assertEquals(repeatedBody.runId, newRunID);
    assertEquals(repeatedBody.idempotent, true);
    void workDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesRunAPIReconnectReattachesDurableBackgroundRun", async () => {
  const { server, sessionDir, workDir, model } = newTestServer();
  try {
    installUpstream(server, (method, path) => {
      if (method === "GET" && path.endsWith("/responses/resp-reconnect")) {
        return new Response(
          JSON.stringify({ id: "resp-reconnect", status: "completed" }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    enableResponsesBackground(server);
    const sess = await getOrCreateSession(
      server,
      "reconnect-session",
      getWorkDir(server.cfg!),
    );
    const now = new Date();
    seedRunRow(sessionDir, {
      id: "reconnect-local",
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
      localRunId: "reconnect-remote",
      localTurnId: "reconnect-local",
      messageId: null,
      responseId: "resp-reconnect",
      provider: server.provider!.name(),
      api: server.provider!.api(),
      state: "completed",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    saveResponseTurn(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localTurnId: "reconnect-local",
      messageId: null,
      requestId: "",
      responseId: "resp-reconnect",
      previousResponseId: "",
      conversationId: "",
      provider: server.provider!.name(),
      api: server.provider!.api(),
      model: "background",
      stateMode: "replay",
      status: "completed",
      incompleteReason: "",
      requestSummary: undefined,
      responseSummary: { status: "completed" },
      createdAt: now,
      completedAt: null,
    });

    const response = await handleResponsesRunAPI(
      server,
      new Request(
        `http://localhost/api/responses/runs/reconnect-remote/reconnect?session_id=${sess.id}`,
        { method: "POST" },
      ),
    );
    const bodyText = await response.text();
    assertEquals(response.status, 202, bodyText);
    const body = JSON.parse(bodyText);
    assert(body.reattached, `reconnect body = ${bodyText}`);

    let status: string | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const local = getDurableRun(sessionDir, "reconnect-local");
      if (local !== null && local.status === "completed") {
        status = local.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(status, "completed", "reattached local run did not complete");
    void workDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesRunAPIReconnectRejectsSharedRuntimeConflict", async () => {
  const { server, sessionDir, workDir, model } = newTestServer();
  try {
    installUpstream(server, (method, path) => {
      if (method === "GET" && path.endsWith("/responses/resp-conflict")) {
        return new Response(
          JSON.stringify({ id: "resp-conflict", status: "in_progress" }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    enableResponsesBackground(server);
    const sess = await getOrCreateSession(
      server,
      "reconnect-conflict",
      getWorkDir(server.cfg!),
    );
    const now = new Date();
    seedRunRow(sessionDir, {
      id: "reconnect-conflict-local",
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
      localRunId: "reconnect-conflict-remote",
      localTurnId: "reconnect-conflict-local",
      messageId: null,
      responseId: "resp-conflict",
      provider: server.provider!.name(),
      api: server.provider!.api(),
      state: "running",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    const hold = acquireRecovery(
      sessionDir,
      sess.id,
      "reconnect-conflict-local",
    );
    const release = () => hold.release();
    try {
      const response = await handleResponsesRunAPI(
        server,
        new Request(
          `http://localhost/api/responses/runs/reconnect-conflict-remote/reconnect?session_id=${sess.id}`,
          { method: "POST" },
        ),
      );
      const body = await response.text();
      assertEquals(response.status, 409, body);
    } finally {
      release();
    }
    void workDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("responsesRunAPICancelRejectsSharedRuntimeConflict", async () => {
  const { server, sessionDir, workDir } = newTestServer();
  try {
    enableResponsesBackground(server);
    const sess = await getOrCreateSession(
      server,
      "cancel-conflict",
      getWorkDir(server.cfg!),
    );
    const now = new Date();
    saveResponseRun(sessionDir, {
      id: 0,
      sessionId: sess.id,
      localRunId: "cancel-remote",
      localTurnId: "cancel-local",
      messageId: null,
      responseId: "resp-cancel",
      provider: server.provider!.name(),
      api: server.provider!.api(),
      state: "in_progress",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    const hold = acquireMutation(sessionDir, sess.id);
    const release = () => hold.release();
    try {
      const response = await handleResponsesRunAPI(
        server,
        new Request(
          `http://localhost/api/responses/runs/cancel-remote/cancel?session_id=${sess.id}`,
          { method: "POST" },
        ),
      );
      const body = await response.text();
      assertEquals(
        response.status,
        409,
        `cancel status = ${response.status}, body = ${body}`,
      );
      assert(body.includes('"code":"session_reserved"'), body);
    } finally {
      release();
    }
    void workDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});
