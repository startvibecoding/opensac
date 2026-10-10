// (AgentManager lifecycle and
// AgentFactory wiring cases). The concurrency case is omitted: Deno is
// single-threaded, so the manager's map updates are already atomic.
//
// The tests isolated under a temp OPENSAC_DIR so default-session creation never
// touches the developer's real config directory.

import {
  assert,
  assertEquals,
  assertFalse,
  assertThrows,
} from "../compat/assert.ts";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import { type Model } from "../provider/types.ts";
import { createMockProvider, type MockProvider } from "../provider/mock.ts";
import { defaultSettings, type Settings } from "../config/settings.ts";
import { AgentAdapter } from "./bridge.ts";
import { AgentFactory, createAgentFactory } from "./factory.ts";
import {
  AgentManager,
  createAgentManager,
  runtimeConfigOfManagedAgent,
} from "./manager.ts";
import { createMemberDefRegistry, MemberDefRegistry } from "./memberdef.ts";
import { createMemberMailbox } from "./mailbox.ts";

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

function createTestManager(): AgentManager {
  return createAgentManager(new AgentFactory());
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

test("AgentManagerCreate", () => {
  const m = createTestManager();
  const a = m.create({ id: "main" });
  assert(a !== undefined);
  assertEquals(a.id(), "main");
});

test("AgentManagerCreateAutoID", () => {
  const m = createTestManager();
  const a = m.create({});
  assert(a.id() !== "");
});

test("AgentManagerCreateWithParent", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  const child = m.create({ id: "sub-1", parentId: "main" });
  assertEquals(child.parentId(), "main");
  assertEquals(m.getChildren("main"), ["sub-1"]);
  const pid = m.parent("sub-1");
  assertEquals(pid, "main");
});

test("AgentManagerCreateNestedSubAgentRejected", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  assertThrows(() => m.create({ id: "sub-sub-1", parentId: "sub-1" }));
});

test("AgentManagerCreateMissingParent", () => {
  const m = createTestManager();
  assertThrows(() => m.create({ id: "orphan", parentId: "nonexistent" }));
});

test("AgentManagerGet", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  const a = m.get("main");
  assert(a !== undefined);
  assertEquals(m.get("nonexistent"), undefined);
});

test("AgentManagerDestroy", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.create({ id: "sub-2", parentId: "main" });
  assertEquals(m.count(), 3);
  m.destroy("main");
  assertEquals(m.count(), 0);
});

test("AgentManagerDestroyChild", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.create({ id: "sub-2", parentId: "main" });
  m.destroy("sub-1");
  assertEquals(m.count(), 2);
  assertEquals(m.getChildren("main"), ["sub-2"]);
});

test("AgentManagerDestroyNotFound", () => {
  const m = createTestManager();
  assertThrows(() => m.destroy("nonexistent"));
});

test(
  "AgentManagerFinishCancelsChildrenAndRetainsStatus",
  () => {
    const m = createTestManager();
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
    assertEquals(m.status("main"), undefined);
    const st = m.status("sub-1");
    assert(st !== undefined);
    assertEquals(st.state, "error");
    assertEquals(st.error, "network error");
    assert(parent instanceof AgentAdapter);
    assertFalse((parent as AgentAdapter).inner.aborted());
  },
);

test("AgentManagerFinishSuccessKeepsAsyncChildren", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  m.create({ id: "sub-1", parentId: "main" });
  m.markRunning("sub-1");

  let cancelled = false;
  m.setCancel("sub-1", () => {
    cancelled = true;
  });
  m.finish("main", undefined);

  assertFalse(cancelled);
  assertEquals(m.get("main"), undefined);
  assert(m.get("sub-1") !== undefined);
  const st = m.status("sub-1");
  assert(st !== undefined);
  assertEquals(st.state, "running");
});

test("AgentManagerList", () => {
  const m = createTestManager();
  m.create({ id: "a" });
  m.create({ id: "b" });
  m.create({ id: "c" });
  const ids = m.list();
  assertEquals(ids, ["a", "b", "c"]);
  for (let i = 0; i < 20; i++) {
    assertEquals(m.list(), ["a", "b", "c"]);
  }
});

test("AgentManagerChildrenEmpty", () => {
  const m = createTestManager();
  m.create({ id: "main" });
  assertEquals(m.getChildren("main"), undefined);
});

test("AgentManagerParentNotFound", () => {
  const m = createTestManager();
  assertEquals(m.parent("nonexistent"), undefined);
});

test("AgentManagerStatusListenerTerminalTransitions", () => {
  const m = createTestManager();
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

test(
  "AgentManagerUpdateRuntimeConfigAffectsFutureAgents",
  () => {
    const oldModel = model("old-model", "Old", "old-provider");
    const oldProvider = createMockProvider("old-provider", [oldModel], []);
    const newModel = model("new-model", "New", "new-provider");
    const newProvider = createMockProvider("new-provider", [newModel], []);
    const settings: Settings = defaultSettings();
    settings.defaultProvider = "new-provider";
    settings.defaultModel = "new-model";

    const m = createAgentManager(
      createAgentFactory(
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
  },
);

test(
  "ManagerCreatedLeadReceivesTeamToolsAndMailboxSteering",
  () => {
    const m1 = model("m1", "M1", "");
    const p = createMockProvider("mock", [m1], []);
    const factory = createAgentFactory(
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
    const manager = createAgentManager(factory);
    const mailbox = createMemberMailbox();
    manager.setMemberContext(
      createMemberDefRegistry([member("engineer")]),
      mailbox,
      "team",
    );

    const created = manager.create({
      id: "esm-worker",
      multiAgent: true,
    }) as AgentAdapter;
    assert(created.inner.registry()?.get("subagent_spawn") !== undefined);
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
    assert(critic.inner.registry()?.get("subagent_spawn") === undefined);
  },
);

// Keep the exported helpers referenced for lint parity.
void MemberDefRegistry;
