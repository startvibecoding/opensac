import { assert, assertEquals, assertFalse } from "@std/assert";
import { MockProvider, newMockProvider } from "../provider/mock.ts";
import type { Provider } from "../provider/provider.ts";
import {
  type ChatParams,
  type ContentBlock,
  type ImageContent,
  type Message,
  type Model,
  newAssistantMessage,
  newSystemInjectedUserMessage,
  newToolResultMessage,
  newUserMessage,
  streamDone,
  type StreamEvent,
  streamTextDelta,
  type ToolCallBlock,
  type Usage,
} from "../provider/types.ts";
import {
  calculateContextTokens,
  compact,
  compactWithOptions,
  compressLargeToolResults,
  contextUsageFromMessages,
  defaultCompactionSettings,
  defaultMaxCompactionSummaryTokens,
  estimateContextTokens,
  estimateContextTokensWithEstimator,
  estimateTextTokens,
  estimateTokens,
  findCutPoint,
  findCutPointWithEstimator,
  findTurnStartIndex,
  findValidCutPoints,
  generateSummaryInsertThenCompressWithTemplate,
  GenericTokenEstimator,
  resolveCompressionTemplate,
  resolveTokenEstimator,
  serializeConversation,
  shouldCompact,
  shouldCompactPercent,
  summarizeToolResultOnce,
  type TokenEstimator,
} from "./mod.ts";

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function usage(partial: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: zeroCost(),
    ...partial,
  };
}

function model(partial: Partial<Model>): Model {
  return {
    id: "",
    name: "",
    provider: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...partial,
  };
}

function msg(partial: Partial<Message> & { role: string }): Message {
  return { timestamp: new Date(), ...partial };
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

class FixedTokenEstimator implements TokenEstimator {
  readonly tokensByContent: Map<string, number>;
  readonly defaultTokens: number;

  constructor(
    tokensByContent: Record<string, number>,
    defaultTokens: number,
  ) {
    this.tokensByContent = new Map(Object.entries(tokensByContent));
    this.defaultTokens = defaultTokens;
  }

  estimateTokens(msg: Message): number {
    const v = this.tokensByContent.get(msg.content ?? "");
    if (v !== undefined) return v;
    return this.defaultTokens;
  }

  estimateMessagesTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += this.estimateTokens(m);
    }
    return total;
  }
}

class CompactRecordingProvider implements Provider {
  readonly recordedModels: Model[];
  lastChat!: ChatParams;

  constructor(models: Model[]) {
    this.recordedModels = models;
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.lastChat = params;
    yield { type: streamTextDelta, textDelta: "updated summary" };
    yield { type: streamDone };
  }

  name(): string {
    return "compact-recording";
  }

  api(): string {
    return "openai-chat";
  }

  models(): Model[] {
    return this.recordedModels;
  }

  getModel(id: string): Model | undefined {
    return this.recordedModels.find((m) => m.id === id);
  }
}

Deno.test("EstimateTokens", () => {
  const tests: Array<[string, Message, number]> = [
    ["simple text message", msg({ role: "user", content: "Hello, world!" }), 4],
    ["empty message", msg({ role: "user", content: "" }), 0],
    [
      "assistant with text content block",
      msg({
        role: "assistant",
        contents: [textBlock("This is a test message with some content")],
      }),
      8,
    ],
    [
      "assistant with tool call",
      msg({
        role: "assistant",
        contents: [{
          type: "toolCall",
          toolCall: {
            id: "call-1",
            name: "bash",
            arguments: JSON.parse('{"command":"ls -la"}'),
          } as ToolCallBlock,
        }],
      }),
      8,
    ],
    [
      "tool result message",
      msg({
        role: "toolResult",
        content: "file1.txt\nfile2.txt\nfile3.txt",
      }),
      11,
    ],
  ];
  for (const [name, message, expected] of tests) {
    assertEquals(estimateTokens(message), expected, name);
  }
});

Deno.test("CalculateContextTokens", () => {
  assertEquals(calculateContextTokens(null), 0, "nil usage");
  const u = usage({
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 10,
    totalTokens: 180,
  });
  assertEquals(calculateContextTokens(u), 130, "with totalTokens");
  assertEquals(calculateContextTokens(u), 130, "with cache aware totalTokens");
});

