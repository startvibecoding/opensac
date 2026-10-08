// (the tool-surface, status/send/destroy, and parameter-validation cases).

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@opensac/assert";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import type { Tool } from "../tools/tool.ts";
import { createRegistry } from "../tools/tool.ts";
import { createNoneSandbox } from "../sandbox/none.ts";
import { createTestFactoryAndManager } from "./agent_testutil.ts";
import { subAgentToolNames } from "./subagent_support.ts";
import {
  DelegateSubAgentTool,
  registerSubAgentTools,
  SubAgentDestroyTool,
  SubAgentSendTool,
  SubAgentSpawnTool,
  SubAgentStatusTool,
} from "./subagent.ts";

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test("SubAgentToolsImplementToolInterface", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tools: Tool[] = [
    new SubAgentSpawnTool(mgr),
    new SubAgentStatusTool(mgr),
    new SubAgentSendTool(mgr),
    new SubAgentDestroyTool(mgr),
    new DelegateSubAgentTool(mgr),
  ];
  for (const tool of tools) {
    assert(tool.name() !== "");
  }
});

test("SubAgentToolsDescriptions", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tools: Tool[] = [
    new SubAgentSpawnTool(mgr),
    new SubAgentStatusTool(mgr),
    new SubAgentSendTool(mgr),
    new SubAgentDestroyTool(mgr),
  ];
  for (const tool of tools) {
    assert(tool.name() !== "");
    assert(tool.description() !== "");
    assert(tool.parameters() !== undefined);
  }
});

test("SubAgentToolNamesMatchRegisteredTools", () => {
  const [, mgr] = createTestFactoryAndManager();
  const registry = createRegistry(
    Deno.makeTempDirSync({ prefix: "opensac-agent-registry-" }),
    createNoneSandbox(),
  );
  registerSubAgentTools(registry, mgr);

  const registered = new Set<string>();
  for (const tool of registry.all()) {
    if (tool.name().startsWith("subagent_")) registered.add(tool.name());
  }
  const names = subAgentToolNames();
  assert(names.length > 0);
  for (const name of names) {
    assert(name.startsWith("subagent_"));
    assert(registered.has(name));
  }
  assertEquals(registered.size, names.length);
});

test("SubAgentStatusTool", () => {
  const [, mgr] = createTestFactoryAndManager();
  const a = mgr.create({ id: "test-agent" });
  const tool = new SubAgentStatusTool(mgr);
  const result = tool.execute({}, { handle: a.id() });
  assertEquals(parse(result.text)["handle"], "test-agent");
});

test("SubAgentStatusToolNotFound", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentStatusTool(mgr);
  assertThrows(() => tool.execute({}, { handle: "nonexistent" }));
});

test("SubAgentStatusToolAfterParentFinish", () => {
  const [, mgr] = createTestFactoryAndManager();
  mgr.create({ id: "main" });
  mgr.create({ id: "sub-1", parentId: "main" });
  mgr.markDone("sub-1", "finished work");
  mgr.finish("main", undefined);

  const tool = new SubAgentStatusTool(mgr);
  const result = tool.execute({}, { handle: "sub-1" });
  const parsed = parse(result.text);
  assertEquals(parsed["status"], "done");
  assertEquals(parsed["last_response"], "finished work");
});

test("SubAgentStatusToolMissingHandle", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentStatusTool(mgr);
  assertThrows(() => tool.execute({}, {}));
});

test("SubAgentSendTool", async () => {
  const [, mgr] = createTestFactoryAndManager();
  const a = mgr.create({ id: "test-agent" });
  const tool = new SubAgentSendTool(mgr);
  const result = tool.execute({}, { handle: a.id(), message: "do something" });
  assertEquals(parse(result.text)["status"], "message_sent");
  await waitForManagedAgentToStop(mgr, a.id());
  mgr.destroy(a.id());
});

test("SubAgentSendToolNotFound", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentSendTool(mgr);
  assertThrows(() =>
    tool.execute({}, { handle: "nonexistent", message: "test" })
  );
});

test("SubAgentSendToolMissingParams", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentSendTool(mgr);
  assertThrows(() => tool.execute({}, { handle: "x" }));
});

test("SubAgentDestroyTool", () => {
  const [, mgr] = createTestFactoryAndManager();
  const a = mgr.create({ id: "to-destroy" });
  const tool = new SubAgentDestroyTool(mgr);
  const result = tool.execute({}, { handle: a.id() });
  assertEquals(parse(result.text)["status"], "destroyed");
  assertEquals(mgr.get("to-destroy"), undefined);
});

test("SubAgentDestroyToolNotFound", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentDestroyTool(mgr);
  assertThrows(() => tool.execute({}, { handle: "nonexistent" }));
});

test("SubAgentDestroyToolMissingHandle", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentDestroyTool(mgr);
  assertThrows(() => tool.execute({}, {}));
});

test("SubAgentSpawnToolMissingTask", () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new SubAgentSpawnTool(mgr);
  assertThrows(() => tool.execute({}, {}));
});

test("DelegateSubAgentToolMissingTask", async () => {
  const [, mgr] = createTestFactoryAndManager();
  const tool = new DelegateSubAgentTool(mgr);
  await assertRejects(() => tool.execute({}, {}));
});

/** Polls the manager until the agent reaches a terminal state. */
async function waitForManagedAgentToStop(
  mgr: ReturnType<typeof createTestFactoryAndManager>[1],
  id: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const st = mgr.status(id);
    if (
      st !== undefined &&
      (st.state === "done" || st.state === "error" || st.state === "canceled" ||
        st.state === "incomplete")
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
