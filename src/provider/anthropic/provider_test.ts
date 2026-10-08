//
// Deviation: the Go tests inject a custom http.RoundTripper via `p.client`.
// This port injects a fake `HttpClient` and builds plain Response-like objects
// (the provider only reads `status`, `body`, and `text()`).

import { assert, assertEquals } from "@opensac/assert";
import type { HttpClient } from "../http_client.ts";
import {
  cacheInfo,
  type ChatParams,
  type ContentBlock,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type Model,
  type ModelPricing,
  streamDone,
  streamError,
  type StreamEvent,
  streamRetry,
  streamTextDelta,
  streamToolCall,
  streamUsage,
  thinkingHigh,
  thinkingMedium,
  thinkingXHigh,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "../types.ts";
import {
  createAnthropicProvider,
  createAnthropicProviderWithHTTPClient,
  mergeToolCallInput,
  type Provider,
} from "./provider.ts";
import { resolveAnthropicModels } from "./register.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

const emptyCost: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function m(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "anthropic",
    reasoning: false,
    input: ["text"],
    cost: emptyCost,
    contextWindow: 0,
    maxTokens: 0,
    ...extra,
  };
}

function boolPtr(v: boolean): boolean {
  return v;
}

function fakeResponse(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  text = "",
): Response {
  return {
    status,
    body,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function sseBody(text: string, err?: Error): ReadableStream<Uint8Array> {
  // The idle-timeout wrapper reads its source eagerly, so a synchronous
  // controller.error() would discard the queued chunk. Real transport errors
  // arrive after prior bytes are delivered, so a delayed error models that.
  const encoder = new TextEncoder();
  let stage = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        stage = 1;
        if (text.length > 0) controller.enqueue(encoder.encode(text));
        return;
      }
      if (stage === 1) {
        stage = 2;
        if (err !== undefined) {
          setTimeout(() => controller.error(err), 1);
        } else {
          controller.close();
        }
      }
    },
  });
}

interface CapturedRequest {
  headers: Headers;
  body: string;
}

function createMockAnthropicProvider(
  models: Model[],
  sse: string,
  bodies?: CapturedRequest[],
  check?: (req: CapturedRequest) => void,
): Provider {
  const client: HttpClient = {
    fetch(_input, init) {
      const headers = init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      const captured: CapturedRequest = { headers, body };
      if (check !== undefined) check(captured);
      if (bodies !== undefined) bodies.push(captured);
      return Promise.resolve(fakeResponse(200, sseBody(sse)));
    },
    close() {},
  };
  return createAnthropicProviderWithHTTPClient(
    "fake-key",
    "https://api.anthropic.com",
    models,
    client,
  );
}

async function chatAndCollect(
  p: Provider,
  params: ChatParams,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of p.chat(params)) events.push(e);
  return events;
}

function mustUsage(events: StreamEvent[]): Usage {
  for (const e of events) {
    if (e.type === streamUsage && e.usage !== undefined) return e.usage;
  }
  throw new Error("no STREAM_USAGE event received");
}

async function captureBody(
  p: Provider,
  params: ChatParams,
  bodies: CapturedRequest[],
): Promise<Record<string, unknown>> {
  await chatAndCollect(p, params);
  if (bodies.length === 0) throw new Error("no request body captured");
  return JSON.parse(bodies[0].body) as Record<string, unknown>;
}

const abortParams = (): ChatParams => ({
  messages: [createUserMessage("hi")],
  systemPrompt: "",
  thinkingLevel: "off",
  maxTokens: 0,
  modelId: "",
  abort: new AbortController().signal,
});

// ─── retry / transport ───────────────────────────────────────────────────────