Deno.test("ContextUsageFromMessagesNormalizesCacheBreakdown", () => {
  const messages: Message[] = [
    newUserMessage("current request"),
    msg({
      role: "assistant",
      content: "response",
      usage: usage({
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 10,
        totalTokens: 180,
      }),
    }),
  ];
  const result = contextUsageFromMessages(
    messages,
    new GenericTokenEstimator(),
  );
  assertEquals(result.totalTokens, 130);
  assertEquals(result.input, 100);
  assertEquals(result.cacheRead, 20);
  assertEquals(result.cacheWrite, 10);
  assertEquals(result.tokens, result.totalTokens);
});

Deno.test("EstimateTextTokensUsesDeepSeekAddedTokens", () => {
  assertEquals(estimateTextTokens("<｜User｜>"), 1);
});

Deno.test("EstimateContextTokens", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "Hello" }),
    msg({
      role: "assistant",
      content: "Hi there",
      usage: usage({ input: 100, output: 50, totalTokens: 150 }),
    }),
    msg({ role: "user", content: "How are you?" }),
  ];
  const { tokens, lastUsageIndex } = estimateContextTokens(messages);
  assertEquals(lastUsageIndex, 1);
  assertEquals(tokens, 104);
});

Deno.test("EstimateContextTokensWithEstimator", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "already counted" }),
    msg({
      role: "assistant",
      content: "response",
      usage: usage({ input: 100, output: 50, totalTokens: 150 }),
    }),
    msg({ role: "user", content: "trailing" }),
  ];
  const estimator = new FixedTokenEstimator({ trailing: 42 }, 1);
  const { tokens, lastUsageIndex } = estimateContextTokensWithEstimator(
    messages,
    estimator,
  );
  assertEquals(lastUsageIndex, 1);
  assertEquals(tokens, 142);
});

Deno.test("ShouldCompact", () => {
  const tests: Array<[string, number, number, number, boolean]> = [
    ["over threshold", 190000, 200000, 16384, true],
    ["under threshold", 100000, 200000, 16384, false],
    ["no context window", 100000, 0, 16384, false],
  ];
  for (const [name, ct, cw, rt, expected] of tests) {
    assertEquals(shouldCompact(ct, cw, rt), expected, name);
  }
});

Deno.test("ShouldCompactPercent", () => {
  assert(shouldCompactPercent(160, 200, 0.8));
  assertFalse(shouldCompactPercent(159, 200, 0.8));
  assert(shouldCompactPercent(80, 100, 80));
  assertFalse(shouldCompactPercent(80, 0, 0.8));
});

Deno.test("FindCutPoint", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "Message 1" }),
    msg({ role: "assistant", content: "Response 1" }),
    msg({ role: "user", content: "Message 2" }),
    msg({ role: "assistant", content: "Response 2" }),
    msg({ role: "user", content: "Message 3" }),
    msg({ role: "assistant", content: "Response 3" }),
  ];
  const cutPoint = findCutPoint(messages, 0, messages.length, 10);
  assert(
    cutPoint.firstKeptIndex >= 0 && cutPoint.firstKeptIndex < messages.length,
  );
});

Deno.test("FindCutPointWithEstimator", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "old" }),
    msg({ role: "assistant", content: "old response" }),
    msg({ role: "user", content: "recent" }),
    msg({ role: "assistant", content: "recent response" }),
  ];
  const estimator = new FixedTokenEstimator({
    "old": 1,
    "old response": 1,
    "recent": 40,
    "recent response": 40,
  }, 1);
  const cutPoint = findCutPointWithEstimator(
    messages,
    0,
    messages.length,
    40,
    estimator,
  );
  assertEquals(cutPoint.firstKeptIndex, 3);
  assertEquals(cutPoint.isSplitTurn, true);
  assertEquals(cutPoint.turnStartIndex, 2);
});

Deno.test("ResolveCompressionTemplate", () => {
  const tests: Array<[string, string, string, string]> = [
    ["default empty", "", "default", "structured context checkpoint"],
    ["code", "code", "code", "structured coding checkpoint"],
    ["conversation", "conversation", "conversation", "conversation checkpoint"],
    [
      "unknown fallback",
      "missing",
      "default",
      "structured context checkpoint",
    ],
  ];
  for (const [name, template, wantName, wantText] of tests) {
    const tpl = resolveCompressionTemplate(template);
    assertEquals(tpl.name, wantName, name);
    assert(tpl.instruction.includes(wantText), name);
  }
});

