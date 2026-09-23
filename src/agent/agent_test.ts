// coverage_test.go (LoadHistory/GetContextUsage), max_tokens_test.go
// (EscalatedMaxTokens), parallel_test.go (tool-execution normalization), and
// the image-admission cases from agent_test.go (ToolResultImageCapabilityGate,
// ValidateImageRequestBudget*, SupportsImages).

import { assert, assertEquals } from "@std/assert";
import type { ContentBlock, Model } from "../provider/types.ts";
import { newAssistantMessage, newUserMessage } from "../provider/types.ts";
import { newMockProvider } from "../provider/mock.ts";
import { newRegistry } from "../tools/mod.ts";
import type { Tool } from "../tools/mod.ts";
import {
  Agent,
  agentIDFromContext,
  contextWithAgentID,
  contextWithEventChan,
  contextWithParentMode,
  contextWithParentRunContext,
  defaultOutputMaxTokens,
  escalatedOutputMaxTokens,
  eventChanFromContext,
  newAgent,
  newAgentWithLoopConfig,
  parentModeFromContext,
  parentRunContextFromContext,
} from "./agent.ts";
import { newRunContext } from "./run_context.ts";
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

Deno.test("newAgent generates a non-empty ID when omitted", () => {
  const a = newAgent({}, undefined);
  assert(a.id().length > 0);
  assert(a.id().startsWith("agent-"));
});

Deno.test("agent abort is one-shot and observable", () => {
  const a = newAgent({}, undefined);
  assertEquals(a.aborted(), false);
  a.abort();
  assertEquals(a.aborted(), true);
  a.abort();
  assertEquals(a.aborted(), true);
});

Deno.test("setConversationTurn binds the durable run identity", () => {
  const a = newAgent({}, undefined);
  a.setConversationTurn("turn-1", "intent-1", "run-1");
  assertEquals(a.config.conversationTurnId, "turn-1");
  assertEquals(a.config.intentId, "intent-1");
  assertEquals(a.config.runId, "run-1");
  assertEquals(a.config.runtimeOwnsTurnEnd, true);
  assertEquals(a.config.runtimeOwnsUserEntry, true);
  assertEquals(a.config.userEntryId, runUserEntryID("run-1"));
});

Deno.test("loadHistoryMessages retains messages and context", () => {
  const a = newAgent(
    { id: "test", model: model(["text"]), mode: "agent" },
    undefined,
  );
  a.loadHistoryMessages([
    newUserMessage("hello"),
    newAssistantMessage([{ type: "text", text: "hi there" }]),
  ]);
  assertEquals(a.getMessages().length, 2);
  assertEquals(a.getContext()!.messages.length, 2);
});

Deno.test("loadHistoryState keeps entry IDs aligned", () => {
  const a = newAgent({}, undefined);
  a.loadHistoryState([newUserMessage("a"), newUserMessage("b")], ["e1", "e2"]);
  const [msgs, ids] = a.getHistoryState();
  assertEquals(msgs.length, 2);
  assertEquals(ids, ["e1", "e2"]);

  // A length mismatch pads with empty IDs, matching the Go behavior.
  a.loadHistoryState([newUserMessage("c")], ["x", "y"]);
  assertEquals(a.getHistoryState()[1], ["e1", "e2", ""]);
});

Deno.test("getContextUsage returns undefined without a model", () => {
  const a = newAgent({ id: "test", mode: "agent" }, undefined);
  assertEquals(a.getContextUsage(), undefined);
});

Deno.test("getContextUsage returns undefined for a zero context window", () => {
  const a = newAgent(
    { id: "test", model: model(["text"], 0), mode: "agent" },
    undefined,
  );
  assertEquals(a.getContextUsage(), undefined);
});

Deno.test("getContextUsage estimates a positive footprint", () => {
  const a = newAgent(
    { id: "test", model: model(["text"], 100000), mode: "agent" },
    undefined,
  );
  a.loadHistoryMessages([newUserMessage("hello world")]);
  const usage = a.getContextUsage();
  assert(usage !== undefined);
  assert(usage!.totalTokens > 0);
  assertEquals(usage!.contextWindow, 100000);
  assert(usage!.percent !== undefined && usage!.percent > 0);
});

Deno.test("escalatedMaxTokens never exceeds the model output limit", () => {
  const a = newAgentWithLoopConfig(
    { model: model(["text"], 128000, 16384) },
    undefined,
  );
  assertEquals(a.escalatedMaxTokens(8192), 16384);
});

Deno.test("escalatedMaxTokens returns zero once at the ceiling", () => {
  const a = newAgentWithLoopConfig({ model: model(["text"], 0, 0) }, undefined);
  assertEquals(a.escalatedMaxTokens(escalatedOutputMaxTokens), 0);
  // Without a model limit the default escalation ceiling applies.
  assertEquals(
    a.escalatedMaxTokens(defaultOutputMaxTokens),
    escalatedOutputMaxTokens,
  );
});