Deno.test("AnthropicRetriesEarlyStreamReadError", async () => {
  const streamErr = new Error(
    "stream error: stream ID 19; INTERNAL_ERROR; received from peer",
  );
  let attempts = 0;
  const p = createAnthropicProvider("fake-key", "https://api.anthropic.com", [
    m("mock"),
  ]);
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = {
    fetch() {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(fakeResponse(200, sseBody("", streamErr)));
      }
      return Promise.resolve(
        fakeResponse(200, sseBody('data: {"type":"message_stop"}\n')),
      );
    },
    close() {},
  };

  const events = await chatAndCollect(p, {
    ...abortParams(),
    messages: [createUserMessage("hi")],
  });
  assertEquals(attempts, 2);
  let retryEvent: StreamEvent | undefined;
  let sawDone = false;
  for (const e of events) {
    if (e.type === streamRetry) retryEvent = e;
    if (e.type === streamDone) sawDone = true;
    if (e.type === streamError) {
      throw new Error(`unexpected STREAM_ERROR: ${e.error}`);
    }
  }
  assert(retryEvent !== undefined && sawDone);
  assertEquals(retryEvent!.retryAttempt, 1);
  assertEquals(retryEvent!.retryMaxAttempts, 1);
  assertEquals(retryEvent!.retryMax, 1);
  assertEquals(retryEvent!.retryAfterMs, 1);
});

Deno.test("AnthropicDoesNotRetryStreamReadErrorAfterVisibleOutput", async () => {
  const streamErr = new Error(
    "stream error: stream ID 19; INTERNAL_ERROR; received from peer",
  );
  let attempts = 0;
  const p = createAnthropicProvider("fake-key", "https://api.anthropic.com", [
    m("mock"),
  ]);
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = {
    fetch() {
      attempts++;
      return Promise.resolve(fakeResponse(
        200,
        sseBody(
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n',
          streamErr,
        ),
      ));
    },
    close() {},
  };

  const events = await chatAndCollect(p, {
    ...abortParams(),
    messages: [createUserMessage("hi")],
  });
  assertEquals(attempts, 1);
  let sawText = false;
  let sawError = false;
  for (const e of events) {
    if (e.type === streamTextDelta) sawText = e.textDelta === "hello";
    if (e.type === streamRetry) throw new Error("unexpected StreamRetry");
    if (e.type === streamError) {
      sawError = true;
      assert(
        e.error !== undefined && e.error.message.includes("INTERNAL_ERROR"),
      );
    }
  }
  assert(sawText && sawError);
});

Deno.test("AnthropicProviderHTTPProxy", () => {
  const p = createAnthropicProvider(
    "fake-key",
    "https://api.anthropic.com",
    [m("m1")],
    { proxyUrl: "http://127.0.0.1:7890" },
  );
  try {
    assertEquals(p.client.proxyUrl, "http://127.0.0.1:7890");
  } finally {
    p.client.close();
  }
});

// ─── tool_choice / tool calls ────────────────────────────────────────────────

Deno.test("AnthropicParallelToolUseRequest", async () => {
  const tools: ToolDefinition[] = [{
    name: "read",
    description: "",
    parameters: { type: "object" },
  }];

  let bodies: CapturedRequest[] = [];
  let p = createMockAnthropicProvider(
    [m("mock")],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  let req = await captureBody(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("use the tools")],
    tools,
  }, bodies);
  let choice = req.tool_choice as Record<string, unknown> | undefined;
  assert(choice !== undefined);
  assertEquals(choice!.type, "auto");
  assertEquals(choice!.disable_parallel_tool_use, false);

  bodies = [];
  p = createMockAnthropicProvider(
    [m("mock")],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  req = await captureBody(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("use the tool")],
    tools,
    responseOptions: { parallelTools: false },
  }, bodies);
  choice = req.tool_choice as Record<string, unknown> | undefined;
  assert(choice !== undefined);
  assertEquals(choice!.disable_parallel_tool_use, true);

  bodies = [];
  p = createMockAnthropicProvider(
    [m("mock", { compat: { supportsParallelToolCalls: false } })],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  req = await captureBody(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("use the tool")],
    tools,
  }, bodies);
  assertEquals(req.tool_choice, undefined);

  bodies = [];
  p = createMockAnthropicProvider(
    [m("mock", { compat: { supportsParallelToolCalls: false } })],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  req = await captureBody(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("use the tool")],
    tools,
    responseOptions: { parallelTools: true },
  }, bodies);
  assertEquals(req.tool_choice, undefined);

  bodies = [];
  p = createMockAnthropicProvider(
    [m("mock", {
      compat: { supportsParallelToolCalls: true, supportsToolChoice: false },
    })],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  req = await captureBody(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("use the tool")],
    tools,
  }, bodies);
  assertEquals(req.tool_choice, undefined);
});