Deno.test("CompactUsesConfiguredTemplate", async () => {
  const p = new CompactRecordingProvider([model({
    id: "m",
    name: "m",
    maxTokens: 1024,
  })]);
  const messages: Message[] = [
    msg({ role: "user", content: "old ".repeat(80) }),
    msg({ role: "assistant", content: "old response ".repeat(80) }),
    msg({ role: "user", content: "recent" }),
  ];
  await compact(
    undefined,
    messages,
    p,
    p.models()[0],
    "system",
    null,
    {
      enabled: true,
      reserveTokens: 1024,
      keepRecentTokens: 1,
      template: "code",
    },
    "",
  );
  const last = p.lastChat.messages[p.lastChat.messages.length - 1];
  assert((last.content ?? "").includes("structured coding checkpoint"));
});

Deno.test("CompactCapsSummaryMaxTokens", async () => {
  const p = new CompactRecordingProvider([model({
    id: "m",
    name: "m",
    maxTokens: 16000,
  })]);
  const messages: Message[] = [
    msg({ role: "user", content: "old ".repeat(80) }),
    msg({ role: "assistant", content: "old response ".repeat(80) }),
    msg({ role: "user", content: "recent" }),
  ];
  await compact(
    undefined,
    messages,
    p,
    p.models()[0],
    "system",
    null,
    { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
    "",
  );
  assertEquals(p.lastChat.maxTokens, defaultMaxCompactionSummaryTokens);
});

Deno.test("CompactWithOptionsForceAllowsSummaryOnly", async () => {
  const p = new CompactRecordingProvider([model({
    id: "m",
    name: "m",
    maxTokens: 1024,
  })]);
  const messages: Message[] = [
    msg({ role: "user", content: "only current user" }),
    msg({ role: "assistant", content: "only current response" }),
  ];
  const result = await compactWithOptions(
    undefined,
    messages,
    p,
    p.models()[0],
    "system",
    null,
    { enabled: true, reserveTokens: 1024, keepRecentTokens: 20000 },
    "",
    { force: true },
  );
  assertEquals(result.firstKeptIndex, messages.length);
});

Deno.test("GenerateSummaryUsesConfiguredUpdateTemplate", async () => {
  const p = new CompactRecordingProvider([model({
    id: "m",
    name: "m",
    maxTokens: 1024,
  })]);
  await generateSummaryInsertThenCompressWithTemplate(
    undefined,
    [msg({ role: "user", content: "new information" })],
    p,
    p.models()[0],
    "system",
    null,
    "## Goal\nprevious",
    512,
    resolveCompressionTemplate("code"),
  );
  const last = p.lastChat.messages[p.lastChat.messages.length - 1];
  assert((last.content ?? "").includes("existing coding checkpoint summary"));
  assert((last.content ?? "").includes("## Goal\nprevious"));
});

Deno.test("EstimateTokensImage", () => {
  const message = msg({
    role: "user",
    contents: [{
      type: "image",
      image: { mimeType: "image/png", data: "base64data" },
    }],
  });
  assertEquals(estimateTokens(message), 1200);
});

Deno.test("EstimateTokensLargeImageUsesPayloadSize", () => {
  const message = msg({
    role: "user",
    contents: [{
      type: "image",
      image: { mimeType: "image/png", data: "a".repeat(20000) },
    }],
  });
  assertEquals(estimateTokens(message), 5000);
});

Deno.test("EstimateTokensImageUsesDimensions", () => {
  const message = msg({
    role: "user",
    contents: [{
      type: "image",
      image: {
        mimeType: "image/png",
        data: "abc",
        width: 1024,
        height: 513,
      },
    }],
  });
  assertEquals(estimateTokens(message), 3200);
});

Deno.test("ResolveTokenEstimatorUsesModelAwareImageRules", () => {
  const tests: Array<[string, Model, ImageContent, number]> = [
    [
      "claude patch estimate",
      model({ id: "claude-sonnet-4-5", provider: "anthropic" }),
      { mimeType: "image/png", data: "abc", width: 1568, height: 1019 },
      2072,
    ],
    [
      "gemini small tile estimate",
      model({ id: "gemini-2.5-pro", provider: "google-gemini" }),
      { mimeType: "image/png", data: "abc", width: 384, height: 300 },
      258,
    ],
    [
      "qwen patch estimate",
      model({ id: "qwen3.7-plus", provider: "alibaba-coding-plan" }),
      { mimeType: "image/png", data: "abc", width: 1024, height: 768 },
      1036,
    ],
    [
      "openai low detail estimate",
      model({ id: "gpt-4o", provider: "openai" }),
      {
        mimeType: "image/png",
        data: "abc",
        width: 1024,
        height: 1024,
        detail: "fast",
      },
      85,
    ],
    [
      "openai high detail estimate",
      model({ id: "gpt-4o", provider: "openai" }),
      {
        mimeType: "image/png",
        data: "abc",
        width: 1024,
        height: 513,
        detail: "detail",
      },
      765,
    ],
  ];
  for (const [name, mdl, image, want] of tests) {
    const estimator = resolveTokenEstimator(
      {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 0,
        tokenizer: "auto",
      },
      mdl,
    );
    const message = msg({
      role: "user",
      contents: [{ type: "image", image }],
    });
    assertEquals(estimator.estimateTokens(message), want, name);
  }
});

Deno.test("ModelAwareTokenEstimatorSumsMultipleImages", () => {
  const estimator = resolveTokenEstimator(
    { enabled: true, reserveTokens: 0, keepRecentTokens: 0, tokenizer: "auto" },
    model({ id: "gemini-2.5-pro", provider: "google-gemini" }),
  );
  const message = msg({
    role: "user",
    contents: [
      textBlock("compare"),
      {
        type: "image",
        image: {
          mimeType: "image/png",
          data: "abc",
          width: 384,
          height: 300,
        },
      },
      {
        type: "image",
        image: {
          mimeType: "image/png",
          data: "abc",
          width: 1024,
          height: 768,
        },
      },
    ],
  });
  assertEquals(estimator.estimateTokens(message), 775);
});

Deno.test("EstimateTokensThinking", () => {
  const message = msg({
    role: "assistant",
    contents: [{ type: "thinking", thinking: "Let me think about this..." }],
  });
  assertEquals(estimateTokens(message), 6);
});

Deno.test("CompactDoesNotResendPreviousSummaryAsConversationMessage", async () => {
  const summary = "## Goal\ncarry forward state";
  const messages: Message[] = [
    newSystemInjectedUserMessage(summary),
    newUserMessage("old context ".repeat(20)),
    newAssistantMessage([textBlock("assistant context ".repeat(20))]),
    newUserMessage("recent question ".repeat(16)),
    newAssistantMessage([textBlock("recent answer ".repeat(16))]),
  ];
  const p = new CompactRecordingProvider([model({
    id: "model1",
    name: "Model 1",
    maxTokens: 1024,
  })]);
  await compact(
    undefined,
    messages,
    p,
    p.models()[0],
    "",
    null,
    { enabled: true, reserveTokens: 1024, keepRecentTokens: 48 },
    summary,
  );
  assert(p.lastChat.messages.length > 0);
  assertFalse(p.lastChat.messages[0].content === summary);
  const last = p.lastChat.messages[p.lastChat.messages.length - 1];
  assert((last.content ?? "").includes("<existing-summary>"));
});

Deno.test("EstimateTokensContentBlocksTakePrecedence", () => {
  const message = msg({
    role: "assistant",
    content: "This should be ignored because Contents is set",
    contents: [textBlock("Short")],
  });
  assertEquals(estimateTokens(message), 1);
});

Deno.test("EstimateTokensToolCallNilBlock", () => {
  const message = msg({
    role: "assistant",
    contents: [{ type: "toolCall" }],
  });
  assertEquals(estimateTokens(message), 0);
});

Deno.test("CalculateContextTokensFallback", () => {
  const u = usage({
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 10,
    totalTokens: 0,
  });
  assertEquals(calculateContextTokens(u), 130);
});

Deno.test("EstimateContextTokensNoUsage", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "Hello" }),
    msg({ role: "assistant", content: "Hi there" }),
  ];
  const { tokens, lastUsageIndex } = estimateContextTokens(messages);
  assertEquals(lastUsageIndex, -1);
  const expected = estimateTokens(messages[0]) + estimateTokens(messages[1]);
  assertEquals(tokens, expected);
});

