// Focused tests for the stateless helpers ported from internal/agent/agent.go.

import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { Message, ToolCallBlock } from "../provider/types.ts";
import type { Settings } from "../config/settings.ts";
import { createMockProvider } from "../provider/mock.ts";
import { hostedToolOpenAIResponsesWebSearch } from "../provider/mod.ts";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from "../provider/types.ts";
import type { Tool } from "../tools/mod.ts";
import type { ToolContext } from "../tools/mod.ts";
import {
  buildOutputRecoveryMessage,
  buildStreamRecoveryMessage,
  cloneAgentContext,
  cloneMessages,
  cloneMessagesWithoutUsage,
  configuredWebSearchToolDefinition,
  goDurationString,
  imageGenerationToolDefinition,
  isOutputTruncationReason,
  isReadOnlyToolName,
  isSideEffectingToolName,
  normalizeToolCallArguments,
  openAIResponsesWebSearchToolDefinition,
  parseToolExecutionResultSummary,
  replayTextContent,
  retryCompatibilityStatus,
  toolExecutionContext,
  toolExecutionResultSummary,
  usageStatsProviderName,
} from "./agent_support.ts";

Deno.test("cloneMessages deep-copies contents", () => {
  const original: Message = {
    role: "assistant",
    contents: [{ type: "text", text: "hi" }],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: new Date(),
  };
  const [cloned] = cloneMessages([original]);
  assertNotStrictEquals(cloned, original);
  assertNotStrictEquals(cloned.contents, original.contents);
  assertNotStrictEquals(cloned.usage, original.usage);
  assertEquals(cloned.contents?.[0].text, "hi");

  const without = cloneMessagesWithoutUsage([original]);
  assertEquals(without[0].usage, undefined);
  assertEquals(original.usage?.input, 1);

  assertEquals(cloneMessages([]), []);
});

Deno.test("cloneAgentContext handles null and copies tools", () => {
  assertEquals(cloneAgentContext(null), null);
  const ctx = {
    systemPrompt: "sys",
    messages: [createUserMessage("hi")],
    tools: [{ name: "bash", description: "run" }],
  };
  const cloned = cloneAgentContext(ctx)!;
  assertEquals(cloned.systemPrompt, "sys");
  assertEquals(cloned.tools.length, 1);
  assertNotStrictEquals(cloned.messages, ctx.messages);
});

Deno.test("normalizeToolCallArguments decodes and preserves invalid input", () => {
  const [none, noneErr] = normalizeToolCallArguments(undefined);
  assertEquals(none, null);
  assertEquals(noneErr, null);

  const [obj, objErr] = normalizeToolCallArguments({
    id: "c",
    name: "bash",
    arguments: { command: "ls" },
  });
  assertEquals(objErr, null);
  assertEquals(obj?.command, "ls");

  const [parsed, parsedErr] = normalizeToolCallArguments({
    id: "c",
    name: "bash",
    arguments: '{"command":"ls"}',
  });
  assertEquals(parsedErr, null);
  assertEquals(parsed?.command, "ls");

  const tc: ToolCallBlock = {
    id: "c",
    name: "bash",
    arguments: "{not json",
  };
  const [bad, badErr] = normalizeToolCallArguments(tc);
  assertEquals(bad, null);
  assertEquals(badErr !== null, true);
  assertEquals(tc.invalidArguments, "{not json");
  assertEquals(tc.arguments, {});
});

Deno.test("retryCompatibilityStatus formats attempt and wait", () => {
  assertEquals(retryCompatibilityStatus(0, 0, 0), "Retrying...");
  assertEquals(
    retryCompatibilityStatus(1, 3, 0),
    "Retrying (attempt 1/3)...",
  );
  assertEquals(
    retryCompatibilityStatus(2, 5, 1000),
    "Retrying (attempt 2/5); waiting 1s...",
  );
});

Deno.test("goDurationString matches Go formatting", () => {
  assertEquals(goDurationString(0), "0s");
  assertEquals(goDurationString(250), "250ms");
  assertEquals(goDurationString(1000), "1s");
  assertEquals(goDurationString(1500), "1.5s");
  assertEquals(goDurationString(30000), "30s");
  assertEquals(goDurationString(60000), "1m0s");
  assertEquals(goDurationString(3600000), "1h0m0s");
});

Deno.test("buildOutputRecoveryMessage quotes the tail", () => {
  const short = buildOutputRecoveryMessage("abc");
  assertEquals(
    short.includes(
      "<previous_response_suffix>\nabc\n</previous_response_suffix>",
    ),
    true,
  );
  const long = buildOutputRecoveryMessage("x".repeat(2000));
  const marker = long.split("<previous_response_suffix>\n")[1].split(
    "\n</previous_response_suffix>",
  )[0];
  assertEquals(marker.length, 1200);
});

Deno.test("buildStreamRecoveryMessage falls back without a partial", () => {
  const base = buildStreamRecoveryMessage("");
  assertEquals(base.includes("<previous_response_suffix>"), false);
  const withTail = buildStreamRecoveryMessage("hello");
  assertEquals(
    withTail.includes(
      "<previous_response_suffix>\nhello\n</previous_response_suffix>",
    ),
    true,
  );
});

Deno.test("isOutputTruncationReason", () => {
  assertEquals(isOutputTruncationReason("length"), true);
  assertEquals(isOutputTruncationReason(" max_tokens "), true);
  assertEquals(isOutputTruncationReason("MAX-TOKENS"), true);
  assertEquals(isOutputTruncationReason("token_limit"), true);
  assertEquals(isOutputTruncationReason("stop"), false);
});