Deno.test("MergeToolCallInputPreservesInitialOnMalformedStream", () => {
  const got = mergeToolCallInput('{"path":"a"}', '{"path":"b"');
  assertEquals(got, '{"path":"a"}');
});

Deno.test("AnthropicStreamMultipleToolCallsWithInitialInput", async () => {
  const sse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"read","input":{"path":"a"}}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-2","name":"read","input":{"path":"b"}}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
  ].join("\n") + "\n";
  const p = createMockAnthropicProvider([m("mock")], sse);
  const calls: ToolCallBlock[] = [];
  for (
    const event of await chatAndCollect(p, {
      ...abortParams(),
      modelId: "mock",
      messages: [createUserMessage("read both")],
    })
  ) {
    if (event.type === streamToolCall && event.toolCall !== undefined) {
      calls.push(event.toolCall);
    }
  }
  assertEquals(calls.length, 2);
  assertEquals(calls[0].id, "call-1");
  assertEquals(calls[1].id, "call-2");
  assertEquals(calls[0].arguments, { path: "a" });
  assertEquals(calls[1].arguments, { path: "b" });
});

Deno.test("AnthropicCustomHeaders", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockAnthropicProvider(
    [m("claude-test")],
    'data: {"type":"message_stop"}\n',
    bodies,
    (req) => {
      assertEquals(req.headers.get("X-Custom-Header"), "custom-value");
      assertEquals(req.headers.get("anthropic-version"), "2024-01-01");
    },
  );
  p.setHeaders({
    "X-Custom-Header": "custom-value",
    "anthropic-version": "2024-01-01",
  });
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "claude-test",
    messages: [createUserMessage("hi")],
  });
});

// ─── convertMessages / cache_control ─────────────────────────────────────────

Deno.test("ConvertMessagesPreservesCacheControlOnSingleTextBlock", () => {
  const p = createAnthropicProvider("fake-key", "https://api.anthropic.com");
  p.setCacheControlEnabled(boolPtr(true));
  const msgs = p.convertMessages({
    messages: [{
      role: "user",
      contents: [{
        type: "text",
        text: "cached text",
        cache_control: { type: "ephemeral" },
      }],
      timestamp: new Date(),
    }],
  } as ChatParams);
  assertEquals(msgs.length, 1);
  const blocks = msgs[0].content as unknown as Array<Record<string, unknown>>;
  assert(Array.isArray(blocks));
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].cache_control, { type: "ephemeral" });
});

Deno.test("ConvertMessagesOmitsCacheControlWhenDisabled", () => {
  const p = createAnthropicProvider("fake-key", "https://api.anthropic.com");
  p.setCacheControlEnabled(boolPtr(false));
  const msgs = p.convertMessages({
    messages: [{
      role: "user",
      contents: [{
        type: "text",
        text: "cached text",
        cache_control: { type: "ephemeral" },
      }],
      timestamp: new Date(),
    }],
  } as ChatParams);
  assertEquals(msgs[0].content, "cached text");
});

Deno.test("ChatRequestPreservesCacheControlOnSingleTextBlock", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockAnthropicProvider(
    [m("claude-test")],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  p.setCacheControlEnabled(boolPtr(true));
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "claude-test",
    messages: [{
      role: "user",
      contents: [{
        type: "text",
        text: "cached text",
        cache_control: { type: "ephemeral" },
      }],
      timestamp: new Date(),
    }],
  });
  const req = JSON.parse(bodies[0].body) as Record<string, unknown>;
  const messages = req.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length, 1);
  const blocks = messages[0].content as Array<Record<string, unknown>>;
  assert(Array.isArray(blocks));
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].cache_control, { type: "ephemeral" });
});

Deno.test("ChatRequestUsesExplicitMaxTokens", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockAnthropicProvider(
    [m("claude-test")],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "claude-test",
    messages: [createUserMessage("hi")],
    maxTokens: 4096,
  });
  const req = JSON.parse(bodies[0].body) as Record<string, unknown>;
  assertEquals(req.max_tokens, 4096);
});