Deno.test("EstimateContextTokensEmptyMessages", () => {
  const { tokens, lastUsageIndex } = estimateContextTokens([]);
  assertEquals(tokens, 0);
  assertEquals(lastUsageIndex, -1);
});

Deno.test("EstimateContextTokensUsageWithZeroTotal", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "Hello" }),
    msg({
      role: "assistant",
      content: "Hi",
      usage: usage({ totalTokens: 0 }),
    }),
  ];
  const { lastUsageIndex } = estimateContextTokens(messages);
  assertEquals(lastUsageIndex, -1);
});

Deno.test("FindValidCutPoints", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "msg1" }),
    msg({ role: "assistant", content: "resp1" }),
    msg({ role: "toolResult", content: "result1" }),
    msg({ role: "user", content: "msg2" }),
    msg({ role: "assistant", content: "resp2" }),
  ];
  assertEquals(findValidCutPoints(messages, 0, messages.length), [0, 1, 3, 4]);
});

Deno.test("FindValidCutPointsSubrange", () => {
  const messages: Message[] = [
    msg({ role: "user" }),
    msg({ role: "assistant" }),
    msg({ role: "user" }),
    msg({ role: "assistant" }),
  ];
  assertEquals(findValidCutPoints(messages, 1, 3), [1, 2]);
});

