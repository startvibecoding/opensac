// the workflow
// AgentHost binding to AgentManager and the end-to-end workflow_run tool.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { defaultSettings } from "../config/settings.ts";
import { createMockProvider } from "../provider/mock.ts";
import {
  streamDone,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../provider/mod.ts";
import { type Model } from "../provider/types.ts";
import {
  createManager as newSandboxManager,
  Level,
} from "../sandbox/sandbox.ts";
import {
  type AgentFactoryOptions,
  createAgentFactory,
} from "../agent/factory.ts";
import { createAgentManager } from "../agent/manager.ts";
import { type Event } from "../agent/events.ts";
import { emptyCompaction } from "../agent/agent_testutil.ts";
import { AgentHost, workflowAgentID } from "./agent_host.ts";
import { createRunTool } from "./tools.ts";
import { createActiveRegistry } from "./active.ts";
import {
  type AgentTask,
  type RunState,
  statusDone,
  type Store,
} from "./types.ts";
import { test } from "#testing";

function probeModel(): Model {
  return {
    id: "model1",
    name: "Model 1",
    provider: "mock",
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

function streamWith(text: string): StreamEvent[] {
  return [
    { type: streamStart },
    { type: streamTextDelta, textDelta: text },
    { type: streamDone, stopReason: "stop" },
  ];
}

function buildManager() {
  const mock = createMockProvider(
    "mock",
    [probeModel()],
    streamWith("audit complete"),
  );
  const sandboxMgr = newSandboxManager(runtime.makeTempDirSync());
  sandboxMgr.setLevel(Level.None);
  const settings = defaultSettings();
  settings.sessionDir = runtime.makeTempDirSync();
  const opts: AgentFactoryOptions = {
    multiAgentEnabled: true,
    delegateEnabled: false,
    workflowsEnabled: true,
  };
  const factory = createAgentFactory(
    mock,
    mock.models()[0],
    settings,
    sandboxMgr,
    "",
    "",
    undefined,
    emptyCompaction(),
    undefined,
    opts,
  );
  return createAgentManager(factory);
}

/** An in-memory Store mirroring the Go test memoryStore. */
class MemoryStore implements Store {
  runs = new Map<string, RunState>();

  save(state: RunState): Promise<void> {
    this.runs.set(state.id, state);
    return Promise.resolve();
  }

  load(id: string): Promise<RunState> {
    const state = this.runs.get(id);
    if (state === undefined) {
      return Promise.reject(new Error(`workflow ${id} not found`));
    }
    return Promise.resolve(state);
  }

  list(): Promise<RunState[]> {
    return Promise.resolve([...this.runs.values()]);
  }
}

test("AgentHost uses the DSL name for the agent id", async () => {
  const manager = buildManager();
  const events: Event[] = [];
  const sink = (ev: Event) => {
    events.push(ev);
    return true;
  };
  const host = new AgentHost();
  host.manager = manager;
  host.parentMode = "plan";
  host.parentSink = sink;

  const task: AgentTask = {
    name: "handler-audit",
    mode: "plan",
    tools: ["read"],
    prompt: "Audit the handler.",
  };
  await host.runAgent(task);

  assert(
    events.some((ev) => ev.agentId === "agent-handler-audit"),
    "expected a forwarded event from agent-handler-audit",
  );
});

test("workflowAgentID includes the instance key", () => {
  assertEquals(
    workflowAgentID("handler-audit", "r1"),
    "agent-handler-audit[r1]",
  );
  assertEquals(workflowAgentID("handler-audit", ""), "agent-handler-audit");
  assertEquals(workflowAgentID("", "r1"), "");
});

test("workflow_run tool executes a read-only audit end to end", async () => {
  const manager = buildManager();
  const store = new MemoryStore();
  const active = createActiveRegistry();
  const tool = createRunTool(manager, store, active);

  const result = await tool.execute(
    {},
    {
      source: `workflow("readonly audit", {concurrency:2, phases:[phase("scan", parallel(agent("api", {mode:"plan", tools:["read","grep"], prompt:"audit api"}), agent("agent", {mode:"plan", tools:["read","grep"], prompt:"audit agent"}))), phase("verify", agent("cross-check", {mode:"plan", tools:["read"], prompt:"cross-check findings"}))]});`,
    },
  );

  const parsed = JSON.parse(result.text) as {
    id: string;
    status: string;
    results: Record<string, string>;
  };
  assertEquals(parsed.status, statusDone);
  assertEquals(parsed.results["scan.api"], statusDone);
  assertEquals(parsed.results["scan.agent"], statusDone);
  assertEquals(parsed.results["verify.cross-check"], statusDone);
  assertEquals(active.isActive(parsed.id), false);

  const state = await store.load(parsed.id);
  assertEquals(state.phases!.length, 2);
});

test("workflow_run rejects an empty source", async () => {
  const manager = buildManager();
  const tool = createRunTool(
    manager,
    new MemoryStore(),
    createActiveRegistry(),
  );
  let threw = false;
  try {
    await tool.execute({}, { source: "   " });
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes("source is required"));
  }
  assert(threw, "empty source must be rejected");
});