Deno.test("ChatRequestExplicitZeroMaxTokensFallsBackToDefault", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockAnthropicProvider(
    [m("claude-test", { maxTokens: 0, maxTokensSet: true })],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "claude-test",
    messages: [createUserMessage("hi")],
  });
  const req = JSON.parse(bodies[0].body) as Record<string, unknown>;
  assertEquals(req.max_tokens, 16384);
});

Deno.test("ChatRequestHostedWebSearchTool", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockAnthropicProvider(
    [m("claude-test")],
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "claude-test",
    messages: [createUserMessage("search the web")],
    tools: [{
      name: "web_search",
      description: "",
      kind: "hosted",
      provider: "anthropic",
      providerType: "messages",
    }],
  });
  const req = JSON.parse(bodies[0].body) as Record<string, unknown>;
  const tools = req.tools as Array<Record<string, unknown>>;
  assertEquals(tools.length, 1);
  assertEquals(tools[0].type, "web_search_20250305");
  assertEquals(tools[0].name, undefined);
});

Deno.test("ConvertMessagesAnthropicToolResultEmptyContentFallback", () => {
  const p = createAnthropicProvider("fake-key", "https://api.anthropic.com");
  const msgs = p.convertMessages({
    messages: [createToolResultMessage("toolu_1", "bash", "", false)],
  } as ChatParams);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].role, "user");
  const blocks = msgs[0].content as unknown as Array<Record<string, unknown>>;
  assert(Array.isArray(blocks));
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "tool_result");
  assertEquals(blocks[0].tool_use_id, "toolu_1");
  assertEquals(blocks[0].content, "Tool completed with no output.");
});

Deno.test("ConvertMessagesAnthropicGroupsConsecutiveToolResults", () => {
  const p = createAnthropicProvider("fake-key", "https://api.anthropic.com");
  const contents: ContentBlock[] = [
    { type: "text", text: "second" },
    { type: "image", image: { mimeType: "image/png", data: "abc123" } },
  ];
  const msgs = p.convertMessages({
    messages: [
      createToolResultMessage("toolu_1", "read", "first", false),
      createToolResultMessage(
        "toolu_2",
        "screenshot",
        "image result",
        false,
        contents,
      ),
      createAssistantMessage([{ type: "text", text: "done" }]),
    ],
  } as ChatParams);
  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].role, "user");
  const blocks = msgs[0].content as unknown as Array<Record<string, unknown>>;
  assert(Array.isArray(blocks));
  assertEquals(blocks.length, 3);
  assertEquals(blocks[0].type, "tool_result");
  assertEquals(blocks[0].tool_use_id, "toolu_1");
  assertEquals(blocks[0].content, "first");
  assertEquals(blocks[1].type, "tool_result");
  assertEquals(blocks[1].tool_use_id, "toolu_2");
  assertEquals(blocks[1].content, "second");
  assertEquals(blocks[2].type, "image");
  assertEquals((blocks[2].source as Record<string, unknown>).data, "abc123");
});

// ─── thinking formats ────────────────────────────────────────────────────────

async function captureThinking(
  models: Model[],
  format: string,
  params: Partial<ChatParams>,
): Promise<Record<string, unknown>> {
  const bodies: CapturedRequest[] = [];
  const p = createMockAnthropicProvider(
    models,
    'data: {"type":"message_stop"}\n',
    bodies,
  );
  if (format !== "") p.setThinkingFormat(format);
  await chatAndCollect(p, { ...abortParams(), ...params });
  return JSON.parse(bodies[0].body) as Record<string, unknown>;
}

Deno.test("AnthropicThinkingFormatDeepSeek", async () => {
  const req = await captureThinking(
    [m("deepseek-test", { reasoning: true })],
    "deepseek",
    {
      modelId: "deepseek-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingXHigh,
    },
  );
  const thinking = req.thinking as Record<string, unknown>;
  assertEquals(thinking.type, "enabled");
  assertEquals(thinking.budget_tokens, undefined);
  assertEquals((req.output_config as Record<string, unknown>).effort, "max");
});

