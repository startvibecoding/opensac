// Translated from internal/serve/openaiapi/handler_run_submit_test.go — the
// submit-half cluster that does not depend on the not-yet-ported command,
// SkillHub, or Responses-background collaborators. The pure/persistence tests
// (admission-error snapshot, policy snapshot, ingress event IDs, tool options)
// run directly; the end-to-end submit tests use a scripted provider through
// the real SessionRuntime and wait for the background task's terminal state
// before asserting. The agent-construction retry families
// (TestRetryRun*) land with the run API slice that injects the retry context.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { ChatParams, Model, StreamEvent } from "../../provider/types.ts";
import {
  newAssistantMessage,
  newUserMessage,
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import type { Config } from "./config.ts";
import { getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { listSessionRunEvents } from "../../session/session_events.ts";
import { idempotencyKeyFingerprint } from "./events.ts";
import {
  executionAdmissionError,
  extractSessionIDFromPath,
  handleSubmitRun,
  marshalRunPolicySnapshot,
  sessionToolOptionsFromNames,
  setSubmitIngressEventID,
} from "./handler_run_submit.ts";
import type { InputIngress } from "../../agentruntime/input_materializer.ts";
import { getSessionCapabilities } from "./session_read.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function newSubmitServer(
  opts: { sessionDir: string; workDir: string },
): Server {
  const server = new Server({
    settings: { sessionDir: opts.sessionDir } as never,
    cfg: {
      defaultMode: "yolo",
      defaultWorkDir: opts.workDir,
      requestTimeoutSecs: 30,
    } as Config,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  return server;
}

function submitRequest(
  sessionID: string,
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/api/sessions/${sessionID}/runs`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
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

// ---------------------------------------------------------------------------
// Pure/persistence helpers
// ---------------------------------------------------------------------------

Deno.test("executionAdmissionErrorUsesCanonicalSnapshot", async () => {
  const { server, sessionDir, workDir } = await newHistoryServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "orphan-admission-session",
      workDir,
    );
    const now = new Date();
    // Canonical RunStore creation (the test-hygiene guard forbids direct
    // session-row writes in adapter tests).
    new RunStore(sessionDir).create({
      id: "orphan-run",
      sessionId: sess.id,
      intentId: "",
      retryOf: "",
      attempt: 1,
      workDir: sess.workDir,
      source: "webui",
      model: "m1",
      mode: "yolo",
      status: "running",
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
      conversationTurnId: "turn-orphan-run",
      conversationTurn: false,
    });
    const { status, info } = executionAdmissionError(
      server,
      sess.id,
      new Error("session recovery required"),
    );
    assertEquals(status, 409);
    assertEquals(info.code, "session_recovery_in_progress");
    assertEquals(info.runId, "orphan-run");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("marshalRunPolicySnapshotIncludesProviderSelection", () => {
  const snapshot = marshalRunPolicySnapshot(
    undefined,
    undefined,
    {
      message: "hello",
      provider: "anthropic",
      model: "claude-sonnet",
      mode: "",
      transcript: false,
      workDir: "",
    },
    "webui",
    "yolo",
  );
  const decoded = JSON.parse(snapshot) as Record<string, unknown>;
  assertEquals(decoded.provider, "anthropic");
  assertEquals(decoded.source, "webui");
  assertEquals(decoded.mode, "yolo");
});

Deno.test("setSubmitIngressEventIDUsesStableRequestKey", () => {
  const ingresses: InputIngress[] = [
    ingressWithIndex(9),
    ingressWithIndex(8),
  ];
  setSubmitIngressEventID(ingresses, "client-key");
  ingresses.forEach((ingress, index) => {
    assertEquals(ingress.eventId, "webui-submit:client-key");
    assertEquals(ingress.itemIndex, index);
  });
  setSubmitIngressEventID(ingresses, "");
  assertEquals(ingresses[0].eventId, "webui-submit:client-key");
});

function ingressWithIndex(itemIndex: number): InputIngress {
  return {
    origin: "webui",
    eventId: "",
    itemIndex,
    reference: "webui-upload",
    kind: "image",
    filenameHint: "image",
    mediaTypeHint: "image/png",
    sizeHint: 0,
    open: () => ({}),
  };
}

Deno.test("sessionToolOptionsFromNamesDoesNotOverrideHostedTools", () => {
  const options = sessionToolOptionsFromNames(["webSearch", "browser"]);
  assert(options);
  assertEquals(options.webSearch, undefined);
  assertEquals(options.browser, true);
  assertEquals(options.multiAgent, false);
  assertThrows(() => sessionToolOptionsFromNames(["bogusTool"]));
});

function assertThrows(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw);
}

// ---------------------------------------------------------------------------
// handleSubmitRun validation table (no session creation)
// ---------------------------------------------------------------------------

Deno.test("submitRunValidationTable", async () => {
  const server = new Server({
    cfg: { defaultMode: "yolo" } as Config,
  });
  server.pool = new SessionPool(0, 0);

  // Wrong method writes the bare status code.
  const methodResponse = await handleSubmitRun(
    server,
    new Request("http://localhost/api/sessions/s1/runs", { method: "GET" }),
  );
  assertEquals(methodResponse.status, 405);

  // Missing session ID.
  const missingID = await handleSubmitRun(
    server,
    new Request("http://localhost/api/sessions//runs", {
      method: "POST",
      body: "{}",
    }),
  );
  assertEquals(missingID.status, 400);
  const missingBody = await missingID.json();
  assertEquals(missingBody.error.code, "session_id_required");
  assertEquals(missingBody.error.messageKey, "run.error.sessionIDRequired");

  // Idempotency key too long.
  const longKey = await handleSubmitRun(
    server,
    submitRequest("s1", `{"message":"hi"}`, {
      "Idempotency-Key": "k".repeat(257),
    }),
  );
  assertEquals(longKey.status, 400);
  assertEquals((await longKey.json()).error.code, "idempotency_key_too_long");

  // Malformed JSON is projected through the shared safe error contract.
  const malformed = await handleSubmitRun(
    server,
    submitRequest("safe-error-submit", `{"message":"unterminated"`),
  );
  assertEquals(malformed.status, 400);
  const malformedBody = await malformed.json();
  assertEquals(malformedBody.error.code, "invalid_json");
  assertEquals(malformedBody.error.type, "invalid_request_error");
  assertEquals(malformedBody.error.messageKey, "run.error.invalidJSON");
  assertEquals(
    malformedBody.error.message,
    "The request body is not valid JSON.",
  );
  assert(!malformedBody.error.message.includes("unexpected"));

  // Empty message (no images/attachments) is rejected.
  const empty = await handleSubmitRun(
    server,
    submitRequest("s1", `{"message":"  "}`),
  );
  assertEquals(empty.status, 400);
  assertEquals((await empty.json()).error.code, "message_required");

  // A client-chosen workDir outside the allowed set is rejected.
  const allowed = tempDir("openaiapi-submit-allowed-");
  const outside = tempDir("openaiapi-submit-outside-");
  const restricted = new Server({
    cfg: {
      defaultMode: "yolo",
      defaultWorkDir: allowed,
      allowedWorkDirs: [allowed],
    } as Config,
  });
  restricted.pool = new SessionPool(0, 0);
  const denied = await handleSubmitRun(
    restricted,
    submitRequest(
      "client-created-disallowed-workdir",
      JSON.stringify({ message: "workdir test", workDir: outside }),
    ),
  );
  assertEquals(denied.status, 403);
  assertEquals((await denied.json()).error.code, "workdir_not_allowed");
});

// ---------------------------------------------------------------------------
// End-to-end submit path (scripted provider through the real SessionRuntime)
// ---------------------------------------------------------------------------

function newHistoryServer(): {
  server: Server;
  provider: HistoryRecordingProvider;
  sessionDir: string;
  workDir: string;
} {
  const sessionDir = tempDir("openaiapi-submit-sess-");
  const workDir = tempDir("openaiapi-submit-work-");
  const server = newSubmitServer({ sessionDir, workDir });
  const provider = new HistoryRecordingProvider();
  server.provider = provider;
  server.model = provider.model;
  server.providerName = "history-recording";
  return { server, provider, sessionDir, workDir };
}

async function waitForRunDone(sess: {
  isRunning(): boolean;
}): Promise<void> {
  await waitFor(() => !sess.isRunning());
}

Deno.test("submitRunReplaysSessionHistory", async () => {
  const { server, provider, workDir } = await newHistoryServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "run-history-session",
      getWorkDir(server.cfg!),
    );
    sess.manager!.appendMessage(newUserMessage("之前的问题"));
    sess.manager!.appendMessage(
      newAssistantMessage([{ type: "text", text: "之前的回答" }]),
    );
    // Reset the replay cache so the appended history is loaded by the run.
    server.pool?.put(sess);

    const response = await handleSubmitRun(
      server,
      submitRequest(
        "run-history-session",
        `{"message":"接着聊","transcript":true}`,
      ),
    );
    assertEquals(response.status, 202);
    const body = await response.json();
    assertEquals(body.status, "queued");
    assert(body.runId !== "");

    await waitForRunDone(sess);
    await waitFor(() => provider.calls.length > 0);
    const messages = provider.calls[0].messages;
    // The provider sees the persisted history plus the new user turn; the
    // agent may prepend a system-injected session context message.
    const texts = messages.map((m) =>
      (m.contents ?? []).filter((b) => b.type === "text").map((b) =>
        (b as { text?: string }).text ?? ""
      ).join("") || m.content || ""
    );
    assert(texts.some((t) => t!.includes("之前的问题")));
    assert(texts.some((t) => t!.includes("之前的回答")));
    const last = messages[messages.length - 1];
    assertEquals(last.role, "user");
    const lastText = (last.contents ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("") || last.content;
    assertEquals(lastText, "接着聊");
    void workDir;
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunIdempotencyKeyReturnsExistingRun", async () => {
  const { server, provider } = await newHistoryServer();
  try {
    const first = await handleSubmitRun(
      server,
      submitRequest("idempotent-submit-session", `{"message":"run once"}`, {
        "Idempotency-Key": "retry-key-1",
      }),
    );
    assertEquals(first.status, 202);
    const firstBody = await first.json();

    const second = await handleSubmitRun(
      server,
      submitRequest("idempotent-submit-session", `{"message":"run once"}`, {
        "Idempotency-Key": "retry-key-1",
      }),
    );
    assertEquals(second.status, 202);
    const secondBody = await second.json();
    assertEquals(secondBody.idempotent, true);
    assertEquals(secondBody.runId, firstBody.runId);
    assertEquals(secondBody.intentId, firstBody.intentId);

    await waitForRunDone(server.pool!.get("idempotent-submit-session")!);
    assert(provider.calls.length <= 1);
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunIdempotencyKeyRejectsDifferentRequest", async () => {
  const { server } = await newHistoryServer();
  try {
    const first = await handleSubmitRun(
      server,
      submitRequest(
        "idempotent-submit-conflict-session",
        `{"message":"run once"}`,
        {
          "Idempotency-Key": "retry-key-conflict",
        },
      ),
    );
    assertEquals(first.status, 202);

    const second = await handleSubmitRun(
      server,
      submitRequest(
        "idempotent-submit-conflict-session",
        `{"message":"different request"}`,
        { "Idempotency-Key": "retry-key-conflict" },
      ),
    );
    assertEquals(second.status, 409);
    const body = await second.json();
    assertStringIncludes(JSON.stringify(body), "idempotency");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunAppliesToolOptionsAndMode", async () => {
  const { server, provider } = await newHistoryServer();
  try {
    const response = await handleSubmitRun(
      server,
      submitRequest(
        "run-tools-session",
        `{"message":"hi","mode":"plan","tools":["webSearch"],"transcript":true}`,
      ),
    );
    assertEquals(response.status, 202);
    const sess = server.pool!.get("run-tools-session")!;
    await waitForRunDone(sess);
    await waitFor(() => provider.calls.length > 0);

    const caps = getSessionCapabilities(server, "run-tools-session");
    assertEquals(caps.mode, "plan");
    // Hosted configuration is preserved independently of the local tool list.
    assertEquals(caps.webSearch, false);
    assertEquals(caps.browser, false);
    assertEquals(caps.multiAgent, false);

    // Unknown tool names are rejected.
    const bogus = await handleSubmitRun(
      server,
      submitRequest(
        "run-tools-bogus",
        `{"message":"hi","tools":["bogusTool"]}`,
      ),
    );
    assertEquals(bogus.status, 400);
    assertEquals((await bogus.json()).error.code, "invalid_tool_option");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("submitRunPersistsDurableRunAndSafeStartEvent", async () => {
  const { server, sessionDir } = await newHistoryServer();
  try {
    const response = await handleSubmitRun(
      server,
      submitRequest("run-durable-session", `{"message":"run once"}`, {
        "Idempotency-Key": "durable-key",
      }),
    );
    assertEquals(response.status, 202);
    const body = await response.json();
    const sess = server.pool!.get("run-durable-session")!;
    await waitForRunDone(sess);

    const run = getDurableRun(sessionDir, body.runId);
    assert(run);
    assertEquals(run.sessionId, "run-durable-session");
    assertEquals(run.intentId, body.intentId);
    assertEquals(run.attempt, 1);
    assert(
      !["", "queued", "running"].includes(run.status),
      `run should be terminal, got ${run.status}`,
    );
    // The plaintext key never crosses into durable state; the started event
    // carries only its fingerprint (Go's TestRetryRun* assert the same).
    const events = listSessionRunEvents(sessionDir, "run-durable-session");
    const started = events.find((e) =>
      e.runId === body.runId && e.eventType === "started"
    );
    assert(started);
    const data = (typeof started.data === "string"
      ? JSON.parse(started.data)
      : started.data) as Record<string, unknown>;
    assertEquals(data["idempotencyKey"], undefined);
    assertEquals(
      data["idempotencyKeyHash"],
      idempotencyKeyFingerprint("durable-key"),
    );
    assertEquals(data["idempotencyScope"], "submit");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("extractSessionIDFromPathTable", () => {
  assertEquals(
    extractSessionIDFromPath("/api/sessions/abc/runs", "/runs"),
    "abc",
  );
  assertEquals(
    extractSessionIDFromPath("/api/sessions/abc/stop", "/runs"),
    "",
  );
  assertEquals(extractSessionIDFromPath("/other/runs", "/runs"), "");
});
