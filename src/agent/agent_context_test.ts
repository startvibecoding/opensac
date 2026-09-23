// (clamp),
// and agent_test.go (repairDanglingToolCalls), plus focused tests for the
// remaining stateless agent_context.go helpers.

import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../provider/types.ts";
import {
  newAssistantMessage,
  newToolResultMessage,
  newUserMessage,
} from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import {
  applyCacheMarkers,
  clampMaxTokensToContext,
  completeProviderUsage,
  containsImageContent,
  contentRejectionPlaceholder,
  contextGuardToolResult,
  encodedImagePayloadBytes,
  estimateChatRequestTokens,
  estimateGuardRequestTokens,
  estimateGuardToolResultTokens,
  estimateProviderUsage,
  isContextGuardToolResult,
  lastUserTurnIndex,
  providerImageRequestBudget,
  repairDanglingToolCalls,
  selectCacheMarkers,
  streamRecoveryRetryDelay,
  stripImagesFromMessage,
  toolResultImages,
  waitForStreamRecoveryRetry,
} from "./agent_context.ts";

function userMessage(text: string, systemInjected = false): Message {
  const msg = newUserMessage(text);
  if (systemInjected) msg.systemInjected = true;
  return msg;
}

function assistantText(text: string): Message {
  return { role: "assistant", content: text, timestamp: new Date() };
}

function toolCallMessage(id: string, name: string): Message {
  return newAssistantMessage([{
    type: "toolCall",
    toolCall: { id, name, arguments: {} },
  }]);
}

function imageBlock(data = "AAAA", mimeType = "image/png"): ContentBlock {
  return { type: "image", image: { data, mimeType } };
}

// --- selectCacheMarkers / applyCacheMarkers (cache_test.go) ---

Deno.test("selectCacheMarkers", () => {
  const cases: Array<
    { name: string; messages: Message[]; want: [number, number] }
  > = [
    { name: "empty messages", messages: [], want: [-1, -1] },
    { name: "single message", messages: [userMessage("Hello")], want: [-1, 0] },
    {
      name: "two messages",
      messages: [userMessage("Hello"), newAssistantMessage([])],
      want: [0, 1],
    },
    {
      name: "skips system injected",
      messages: [
        userMessage("Hello", true),
        userMessage("Message 1"),
        newAssistantMessage([]),
      ],
      want: [1, 2],
    },
    {
      name: "multiple messages with injected",
      messages: [
        userMessage("Session context", true),
        userMessage("Message 1"),
        newAssistantMessage([]),
        userMessage("Message 2"),
        newAssistantMessage([]),
      ],
      want: [3, 4],
    },
    {
      name: "all injected messages",
      messages: [
        userMessage("Context 1", true),
        userMessage("Context 2", true),
      ],
      want: [-1, -1],
    },
  ];

  for (const tt of cases) {
    const got = selectCacheMarkers(tt.messages);
    assertEquals(got, tt.want, tt.name);
  }
});

Deno.test("applyCacheMarkers", () => {
  const cases: Array<{
    name: string;
    messages: Message[];
    markers: [number, number];
    wantCC: boolean[];
  }> = [
    {
      name: "no markers",
      messages: [userMessage("Hello"), assistantText("Hi")],
      markers: [-1, -1],
      wantCC: [false, false],
    },
    {
      name: "apply to last message",
      messages: [userMessage("Hello"), assistantText("Hi")],
      markers: [-1, 1],
      wantCC: [false, true],
    },
    {
      name: "apply to two messages",
      messages: [userMessage("Hello"), assistantText("Hi")],
      markers: [0, 1],
      wantCC: [true, true],
    },
    {
      name: "apply to content blocks",
      messages: [
        userMessage("Hello"),
        newAssistantMessage([{ type: "text", text: "Response" }]),
      ],
      markers: [0, 1],
      wantCC: [true, true],
    },
  ];

  for (const tt of cases) {
    const result = applyCacheMarkers(tt.messages, tt.markers);

    // Original messages must not be modified.
    for (const msg of tt.messages) {
      for (const block of msg.contents ?? []) {
        assertEquals(
          block.cache_control,
          undefined,
          `${tt.name}: original modified`,
        );
      }
    }

    for (let i = 0; i < tt.wantCC.length; i++) {
      const msg = result[i];
      let hasCC = false;
      const contents = msg.contents ?? [];
      if (contents.length > 0) {
        const last = contents[contents.length - 1];
        hasCC = last.cache_control?.type === "ephemeral";
      }
      assertEquals(hasCC, tt.wantCC[i], `${tt.name}: message ${i}`);
    }
  }
});

