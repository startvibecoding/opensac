// Translated from internal/serve/openaiapi/server_test.go and pure_chat_test.go
// — the handler_chat HTTP half: the response helpers, the direct
// streaming/non-streaming event projections, the broker-mediated projections,
// and the handleChatCompletions validation table. The agent-construction-heavy
// run paths are covered by run_executor_test.ts per the test-hygiene guard, so
// the direct projections use the stub/null-agent pattern (the replayed events
// never reach the approval/question registration paths).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { EventChannel } from "../../agent/event_channel.ts";
import {
  type Event,
  EventDone,
  EventError,
  EventRunFinished,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
  EventUsage,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../../agent/events.ts";
import { Server } from "./server.ts";
import { APISession } from "./session_mgr.ts";
import { EventBroker } from "./event_broker.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import type { Config } from "./config.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import {
  cloneModel,
  handleChatCompletions,
  handleNonStreamingResponseWithAgent,
  handleNonStreamingViaBroker,
  handleStreamingResponseWithAgent,
  handleStreamingViaBroker,
  safeRunResultMessage,
  writeCommandResponse,
  writeCommandResponseStreaming,
} from "./handler_chat.ts";
import { newRunExecutor, type RunResult } from "./run_executor.ts";
import type { SSEWriterSink } from "./streaming.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function minimalServer(cfg?: Partial<Config>): Server {
  const server = new Server({
    cfg: {
      defaultMode: "yolo",
      toolVisibility: { mode: "content" },
      ...cfg,
    } as Config,
  });
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  return server;
}

function newSession(id = "sess-1"): APISession {
  const sess = new APISession();
  sess.id = id;
  sess.workDir = "/tmp/test";
  return sess;
}

function channelOf(events: Event[]): EventChannel {
  const ch = new EventChannel();
  for (const ev of events) ch.push(ev);
  ch.close();
  return ch;
}

function run(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "/tmp/test",
    source: "",
    model: "",
    mode: "",
    status: "running",
    startedAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: null,
    progress: null,
    usage: null,
    contextUsage: null,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
  };
}

function stringSink(): { sink: SSEWriterSink; frames: () => string } {
  const chunks: string[] = [];
  return {
    sink: { write: (chunk) => chunks.push(chunk) },
    frames: () => chunks.join(""),
  };
}

const baseModel: Model = {
  id: "m1",
  name: "Model One",
  provider: "test",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  temperature: 0.4,
  topP: 0.9,
  compat: { thinkingFormat: "native" },
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

Deno.test("cloneModelCopiesInputAndCompat", () => {
  const copy = cloneModel(baseModel);
  assert(copy);
  assert(copy !== baseModel);
  assert(copy.input !== baseModel.input);
  assert(copy.compat !== baseModel.compat);
  assertEquals(copy.input, baseModel.input);
  assertEquals(copy.compat, baseModel.compat);
  // Mutating the copies must not affect the original.
  copy.input.push("audio");
  copy.compat!.thinkingFormat = "collapsed";
  assertEquals(baseModel.input, ["text", "image"]);
  assertEquals(baseModel.compat!.thinkingFormat, "native");
  assertEquals(cloneModel(undefined), undefined);
});

Deno.test("safeRunResultMessageProjectsSafeMessages", () => {
  assertEquals(safeRunResultMessage(null), "The run could not be completed.");
  // Structured error info wins when present.
  const withInfo = {
    status: "failed",
    error: "",
    errorInfo: { message: "Safe display message." },
  } as unknown as RunResult;
  assertEquals(safeRunResultMessage(withInfo), "Safe display message.");
  // Cancel runs distinguish timeout wording.
  const timeout = { status: "canceled", error: "context deadline exceeded" };
  assertEquals(
    safeRunResultMessage(timeout as unknown as RunResult),
    "The run timed out.",
  );
  const canceled = { status: "canceled", error: "canceled" };
  assertEquals(
    safeRunResultMessage(canceled as unknown as RunResult),
    "The run was cancelled.",
  );
});

Deno.test("writeCommandResponseAndStreaming", async () => {
  const server = minimalServer();
  const resp = writeCommandResponse(
    server,
    { message: "cleared", error: false },
    "m1",
    "s1",
    "/clear",
  );
  assertEquals(resp.status, 200);
  const body = JSON.parse(await resp.text());
  assertEquals(body.object, "chat.completion");
  assertEquals(body.choices[0].message.content, "cleared");
  assertEquals(body.choices[0].finish_reason, "stop");
  assertEquals(body.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });

  const { sink, frames } = stringSink();
  writeCommandResponseStreaming(
    server,
    sink,
    { message: "cleared", error: false },
    "m1",
    "s1",
    "/clear",
    true,
  );
  assertStringIncludes(frames(), "cleared");
  assertStringIncludes(frames(), '"finish_reason":"stop"');
});

