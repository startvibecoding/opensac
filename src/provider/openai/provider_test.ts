//
// Go's httptest-based mock client is replaced by an injected fetch client
// (see test_helpers.ts) that returns prepared Response objects.

import { assert, assertEquals } from "@std/assert";
import {
  cacheInfo,
  type ChatParams,
  createToolResultMessage,
  createUserMessage,
  type Message,
  type Model,
  streamDone,
  streamError,
  type StreamEvent,
  streamRetry,
  streamTextDelta,
  streamToolCall,
  thinkingHigh,
  type ThinkingLevel,
  thinkingLow,
  thinkingMedium,
  thinkingMinimal,
  thinkingOff,
  thinkingXHigh,
} from "../types.ts";
import {
  deepseekReasoningEffort,
  doubaoSeedReasoningEffort,
  isDoubaoSeedModel,
  isQwenModel,
  kimiReasoningEffort,
  normalizeToolResultSequence,
  type OpenAIChatRequest,
  Provider,
  qwenThinkingBudget,
} from "./provider.ts";
import {
  chatAndCollect,
  createMockOpenAIProvider,
  dummyClient,
  errorAfterStream,
  mockClient,
  mustUsage,
} from "./test_helpers.ts";
import { createOpenAIProvider } from "./provider.ts";

function model(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...extra,
  };
}

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    messages: [],
    systemPrompt: "",
    thinkingLevel: "",
    maxTokens: 0,
    modelId: "",
    ...overrides,
  };
}

function createAssistantToolCall(contents: Message["contents"]): Message {
  return { role: "assistant", contents, timestamp: new Date() };
}

// ─── retries ─────────────────────────────────────────────────────────────────

Deno.test("OpenAIRetriesEarlyStreamReadError", async () => {
  const streamErr = new Error(
    "read tcp 192.168.1.143:44252-180.76.199.86:443: read: connection reset by peer",
  );
  let attempts = 0;
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("mock"),
  ]);
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = mockClient(() => {
    attempts++;
    if (attempts === 1) {
      return new Response(errorAfterStream("", streamErr), { status: 200 });
    }
    return new Response("data: [DONE]\n", { status: 200 });
  });

  const events = await chatAndCollect(
    p,
    params({
      messages: [createUserMessage("hi")],
    }),
  );
  assertEquals(attempts, 2);
  let retryEvent: StreamEvent | undefined;
  let sawDone = false;
  for (const e of events) {
    if (e.type === streamRetry) retryEvent = e;
    else if (e.type === streamDone) sawDone = true;
    else if (e.type === streamError) {
      throw new Error(`unexpected error ${e.error}`);
    }
  }
  assert(retryEvent !== undefined);
  assertEquals(retryEvent!.retryAttempt, 1);
  assertEquals(retryEvent!.retryMaxAttempts, 1);
  assertEquals(retryEvent!.retryMax, 1);
  assertEquals(retryEvent!.retryAfterMs, 1);
  assert(sawDone);
});

Deno.test("OpenAIRetriesGeneric4xxResponse", async () => {
  let attempts = 0;
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("mock"),
  ]);
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = mockClient(() => {
    attempts++;
    if (attempts === 1) {
      return new Response(
        `{"error":{"message":"temporary compatibility failure"}}`,
        { status: 400 },
      );
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"recovered"}}]}\ndata: [DONE]\n',
      { status: 200 },
    );
  });

  const events = await chatAndCollect(
    p,
    params({
      messages: [createUserMessage("hi")],
    }),
  );
  assertEquals(attempts, 2);
  let sawRetry = false;
  let sawText = false;
  let sawDone = false;
  for (const event of events) {
    if (event.type === streamRetry) sawRetry = true;
    else if (event.type === streamTextDelta) {
      sawText = sawText || event.textDelta === "recovered";
    } else if (event.type === streamDone) sawDone = true;
    else if (event.type === streamError) {
      throw new Error(`unexpected error ${event.error}`);
    }
  }
  assert(sawRetry && sawText && sawDone);
});

