// Focused tests for the SessionRuntime-bound source resolvers ported from
// internal/agentruntime/session_runtime.go (`resolveManagerSource` /
// `resolveManagerPolicy`). Go exercises these only through the agent-manager
// integration cases; these cover the precedence and conflict rules directly.

import { assertEquals, assertThrows } from "@std/assert";
import { createManager } from "../session/manager.ts";
import { closeDatabases } from "../session/root_db.ts";
import {
  resolveManagerPolicy,
  resolveManagerSource,
} from "./session_source.ts";
import { SOURCE_TUI, SOURCE_WE_CHAT, SourceConflictError } from "./source.ts";

Deno.test("resolveManagerSourcePrefersPersistedBindingOverRequest", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-source-" });
  try {
    const manager = createManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithBinding("wechat", "source-user");
    const resolved = resolveManagerSource(manager, { requested: SOURCE_TUI });
    assertEquals(resolved.source, SOURCE_WE_CHAT);
    assertEquals(resolved.conflicted, false);
  } finally {
    closeDatabases();
  }
});

Deno.test("resolveManagerSourceFallsBackToRequestWithoutManager", () => {
  const resolved = resolveManagerSource(undefined, { requested: SOURCE_TUI });
  assertEquals(resolved.source, SOURCE_TUI);
  assertEquals(resolved.conflicted, false);
});

Deno.test("resolveManagerSourceThrowsOnConflictingCurrent", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-source-" });
  try {
    const manager = createManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithBinding("wechat", "source-user");
    assertThrows(
      () => resolveManagerSource(manager, { current: SOURCE_TUI }),
      SourceConflictError,
    );
  } finally {
    closeDatabases();
  }
});

Deno.test("resolveManagerPolicyAppliesForcedChannelMode", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-source-" });
  try {
    const manager = createManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithBinding("wechat", "source-user");
    const result = resolveManagerPolicy(
      manager,
      { requested: SOURCE_TUI },
      "plan",
      "plan",
      "agent",
    );
    assertEquals(result.resolution.source, SOURCE_WE_CHAT);
    assertEquals(result.mode, "yolo");
  } finally {
    closeDatabases();
  }
});

Deno.test("resolveManagerPolicyUsesDefaultWhenUnbound", () => {
  const result = resolveManagerPolicy(undefined, {}, "", "", "agent");
  assertEquals(result.mode, "agent");
});
