// Translated from internal/agent/manager_test.go (AgentManager lifecycle and
// AgentFactory wiring cases). The concurrency case is omitted: Deno is
// single-threaded, so the manager's map updates are already atomic.
//
// The tests isolated under a temp OPENSAC_DIR so default-session creation never
// touches the developer's real config directory.

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { Model } from "../provider/types.ts";
import { type MockProvider, newMockProvider } from "../provider/mock.ts";
import { defaultSettings, type Settings } from "../config/settings.ts";
import { AgentAdapter } from "./bridge.ts";
import {
  AgentFactory,
  newAgentFactory,
  newAgentFactoryWithOptions,
} from "./factory.ts";
import {
  AgentManager,
  newAgentManager,
  runtimeConfigOfManagedAgent,
} from "./manager.ts";
import { MemberDefRegistry, newMemberDefRegistry } from "./memberdef.ts";
import { newMemberMailbox } from "./mailbox.ts";

Deno.env.set(
  "OPENSAC_DIR",
  Deno.makeTempDirSync({ prefix: "opensac-agent-manager-" }),
);

function model(id: string, name: string, provider: string): Model {
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

function emptyCompaction() {
  return { enabled: false, reserveTokens: 0, keepRecentTokens: 0 };
}

function newTestManager(): AgentManager {
  return newAgentManager(new AgentFactory());
}

function member(id: string): import("./memberdef.ts").MemberDef {
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

Deno.test("AgentManagerCreate", () => {
  const m = newTestManager();
  const a = m.create({ id: "main" });
  assert(a !== undefined);
  assertEquals(a.id(), "main");
});

Deno.test("AgentManagerCreateAutoID", () => {
  const m = newTestManager();
  const a = m.create({});
  assert(a.id() !== "");
});

Deno.test("AgentManagerCreateWithParent", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  const child = m.create({ id: "sub-1", parentId: "main" });
  assertEquals(child.parentId(), "main");
  assertEquals(m.getChildren("main"), ["sub-1"]);
  const [pid, ok] = m.parent("sub-1");
  assert(ok);
  assertEquals(pid, "main");
});

Deno.test("AgentManagerCreateNestedSubAgentRejected", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  assertThrows(() => m.create({ id: "sub-sub-1", parentId: "sub-1" }));
});

Deno.test("AgentManagerCreateMissingParent", () => {
  const m = newTestManager();
  assertThrows(() => m.create({ id: "orphan", parentId: "nonexistent" }));
});

Deno.test("AgentManagerGet", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  const [a, ok] = m.get("main");
  assert(ok && a !== undefined);
  const [, found] = m.get("nonexistent");
  assertFalse(found);
});

Deno.test("AgentManagerDestroy", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.create({ id: "sub-2", parentId: "main" });
  assertEquals(m.count(), 3);
  m.destroy("main");
  assertEquals(m.count(), 0);
});

Deno.test("AgentManagerDestroyChild", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.create({ id: "sub-2", parentId: "main" });
  m.destroy("sub-1");
  assertEquals(m.count(), 2);
  assertEquals(m.getChildren("main"), ["sub-2"]);
});

Deno.test("AgentManagerDestroyNotFound", () => {
  const m = newTestManager();
  assertThrows(() => m.destroy("nonexistent"));
});

Deno.test("AgentManagerFinishCancelsChildrenAndRetainsStatus", () => {
  const m = newTestManager();
  const parent = m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.markRunning("sub-1");

  let cancelled = false;
  m.setCancel("sub-1", () => {
    cancelled = true;
  });
  m.finish("main", new Error("network error"));

  assert(cancelled);
  assertEquals(m.count(), 0);
  const [, hasParentStatus] = m.status("main");
  assertFalse(hasParentStatus);
  const [st, ok] = m.status("sub-1");
  assert(ok && st !== undefined);
  assertEquals(st.state, "error");
  assertEquals(st.error, "network error");
  assert(parent instanceof AgentAdapter);
  assertFalse((parent as AgentAdapter).inner.aborted());
});

Deno.test("AgentManagerFinishSuccessKeepsAsyncChildren", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.markRunning("sub-1");

  let cancelled = false;
  m.setCancel("sub-1", () => {
    cancelled = true;
  });
  m.finish("main", undefined);

  assertFalse(cancelled);
  const [, hasMain] = m.get("main");
  assertFalse(hasMain);
  const [, hasChild] = m.get("sub-1");
  assert(hasChild);
  const [st, ok] = m.status("sub-1");
  assert(ok && st !== undefined);
  assertEquals(st.state, "running");
});