Deno.test("FindValidCutPointsEmpty", () => {
  assertEquals(findValidCutPoints([], 0, 0), []);
});

Deno.test("FindTurnStartIndex", () => {
  const messages: Message[] = [
    msg({ role: "user" }),
    msg({ role: "assistant" }),
    msg({ role: "toolResult" }),
    msg({ role: "assistant" }),
  ];
  assertEquals(findTurnStartIndex(messages, 3, 0), 0);
  assertEquals(findTurnStartIndex(messages, 1, 0), 0);
  const noUserMsgs: Message[] = [
    msg({ role: "assistant" }),
    msg({ role: "toolResult" }),
  ];
  assertEquals(findTurnStartIndex(noUserMsgs, 1, 0), -1);
});

Deno.test("FindCutPointNoCutPoints", () => {
  const messages: Message[] = [
    msg({ role: "toolResult", content: "result1" }),
    msg({ role: "toolResult", content: "result2" }),
  ];
  const result = findCutPoint(messages, 0, messages.length, 10);
  assertEquals(result.firstKeptIndex, 0);
  assertEquals(result.turnStartIndex, -1);
});

Deno.test("FindCutPointSplitTurn", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "first question" }),
    msg({ role: "assistant", content: "first answer" }),
    msg({ role: "user", content: "second question" }),
    msg({ role: "assistant", content: "x".repeat(200) }),
    msg({ role: "user", content: "third question" }),
    msg({ role: "assistant", content: "y".repeat(200) }),
  ];
  const result = findCutPoint(messages, 0, messages.length, 20);
  assert(result.firstKeptIndex >= 0 && result.firstKeptIndex < messages.length);
});

Deno.test("FindCutPointKeepAll", () => {
  const messages: Message[] = [
    msg({ role: "user", content: "Hello" }),
    msg({ role: "assistant", content: "Hi" }),
  ];
  const result = findCutPoint(messages, 0, messages.length, 999999);
  assertEquals(result.firstKeptIndex, 0);
});

Deno.test("SerializeConversation", () => {
  const result = serializeConversation([
    msg({ role: "user", content: "Hello" }),
    msg({ role: "assistant", content: "Hi there" }),
  ]);
  assert(result !== "");
  assert(result.includes("User: Hello"));
  assert(result.includes("Assistant: Hi there"));
});

Deno.test("SerializeConversationToolResult", () => {
  const result = serializeConversation([
    msg({ role: "toolResult", toolName: "bash", content: "output here" }),
  ]);
  assert(result.includes("Tool Result [bash]"));
  assert(result.includes("output here"));
});

Deno.test("SerializeConversationThinking", () => {
  const result = serializeConversation([
    msg({
      role: "assistant",
      contents: [
        { type: "thinking", thinking: "hmm let me think" },
        textBlock("Here is my answer"),
      ],
    }),
  ]);
  assert(result.includes("[thinking: hmm let me think]"));
  assert(result.includes("Here is my answer"));
});

Deno.test("SerializeConversationToolCall", () => {
  const result = serializeConversation([
    msg({
      role: "assistant",
      contents: [{
        type: "toolCall",
        toolCall: {
          id: "call-1",
          name: "read",
          arguments: { path: "foo.go" },
        },
      }],
    }),
  ]);
  assert(result.includes("[tool_call: read("));
});