Deno.test("system injected messages are skipped by cache markers", () => {
  const messages = [
    userMessage("Session context", true),
    userMessage("Message 1"),
    newAssistantMessage([]),
    userMessage("Compression summary", true),
    userMessage("Message 2"),
    newAssistantMessage([]),
  ];
  const markers = selectCacheMarkers(messages);
  assertEquals(markers, [4, 5]);

  const result = applyCacheMarkers(messages, markers);
  for (const msg of result) {
    if (msg.systemInjected === true) {
      for (const block of msg.contents ?? []) {
        assertEquals(block.cache_control, undefined);
      }
    }
  }
});

// --- repairDanglingToolCalls (agent_test.go) ---

Deno.test("repairDanglingToolCalls", async (t) => {
  await t.step("no tool calls returns input unchanged", () => {
    const msgs = [
      userMessage("hi"),
      newAssistantMessage([{ type: "text", text: "hello" }]),
    ];
    const out = repairDanglingToolCalls(msgs);
    assertEquals(out.length, msgs.length);
  });

  await t.step("valid history unchanged", () => {
    const msgs = [
      userMessage("hi"),
      toolCallMessage("call_1", "bash"),
      newToolResultMessage("call_1", "bash", "ok", false),
      newAssistantMessage([{ type: "text", text: "done" }]),
    ];
    const out = repairDanglingToolCalls(msgs);
    assertEquals(out.length, msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      assertEquals(out[i].role, msgs[i].role);
      assertEquals(out[i].toolCallId, msgs[i].toolCallId);
    }
  });

  await t.step("dangling tool call gets synthesized error result", () => {
    const msgs = [
      userMessage("hi"),
      toolCallMessage("bash:0", "bash"),
      userMessage("next question"),
    ];
    const out = repairDanglingToolCalls(msgs);
    assertEquals(out.length, 4);
    const synth = out[2];
    assertEquals(synth.role, "toolResult");
    assertEquals(synth.toolCallId, "bash:0");
    assertEquals(synth.toolName, "bash");
    assertEquals(synth.isError, true);
    assertEquals(out[3].role, "user");
  });

  await t.step("result recorded later is moved adjacent", () => {
    const late = newToolResultMessage(
      "bash:0",
      "bash",
      "interrupted output",
      true,
    );
    const msgs = [
      userMessage("hi"),
      toolCallMessage("bash:0", "bash"),
      userMessage("next question"),
      late,
    ];
    const out = repairDanglingToolCalls(msgs);
    assertEquals(out.length, 4);
    assertEquals(out[2].role, "toolResult");
    assertEquals(out[2].toolCallId, "bash:0");
    assertEquals(out[2].content, "interrupted output");
    assertEquals(out[3].role, "user");
  });

  await t.step("multiple tool calls with partial results", () => {
    const assistant = newAssistantMessage([
      {
        type: "toolCall",
        toolCall: { id: "call_1", name: "bash", arguments: {} },
      },
      {
        type: "toolCall",
        toolCall: { id: "call_2", name: "read", arguments: {} },
      },
    ]);
    const msgs = [
      userMessage("hi"),
      assistant,
      newToolResultMessage("call_1", "bash", "ok", false),
    ];
    const out = repairDanglingToolCalls(msgs);
    assertEquals(out.length, 4);
    assertEquals(out[2].toolCallId, "call_1");
    assertEquals(out[2].isError, false);
    assertEquals(out[3].role, "toolResult");
    assertEquals(out[3].toolCallId, "call_2");
    assertEquals(out[3].isError, true);
  });

  await t.step("input slice is not mutated", () => {
    const msgs = [toolCallMessage("bash:0", "bash")];
    const out = repairDanglingToolCalls(msgs);
    assertEquals(msgs.length, 1);
    assertEquals(out.length, 2);
  });
});