Deno.test("tool-execution settings normalize in newAgent", () => {
  const settings = { toolExecution: { mode: "sequential", maxConcurrency: 4 } };
  const a = newAgent({ settings }, undefined);
  assertEquals(a.config.toolExecutionMode, "sequential");
  assertEquals(a.maxToolConcurrency(), 4);
});

Deno.test("tool-execution settings normalize in newAgentWithLoopConfig", () => {
  const settings = { toolExecution: { mode: "sequential", maxConcurrency: 4 } };
  const configured = newAgentWithLoopConfig({ settings }, undefined);
  assertEquals(configured.config.toolExecutionMode, "sequential");
  assertEquals(configured.maxToolConcurrency(), 4);

  const dflt = newAgentWithLoopConfig({}, undefined);
  assertEquals(dflt.config.toolExecutionMode, "parallel");
  assertEquals(dflt.maxToolConcurrency(), 10);
});

Deno.test("forced mode overwrites the configured mode", () => {
  const a = newAgentWithLoopConfig(
    { mode: "agent", forcedMode: "yolo" },
    undefined,
  );
  assertEquals(a.config.mode, "yolo");
});

Deno.test("buildFrozenPrompt registers mode tools for the run", () => {
  const registry = newRegistry("/tmp", undefined);
  const fake: Tool = {
    name: () => "read",
    description: () => "Read",
    promptSnippet: () => "Read a file",
    promptGuidelines: () => ["Read carefully"],
    parameters: () => ({ type: "object" }),
    execute: () => ({ text: "ok" }),
  };
  registry.register(fake);
  const a = newAgentWithLoopConfig({ mode: "agent" }, registry);
  assertEquals(a.isToolRegisteredForRun("read"), true);
  assertEquals(a.isToolRegisteredForRun("write"), false);
  assert(a.frozenSystemPrompt().length > 0);
  assertEquals(a.frozenToolDefinitions().length, 1);
});

Deno.test("no registry means no registered tools", () => {
  const a = newAgentWithLoopConfig({ mode: "agent" }, undefined);
  assertEquals(a.isToolRegisteredForRun("read"), false);
  assertEquals(a.frozenSystemPrompt(), "");
});

Deno.test("supportsImages reflects model input capabilities", () => {
  const a = newAgentWithLoopConfig({ model: model(["text"]) }, undefined);
  assertEquals(a.supportsImages(), false);

  a.config.model = model(["text", "image"]);
  assertEquals(a.supportsImages(), true);

  a.config.model = undefined;
  assertEquals(a.supportsImages(), false);
});

Deno.test("gateToolResultImages rejects images for text-only models", () => {
  const a = newAgentWithLoopConfig({ model: model(["text"]) }, undefined);
  const [content, gated, isError, err] = a.gateToolResultImages(
    "image output",
    [imageBlock()],
    false,
  );
  assert(err !== undefined);
  assertEquals(isError, true);
  assertEquals(gated, undefined);
  assert(content.includes("does not support image input"));
});

Deno.test("gateToolResultImages passes images through for vision models", () => {
  const a = newAgentWithLoopConfig(
    { model: model(["text", "image"]) },
    undefined,
  );
  const contents = [imageBlock()];
  const [content, gated, isError, err] = a.gateToolResultImages(
    "image output",
    contents,
    false,
  );
  assertEquals(err, undefined);
  assertEquals(isError, false);
  assertEquals(gated, contents);
  assertEquals(content, "image output");
});

Deno.test("validateImageRequestBudget rejects over-limit image payloads", () => {
  const m = model(["text", "image"]);
  const groq = newMockProvider("groq", [m], []);
  const a = newAgentWithLoopConfig(
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
  const groq = newMockProvider("groq", [m], []);
  const a = newAgentWithLoopConfig(
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
  const groq = newMockProvider("groq", [m], []);
  const a = newAgentWithLoopConfig(
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
  const a = newAgent({}, undefined);
  a.loadHistoryMessages([newUserMessage("hello")]);
  const [msgs, ctx] = a.callbackSnapshot();
  assertEquals(msgs.length, 1);
  assertEquals(ctx!.messages.length, 1);
  assertEquals(a.agentEndEvent().messages!.length, 1);
});

Deno.test("run-context helpers round-trip typed values", () => {
  const ctx = newRunContext();
  const withId = contextWithAgentID(ctx, "a1");
  assertEquals(agentIDFromContext(withId), ["a1", true]);

  const ch = (_ev: Event): boolean => true;
  const withChan = contextWithEventChan(ctx, ch);
  assertEquals(eventChanFromContext(withChan)[1], true);

  const withParent = contextWithParentRunContext(ctx, ctx);
  assertEquals(parentRunContextFromContext(withParent)[1], true);

  const withMode = contextWithParentMode(ctx, "yolo");
  assertEquals(parentModeFromContext(withMode), ["yolo", true]);
});

Deno.test("direct constructor does not build a frozen prompt", () => {
  const a = new Agent("id-1", "", {}, undefined);
  assertEquals(a.frozenSystemPrompt(), "");
  assertEquals(a.id(), "id-1");
});