Deno.test("AgentManagerList", () => {
  const m = newTestManager();
  m.create({ id: "a" });
  m.create({ id: "b" });
  m.create({ id: "c" });
  const ids = m.list();
  assertEquals(ids, ["a", "b", "c"]);
  for (let i = 0; i < 20; i++) {
    assertEquals(m.list(), ["a", "b", "c"]);
  }
});

Deno.test("AgentManagerChildrenEmpty", () => {
  const m = newTestManager();
  m.create({ id: "main" });
  assertEquals(m.getChildren("main"), undefined);
});

Deno.test("AgentManagerParentNotFound", () => {
  const m = newTestManager();
  const [, ok] = m.parent("nonexistent");
  assertFalse(ok);
});

Deno.test("AgentManagerStatusListenerTerminalTransitions", () => {
  const m = newTestManager();
  const seen: string[] = [];
  m.addStatusListener((st) => {
    seen.push(`${st.id}:${st.state}`);
  });
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.markRunning("sub-1");
  m.markDone("sub-1", "ok");
  m.markDone("sub-1", "again");
  assertEquals(seen, ["sub-1:done"]);
});

Deno.test("AgentManagerUpdateRuntimeConfigAffectsFutureAgents", () => {
  const oldModel = model("old-model", "Old", "old-provider");
  const oldProvider = newMockProvider("old-provider", [oldModel], []);
  const newModel = model("new-model", "New", "new-provider");
  const newProvider = newMockProvider("new-provider", [newModel], []);
  const settings: Settings = defaultSettings();
  settings.defaultProvider = "new-provider";
  settings.defaultModel = "new-model";

  const m = newAgentManager(
    newAgentFactory(
      oldProvider,
      oldModel,
      defaultSettings(),
      undefined,
      "",
      "",
      undefined,
      emptyCompaction(),
      undefined,
    ),
  );
  m.updateRuntimeConfig(
    newProvider,
    "new-provider",
    newModel,
    settings,
    undefined,
  );

  const a = m.create({ id: "future" }) as AgentAdapter;
  const cfg = runtimeConfigOfManagedAgent(a);
  assert(cfg !== undefined);
  assertEquals(cfg.provider, newProvider as MockProvider);
  assertEquals(cfg.model?.id, "new-model");
  assertEquals(cfg.settings?.defaultProvider, "new-provider");
  assertEquals(cfg.settings?.defaultModel, "new-model");
});

Deno.test("ManagerCreatedLeadReceivesTeamToolsAndMailboxSteering", () => {
  const m1 = model("m1", "M1", "");
  const p = newMockProvider("mock", [m1], []);
  const factory = newAgentFactoryWithOptions(
    p,
    m1,
    defaultSettings(),
    undefined,
    "",
    "",
    undefined,
    emptyCompaction(),
    undefined,
    {
      multiAgentEnabled: true,
      delegateEnabled: false,
      workflowsEnabled: false,
    },
  );
  const manager = newAgentManager(factory);
  const mailbox = newMemberMailbox();
  manager.setMemberContext(
    newMemberDefRegistry([member("engineer")]),
    mailbox,
    "team",
  );

  const created = manager.create({
    id: "esm-worker",
    multiAgent: true,
  }) as AgentAdapter;
  assert(created.inner.registry()?.get("subagent_spawn").ok === true);
  assert(created.inner.config.getSteeringMessages !== undefined);

  mailbox.enqueue(
    {
      kind: "",
      memberId: "engineer",
      displayName: "",
      status: "done",
      payload: "completed work",
      questionId: "",
      options: [],
    } as import("./mailbox.ts").MemberCompletion,
  );
  const messages = created.inner.config.getSteeringMessages?.() ?? [];
  assertEquals(messages.length, 1);
  assertEquals(messages[0].systemInjected, true);

  const critic = manager.create({
    id: "esm-critic",
    multiAgent: false,
    tools: ["read"],
  }) as AgentAdapter;
  assert(critic.inner.registry()?.get("subagent_spawn").ok === false);
});

// Keep the exported helpers referenced for lint parity.
void MemberDefRegistry;