Deno.test("AnthropicThinkingFormatDeepSeekHigh", async () => {
  const req = await captureThinking(
    [m("deepseek-v4-pro", { reasoning: true })],
    "deepseek",
    {
      modelId: "deepseek-v4-pro",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
    },
  );
  assertEquals((req.thinking as Record<string, unknown>).type, "enabled");
  assertEquals((req.output_config as Record<string, unknown>).effort, "high");
});

Deno.test("AnthropicThinkingOmittedForNonReasoningModel", async () => {
  const req = await captureThinking(
    [m("claude-opus-test", { reasoning: false })],
    "",
    {
      modelId: "claude-opus-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingMedium,
    },
  );
  assertEquals(req.thinking, undefined);
  assertEquals(req.output_config, undefined);
});

Deno.test("AnthropicThinkingAdaptiveForOpus47", async () => {
  const req = await captureThinking(
    [m("claude-opus-4-7", { reasoning: true })],
    "",
    {
      modelId: "claude-opus-4-7",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
    },
  );
  const thinking = req.thinking as Record<string, unknown>;
  assertEquals(thinking.type, "adaptive");
  assertEquals(thinking.budget_tokens, undefined);
  assertEquals((req.output_config as Record<string, unknown>).effort, "high");
});

Deno.test("AnthropicThinkingAdaptiveFromModelCompat", async () => {
  const req = await captureThinking(
    [m("custom-adaptive", {
      reasoning: true,
      compat: { forceAdaptiveThinking: true },
    })],
    "",
    {
      modelId: "custom-adaptive",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingMedium,
    },
  );
  assertEquals((req.thinking as Record<string, unknown>).type, "adaptive");
  assertEquals((req.output_config as Record<string, unknown>).effort, "medium");
});

// ─── usage / cache accounting ────────────────────────────────────────────────

async function usageFor(sse: string): Promise<Usage> {
  const p = createMockAnthropicProvider([m("mock")], sse);
  return mustUsage(
    await chatAndCollect(p, {
      ...abortParams(),
      messages: [createUserMessage("hi")],
    }),
  );
}

Deno.test("AnthropicCache_FirstTurn", async () => {
  const sse =
    'data: {"type":"message_start","message":{"id":"msg_1","content":[],"stop_reason":null,"usage":{"input_tokens":1000,"output_tokens":0,"cache_creation_input_tokens":5000,"cache_read_input_tokens":0}}}\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n' +
    'data: {"type":"content_block_stop","index":0}\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n' +
    'data: {"type":"message_stop"}\n';
  const u = await usageFor(sse);
  assertEquals(u.input, 1000);
  assertEquals(u.output, 10);
  assertEquals(u.cacheRead, 0);
  assertEquals(u.cacheWrite, 5000);
  assertEquals(u.totalTokens, 6010);
  assertEquals(cacheInfo(u), "CacheWrite: 5000");
});

Deno.test("AnthropicCache_CachedTurn", async () => {
  const sse =
    'data: {"type":"message_start","message":{"id":"msg_2","content":[],"stop_reason":null,"usage":{"input_tokens":1000,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":750}}}\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"World"}}\n' +
    'data: {"type":"content_block_stop","index":0}\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n' +
    'data: {"type":"message_stop"}\n';
  const u = await usageFor(sse);
  assertEquals(u.input, 1000);
  assertEquals(u.output, 15);
  assertEquals(u.cacheRead, 750);
  assertEquals(u.cacheWrite, 0);
  assertEquals(u.totalTokens, 1765);
  assertEquals(cacheInfo(u), "Cache: 43%");
});

Deno.test("AnthropicCache_NoCache", async () => {
  const sse =
    'data: {"type":"message_start","message":{"id":"msg_3","content":[],"stop_reason":null,"usage":{"input_tokens":200,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n' +
    'data: {"type":"content_block_stop","index":0}\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n' +
    'data: {"type":"message_stop"}\n';
  const u = await usageFor(sse);
  assertEquals(u.input, 200);
  assertEquals(u.cacheRead, 0);
  assertEquals(u.cacheWrite, 0);
  assertEquals(u.totalTokens, 205);
  assertEquals(cacheInfo(u), "Cache: 0%");
});

