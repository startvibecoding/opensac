// The two Go builder-integration tests deferred from the bootstrap slice to
// backlog #19: the facade must register the internal agent builder so the
// public `Builder` constructs a real Agent, and the built agent must run one
// full turn against a scripted public Provider through the bridge.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import {
  eventAgentEnd,
  eventTextDelta,
  type ModelInfo,
  newBuilder,
  roleUser,
  streamDone,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../../sdk/agent/mod.ts";
// Importing the facade registers the provider factories, the provider
// resolution hook, and the internal agent builder (Go's bootstrap init()).
import "../../bootstrap.ts";
import { test } from "#testing";

const testModel: ModelInfo = {
  id: "test-model",
  name: "test-model",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 0,
  maxTokens: 0,
};

test("bootstrap facade registers the internal agent builder", () => {
  const agent = newBuilder()
    .withProvider({
      chat: async function* (): AsyncIterable<StreamEvent> {
        yield { type: streamDone };
      },
      name: () => "test",
      models: () => [testModel],
      getModel: (id) => (id === testModel.id ? testModel : undefined),
    })
    .withWorkDir(runtime.makeTempDirSync())
    .build();

  // Go asserts the returned Agent is the internal implementation: it carries a
  // non-empty agent id and an empty parent id (top-level agent).
  assert(agent.id() !== "", "agent id must not be empty");
  assertEquals(agent.parentId(), "");
});

test("built agent runs one turn through the provider bridge", async () => {
  const agent = newBuilder()
    .withProvider({
      chat: async function* (): AsyncIterable<StreamEvent> {
        yield { type: streamStart };
        yield { type: streamTextDelta, textDelta: "bridge ok" };
        yield { type: streamDone };
      },
      name: () => "test",
      models: () => [testModel],
      getModel: (id) => (id === testModel.id ? testModel : undefined),
    })
    .withWorkDir(runtime.makeTempDirSync())
    .build();

  let text = "";
  let ended = false;
  for await (const event of agent.run("hi")) {
    if (event.type === eventTextDelta) text += event.textDelta ?? "";
    else if (event.type === eventAgentEnd) ended = true;
  }
  assertEquals(text, "bridge ok");
  assert(ended, "agent must emit the end event");
  // The turn's user message lands in the agent history through the internal
  // loop (Go's TestBuilderIntegrationMessageHistory).
  const history = agent.getMessages();
  assert(
    history.some((m) => m.role === roleUser && m.content === "hi"),
    "user message must be recorded in history",
  );
});