// --- clampMaxTokensToContext (max_tokens_test.go) ---

Deno.test("clampMaxTokensToContext", () => {
  assertEquals(clampMaxTokensToContext(10000, 12000, 3000), 8488);
});

Deno.test("clampMaxTokensToContext reserves safety margin", () => {
  assertEquals(clampMaxTokensToContext(262144, 262144, 6523 + 1565), 253544);
});

Deno.test("clampMaxTokensToContext keeps value when it fits", () => {
  assertEquals(clampMaxTokensToContext(4000, 12000, 3000), 4000);
});

Deno.test("clampMaxTokensToContext keeps zero fallback", () => {
  assertEquals(clampMaxTokensToContext(0, 12000, 3000), 0);
});

// --- focused stateless-helper tests ---

Deno.test("containsImageContent", () => {
  assertEquals(containsImageContent([]), false);
  assertEquals(containsImageContent([{ type: "text", text: "hi" }]), false);
  assertEquals(containsImageContent([imageBlock()]), true);
  assertEquals(
    containsImageContent([{
      type: "image",
      image: { data: "", mimeType: "image/png" },
    }]),
    true,
  );
});

Deno.test("toolResultImages extracts only image payloads", () => {
  assertEquals(toolResultImages([{ type: "text", text: "hi" }]), undefined);
  assertEquals(toolResultImages([imageBlock("QUJD", "image/jpeg")]), [
    { mimeType: "image/jpeg", data: "QUJD" },
  ]);
});

Deno.test("encodedImagePayloadBytes accounts for data URI overhead", () => {
  assertEquals(encodedImagePayloadBytes(null), 0);
  // 4 data chars + 9 mime chars + 13 prefix chars + 128
  assertEquals(
    encodedImagePayloadBytes({ data: "AAAA", mimeType: "image/png" }),
    154,
  );
});

Deno.test("providerImageRequestBudget applies known provider limits", () => {
  const base: Provider = {
    chat: () => (async function* () {})(),
    name: () => "anthropic",
    api: () => "anthropic-messages",
    models: () => [],
    getModel: () => undefined,
  };
  const anthropic = providerImageRequestBudget(base, "anthropic");
  assertEquals(anthropic.maxSingleBytes, 10 << 20);

  const groq = providerImageRequestBudget(
    { ...base, name: () => "groq" },
    "groq",
  );
  assertEquals(groq.maxImages, 5);
  assertEquals(groq.maxSingleBytes, 4 << 20);
  assertEquals(groq.maxTotalBytes, 4 << 20);

  const unknown = providerImageRequestBudget(null, "");
  assertEquals(unknown.maxSingleBytes, 20 << 20);
  assertEquals(unknown.maxImages, 0);
});

Deno.test("estimateChatRequestTokens grows with input", () => {
  const tools: ToolDefinition[] = [{
    name: "bash",
    description: "run a command",
    parameters: { type: "object" },
  }];
  const empty = estimateChatRequestTokens("system", [], [], null);
  const withMsg = estimateChatRequestTokens(
    "system",
    [userMessage("hello world")],
    [],
    null,
  );
  const withTools = estimateChatRequestTokens("system", [], tools, null);
  assertEquals(empty > 0, true);
  assertEquals(withMsg >= empty, true);
  assertEquals(withTools > empty, true);
});

Deno.test("estimateGuardRequestTokens floors tool-result token counts", () => {
  const repeated = "a".repeat(400);
  const msg = newToolResultMessage("c", "bash", repeated, false);
  const guard = estimateGuardRequestTokens("sys", [msg], [], null);
  const plain = estimateChatRequestTokens("sys", [msg], [], null);
  assertEquals(guard >= plain, true);
  // The guard heuristic floors a repetitive tool result at chars/4.
  assertEquals(estimateGuardToolResultTokens(msg, null) >= 100, true);
});