Deno.test("AnthropicCache_ProxyAllUsageInMessageDelta", async () => {
  const sse =
    'data: {"type":"message_start","message":{"id":"msg_4","content":[],"stop_reason":null}}\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":800,"output_tokens":20,"cache_read_input_tokens":600,"cache_creation_input_tokens":0}}\n' +
    'data: {"type":"message_stop"}\n';
  const u = await usageFor(sse);
  assertEquals(u.input, 800);
  assertEquals(u.output, 20);
  assertEquals(u.cacheRead, 600);
  assertEquals(u.totalTokens, 1420);
  assertEquals(cacheInfo(u), "Cache: 43%");
});

Deno.test("AnthropicCache_ProxySplitUsage", async () => {
  const sse =
    'data: {"type":"message_start","message":{"id":"msg_5","content":[],"stop_reason":null,"usage":{"input_tokens":500,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":500}}}\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}\n' +
    'data: {"type":"message_stop"}\n';
  const u = await usageFor(sse);
  assertEquals(u.input, 500);
  assertEquals(u.output, 8);
  assertEquals(u.cacheRead, 500);
  assertEquals(u.totalTokens, 1008);
  assertEquals(cacheInfo(u), "Cache: 50%");
});

Deno.test("AnthropicCache_FirstWinsOnConflict", async () => {
  const sse =
    'data: {"type":"message_start","message":{"id":"msg_6","content":[],"stop_reason":null,"usage":{"input_tokens":1000,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":750}}}\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":999,"output_tokens":12,"cache_read_input_tokens":800}}\n' +
    'data: {"type":"message_stop"}\n';
  const u = await usageFor(sse);
  assertEquals(u.input, 1000);
  assertEquals(u.cacheRead, 750);
  assertEquals(u.output, 12);
});

// ─── sampling params suppression ─────────────────────────────────────────────

Deno.test("AnthropicThinkingDropsSamplingParams", async () => {
  const req = await captureThinking(
    [m("mock", { reasoning: true })],
    "",
    {
      modelId: "mock",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingMedium,
      temperature: 0.7,
      topP: 0.9,
    },
  );
  assert(req.thinking !== undefined);
  assertEquals(req.temperature, undefined);
  assertEquals(req.top_p, undefined);
});

Deno.test("AnthropicDisableSamplingParamsCompat", async () => {
  const req = await captureThinking(
    [m("mock", { compat: { disableSamplingParams: true } })],
    "",
    {
      modelId: "mock",
      messages: [createUserMessage("hi")],
      thinkingLevel: "off",
      temperature: 0.7,
      topP: 0.9,
    },
  );
  assertEquals(req.thinking, undefined);
  assertEquals(req.temperature, undefined);
  assertEquals(req.top_p, undefined);
});

Deno.test("AnthropicSamplingParamsDroppedByDefault", async () => {
  const req = await captureThinking([m("mock")], "", {
    modelId: "mock",
    messages: [createUserMessage("hi")],
    thinkingLevel: "off",
    temperature: 0.7,
    topP: 0.9,
  });
  assertEquals(req.temperature, undefined);
  assertEquals(req.top_p, undefined);
});

Deno.test("AnthropicSamplingParamsPassThrough", async () => {
  const req = await captureThinking(
    [m("mock", { compat: { disableSamplingParams: false } })],
    "",
    {
      modelId: "mock",
      messages: [createUserMessage("hi")],
      thinkingLevel: "off",
      temperature: 0.7,
      topP: 0.9,
    },
  );
  assertEquals(req.temperature, 0.7);
  assertEquals(req.top_p, 0.9);
});

// ─── register ────────────────────────────────────────────────────────────────

Deno.test("ResolveAnthropicModelsDefaults", () => {
  const models = resolveAnthropicModels(null);
  assertEquals(models.length, 4);
  assertEquals(models[0].id, "claude-sonnet-4-20250514");
  assertEquals(models[0].provider, "anthropic");
});

Deno.test("ResolveAnthropicModelsFromConfig", () => {
  const models = resolveAnthropicModels({
    models: [{ id: "custom", name: "Custom", reasoning: true }],
  });
  assertEquals(models.length, 1);
  assertEquals(models[0].id, "custom");
  assertEquals(models[0].input, ["text", "image"]);
});
