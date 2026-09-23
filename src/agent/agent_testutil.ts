// Shared test fixtures for the src/agent ports of internal/agent. Not a test
// file itself (the name does not match Deno's test discovery patterns).

import type { Model } from "../provider/types.ts";
import { createMockProvider, MockProvider } from "../provider/mock.ts";
import { defaultSettings, type Settings } from "../config/settings.ts";
import { Level, Manager as SandboxManager } from "../sandbox/sandbox.ts";
import { createManager } from "../sandbox/sandbox.ts";
import { AgentFactory, createAgentFactory } from "./factory.ts";
import { AgentManager, createAgentManager } from "./manager.ts";
import type { CompactionSettings } from "../context/compaction.ts";
import { streamDone, type StreamEvent, streamStart } from "../provider/mod.ts";
import type { MemberDef } from "./memberdef.ts";

/** Builds a full Model value with empty pricing. */
export function testModel(id: string, name: string, provider = ""): Model {
  return {
    id,
    name,
    provider,
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

/** Empty compaction settings used by the Go test helper. */
export function emptyCompaction(): CompactionSettings {
  return { enabled: false, reserveTokens: 0, keepRecentTokens: 0 };
}

/** Builds a full MemberDef with defaults. */
export function testMemberDef(id: string): MemberDef {
  return {
    id,
    displayName: "",
    emoji: "",
    role: "",
    description: "",
    prompt: "",
    mode: "",
    tools: [],
    maxIterations: 0,
    workDir: "",
  };
}

/** The minimal normal provider stream (STREAM_START + STREAM_DONE). */
export function doneStream(): StreamEvent[] {
  return [{ type: streamStart }, { type: streamDone, stopReason: "stop" }];
}

/**
 * Builds the standard test factory/manager pair: a mock provider, a None-level
 * sandbox, and an isolated session directory.
 */
export function createTestFactoryAndManager(): [AgentFactory, AgentManager] {
  const mockProvider: MockProvider = createMockProvider(
    "mock",
    [testModel("model1", "Model 1")],
    doneStream(),
  );
  const sandboxMgr: SandboxManager = createManager(
    Deno.makeTempDirSync({ prefix: "opensac-agent-sandbox-" }),
  );
  sandboxMgr.setLevel(Level.None);
  const settings: Settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync({
    prefix: "opensac-agent-sessions-",
  });

  const factory = createAgentFactory(
    mockProvider,
    mockProvider.models()[0],
    settings,
    sandboxMgr,
    "",
    "",
    undefined,
    emptyCompaction(),
    undefined,
  );
  return [factory, createAgentManager(factory)];
}
