// assembly and compaction decisions: the SetForceCompact/ShouldCompact cases
// (TestSetForceCompact_ShouldCompactReturnsTrue,
// TestSetForceCompact_NoMessagesDoesNotForce,
// TestShouldCompact_OverThresholdButNoCompactableMessages, the no-model force
// case), buildRequestMessages image retention
// (TestBuildRequestMessagesRetainsImagesForUnsupportedModel), plus focused
// tests for the newly ported request-assembly helpers.

import { assert, assertEquals } from "../compat/assert.ts";
import { type ContentBlock, type Message, type Model } from "../provider/types.ts";
import {
  createAssistantMessage,
  createSystemInjectedUserMessage,
  createToolResultMessage,
  createUserMessage,
} from "../provider/types.ts";
import { createRegistry } from "../tools/mod.ts";
import { createAgent } from "./agent.ts";
import { isContextGuardToolResult } from "./agent_context.ts";
import { test } from "#testing";

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

function imageBlock(data = "base64data"): ContentBlock {
  return { type: "image", image: { mimeType: "image/png", data } };
}

test("setForceCompact drives shouldCompact and is consumed once", () => {
  const registry = createRegistry("/tmp", undefined);
  const a = createAgent(
    {
      provider: undefined,
      model: model(["text"], 100000),
      mode: "agent",
      compactionSettings: {
        enabled: false,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    },
    registry,
  );
  a.loadHistoryMessages([
    createUserMessage("Hello"),
    createAssistantMessage([{ type: "text", text: "Hi there" }]),
    createUserMessage("Second turn"),
    createAssistantMessage([{ type: "text", text: "Second response" }]),
  ]);

  assertEquals(a.shouldCompact(), false);
  a.setForceCompact();
  assertEquals(a.shouldCompact(), true);
  // The force flag is consumed.
  assertEquals(a.shouldCompact(), false);
});

test("setForceCompact without messages does not force", () => {
  const a = createAgent(
    { model: model(["text"], 100000), mode: "agent" },
    undefined,
  );
  a.setForceCompact();
  assertEquals(a.shouldCompact(), false);
});

test("setForceCompact without a model does not force", () => {
  const a = createAgent({ mode: "agent" }, undefined);
  a.loadHistoryMessages([
    createUserMessage("Hello"),
    createAssistantMessage([{ type: "text", text: "Hi" }]),
  ]);
  a.setForceCompact();
  assertEquals(a.shouldCompact(), false);
});

test("shouldCompact is false over threshold with no compactable messages", () => {
  const registry = createRegistry("/tmp", undefined);
  const a = createAgent(
    {
      model: model(["text"], 100),
      mode: "agent",
      compactionSettings: {
        enabled: true,
        reserveTokens: 10,
        keepRecentTokens: 20,
      },
    },
    registry,
  );
  a.loadHistoryMessages([
    createUserMessage("current request"),
    createAssistantMessage([{ type: "text", text: "x".repeat(500) }]),
  ]);
  assertEquals(a.shouldCompact(), false);
});

test("buildRequestMessages retains images for unsupported models", () => {
  const a = createAgent({ model: model(["text"]), mode: "agent" }, undefined);
  a.loadHistoryMessages([
    {
      role: "toolResult",
      timestamp: new Date(),
      contents: [imageBlock()],
    },
  ]);
  const messages = a.buildRequestMessages(
    createSystemInjectedUserMessage("context"),
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[1].contents!.length, 1);
  assertEquals(messages[1].contents![0].type, "image");
});

test("buildSessionContextMessage carries date, model, cwd and mode", () => {
  const registry = createRegistry("/work/dir", undefined);
  const a = createAgent(
    { model: model(["text"], 1000), mode: "yolo" },
    registry,
  );
  const msg = a.buildSessionContextMessage();
  assertEquals(msg.systemInjected, true);
  assert((msg.content ?? "").includes("- Model: m1 (m1)"));
  assert((msg.content ?? "").includes("- Working directory: /work/dir"));
  assert((msg.content ?? "").includes("- Mode: yolo"));
  assert(/Current date: \d{4}-\d{2}-\d{2}/.test(msg.content ?? ""));
});

test("requestTokenBudget derives the input budget from the window", () => {
  const a = createAgent(
    { model: model(["text"], 100000), maxTokens: 8192 },
    undefined,
  );
  const [budget, reserve, window, ok] = a.requestTokenBudget();
  assertEquals(ok, true);
  assertEquals(window, 100000);
  assertEquals(reserve, 8192);
  assertEquals(budget, 100000 - 8192);

  const noModel = createAgent({}, undefined);
  assertEquals(noModel.requestTokenBudget(), [0, 0, 0, false]);
});

test("maxTokensForRequest clamps to the context window", () => {
  const a = createAgent(
    { model: model(["text"], 1000), maxTokens: 800 },
    undefined,
  );
  const clamped = a.maxTokensForRequest([
    createSystemInjectedUserMessage("context"),
    createUserMessage("hello"),
  ]);
  assert(clamped < 800);
  assert(clamped > 0);
});

test("replaceLargestToolResultForContext replaces the largest result", () => {
  const registry = createRegistry("/tmp", undefined);
  const a = createAgent(
    {
      model: model(["text"], 100000),
      mode: "agent",
      compactionSettings: {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
    },
    registry,
  );
  a.loadHistoryMessages([
    createUserMessage("run tools"),
    createAssistantMessage([
      { type: "text", text: "calling" },
    ]),
    createToolResultMessage("t1", "small_tool", "short", false),
    createToolResultMessage("t2", "big_tool", "y".repeat(4000), false),
  ]);

  const toolName = a.replaceLargestToolResultForContext(
    5000,
    1000,
    100000,
    8000,
  );
  assertEquals(toolName, "big_tool");
  const messages = a.getMessages();
  const guarded = messages.filter((m: Message) => isContextGuardToolResult(m));
  assertEquals(guarded.length, 1);
  assertEquals(guarded[0].toolName, "big_tool");
});

test("previousCompactionSummary falls back to the Goal message", () => {
  const a = createAgent({ model: model(["text"]), mode: "agent" }, undefined);
  const goal = createSystemInjectedUserMessage("## Goal\nShip it");
  const summary = a.previousCompactionSummary([goal]);
  assertEquals(summary, "## Goal\nShip it");
  assertEquals(a.previousCompactionSummary([]), "");
});
