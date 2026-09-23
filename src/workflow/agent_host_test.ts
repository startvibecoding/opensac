// the workflow
// AgentHost binding to AgentManager and the end-to-end workflow_run tool.

import { assert, assertEquals } from "@std/assert";
import { defaultSettings } from "../config/settings.ts";
import { newMockProvider } from "../provider/mock.ts";
import {
  streamDone,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../provider/mod.ts";
import type { Model } from "../provider/types.ts";
import { Level, newManager as newSandboxManager } from "../sandbox/sandbox.ts";
import {
  type AgentFactoryOptions,
  newAgentFactoryWithOptions,
} from "../agent/factory.ts";
import { newAgentManager } from "../agent/manager.ts";
import type { Event } from "../agent/events.ts";
import { emptyCompaction } from "../agent/agent_testutil.ts";
import { AgentHost, workflowAgentID } from "./agent_host.ts";
import { newRunToolWithActive } from "./tools.ts";
import { newActiveRegistry } from "./active.ts";
import {
  type AgentTask,
  type RunState,
  statusDone,
  type Store,
} from "./types.ts";

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
  const mock = newMockProvider(
    "mock",
    [probeModel()],
    streamWith("audit complete"),
  );
  const sandboxMgr = newSandboxManager(Deno.makeTempDirSync());
  sandboxMgr.setLevel(Level.None);
  const settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync();
  const opts: AgentFactoryOptions = {
    multiAgentEnabled: true,
    delegateEnabled: false,
    workflowsEnabled: true,
  };
  const factory = newAgentFactoryWithOptions(
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
  return newAgentManager(factory);
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

Deno.test("AgentHost uses the DSL name for the agent id", async () => {
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

Deno.test("workflowAgentID includes the instance key", () => {
  assertEquals(
    workflowAgentID("handler-audit", "r1"),
    "agent-handler-audit[r1]",
  );
  assertEquals(workflowAgentID("handler-audit", ""), "agent-handler-audit");
  assertEquals(workflowAgentID("", "r1"), "");
});

Deno.test("workflow_run tool executes a read-only audit end to end", async () => {
  const manager = buildManager();
  const store = new MemoryStore();
  const active = newActiveRegistry();
  const tool = newRunToolWithActive(manager, store, active);

  const result = await tool.execute({}, {
    source:
      `workflow("readonly audit", {concurrency:2, phases:[phase("scan", parallel(agent("api", {mode:"plan", tools:["read","grep"], prompt:"audit api"}), agent("agent", {mode:"plan", tools:["read","grep"], prompt:"audit agent"}))), phase("verify", agent("cross-check", {mode:"plan", tools:["read"], prompt:"cross-check findings"}))]});`,
  });

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

Deno.test("workflow_run rejects an empty source", async () => {
  const manager = buildManager();
  const tool = newRunToolWithActive(
    manager,
    new MemoryStore(),
    newActiveRegistry(),
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
