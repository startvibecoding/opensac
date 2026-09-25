// (AgentFactory runtime-config inheritance, provider-name propagation, and the
// compile-time AgentAdapter interface assertion).

import { assert, assertEquals } from "@std/assert";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import type { Agent as PublicAgent } from "../../sdk/agent/types.ts";
import { defaultSettings, type Settings } from "../config/settings.ts";
import { Level, Manager as SandboxManager } from "../sandbox/sandbox.ts";
import { createManager } from "../sandbox/sandbox.ts";
import { createNoneSandbox } from "../sandbox/none.ts";
import { createMockProvider } from "../provider/mock.ts";
import { createRegistry } from "../tools/tool.ts";
import { createAgentWithLoopConfig } from "./agent.ts";
import { AgentAdapter, createAgentAdapter } from "./bridge.ts";
import { createAgentFactory } from "./factory.ts";
import { createAgentManager, runtimeConfigOfManagedAgent } from "./manager.ts";
import { emptyCompaction, testModel } from "./agent_testutil.ts";

// Compile-time assertion: AgentAdapter satisfies the public Agent interface.
const _adapterSatisfiesInterface: PublicAgent = new AgentAdapter(
  createAgentWithLoopConfig({ mode: "yolo" }, undefined),
);
void _adapterSatisfiesInterface;

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

test(
  "AgentManagerChildInheritsParentBeforeToolCallPolicy",
  () => {
    const mockProvider = createMockProvider(
      "mock",
      [testModel("model1", "Model 1")],
      [],
    );
    const settings: Settings = defaultSettings();
    settings.sessionDir = Deno.makeTempDirSync({ prefix: "opensac-sessions-" });
    const factory = createAgentFactory(
      mockProvider,
      mockProvider.models()[0],
      settings,
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

    const parentRegistry = createRegistry(
      Deno.makeTempDirSync({ prefix: "opensac-parent-reg-" }),
      createNoneSandbox(),
    );
    const parent = createAgentWithLoopConfig({
      id: "parent",
      mode: "yolo",
      forcedMode: "yolo",
      beforeToolCall: () => ({ block: true, reason: "inherited policy" }),
    }, parentRegistry);
    manager.register(createAgentAdapter(parent));

    const child = manager.create({
      parentId: parent.id(),
      mode: "plan",
      workDir: Deno.makeTempDirSync({ prefix: "opensac-child-" }),
    }) as AgentAdapter;
    const childConfig = runtimeConfigOfManagedAgent(child);
    assert(childConfig !== undefined);
    assert(childConfig.beforeToolCall !== undefined);
    assertEquals(childConfig.mode, "yolo");
    assertEquals(childConfig.forcedMode, "yolo");
    const decision = childConfig.beforeToolCall?.({
      assistantMessage: { role: "assistant", timestamp: new Date() },
      toolCall: { id: "t", name: "bash", kind: "function" },
      args: {},
      context: null,
    });
    assert(decision !== undefined && decision.block);
    assertEquals(decision.reason, "inherited policy");
  },
);

test(
  "AgentManagerChildInheritsParentBeforeToolExecuteFence",
  () => {
    const mockProvider = createMockProvider(
      "mock",
      [testModel("model1", "Model 1")],
      [],
    );
    const settings: Settings = defaultSettings();
    settings.sessionDir = Deno.makeTempDirSync({ prefix: "opensac-sessions-" });
    const factory = createAgentFactory(
      mockProvider,
      mockProvider.models()[0],
      settings,
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

    const parentRegistry = createRegistry(
      Deno.makeTempDirSync({ prefix: "opensac-parent-reg-" }),
      createNoneSandbox(),
    );
    const parent = createAgentWithLoopConfig({
      id: "parent-fence",
      mode: "yolo",
      forcedMode: "yolo",
      beforeToolExecute: () => ({ block: true, reason: "inherited fence" }),
    }, parentRegistry);
    manager.register(createAgentAdapter(parent));

    const child = manager.create({
      parentId: parent.id(),
      mode: "plan",
      workDir: Deno.makeTempDirSync({ prefix: "opensac-child-" }),
    }) as AgentAdapter;
    const childConfig = runtimeConfigOfManagedAgent(child);
    assert(childConfig !== undefined);
    assert(childConfig.beforeToolExecute !== undefined);
    const decision = childConfig.beforeToolExecute?.({
      toolCall: { id: "t", name: "bash", kind: "function" },
      args: {},
      context: null,
      executionContext: {},
      runId: "",
      executionKey: "",
      sideEffecting: false,
    });
    assert(decision !== undefined && decision.block);
    assertEquals(decision.reason, "inherited fence");
  },
);

test("AgentFactoryWorkflowPromptNotInheritedByChild", () => {
  const mockProvider = createMockProvider(
    "mock",
    [testModel("model1", "Model 1")],
    [],
  );
  const sandboxMgr: SandboxManager = createManager(
    Deno.makeTempDirSync({ prefix: "opensac-sandbox-" }),
  );
  sandboxMgr.setLevel(Level.None);
  const settings: Settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync({ prefix: "opensac-sessions-" });
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
    { multiAgentEnabled: true, delegateEnabled: true, workflowsEnabled: true },
  );
  const mgr = createAgentManager(factory);

  const parent = mgr.create({ id: "main" }) as AgentAdapter;
  assert(parent.inner.config.workflows === true);
  assert(contains(parent.inner.frozenSystemPrompt(), "Workflow Tools"));

  const child = mgr.create({ id: "child", parentId: "main" }) as AgentAdapter;
  assert(child.inner.config.multiAgent !== true);
  assert(child.inner.config.delegateMode !== true);
  assert(child.inner.config.workflows !== true);
  assert(!contains(child.inner.frozenSystemPrompt(), "Workflow Tools"));
});

test("AgentFactoryPropagatesProviderNameToChildren", () => {
  const mockProvider = createMockProvider(
    "underlying-vendor",
    [testModel("model1", "Model 1")],
    [],
  );
  const sandboxMgr: SandboxManager = createManager(
    Deno.makeTempDirSync({ prefix: "opensac-sandbox-" }),
  );
  sandboxMgr.setLevel(Level.None);
  const settings: Settings = defaultSettings();
  settings.sessionDir = Deno.makeTempDirSync({ prefix: "opensac-sessions-" });
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
    {
      multiAgentEnabled: true,
      delegateEnabled: false,
      workflowsEnabled: false,
      providerName: "configured-provider",
    },
  );
  const mgr = createAgentManager(factory);

  const parent = mgr.create({ id: "main" }) as AgentAdapter;
  assertEquals(parent.inner.config.vendor, "configured-provider");

  const child = mgr.create({ id: "child", parentId: "main" }) as AgentAdapter;
  assertEquals(child.inner.config.vendor, "configured-provider");

  const nextProvider = createMockProvider(
    "next-underlying-vendor",
    [testModel("model2", "Model 2")],
    [],
  );
  mgr.updateRuntimeConfig(
    nextProvider,
    "next-configured-provider",
    nextProvider.models()[0],
    settings,
    undefined,
  );
  const next = mgr.create({ id: "after-switch" }) as AgentAdapter;
  assertEquals(next.inner.config.vendor, "next-configured-provider");
});