Deno.test("OpenAIPreservesFinal4xxDiagnosticAfterRetries", async () => {
  let attempts = 0;
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("mock"),
  ]);
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = mockClient(() => {
    attempts++;
    return new Response(
      `{"error":{"message":"invalid tool sequence","request_id":"req_400"}}`,
      { status: 400 },
    );
  });
  const events = await chatAndCollect(
    p,
    params({
      messages: [createUserMessage("hi")],
    }),
  );
  assertEquals(attempts, 2);
  for (const event of events) {
    if (event.type === streamError) {
      const text = event.error?.message ?? "";
      assert(text.includes("API error 400"));
      assert(text.includes("invalid tool sequence"));
      return;
    }
  }
  throw new Error("expected final provider error");
});

Deno.test("OpenAIDoesNotRetryStreamReadErrorAfterVisibleOutput", async () => {
  const streamErr = new Error(
    "stream error: stream ID 19; INTERNAL_ERROR; received from peer",
  );
  let attempts = 0;
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("mock"),
  ]);
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = mockClient(() => {
    attempts++;
    return new Response(
      errorAfterStream(
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
        streamErr,
      ),
      { status: 200 },
    );
  });
  const events = await chatAndCollect(
    p,
    params({
      messages: [createUserMessage("hi")],
    }),
  );
  assertEquals(attempts, 1);
  let sawText = false;
  let sawError = false;
  for (const e of events) {
    if (e.type === streamTextDelta) {
      if (e.textDelta === "hello") sawText = true;
    } else if (e.type === streamRetry) {
      throw new Error("unexpected retry after visible output");
    } else if (e.type === streamError) {
      sawError = true;
      assert((e.error?.message ?? "").includes("INTERNAL_ERROR"));
    }
  }
  assert(sawText);
  assert(sawError);
});

// ─── convertMessages ─────────────────────────────────────────────────────────

Deno.test("ConvertMessagesToolResultUsesTextContents", () => {
  const p = new Provider(
    "openai",
    "",
    "https://api.test/v1",
    [],
    dummyClient(),
  );
  const messages = p.convertMessages(
    params({
      messages: [{
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        contents: [{
          type: "text",
          text: "bash output from content block",
          cache_control: { type: "ephemeral" },
        }],
        timestamp: new Date(),
      }],
    }),
    false,
  );
  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "tool");
  assertEquals(messages[0].tool_call_id, "call_1");
  assertEquals(messages[0].name, "bash");
  assertEquals(messages[0].content, "bash output from content block");
});

Deno.test("ConvertMessagesToolResultIncludesKimiToolName", () => {
  const p = new Provider(
    "openai",
    "",
    "https://api.test/v1",
    [],
    dummyClient(),
  );
  const messages = p.convertMessages(
    params({
      messages: [
        createAssistantToolCall([{
          type: "toolCall",
          toolCall: {
            id: "read:2",
            name: "read",
            arguments: { path: "main.go" },
          },
        }]),
        {
          role: "toolResult",
          toolCallId: "read:2",
          toolName: "read",
          content: "ok",
          timestamp: new Date(),
        },
      ],
    }),
    false,
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[0].tool_calls?.length, 1);
  assertEquals(messages[1].role, "tool");
  assertEquals(messages[1].tool_call_id, "read:2");
  assertEquals(messages[1].name, "read");
});

Deno.test("ConvertMessagesImageDetailForOfficialProviders", async (t) => {
  const tests = [
    {
      name: "openai detail",
      baseURL: "https://api.openai.com/v1",
      detail: "detail",
      want: "high",
    },
    {
      name: "xai fast",
      baseURL: "https://api.x.ai/v1",
      detail: "fast",
      want: "low",
    },
    {
      name: "spoofed openai domain omitted",
      baseURL: "https://api.openai.com.example/v1",
      detail: "detail",
      want: "",
    },
    {
      name: "compatible gateway omitted",
      baseURL: "https://openrouter.ai/api/v1",
      detail: "detail",
      want: "",
    },
  ];
  for (const tt of tests) {
    await t.step(tt.name, () => {
      const p = new Provider("openai", "", tt.baseURL, [], dummyClient());
      const messages = p.convertMessages(
        params({
          messages: [{
            role: "user",
            contents: [{
              type: "image",
              image: {
                mimeType: "image/png",
                data: "abc123",
                detail: tt.detail,
              },
            }],
            timestamp: new Date(),
          }],
        }),
        false,
      );
      assertEquals(messages.length, 1);
      const blocks = messages[0].content as Array<Record<string, unknown>>;
      assertEquals(blocks.length, 1);
      const imageUrl = blocks[0].image_url as { detail?: string };
      assertEquals(imageUrl.detail ?? "", tt.want);
    });
  }
});