Deno.test("estimateProviderUsage / completeProviderUsage", () => {
  const estimated = estimateProviderUsage(
    "sys",
    [userMessage("hi")],
    [],
    newAssistantMessage([{ type: "text", text: "hello" }]),
    null,
  );
  assertEquals(estimated.totalTokens, estimated.input + estimated.output);
  assertEquals(estimated.cost.total, 0);

  // No provider usage falls back to the estimate.
  assertStrictEquals(completeProviderUsage(null, estimated), estimated);

  // Missing output is filled from the estimate; total recomputed.
  const partial = {
    input: 0,
    output: 0,
    cacheRead: 5,
    cacheWrite: 7,
    totalTokens: 0,
    cost: estimated.cost,
  };
  const completed = completeProviderUsage(partial, estimated)!;
  assertEquals(completed.input, estimated.input);
  assertEquals(completed.output, estimated.output);
  assertEquals(
    completed.totalTokens,
    estimated.input + 5 + 7 + estimated.output,
  );
});

Deno.test("contentRejectionPlaceholder names the removal and reason", () => {
  const withDetail = contentRejectionPlaceholder(2, "blocked");
  assertEquals(withDetail.includes("2 image(s)"), true);
  assertEquals(withDetail.includes("(blocked)"), true);
  const noDetail = contentRejectionPlaceholder(1, "  ");
  assertEquals(noDetail.includes("1 image(s)"), true);
  assertEquals(noDetail.includes("(  )"), false);
});

Deno.test("stripImagesFromMessage removes images and appends placeholder", () => {
  const [keptText, countText] = stripImagesFromMessage(
    { role: "user", content: "look", timestamp: new Date() },
    "",
  );
  assertEquals(countText, 0);
  assertStrictEquals(keptText.content, "look");

  const msg: Message = {
    role: "user",
    content: "look",
    contents: [{ type: "text", text: "look" }, imageBlock()],
    timestamp: new Date(),
  };
  const [stripped, count] = stripImagesFromMessage(msg, "blocked");
  assertEquals(count, 1);
  assertEquals(stripped.contents?.length, 1);
  assertEquals(stripped.content?.includes("image unavailable"), true);

  const onlyImage: Message = {
    role: "user",
    contents: [imageBlock()],
    timestamp: new Date(),
  };
  const [emptied, emptiedCount] = stripImagesFromMessage(onlyImage, "");
  assertEquals(emptiedCount, 1);
  assertEquals(emptied.contents, undefined);
  assertEquals((emptied.content ?? "").includes("image unavailable"), true);
});

Deno.test("lastUserTurnIndex finds the newest real user message", () => {
  assertEquals(lastUserTurnIndex([]), 0);
  assertEquals(
    lastUserTurnIndex([
      userMessage("a"),
      newAssistantMessage([]),
      userMessage("injected", true),
      newAssistantMessage([]),
    ]),
    0,
  );
  assertEquals(
    lastUserTurnIndex([
      userMessage("a", true),
      newAssistantMessage([]),
      userMessage("b"),
    ]),
    2,
  );
});

Deno.test("isContextGuardToolResult / contextGuardToolResult", () => {
  const plain = newToolResultMessage("c", "bash", "ok", false);
  assertEquals(isContextGuardToolResult(plain), false);
  const guard = contextGuardToolResult(plain, 100, 50, 1000, 200);
  assertEquals(guard.isError, true);
  assertEquals(guard.toolCallId, "c");
  assertEquals(guard.toolName, "bash");
  assertEquals((guard.content ?? "").startsWith("[Context guard]"), true);
  assertEquals(isContextGuardToolResult(guard), true);
});

Deno.test("streamRecoveryRetryDelay follows provider backoff", () => {
  assertEquals(streamRecoveryRetryDelay(1), 1000);
  assertEquals(streamRecoveryRetryDelay(2), 2000);
  assertEquals(streamRecoveryRetryDelay(0), 1000);
});

Deno.test("waitForStreamRecoveryRetry resolves and honors abort", async () => {
  assertEquals(await waitForStreamRecoveryRetry(null, 0), true);
  assertEquals(await waitForStreamRecoveryRetry(null, 1), true);

  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), 5);
  const result = await waitForStreamRecoveryRetry(controller.signal, 5000);
  assertEquals(result, true);
  assertEquals(performance.now() - started < 2000, true);
});

Deno.test("applyCacheMarkers returns new objects", () => {
  const original = [userMessage("hello")];
  const result = applyCacheMarkers(original, [0, 0]);
  assertNotStrictEquals(result[0], original[0]);
  assertEquals(original[0].contents, undefined);
});