Deno.test("replayTextContent", () => {
  assertEquals(replayTextContent(createUserMessage("hi")), "hi");
  assertEquals(
    replayTextContent(
      createAssistantMessage([{ type: "text", text: "a" }, {
        type: "text",
        text: "b",
      }]),
    ),
    "a\nb",
  );
  assertEquals(
    replayTextContent(
      createAssistantMessage([{
        type: "toolCall",
        toolCall: { id: "1", name: "x" },
      }]),
    ),
    undefined,
  );
});

Deno.test("usageStatsProviderName prefers vendor", () => {
  assertEquals(usageStatsProviderName({ vendor: "openai" }), "openai");
  assertEquals(usageStatsProviderName({ vendor: "", provider: null }), "");
  assertEquals(
    usageStatsProviderName({
      provider: {
        chat: () => (async function* () {})(),
        name: () => "anthropic",
        api: () => "anthropic-messages",
        models: () => [],
        getModel: () => undefined,
      },
    }),
    "anthropic",
  );
});

Deno.test("isReadOnlyToolName / isSideEffectingToolName", () => {
  for (
    const name of [
      "read",
      "grep",
      "find",
      "ls",
      "jobs",
      "skill_ref",
      "question",
      "plan",
      " READ ",
    ]
  ) {
    assertEquals(isReadOnlyToolName(name), true, name);
  }
  assertEquals(isReadOnlyToolName("bash"), false);
  assertEquals(isSideEffectingToolName("bash"), true);
  assertEquals(isSideEffectingToolName("read"), false);
});

Deno.test("toolExecutionResultSummary round-trips", () => {
  const summary = toolExecutionResultSummary("done", true);
  assertEquals(parseToolExecutionResultSummary(summary), {
    content: "done",
    isError: true,
  });
  assertEquals(
    parseToolExecutionResultSummary({ content: "", isError: false }).content
      .startsWith("A prior tool execution"),
    true,
  );
  assertEquals(
    parseToolExecutionResultSummary(null).content.startsWith(
      "A prior tool execution",
    ),
    true,
  );
});

Deno.test("toolExecutionContext honors overrides and cancellation", async () => {
  const noTimeout = {
    executionTimeout: () => ({ durationMs: 0, provided: true }),
  } as unknown as Tool;
  const ctx: ToolContext = {};
  const passthrough = toolExecutionContext(ctx, noTimeout, {});
  assertStrictEquals(passthrough.ctx, ctx);

  const shortTimeout = {
    executionTimeout: () => ({ durationMs: 5, provided: true }),
  } as unknown as Tool;
  const { ctx: timed } = toolExecutionContext({}, shortTimeout, {});
  assertEquals(timed.signal !== undefined, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(timed.signal?.aborted, true);

  const controller = new AbortController();
  const parentCtx: ToolContext = { signal: controller.signal };
  const { ctx: child } = toolExecutionContext(parentCtx, noTimeout, {});
  assertStrictEquals(child, parentCtx);
  const { ctx: child2, cancel } = toolExecutionContext(
    parentCtx,
    shortTimeout,
    {},
  );
  controller.abort();
  assertEquals(child2.signal?.aborted, true);
  cancel();
});

Deno.test("createToolResultMessage is cloneable by the support helpers", () => {
  const msg = createToolResultMessage("c", "bash", "ok", false);
  const [cloned] = cloneMessages([msg]);
  assertNotStrictEquals(cloned, msg);
  assertEquals(cloned.content, "ok");
});

Deno.test("ImageGenerationToolDefinitionUsesConfiguredResponsesProvider", () => {
  const settings: Settings = {
    defaultProvider: "openai",
    providers: { openai: { models: [], api: "openai-responses" } },
  };
  const def = imageGenerationToolDefinition(settings, "openai");
  assertStrictEquals(def?.name, "image_generation");
  assertStrictEquals(def?.kind, "hosted");
  assertStrictEquals(def?.providerType, "openai-responses");
});

Deno.test("ConfiguredWebSearchToolDefinitionCarriesModelMetadata", () => {
  const settings: Settings = {
    webSearch: {
      enabled: true,
      provider: "anthropic",
      providerType: "anthropic-messages",
      model: "claude-sonnet-4-20250514",
    },
  };
  const def = configuredWebSearchToolDefinition(settings);
  assertStrictEquals(def?.name, "web_search");
  assertEquals(def?.provider, "anthropic");
  assertEquals(def?.providerType, "anthropic-messages");
  assertEquals(def?.model, "claude-sonnet-4-20250514");
});

Deno.test("ConfiguredWebSearchToolDefinitionResolvesProviderReference", () => {
  const settings: Settings = {
    defaultProvider: "gpt",
    webSearch: {
      enabled: true,
      provider: "gpt",
      providerType: "openai-responses",
    },
    providers: {
      gpt: {
        models: [],
        baseUrl: "https://co.yes.vg/v1",
        api: "openai-responses",
      },
    },
  };
  const def = configuredWebSearchToolDefinition(settings);
  assertStrictEquals(def?.name, "web_search");
  assertEquals(def?.provider, "gpt");
  assertEquals(def?.providerType, "openai-responses");
});

Deno.test("OpenAIResponsesWebSearchToolDefinition", () => {
  const p = createMockProvider("gpt", [], []);
  p.setAPI("openai-responses");
  const def = openAIResponsesWebSearchToolDefinition(p);
  assertStrictEquals(def?.name, hostedToolOpenAIResponsesWebSearch);
  assertEquals(def?.providerType, "openai-responses");
});