function imageMessages(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: "user",
      contents: [{
        type: "image",
        image: { mimeType: "image/png", data: `image-${i}` },
      }],
      timestamp: new Date(),
    });
  }
  return out;
}

function countImages(
  messages: ReturnType<Provider["convertMessages"]>,
): number {
  let imageCount = 0;
  for (const msg of messages) {
    const blocks = msg.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block.type === "image_url") imageCount++;
      }
    }
  }
  return imageCount;
}

Deno.test("ConvertMessagesLimitsHistoricalImagesForMoark", () => {
  const input = imageMessages(6);
  const p = createOpenAIProvider("key", "https://api.moark.com/v1", []);
  const got = p.convertMessages(params({ messages: input }), false);
  assertEquals(got.length, input.length);
  assertEquals(countImages(got), 5);
  assertEquals(got[0].content, "[image omitted: provider image limit]");
});

Deno.test("ConvertMessagesDoesNotLimitImagesForOtherGateways", () => {
  const input = imageMessages(6);
  const p = createOpenAIProvider("key", "https://api.example.test/v1", []);
  const got = p.convertMessages(params({ messages: input }), false);
  assertEquals(countImages(got), 6);
});

Deno.test("ConvertMessagesUsesConfiguredImageLimit", () => {
  const input = imageMessages(4);
  const p = createOpenAIProvider("key", "https://api.example.test/v1", []);
  p.setMaxImagesPerRequest(2);
  assertEquals(
    countImages(p.convertMessages(params({ messages: input }), false)),
    2,
  );
  p.setMaxImagesPerRequest(-1);
  assertEquals(
    countImages(p.convertMessages(params({ messages: input }), false)),
    4,
  );
});

// ─── headers / requests ──────────────────────────────────────────────────────

Deno.test("OpenAICustomHeaders", async () => {
  const { provider: p } = createMockOpenAIProvider(
    [model("gpt-test")],
    "data: [DONE]\n",
    (req) => {
      assertEquals(req.headers.get("X-Custom-Header"), "custom-value");
      assertEquals(req.headers.get("Authorization"), "Bearer override-key");
    },
  );
  p.setHeaders({
    "X-Custom-Header": "custom-value",
    "Authorization": "Bearer override-key",
  });
  await chatAndCollect(
    p,
    params({
      modelId: "gpt-test",
      messages: [createUserMessage("hi")],
    }),
  );
});

Deno.test("OpenAIChatParallelToolCallsRequest", async (t) => {
  const tests = [
    {
      name: "defaults enabled when function tools are present",
      compat: undefined,
      responseValue: undefined,
      want: true,
    },
    {
      name: "response option overrides default",
      compat: undefined,
      responseValue: false,
      want: false,
    },
    {
      name: "compatibility flag omits unsupported field",
      compat: { supportsParallelToolCalls: false },
      responseValue: undefined,
      want: undefined,
    },
  ];
  for (const tt of tests) {
    await t.step(tt.name, async () => {
      const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
        model("chat-test", { compat: tt.compat }),
      ]);
      let body = "";
      p.client = mockClient((req) => {
        body = req.body;
        return new Response("data: [DONE]\n", { status: 200 });
      });
      const chatParams = params({
        modelId: "chat-test",
        messages: [createUserMessage("use the tool")],
        tools: [{
          name: "read",
          description: "",
          parameters: { type: "object" },
        }],
      });
      if (tt.responseValue !== undefined) {
        chatParams.responseOptions = { parallelTools: tt.responseValue };
      }
      await chatAndCollect(p, chatParams);
      const raw = JSON.parse(body) as Record<string, unknown>;
      const present = "parallel_tool_calls" in raw;
      if (tt.want === undefined) {
        assert(!present);
      } else {
        assert(present);
        assertEquals(raw["parallel_tool_calls"], tt.want);
      }
    });
  }
});