Deno.test("SerializeConversationSystemInjectedSkipped", () => {
  const result = serializeConversation([
    msg({ role: "user", content: "Hello", systemInjected: true }),
    msg({ role: "user", content: "World" }),
  ]);
  assertFalse(result.includes("Hello"));
  assert(result.includes("World"));
});

Deno.test("SerializeConversationUserContentBlocks", () => {
  const result = serializeConversation([
    msg({ role: "user", contents: [textBlock("block content")] }),
  ]);
  assert(result.includes("User: block content"));
});

Deno.test("SerializeConversationUserNonTextContentBlocks", () => {
  const result = serializeConversation([
    msg({
      role: "user",
      contents: [{
        type: "image",
        image: { mimeType: "image/png", data: "abc" },
      }],
    }),
  ]);
  assert(result.includes("[image: image/png]"));
});

Deno.test("SerializeConversationToolResultContentBlocks", () => {
  const result = serializeConversation([
    msg({
      role: "toolResult",
      toolName: "read",
      contents: [textBlock("tool block output")],
    }),
  ]);
  assert(result.includes("tool block output"));
});

Deno.test("SerializeConversationLongToolResult", () => {
  const result = serializeConversation([
    msg({ role: "toolResult", toolName: "bash", content: "x".repeat(600) }),
  ]);
  assert(result.includes("..."));
});

Deno.test("DefaultCompactionSettings", () => {
  const s = defaultCompactionSettings();
  assert(s.enabled);
  assertEquals(s.reserveTokens, 16384);
  assertEquals(s.keepRecentTokens, 20000);
});

Deno.test("ShouldCompactExact", () => {
  assertFalse(shouldCompact(183616, 200000, 16384));
  assert(shouldCompact(183617, 200000, 16384));
});

Deno.test("CompressLargeToolResultsRunsParallelSubSummaries", async () => {
  const mdl = model({ id: "test-model" });
  const p = newMockProvider("test", [mdl], [{
    type: streamTextDelta,
    textDelta: "concise tool summary",
  }]);
  const messages: Message[] = [
    msg({
      role: "assistant",
      contents: [{
        type: "toolCall",
        toolCall: { id: "call-1", name: "read" },
      }],
    }),
    newToolResultMessage("call-1", "read", "a".repeat(50000), false),
    msg({
      role: "assistant",
      contents: [{
        type: "toolCall",
        toolCall: { id: "call-2", name: "grep" },
      }],
    }),
    newToolResultMessage("call-2", "grep", "b".repeat(50000), false),
  ];
  const got = await compressLargeToolResults(
    undefined,
    messages,
    p,
    mdl,
    "system",
    new GenericTokenEstimator(),
  );
  assertEquals(p.getCallCount(), 2);
  for (const index of [1, 3]) {
    assertEquals(got[index].role, "toolResult");
    assertEquals(got[index].content, "concise tool summary");
    assert((got[index].toolCallId ?? "") !== "");
    assert((got[index].toolName ?? "") !== "");
  }
});

Deno.test("CompressLargeToolResultsSkipsSmallResults", async () => {
  const mdl = model({ id: "test-model" });
  const p: MockProvider = newMockProvider("test", [mdl], [{
    type: streamTextDelta,
    textDelta: "summary",
  }]);
  const messages: Message[] = [
    newToolResultMessage("call-1", "read", "small", false),
  ];
  const got = await compressLargeToolResults(
    undefined,
    messages,
    p,
    mdl,
    "system",
    new GenericTokenEstimator(),
  );
  assertEquals(p.getCallCount(), 0);
  assertEquals(got[0].content, "small");
});

Deno.test("SummarizeToolResultUsesValidStandaloneUserMessage", async () => {
  const p = new CompactRecordingProvider([model({ id: "test-model" })]);
  const message = newToolResultMessage(
    "call-1",
    "read",
    "important file output",
    false,
  );
  await summarizeToolResultOnce(
    undefined,
    message,
    p,
    p.models()[0],
    "system",
  );
  assertEquals(p.lastChat.messages.length, 1);
  const request = p.lastChat.messages[0];
  assertEquals(request.role, "user");
  assertFalse((request.content ?? "").includes("toolResult"));
  assert((request.content ?? "").includes("important file output"));
});
