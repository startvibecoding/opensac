import { assert, assertEquals, assertExists } from "@std/assert";
import {
  BaseProvider,
  calculateCost,
  type ChatParams,
  type ContentBlock,
  createAssistantMessage,
  createMockProvider,
  createToolResultMessage,
  createUserMessage,
  type Model,
  streamDone,
  streamError,
  type StreamEvent,
  streamStart,
  streamTextDelta,
  streamThinkDelta,
  streamToolCall,
  streamUsage,
  thinkingHigh,
  type ThinkingLevel,
  type ToolCallBlock,
  type Usage,
} from "./mod.ts";

function assertClose(got: number, want: number, msg: string): void {
  assert(
    Math.abs(got - want) < 1e-12,
    `${msg}: got ${got}, want ${want}`,
  );
}

Deno.test("NewBaseProvider", () => {
  const models: Model[] = [
    { id: "model1", name: "Model 1" },
    { id: "model2", name: "Model 2" },
  ] as unknown as Model[];
  const p = new BaseProvider("test", models);
  assertEquals(p.name(), "test");
  assertEquals(p.models().length, 2);
});

Deno.test("GetModel", () => {
  const models: Model[] = [
    { id: "model1", name: "Model 1" },
    { id: "model2", name: "Model 2" },
  ] as unknown as Model[];
  const p = new BaseProvider("test", models);
  const m = p.getModel("model1");
  assertExists(m);
  assertEquals(m!.name, "Model 1");
  assertEquals(p.getModel("model3"), undefined);
});

Deno.test("MockProvider", async () => {
  const models: Model[] = [{
    id: "model1",
    name: "Model 1",
  }] as unknown as Model[];
  const responses: StreamEvent[] = [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "Hello" },
    { type: streamDone },
  ];
  const p = createMockProvider("mock", models, responses);
  assertEquals(p.name(), "mock");
  assertEquals(p.getCallCount(), 0);
  assertEquals(p.models().length, 1);
  assertExists(p.getModel("model1"));
  assertEquals(p.getModel("nonexistent"), undefined);

  const events: StreamEvent[] = [];
  for await (const event of p.chat({} as ChatParams)) events.push(event);
  assertEquals(events.length, 3);
  assertEquals(p.getCallCount(), 1);
});

Deno.test("MockProviderWithContext", async () => {
  const models: Model[] = [{
    id: "model1",
    name: "Model 1",
  }] as unknown as Model[];
  const responses: StreamEvent[] = [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "Hello" },
    { type: streamDone },
  ];
  const p = createMockProvider("mock", models, responses);

  const controller = new AbortController();
  controller.abort();

  const events: StreamEvent[] = [];
  for await (
    const event of p.chat({ abort: controller.signal } as ChatParams)
  ) events.push(event);

  assert(events.some((e) => e.type === streamError));
});