Deno.test("OpenAIChatParsesMultipleToolCalls", async () => {
  const toolChunk = (
    index: number,
    id: string,
    name: string,
    args: string,
  ): string => {
    return "data: " + JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index,
            id,
            type: "function",
            function: { name, arguments: args },
          }],
        },
      }],
    });
  };
  const sse = [
    toolChunk(0, "call_0", "read", `{"path":"a`),
    toolChunk(1, "call_1", "read", `{"path":"b`),
    toolChunk(0, "", "", `"}`),
    toolChunk(1, "", "", `"}`),
    "data: [DONE]",
  ].join("\n") + "\n";
  const { provider: p } = createMockOpenAIProvider([model("chat-test")], sse);
  const events = await chatAndCollect(
    p,
    params({
      modelId: "chat-test",
      messages: [createUserMessage("read both files")],
    }),
  );
  const calls = events.filter((e) => e.type === streamToolCall).map((e) =>
    e.toolCall!
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].id, "call_0");
  assertEquals(calls[0].name, "read");
  assertEquals(JSON.stringify(calls[0].arguments), `{"path":"a"}`);
  assertEquals(calls[1].id, "call_1");
  assertEquals(JSON.stringify(calls[1].arguments), `{"path":"b"}`);
});

// ─── thinking helpers ────────────────────────────────────────────────────────

Deno.test("OpenAIKimiThinkingEffort", () => {
  const cases: Array<[ThinkingLevel, string]> = [
    [thinkingMinimal, "low"],
    [thinkingLow, "low"],
    [thinkingMedium, "high"],
    [thinkingHigh, "high"],
    [thinkingXHigh, "max"],
  ];
  for (const [level, want] of cases) {
    assertEquals(kimiReasoningEffort(level), want);
  }
});

Deno.test("DeepSeekReasoningEffort", () => {
  assertEquals(deepseekReasoningEffort(thinkingMinimal), "high");
  assertEquals(deepseekReasoningEffort(thinkingLow), "high");
  assertEquals(deepseekReasoningEffort(thinkingMedium), "high");
  assertEquals(deepseekReasoningEffort(thinkingHigh), "high");
  assertEquals(deepseekReasoningEffort(thinkingXHigh), "max");
});

Deno.test("DoubaoSeedReasoningEffort", () => {
  assertEquals(doubaoSeedReasoningEffort(thinkingMinimal), "minimal");
  assertEquals(doubaoSeedReasoningEffort(thinkingLow), "low");
  assertEquals(doubaoSeedReasoningEffort(thinkingMedium), "medium");
  assertEquals(doubaoSeedReasoningEffort(thinkingHigh), "high");
  assertEquals(doubaoSeedReasoningEffort(thinkingXHigh), "high");
  assertEquals(doubaoSeedReasoningEffort(thinkingOff), "");
});

Deno.test("IsDoubaoSeedModel", () => {
  assertEquals(isDoubaoSeedModel("doubao-seed-2.1-turbo"), true);
  assertEquals(isDoubaoSeedModel("doubao-seed-2-1-turbo-260628"), true);
  assertEquals(isDoubaoSeedModel("doubao-seed-evolving"), true);
  assertEquals(isDoubaoSeedModel("doubao-seed-2-0-lite"), false);
  assertEquals(isDoubaoSeedModel("deepseek-v4-pro"), false);
});

Deno.test("QwenThinkingBudget", () => {
  assertEquals(qwenThinkingBudget(thinkingMinimal), 500);
  assertEquals(qwenThinkingBudget(thinkingLow), 500);
  assertEquals(qwenThinkingBudget(thinkingMedium), 4096);
  assertEquals(qwenThinkingBudget(thinkingHigh), 4096);
  assertEquals(qwenThinkingBudget(thinkingXHigh), 10240);
});

Deno.test("IsQwenModel", () => {
  for (
    const id of [
      "qwen3.6-flash",
      "qwen3.6-plus",
      "qwen3.7-plus",
      "qwen3.7-max",
      "qwen3.8-max-preview",
      "qwen/qwen3.7-plus",
      "Qwen3.6-Max",
    ]
  ) {
    assertEquals(isQwenModel(id), true);
  }
  for (
    const id of [
      "qwen3-coder-plus",
      "qwen3-max-2026-01-23",
      "qwen2.5-72b",
      "deepseek-v4-flash",
      "glm-5",
    ]
  ) {
    assertEquals(isQwenModel(id), false);
  }
});

Deno.test("OpenAIThinkingFormatDeepSeekAutoDetect", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("deepseek-test", { reasoning: true }),
  ], "data: [DONE]\n");
  p.baseURL = p.baseURL + "/deepseek";
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "deepseek-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingXHigh,
    }),
  );
  const req = JSON.parse(body) as OpenAIChatRequest;
  assertEquals(req.thinking?.type, "enabled");
  assertEquals(req.reasoning_effort, "max");
});

