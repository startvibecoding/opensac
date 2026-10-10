// Regression: a freshly built Agent in an existing session must be hydrated
// with the replayed conversation history before the next user message, or the
// follow-up turn loses all prior context.

import { assert, assertEquals } from "../compat/assert.ts";
import { Builder, SessionRuntime } from "./session_runtime.ts";
import { SOURCE_TUI } from "./source.ts";
import { createSession } from "./session_lifecycle.ts";
import { create } from "../provider/factory/factory.ts";
import {
  defaultSettings,
  sandboxLevelFromSettings,
} from "../config/settings.ts";
import { createUserMessage } from "../provider/types.ts";
import { test } from "#testing";

test("buildAgent hydrates the agent with prior session messages", async () => {
  const workDir = await Deno.makeTempDir();
  const settings = defaultSettings();
  const manager = createSession({ workDir });

  // Seed one persisted user turn.
  manager.appendMessages([createUserMessage("remember the number 42")]);

  const runtime: SessionRuntime = await new Builder(
    settings,
    sandboxLevelFromSettings(settings),
  ).build(undefined, {
    source: SOURCE_TUI,
    workDir,
    workflows: false,
    browser: false,
    artifactEnabled: false,
    manager,
  });

  const providerName = settings.defaultProvider ?? "";
  const modelID = settings.defaultModel ?? "";
  const created = create(settings, providerName, modelID, {
    requireModel: true,
  });
  runtime.configureSession(
    created.provider,
    providerName,
    created.model,
    "yolo",
    "off",
  );

  const agent = runtime.buildAgent({
    provider: created.provider,
    providerName,
    model: created.model,
    settings,
    id: "lead",
    hydrateHistory: true,
  });

  const messages = agent.getMessages();
  assert(
    messages.some((m) => (m.content ?? "").includes("remember the number 42")),
    "prior user message missing from the built agent",
  );

  // The hydrated entry IDs keep the runtime-owned user-entry fence aligned.
  const [, entryIDs] = agent.getHistoryState();
  assert(entryIDs.length === messages.length);

  await runtime.shutdown();
  await Deno.remove(workDir, { recursive: true });
});

test("buildAgent without hydrateHistory leaves history empty", async () => {
  const workDir = await Deno.makeTempDir();
  const settings = defaultSettings();
  const manager = createSession({ workDir });
  manager.appendMessages([createUserMessage("earlier turn")]);

  const runtime: SessionRuntime = await new Builder(
    settings,
    sandboxLevelFromSettings(settings),
  ).build(undefined, {
    source: SOURCE_TUI,
    workDir,
    workflows: false,
    browser: false,
    artifactEnabled: false,
    manager,
  });

  const providerName = settings.defaultProvider ?? "";
  const modelID = settings.defaultModel ?? "";
  const created = create(settings, providerName, modelID, {
    requireModel: true,
  });
  runtime.configureSession(
    created.provider,
    providerName,
    created.model,
    "yolo",
    "off",
  );

  // Default (no hydrateHistory) matches ACP behavior: they replay
  // history themselves after the build.
  const agent = runtime.buildAgent({
    provider: created.provider,
    providerName,
    model: created.model,
    settings,
    id: "lead",
  });
  assertEquals(agent.getMessages().length, 0);

  await runtime.shutdown();
  await Deno.remove(workDir, { recursive: true });
});
