// coverage_test.go (LoadHistory/GetContextUsage), max_tokens_test.go
// (EscalatedMaxTokens), parallel_test.go (tool-execution normalization), and
// the image-admission cases from agent_test.go (ToolResultImageCapabilityGate,
// ValidateImageRequestBudget*, SupportsImages).

import { assert, assertEquals } from "@std/assert";
import type { ContentBlock, Model } from "../provider/types.ts";
import {
  createAssistantMessage,
  createUserMessage,
} from "../provider/types.ts";
import { createMockProvider } from "../provider/mock.ts";
import { createRegistry } from "../tools/mod.ts";
import type { Tool } from "../tools/mod.ts";
import {
  Agent,
  agentIDFromContext,
  contextWithAgentID,
  contextWithEventChan,
  contextWithParentMode,
  contextWithParentRunContext,
  createAgent,
  createAgentWithLoopConfig,
  defaultOutputMaxTokens,
  escalatedOutputMaxTokens,
  eventChanFromContext,
  parentModeFromContext,
  parentRunContextFromContext,
} from "./agent.ts";
import { createRunContext } from "./run_context.ts";
import type { Event } from "./events.ts";
import { runUserEntryID } from "../session/run_user_message.ts";

function model(
  input: string[],
  contextWindow = 0,
  maxTokens = 0,
): Model {
  return {
    id: "m1",
    name: "m1",
    provider: "mock",
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function imageBlock(data = "base64data", detail?: string): ContentBlock {
  return { type: "image", image: { mimeType: "image/png", data, detail } };
}

Deno.test("createAgent generates a non-empty ID when omitted", () => {
  const a = createAgent({}, undefined);
  assert(a.id().length > 0);
  assert(a.id().startsWith("agent-"));
});

Deno.test("agent abort is one-shot and observable", () => {
  const a = createAgent({}, undefined);
  assertEquals(a.aborted(), false);
  a.abort();
  assertEquals(a.aborted(), true);
  a.abort();
  assertEquals(a.aborted(), true);
});

Deno.test("setConversationTurn binds the durable run identity", () => {
  const a = createAgent({}, undefined);
  a.setConversationTurn("turn-1", "intent-1", "run-1");
  assertEquals(a.config.conversationTurnId, "turn-1");
  assertEquals(a.config.intentId, "intent-1");
  assertEquals(a.config.runId, "run-1");
  assertEquals(a.config.runtimeOwnsTurnEnd, true);
  assertEquals(a.config.runtimeOwnsUserEntry, true);
  assertEquals(a.config.userEntryId, runUserEntryID("run-1"));
});

Deno.test("loadHistoryMessages retains messages and context", () => {
  const a = createAgent(
    { id: "test", model: model(["text"]), mode: "agent" },
    undefined,
  );
  a.loadHistoryMessages([
    createUserMessage("hello"),
    createAssistantMessage([{ type: "text", text: "hi there" }]),
  ]);
  assertEquals(a.getMessages().length, 2);
  assertEquals(a.getContext()!.messages.length, 2);
});

Deno.test("loadHistoryState keeps entry IDs aligned", () => {
  const a = createAgent({}, undefined);
  a.loadHistoryState([createUserMessage("a"), createUserMessage("b")], [
    "e1",
    "e2",
  ]);
  const [msgs, ids] = a.getHistoryState();
  assertEquals(msgs.length, 2);
  assertEquals(ids, ["e1", "e2"]);

  // A length mismatch pads with empty IDs, matching the Go behavior.
  a.loadHistoryState([createUserMessage("c")], ["x", "y"]);
  assertEquals(a.getHistoryState()[1], ["e1", "e2", ""]);
});

Deno.test("getContextUsage returns undefined without a model", () => {
  const a = createAgent({ id: "test", mode: "agent" }, undefined);
  assertEquals(a.getContextUsage(), undefined);
});

Deno.test("getContextUsage returns undefined for a zero context window", () => {
  const a = createAgent(
    { id: "test", model: model(["text"], 0), mode: "agent" },
    undefined,
  );
  assertEquals(a.getContextUsage(), undefined);
});

Deno.test("getContextUsage estimates a positive footprint", () => {
  const a = createAgent(
    { id: "test", model: model(["text"], 100000), mode: "agent" },
    undefined,
  );
  a.loadHistoryMessages([createUserMessage("hello world")]);
  const usage = a.getContextUsage();
  assert(usage !== undefined);
  assert(usage!.totalTokens > 0);
  assertEquals(usage!.contextWindow, 100000);
  assert(usage!.percent !== undefined && usage!.percent > 0);
});

Deno.test("escalatedMaxTokens never exceeds the model output limit", () => {
  const a = createAgentWithLoopConfig(
    { model: model(["text"], 128000, 16384) },
    undefined,
  );
  assertEquals(a.escalatedMaxTokens(8192), 16384);
});

Deno.test("escalatedMaxTokens returns zero once at the ceiling", () => {
  const a = createAgentWithLoopConfig(
    { model: model(["text"], 0, 0) },
    undefined,
  );
  assertEquals(a.escalatedMaxTokens(escalatedOutputMaxTokens), 0);
  // Without a model limit the default escalation ceiling applies.
  assertEquals(
    a.escalatedMaxTokens(defaultOutputMaxTokens),
    escalatedOutputMaxTokens,
  );
});

Deno.test("tool-execution settings normalize in createAgent", () => {
  const settings = { toolExecution: { mode: "sequential", maxConcurrency: 4 } };
  const a = createAgent({ settings }, undefined);
  assertEquals(a.config.toolExecutionMode, "sequential");
  assertEquals(a.maxToolConcurrency(), 4);
});

Deno.test("tool-execution settings normalize in createAgentWithLoopConfig", () => {
  const settings = { toolExecution: { mode: "sequential", maxConcurrency: 4 } };
  const configured = createAgentWithLoopConfig({ settings }, undefined);
  assertEquals(configured.config.toolExecutionMode, "sequential");
  assertEquals(configured.maxToolConcurrency(), 4);

  const dflt = createAgentWithLoopConfig({}, undefined);
  assertEquals(dflt.config.toolExecutionMode, "parallel");
  assertEquals(dflt.maxToolConcurrency(), 10);
});

Deno.test("forced mode overwrites the configured mode", () => {
  const a = createAgentWithLoopConfig(
    { mode: "agent", forcedMode: "yolo" },
    undefined,
  );
  assertEquals(a.config.mode, "yolo");
});

Deno.test("buildFrozenPrompt registers mode tools for the run", () => {
  const registry = createRegistry("/tmp", undefined);
  const fake: Tool = {
    name: () => "read",
    description: () => "Read",
    promptSnippet: () => "Read a file",
    promptGuidelines: () => ["Read carefully"],
    parameters: () => ({ type: "object" }),
    execute: () => ({ text: "ok" }),
  };
  registry.register(fake);
  const a = createAgentWithLoopConfig({ mode: "agent" }, registry);
  assertEquals(a.isToolRegisteredForRun("read"), true);
  assertEquals(a.isToolRegisteredForRun("write"), false);
  assert(a.frozenSystemPrompt().length > 0);
  assertEquals(a.frozenToolDefinitions().length, 1);
});

Deno.test("no registry means no registered tools", () => {
  const a = createAgentWithLoopConfig({ mode: "agent" }, undefined);
  assertEquals(a.isToolRegisteredForRun("read"), false);
  assertEquals(a.frozenSystemPrompt(), "");
});

Deno.test("supportsImages reflects model input capabilities", () => {
  const a = createAgentWithLoopConfig({ model: model(["text"]) }, undefined);
  assertEquals(a.supportsImages(), false);

  a.config.model = model(["text", "image"]);
  assertEquals(a.supportsImages(), true);

  a.config.model = undefined;
  assertEquals(a.supportsImages(), false);
});

Deno.test("gateToolResultImages rejects images for text-only models", () => {
  const a = createAgentWithLoopConfig({ model: model(["text"]) }, undefined);
  const gated = a.gateToolResultImages("image output", [imageBlock()], false);
  assert(gated.error !== undefined);
  assertEquals(gated.isError, true);
  assertEquals(gated.contents, undefined);
  assert(gated.content.includes("does not support image input"));
});

Deno.test("gateToolResultImages passes images through for vision models", () => {
  const a = createAgentWithLoopConfig(
    { model: model(["text", "image"]) },
    undefined,
  );
  const contents = [imageBlock()];
  const gated = a.gateToolResultImages("image output", contents, false);
  assertEquals(gated.error, undefined);
  assertEquals(gated.isError, false);
  assertEquals(gated.contents, contents);
  assertEquals(gated.content, "image output");
});

Deno.test("validateImageRequestBudget rejects over-limit image payloads", () => {
  const m = model(["text", "image"]);
  const groq = createMockProvider("groq", [m], []);
  const a = createAgentWithLoopConfig(
    { provider: groq, vendor: "groq", model: m },
    undefined,
  );
  const data = "A".repeat((4 << 20) - 128);
  const err = a.validateImageRequestBudget([
    {
      role: "toolResult",
      timestamp: new Date(),
      contents: [imageBlock(data, "raw")],
    },
  ]);
  assert(err !== undefined);
  assert(err!.message.includes("provider limit"));
});

Deno.test("validateImageRequestBudget rejects too many images", () => {
  const m = model(["text", "image"]);
  const groq = createMockProvider("groq", [m], []);
  const a = createAgentWithLoopConfig(
    { provider: groq, vendor: "groq", model: m },
    undefined,
  );
  const contents = Array.from({ length: 6 }, () => imageBlock("aW1hZ2U="));
  const err = a.validateImageRequestBudget([
    { role: "user", timestamp: new Date(), contents },
  ]);
  assert(err !== undefined);
  assert(err!.message.includes("provider limit is 5"));
});

Deno.test("validateImageRequestBudget accepts a within-budget request", () => {
  const m = model(["text", "image"]);
  const groq = createMockProvider("groq", [m], []);
  const a = createAgentWithLoopConfig(
    { provider: groq, vendor: "groq", model: m },
    undefined,
  );
  assertEquals(
    a.validateImageRequestBudget([
      {
        role: "user",
        timestamp: new Date(),
        contents: [imageBlock("aW1hZ2U=")],
      },
    ]),
    undefined,
  );
});

Deno.test("callbackSnapshot and agentEndEvent reflect history", () => {
  const a = createAgent({}, undefined);
  a.loadHistoryMessages([createUserMessage("hello")]);
  const [msgs, ctx] = a.callbackSnapshot();
  assertEquals(msgs.length, 1);
  assertEquals(ctx!.messages.length, 1);
  assertEquals(a.agentEndEvent().messages!.length, 1);
});

Deno.test("run-context helpers round-trip typed values", () => {
  const ctx = createRunContext();
  const withId = contextWithAgentID(ctx, "a1");
  assertEquals(agentIDFromContext(withId), "a1");

  const ch = (_ev: Event): boolean => true;
  const withChan = contextWithEventChan(ctx, ch);
  assert(eventChanFromContext(withChan) === ch);

  const withParent = contextWithParentRunContext(ctx, ctx);
  assert(parentRunContextFromContext(withParent) === ctx);

  const withMode = contextWithParentMode(ctx, "yolo");
  assertEquals(parentModeFromContext(withMode), "yolo");
});

Deno.test("direct constructor does not build a frozen prompt", () => {
  const a = new Agent("id-1", "", {}, undefined);
  assertEquals(a.frozenSystemPrompt(), "");
  assertEquals(a.id(), "id-1");
});