Deno.test("OpenAIThinkingFormatDeepSeekHighEffort", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("deepseek-v4-flash", { reasoning: true }),
  ], "data: [DONE]\n");
  p.baseURL = p.baseURL + "/deepseek";
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "deepseek-v4-flash",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
    }),
  );
  const req = JSON.parse(body) as OpenAIChatRequest;
  assertEquals(req.thinking?.type, "enabled");
  assertEquals(req.reasoning_effort, "high");
});

Deno.test("OpenAIThinkingFormatFromModelCompat", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("compat-test", {
      reasoning: true,
      compat: { thinkingFormat: "deepseek" },
    }),
  ], "data: [DONE]\n");
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "compat-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
    }),
  );
  const req = JSON.parse(body) as OpenAIChatRequest;
  assertEquals(req.thinking?.type, "enabled");
  assertEquals(req.reasoning_effort, "high");
});

Deno.test("OpenAIThinkingFormatQwen", async (t) => {
  const cases = [
    {
      name: "qwen3.7-plus low",
      modelID: "qwen3.7-plus",
      level: thinkingLow,
      wantBudget: 500,
    },
    {
      name: "qwen3.7-plus medium",
      modelID: "qwen3.7-plus",
      level: thinkingMedium,
      wantBudget: 4096,
    },
    {
      name: "qwen3.6-flash high",
      modelID: "qwen3.6-flash",
      level: thinkingHigh,
      wantBudget: 4096,
    },
    {
      name: "qwen3.8-max-preview xhigh",
      modelID: "qwen3.8-max-preview",
      level: thinkingXHigh,
      wantBudget: 10240,
    },
  ];
  for (const tc of cases) {
    await t.step(tc.name, async () => {
      const { provider: p } = createMockOpenAIProvider([
        model(tc.modelID, { reasoning: true }),
      ], "data: [DONE]\n");
      let body = "";
      p.client = mockClient((req) => {
        body = req.body;
        return new Response("data: [DONE]\n", { status: 200 });
      });
      await chatAndCollect(
        p,
        params({
          modelId: tc.modelID,
          messages: [createUserMessage("hi")],
          thinkingLevel: tc.level,
        }),
      );
      const req = JSON.parse(body) as OpenAIChatRequest;
      assertEquals(req.enable_thinking, true);
      assertEquals(req.thinking_budget, tc.wantBudget);
      assertEquals(req.reasoning_effort ?? "", "");
      assertEquals(req.thinking, undefined);
    });
  }
});

// ─── max tokens / compat fields ──────────────────────────────────────────────

Deno.test("OpenAIOmitsMaxTokensByDefault", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("gpt-test", { maxTokens: 64000 }),
  ], "data: [DONE]\n");
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "gpt-test",
      messages: [createUserMessage("hi")],
    }),
  );
  const raw = JSON.parse(body) as Record<string, unknown>;
  assert(!("max_tokens" in raw));
  assert(!("max_completion_tokens" in raw));
});

Deno.test("OpenAIInfersMaxCompletionTokensForNewModels", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("gpt-5-mini", { maxTokens: 64000 }),
  ], "data: [DONE]\n");
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "gpt-5-mini",
      messages: [createUserMessage("summarize")],
      maxTokens: 2048,
    }),
  );
  const raw = JSON.parse(body) as Record<string, unknown>;
  assert(!("max_tokens" in raw));
  assertEquals(raw["max_completion_tokens"], 2048);
});

Deno.test("OpenAIModelCompatRequestFields", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("compat-fields", {
      reasoning: true,
      compat: {
        maxTokensField: "max_completion_tokens",
        supportsReasoningEffort: false,
      },
    }),
  ], "data: [DONE]\n");
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "compat-fields",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
      maxTokens: 1234,
    }),
  );
  const raw = JSON.parse(body) as Record<string, unknown>;
  assert(!("max_tokens" in raw));
  assertEquals(raw["max_completion_tokens"], 1234);
  assert(!("reasoning_effort" in raw));
});

