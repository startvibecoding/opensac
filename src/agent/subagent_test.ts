// Translated from internal/agent/subagent_test.go and subagent_tools_test.go
// (the tool-surface, status/send/destroy, and parameter-validation cases).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Tool } from "../tools/tool.ts";
import { newRegistry } from "../tools/tool.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import { newTestFactoryAndManager } from "./agent_testutil.ts";
import { subAgentToolNames } from "./subagent_support.ts";
import {
  DelegateSubAgentTool,
  registerSubAgentTools,
  SubAgentDestroyTool,
  SubAgentSendTool,
  SubAgentSpawnTool,
  SubAgentStatusTool,
} from "./subagent.ts";

Deno.env.set(
  "MOTHX_DIR",
  Deno.makeTempDirSync({ prefix: "mothx-agent-subagent-" }),
);

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

Deno.test("SubAgentToolsImplementToolInterface", () => {
  const [, mgr] = newTestFactoryAndManager();
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

Deno.test("SubAgentToolsDescriptions", () => {
  const [, mgr] = newTestFactoryAndManager();
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

Deno.test("SubAgentToolNamesMatchRegisteredTools", () => {
  const [, mgr] = newTestFactoryAndManager();
  const registry = newRegistry(
    Deno.makeTempDirSync({ prefix: "mothx-agent-registry-" }),
    newNoneSandbox(),
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

Deno.test("SubAgentStatusTool", () => {
  const [, mgr] = newTestFactoryAndManager();
  const a = mgr.create({ id: "test-agent" });
  const tool = new SubAgentStatusTool(mgr);
  const result = tool.execute({}, { handle: a.id() });
  assertEquals(parse(result.text)["handle"], "test-agent");
});

Deno.test("SubAgentStatusToolNotFound", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentStatusTool(mgr);
  assertThrows(() => tool.execute({}, { handle: "nonexistent" }));
});

Deno.test("SubAgentStatusToolAfterParentFinish", () => {
  const [, mgr] = newTestFactoryAndManager();
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

Deno.test("SubAgentStatusToolMissingHandle", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentStatusTool(mgr);
  assertThrows(() => tool.execute({}, {}));
});

Deno.test("SubAgentSendTool", async () => {
  const [, mgr] = newTestFactoryAndManager();
  const a = mgr.create({ id: "test-agent" });
  const tool = new SubAgentSendTool(mgr);
  const result = tool.execute({}, { handle: a.id(), message: "do something" });
  assertEquals(parse(result.text)["status"], "message_sent");
  await waitForManagedAgentToStop(mgr, a.id());
  mgr.destroy(a.id());
});

Deno.test("SubAgentSendToolNotFound", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentSendTool(mgr);
  assertThrows(() =>
    tool.execute({}, { handle: "nonexistent", message: "test" })
  );
});

Deno.test("SubAgentSendToolMissingParams", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentSendTool(mgr);
  assertThrows(() => tool.execute({}, { handle: "x" }));
});

Deno.test("SubAgentDestroyTool", () => {
  const [, mgr] = newTestFactoryAndManager();
  const a = mgr.create({ id: "to-destroy" });
  const tool = new SubAgentDestroyTool(mgr);
  const result = tool.execute({}, { handle: a.id() });
  assertEquals(parse(result.text)["status"], "destroyed");
  const [, ok] = mgr.get("to-destroy");
  assert(!ok);
});

Deno.test("SubAgentDestroyToolNotFound", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentDestroyTool(mgr);
  assertThrows(() => tool.execute({}, { handle: "nonexistent" }));
});

Deno.test("SubAgentDestroyToolMissingHandle", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentDestroyTool(mgr);
  assertThrows(() => tool.execute({}, {}));
});

Deno.test("SubAgentSpawnToolMissingTask", () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new SubAgentSpawnTool(mgr);
  assertThrows(() => tool.execute({}, {}));
});

Deno.test("DelegateSubAgentToolMissingTask", async () => {
  const [, mgr] = newTestFactoryAndManager();
  const tool = new DelegateSubAgentTool(mgr);
  await assertRejects(() => tool.execute({}, {}));
});

/** Polls the manager until the agent reaches a terminal state. */
async function waitForManagedAgentToStop(
  mgr: ReturnType<typeof newTestFactoryAndManager>[1],
  id: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [st] = mgr.status(id);
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