// ---------------------------------------------------------------------------
// Direct streaming projection (handleStreamingResponseWithAgent)
// ---------------------------------------------------------------------------

Deno.test("streamingResponseWithAgentMapsTerminalStatuses", async () => {
  const server = minimalServer();
  const sess = newSession();

  // Success with truncation stop reason → finish_reason length, incomplete.
  {
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      server,
      sink,
      undefined,
      channelOf([
        { type: EventTextDelta, textDelta: "partial" },
        {
          type: EventRunFinished,
          status: TaskIncomplete,
          stopReason: "max_tokens",
          attachments: [],
        },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "incomplete");
    assertStringIncludes(frames(), '"finish_reason":"length"');
  }

  // Success → stop, completed.
  {
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      server,
      sink,
      undefined,
      channelOf([
        { type: EventTextDelta, textDelta: "hi" },
        { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "completed");
    assertStringIncludes(frames(), '"finish_reason":"stop"');
  }

  // Canceled → done chunk with canceled status.
  {
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      server,
      sink,
      undefined,
      channelOf([
        { type: EventRunFinished, status: TaskCanceled, error: undefined },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "canceled");
    assertStringIncludes(frames(), '"finish_reason":"stop"');
  }

  // Failed → error frame with safe message.
  {
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      server,
      sink,
      undefined,
      channelOf([
        {
          type: EventRunFinished,
          status: TaskFailed,
          error: new Error("boom"),
        },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "failed");
    assertStringIncludes(frames(), '"error"');
  }

  // AbortError event error → canceled.
  {
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      server,
      sink,
      undefined,
      channelOf([
        { type: EventError, error: new DOMException("aborted", "AbortError") },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "canceled");
    assertStringIncludes(frames(), '"finish_reason":"stop"');
  }

  // Stream closed without terminal → protocol failure.
  {
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      server,
      sink,
      undefined,
      channelOf([]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "failed");
    assertEquals(
      outcome.errMsg,
      "event stream closed without terminal result",
    );
    assertStringIncludes(
      frames(),
      "event stream closed without terminal result",
    );
  }
});

Deno.test("streamingResponseWithAgentSkipsSubAgentTerminalsAndPublishesUsage", async () => {
  const server = minimalServer();
  const sess = newSession("sess-sub");
  const { sink, frames } = stringSink();
  const outcome = await handleStreamingResponseWithAgent(
    server,
    sink,
    undefined,
    channelOf([
      { type: EventTextDelta, agentId: "agent-2", textDelta: "member" },
      {
        type: EventRunFinished,
        agentId: "agent-2",
        status: TaskSuccess,
      },
      { type: EventDone, agentId: "agent-2" },
      { type: EventError, agentId: "agent-2", error: new Error("member") },
      {
        type: EventUsage,
        usage: { input: 12, output: 7, cacheRead: 3, cacheWrite: 4 },
      } as unknown as Event,
      { type: EventTextDelta, textDelta: "lead" },
      { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
    ]),
    "m1",
    sess,
    null,
    false,
  );
  assertEquals(outcome.status, "completed");
  // Sub-agent deltas are suppressed for the lead stream; lead delta survives.
  assertStringIncludes(frames(), "lead");
  assert(!frames().includes("member"));
  // Go's Usage.TotalInputTokens() includes cache read+write (12+3+4).
  assertEquals(outcome.usage.prompt_tokens, 19);
  assertEquals(outcome.usage.completion_tokens, 7);
  assertEquals(outcome.usage.cache_read_tokens, 3);
  assertEquals(outcome.usage.total_tokens, 26);
});

Deno.test("streamingResponseWithAgentToolLifecycleInContentAndSSEEventModes", async () => {
  // content mode renders the running line and the expanded result.
  const contentServer = minimalServer({
    toolVisibility: { mode: "content", detail: "expanded" },
  } as Partial<Config>);
  {
    const sess = newSession("sess-tools");
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      contentServer,
      sink,
      undefined,
      channelOf([
        {
          type: EventToolCall,
          toolName: "read",
          toolCallId: "call-1",
          toolArgs: { path: "/tmp/x" },
        },
        {
          type: EventToolExecutionEnd,
          toolName: "read",
          toolCallId: "call-1",
          toolResult: "file contents",
        },
        { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "completed");
    const out = frames();
    assertStringIncludes(out, "⏳ read");
    assertStringIncludes(out, "file contents");
  }

  // sse_event mode emits tool_status frames instead of content.
  const sseServer = minimalServer({
    toolVisibility: { mode: "sse_event", detail: "collapsed" },
  } as Partial<Config>);
  {
    const sess = newSession("sess-tools-sse");
    const { sink, frames } = stringSink();
    const outcome = await handleStreamingResponseWithAgent(
      sseServer,
      sink,
      undefined,
      channelOf([
        {
          type: EventToolCall,
          toolName: "read",
          toolCallId: "call-1",
          toolArgs: { path: "/tmp/x" },
        },
        {
          type: EventToolExecutionEnd,
          toolName: "read",
          toolCallId: "call-1",
          toolResult: "file contents",
          toolError: new Error("nope"),
        },
        { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
      ]),
      "m1",
      sess,
      null,
      false,
    );
    assertEquals(outcome.status, "completed");
    const out = frames();
    assertStringIncludes(out, "event: tool_status");
    assertStringIncludes(out, '"status":"running"');
    assertStringIncludes(out, '"status":"failed"');
    assert(!out.includes("⏳ read"));
  }
});

// ---------------------------------------------------------------------------
// Direct non-streaming projection (handleNonStreamingResponseWithAgent)
// ---------------------------------------------------------------------------

Deno.test("nonStreamingResponseWithAgentBuildsCompletion", async () => {
  const server = minimalServer();
  const sess = newSession();
  const outcome = await handleNonStreamingResponseWithAgent(
    server,
    channelOf([
      { type: EventTextDelta, textDelta: "he" },
      { type: EventTextDelta, textDelta: "llo" },
      { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
      { type: EventDone, stopReason: "stop" },
    ]),
    "m1",
    sess,
    null,
  );
  assertEquals(outcome.status, "completed");
  assert(outcome.response);
  const body = JSON.parse(await outcome.response.text());
  assertEquals(body.choices[0].message.content, "hello");
  assertEquals(body.choices[0].finish_reason, "stop");
});

Deno.test("nonStreamingResponseWithAgentFailurePaths", async () => {
  const server = minimalServer();
  const sess = newSession();

  // Failed run → 500 JSON.
  {
    const outcome = await handleNonStreamingResponseWithAgent(
      server,
      channelOf([
        { type: EventRunFinished, status: TaskFailed, error: new Error("x") },
      ]),
      "m1",
      sess,
      null,
    );
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.response?.status, 500);
  }

  // Error event without payload → protocol violation.
  {
    const outcome = await handleNonStreamingResponseWithAgent(
      server,
      channelOf([{ type: EventError }]),
      "m1",
      sess,
      null,
    );
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.errMsg, "error event without error detail");
  }

  // Stream closed without terminal → protocol failure.
  {
    const outcome = await handleNonStreamingResponseWithAgent(
      server,
      channelOf([]),
      "m1",
      sess,
      null,
    );
    assertEquals(outcome.status, "failed");
    assertEquals(
      outcome.errMsg,
      "event stream closed without terminal result",
    );
  }

  // Cancel event returns canceled with no response written (legacy path).
  {
    const outcome = await handleNonStreamingResponseWithAgent(
      server,
      channelOf([
        {
          type: EventError,
          error: new DOMException("canceled", "AbortError"),
        },
      ]),
      "m1",
      sess,
      null,
    );
    assertEquals(outcome.status, "canceled");
    assertEquals(outcome.response, null);
  }
});

// ---------------------------------------------------------------------------
// Broker-mediated projections
// ---------------------------------------------------------------------------

Deno.test("handleNonStreamingViaBrokerAccumulatesContentAndReturnsJSON", async () => {
  const server = minimalServer();
  const sess = newSession("sess-broker");
  const executor = newRunExecutor(
    server,
    server.eventBroker,
    run("run-b1", sess.id),
  );
  const rawEventCh = channelOf([
    { type: EventTextDelta, textDelta: "bo" },
    { type: EventTextDelta, textDelta: "njour" },
    { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
  ]);
  const outcome = await handleNonStreamingViaBroker(
    server,
    sess,
    "run-b1",
    "m1",
    executor,
    null,
    rawEventCh,
  );
  assertEquals(outcome.status, "completed");
  assert(outcome.response);
  const body = JSON.parse(await outcome.response.text());
  assertEquals(body.choices[0].message.content, "bonjour");
  assertEquals(body.choices[0].finish_reason, "stop");
});

Deno.test("handleStreamingViaBrokerConvertsBrokerEventsToSSE", async () => {
  const server = minimalServer();
  const sess = newSession("sess-sse");
  const executor = newRunExecutor(
    server,
    server.eventBroker,
    run("run-s1", sess.id),
  );
  const rawEventCh = channelOf([
    { type: EventTextDelta, textDelta: "stream" },
    {
      type: EventToolCall,
      toolName: "read",
      toolCallId: "call-9",
      toolArgs: { path: "/tmp/x" },
    },
    {
      type: EventToolExecutionEnd,
      toolName: "read",
      toolCallId: "call-9",
      toolResult: "file contents",
    },
    { type: EventRunFinished, status: TaskSuccess, stopReason: "stop" },
  ]);
  const { sink, frames } = stringSink();
  const outcome = await handleStreamingViaBroker(
    server,
    sink,
    sess,
    "run-s1",
    "m1",
    executor,
    null,
    rawEventCh,
    false,
  );
  assertEquals(outcome.status, "completed");
  const out = frames();
  assertStringIncludes(out, '"role":"assistant"');
  assertStringIncludes(out, "stream");
  assertStringIncludes(out, "⏳ read");
  assertStringIncludes(out, '"finish_reason":"stop"');
});

// ---------------------------------------------------------------------------
// handleChatCompletions validation table
// ---------------------------------------------------------------------------

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("handleChatCompletionsValidationTable", async () => {
  const server = minimalServer();

  // Wrong method.
  const methodResp = await handleChatCompletions(
    server,
    new Request("http://localhost/v1/chat/completions", { method: "GET" }),
  );
  assertEquals(methodResp.status, 405);

  // Invalid JSON.
  const badResp = await handleChatCompletions(
    server,
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: "{not json",
    }),
  );
  assertEquals(badResp.status, 400);
  assertStringIncludes(await badResp.text(), "invalid JSON");

  // Unsupported x_ extension field.
  const extResp = await handleChatCompletions(
    server,
    chatRequest({ messages: [], x_custom: 1 }),
  );
  assertEquals(extResp.status, 400);
  assertStringIncludes(await extResp.text(), "unsupported extension field");

  // Empty messages.
  const emptyResp = await handleChatCompletions(
    server,
    chatRequest({ messages: [] }),
  );
  assertEquals(emptyResp.status, 400);
  assertStringIncludes(
    await emptyResp.text(),
    "messages array is required",
  );
});

Deno.test("handleChatCompletionsModelResolutionAndBackgroundGuards", async () => {
  const workDir = tempDir("openaiapi-chat-work-");
  try {
    // Model not found (provider has no such model).
    const noModelServer = minimalServer({ defaultWorkDir: workDir });
    noModelServer.model = baseModel;
    noModelServer.provider = {
      getModel: () => undefined,
      models: () => [],
    } as unknown as Provider;
    const resp = await handleChatCompletions(
      noModelServer,
      chatRequest({
        model: "nope",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assertEquals(resp.status, 400);
    assertStringIncludes(await resp.text(), "not found");

    // No user message found.
    const server = minimalServer({ defaultWorkDir: workDir });
    server.model = baseModel;
    server.provider = {
      getModel: () => baseModel,
      models: () => [baseModel],
    } as unknown as Provider;
    const noUserResp = await handleChatCompletions(
      server,
      chatRequest({ messages: [{ role: "assistant", content: "hi" }] }),
    );
    assertEquals(noUserResp.status, 400);
    assertStringIncludes(await noUserResp.text(), "no user message found");

    // x_background + stream → 400.
    const bgStreamResp = await handleChatCompletions(
      server,
      chatRequest({
        x_background: true,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assertEquals(bgStreamResp.status, 400);
    assertStringIncludes(await bgStreamResp.text(), "x_background");

    // x_background without a Responses background runtime → 501.
    const bgResp = await handleChatCompletions(
      server,
      chatRequest({
        x_background: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assertEquals(bgResp.status, 501);
    assertStringIncludes(await bgResp.text(), "background runtime");
  } finally {
    closeAll();
  }
});