Deno.test("OpenAIRetriesUnsupportedMaxTokensWithCompletionTokens", async () => {
  let attempts = 0;
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("custom-reasoning-model"),
  ]);
  p.client = mockClient((req) => {
    attempts++;
    const raw = JSON.parse(req.body) as Record<string, unknown>;
    if (attempts === 1) {
      assert("max_tokens" in raw);
      return new Response(
        `{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}`,
        { status: 400 },
      );
    }
    assert(!("max_tokens" in raw));
    assertEquals(raw["max_completion_tokens"], 2048);
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "custom-reasoning-model",
      messages: [createUserMessage("summarize")],
      maxTokens: 2048,
    }),
  );
  assertEquals(attempts, 2);
});

Deno.test("OpenAIRequiresReasoningContentOnAssistant", async () => {
  const { provider: p } = createMockOpenAIProvider([
    model("compat-reasoning", {
      compat: { requiresReasoningContentOnAssistant: true },
    }),
  ], "data: [DONE]\n");
  let body = "";
  p.client = mockClient((req) => {
    body = req.body;
    return new Response("data: [DONE]\n", { status: 200 });
  });
  await chatAndCollect(
    p,
    params({
      modelId: "compat-reasoning",
      messages: [
        {
          role: "assistant",
          contents: [{ type: "text", text: "previous answer" }],
          timestamp: new Date(),
        },
        createUserMessage("continue"),
      ],
    }),
  );
  const raw = JSON.parse(body) as Record<string, unknown>;
  const messages = raw["messages"] as Array<Record<string, unknown>>;
  assert(messages.length > 0);
  assert("reasoning_content" in messages[0]);
  assertEquals(messages[0]["reasoning_content"], "");
});

// ─── normalizeToolResultSequence ─────────────────────────────────────────────

Deno.test("NormalizeToolResultSequenceRepairsMissingKimiResponses", () => {
  const messages: Message[] = [
    createAssistantToolCall([{
      type: "toolCall",
      toolCall: { id: "read:26", name: "read", arguments: { path: "main.go" } },
    }]),
    createUserMessage("continue"),
  ];
  const got = normalizeToolResultSequence(messages);
  assertEquals(got.length, 3);
  assertEquals(got[1].role, "toolResult");
  assertEquals(got[1].toolCallId, "read:26");
  assertEquals(got[1].toolName, "read");
  assert(got[1].isError === true);
  assert((got[1].content ?? "").includes("unavailable"));
  assertEquals(got[2].role, "user");
});

Deno.test("NormalizeToolResultSequenceDoesNotDuplicateResults", () => {
  const messages: Message[] = [
    createAssistantToolCall([{
      type: "toolCall",
      toolCall: { id: "call-1", name: "read" },
    }]),
    createToolResultMessage("call-1", "read", "ok", false),
  ];
  assertEquals(normalizeToolResultSequence(messages).length, messages.length);
});

Deno.test("NormalizeToolResultSequenceOrdersAndFiltersResults", () => {
  const messages: Message[] = [
    createAssistantToolCall([
      { type: "toolCall", toolCall: { id: "a", name: "read" } },
      { type: "toolCall", toolCall: { id: "b", name: "grep" } },
    ]),
    createToolResultMessage("stale", "old", "bad", false),
    createToolResultMessage("b", "grep", "B", false),
    createToolResultMessage("b", "grep", "duplicate", false),
    createToolResultMessage("a", "read", "A", false),
  ];
  const got = normalizeToolResultSequence(messages);
  assertEquals(got.length, 3);
  assertEquals(got[1].toolCallId, "a");
  assertEquals(got[2].toolCallId, "b");
});

Deno.test("NormalizeToolResultSequenceDropsOrphanedResults", () => {
  const messages: Message[] = [
    createAssistantToolCall([{
      type: "toolCall",
      toolCall: { id: "call-1", name: "read" },
    }]),
    createToolResultMessage("call-1", "read", "ok", false),
    createToolResultMessage("read:25", "read", "stale", false),
    createUserMessage("continue"),
  ];
  const got = normalizeToolResultSequence(messages);
  assertEquals(got.length, 3);
  assertEquals(got[2].role, "user");
});

Deno.test("OpenAIRequiresReasoningContentForKimiModels", () => {
  const p = createOpenAIProvider("key", "https://api.test/v1", []);
  assert(p.requiresReasoningContentOnAssistant(model("kimi-k3")));
  assert(p.requiresReasoningContentOnAssistant(model("k3")));
});

// ─── cache / tool call parsing ───────────────────────────────────────────────