Deno.test("ModelPricing", () => {
  const u: Usage = {
    input: 1000,
    output: 500,
    cacheRead: 100,
    cacheWrite: 50,
    totalTokens: 1650,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const model: Model = {
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  } as unknown as Model;
  calculateCost(u, model);
  assertClose(u.cost.input, 0.003, "input cost");
  assertClose(u.cost.output, 0.0075, "output cost");
  assertClose(u.cost.total, 0.003 + 0.0075 + 0.00003 + 0.0001875, "total");
});

Deno.test("ModelPricingDoesNotDoubleChargeIncludedCacheRead", () => {
  const u: Usage = {
    input: 1000,
    output: 100,
    cacheRead: 750,
    cacheWrite: 0,
    totalTokens: 1100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const model: Model = {
    cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 },
  } as unknown as Model;
  calculateCost(u, model);
  assertClose(u.cost.input, 0.0005, "input cost");
  assertClose(u.cost.cacheRead, 0.000375, "cache-read cost");
  assertClose(u.cost.total, 0.001875, "total cost");
});

Deno.test("ModelPricingDoesNotDoubleChargeGoogleCacheReadWithReasoning", () => {
  const u: Usage = {
    input: 1000,
    output: 100,
    reasoning: 50,
    cacheRead: 750,
    cacheWrite: 0,
    totalTokens: 1150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const model: Model = {
    cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 },
  } as unknown as Model;
  calculateCost(u, model);
  assertClose(u.cost.input, 0.0005, "input cost");
});

Deno.test("ModelPricingNilModel", () => {
  const u: Usage = {
    input: 1000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(u, null);
  assertEquals(u.cost.total, 0);
});

Deno.test("NewUserMessage", () => {
  const msg = createUserMessage("Hello");
  assertEquals(msg.role, "user");
  assertEquals(msg.content, "Hello");
  assert(msg.timestamp.getTime() !== 0);
});

Deno.test("NewAssistantMessage", () => {
  const contents: ContentBlock[] = [
    { type: "text", text: "Hello" },
    { type: "thinking", thinking: "Let me think..." },
  ];
  const msg = createAssistantMessage(contents);
  assertEquals(msg.role, "assistant");
  assertEquals(msg.contents!.length, 2);
  assert(msg.timestamp.getTime() !== 0);
});

Deno.test("NewToolResultMessage", () => {
  const msg = createToolResultMessage(
    "call_1",
    "ls",
    "file1.txt\nfile2.txt",
    false,
  );
  assertEquals(msg.role, "toolResult");
  assertEquals(msg.toolCallId, "call_1");
  assertEquals(msg.toolName, "ls");
  assertEquals(msg.content, "file1.txt\nfile2.txt");
  assertEquals(msg.isError, false);
});

Deno.test("NewToolResultMessageError", () => {
  const msg = createToolResultMessage(
    "call_1",
    "bash",
    "command not found",
    true,
  );
  assert(msg.isError);
});

Deno.test("StreamEventTypes", () => {
  const events: StreamEvent[] = [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "Hello" },
    { type: streamThinkDelta, thinkDelta: "Thinking..." },
    { type: streamToolCall, toolCall: { id: "1", name: "ls" } },
    { type: streamUsage, usage: { input: 100, output: 50 } as Usage },
    { type: streamDone, stopReason: "end_turn" },
    { type: streamError },
  ];
  assert(events.length === 7);
});

Deno.test("ThinkingLevels", () => {
  const levels: ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  const expected = ["off", "minimal", "low", "medium", "high", "xhigh"];
  assertEquals(levels, expected);
  assertEquals(thinkingHigh, "high");
});

Deno.test("Model", () => {
  const model: Model = {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
  assertEquals(model.id, "gpt-4o");
  assertEquals(model.name, "GPT-4o");
  assertEquals(model.provider, "openai");
  assertEquals(model.reasoning, false);
  assertEquals(model.input.length, 2);
  assertEquals(model.contextWindow, 128000);
  assertEquals(model.maxTokens, 16384);
});

Deno.test("ContentBlock", () => {
  const block: ContentBlock = { type: "text", text: "Hello" };
  assertEquals(block.type, "text");
  assertEquals(block.text, "Hello");
});

Deno.test("ToolCallBlock", () => {
  const block: ToolCallBlock = {
    id: "call_1",
    name: "ls",
    arguments: { path: "." },
  };
  assertEquals(block.id, "call_1");
  assertEquals(block.name, "ls");
  assertEquals(JSON.stringify(block.arguments), `{"path":"."}`);
});

Deno.test("ChatParams", () => {
  const params: ChatParams = {
    messages: [createUserMessage("Hello")],
    tools: [{ name: "ls", description: "List files" }],
    systemPrompt: "You are a helpful assistant",
    thinkingLevel: "medium",
    maxTokens: 1000,
    modelId: "test",
    abort: new AbortController().signal,
  };
  assertEquals(params.messages.length, 1);
  assertEquals(params.tools!.length, 1);
  assertEquals(params.systemPrompt, "You are a helpful assistant");
  assertEquals(params.thinkingLevel, "medium");
  assertEquals(params.maxTokens, 1000);
});