Deno.test("OpenAICache_CacheHit", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":5,"total_tokens":1005,"prompt_tokens_details":{"cached_tokens":750}}}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const u = mustUsage(
    await chatAndCollect(p, params({ messages: [createUserMessage("hi")] })),
  );
  assertEquals(u.input, 1000);
  assertEquals(u.output, 5);
  assertEquals(u.cacheRead, 750);
  assertEquals(cacheInfo(u), "Cache: 75%");
});

Deno.test("OpenAICache_NoCache", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":8,"total_tokens":208}}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const u = mustUsage(
    await chatAndCollect(p, params({ messages: [createUserMessage("hi")] })),
  );
  assertEquals(u.input, 200);
  assertEquals(u.cacheRead, 0);
  assertEquals(cacheInfo(u), "Cache: 0%");
});

Deno.test("OpenAICache_100Pct", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"Full"}}]}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":500,"completion_tokens":4,"total_tokens":504,"prompt_tokens_details":{"cached_tokens":500}}}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const u = mustUsage(
    await chatAndCollect(p, params({ messages: [createUserMessage("hi")] })),
  );
  assertEquals(u.cacheRead, 500);
  assertEquals(cacheInfo(u), "Cache: 100%");
});

Deno.test("OpenAICache_ProxyFirstChunkHasUsage", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"Hey"}}],"usage":{"prompt_tokens":800,"completion_tokens":3,"total_tokens":803,"prompt_tokens_details":{"cached_tokens":600}}}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const u = mustUsage(
    await chatAndCollect(p, params({ messages: [createUserMessage("hi")] })),
  );
  assertEquals(u.input, 800);
  assertEquals(u.cacheRead, 600);
  assertEquals(cacheInfo(u), "Cache: 75%");
});

Deno.test("OpenAICache_ProxyFirstWinsOnConflict", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"A"}}],"usage":{"prompt_tokens":1000,"completion_tokens":6,"total_tokens":1006,"prompt_tokens_details":{"cached_tokens":750}}}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":999,"completion_tokens":99,"total_tokens":1098,"prompt_tokens_details":{"cached_tokens":800}}}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const u = mustUsage(
    await chatAndCollect(p, params({ messages: [createUserMessage("hi")] })),
  );
  assertEquals(u.input, 1000);
  assertEquals(u.output, 6);
  assertEquals(u.cacheRead, 750);
  assertEquals(cacheInfo(u), "Cache: 75%");
});

Deno.test("OpenAICache_ProxySplitUsage", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"B"}}],"usage":{"prompt_tokens":400,"completion_tokens":7,"total_tokens":407}}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":300}}}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const u = mustUsage(
    await chatAndCollect(p, params({ messages: [createUserMessage("hi")] })),
  );
  assertEquals(u.input, 400);
  assertEquals(u.output, 7);
  assertEquals(u.cacheRead, 300);
  assertEquals(cacheInfo(u), "Cache: 75%");
});

Deno.test("OpenAIToolCall_MissingIDGetsFallback", async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"bash","arguments":"{\\"command\\":"}}]},"finish_reason":null}]}\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"\\"echo hi\\"}"}}]},"finish_reason":null}]}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const events = await chatAndCollect(
    p,
    params({ messages: [createUserMessage("hi")] }),
  );
  const got = events.find((e) => e.type === streamToolCall)?.toolCall;
  assert(got !== undefined);
  assert(got!.id !== "");
  assert(got!.id.startsWith("openai_toolcall_"));
  assertEquals(got!.name, "bash");
  assertEquals(JSON.stringify(got!.arguments), '{"command":"echo hi"}');
});

Deno.test("OpenAIToolCall_AcceptsObjectArguments", async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_write","type":"function","function":{"name":"write","arguments":{"path":"internal/raft/node.go","content":"package raft\\n"}}}]},"finish_reason":"tool_calls"}]}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  const events = await chatAndCollect(
    p,
    params({ messages: [createUserMessage("hi")] }),
  );
  const got = events.find((e) => e.type === streamToolCall)?.toolCall;
  assert(got !== undefined);
  assertEquals(got!.id, "call_write");
  assertEquals(got!.name, "write");
  assertEquals(
    JSON.stringify(got!.arguments),
    `{"path":"internal/raft/node.go","content":"package raft\\n"}`,
  );
});
