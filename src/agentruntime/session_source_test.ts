// Focused tests for the SessionRuntime-bound source resolvers ported from
// internal/agentruntime/session_runtime.go (`resolveManagerSource` /
// `resolveManagerPolicy`). Go exercises these only through the agent-manager
// integration cases; these cover the precedence and conflict rules directly.

import { assertEquals, assertThrows } from "@std/assert";
import { newManager } from "../session/manager.ts";
import { closeDatabases } from "../session/root_db.ts";
import {
  resolveManagerPolicy,
  resolveManagerSource,
} from "./session_source.ts";
import { SourceConflictError, SourceTUI, SourceWeChat } from "./source.ts";

Deno.test("resolveManagerSourcePrefersPersistedBindingOverRequest", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-source-" });
  try {
    const manager = newManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithBinding("wechat", "source-user");
    const resolved = resolveManagerSource(manager, { requested: SourceTUI });
    assertEquals(resolved.source, SourceWeChat);
    assertEquals(resolved.conflicted, false);
  } finally {
    closeDatabases();
  }
});

Deno.test("resolveManagerSourceFallsBackToRequestWithoutManager", () => {
  const resolved = resolveManagerSource(undefined, { requested: SourceTUI });
  assertEquals(resolved.source, SourceTUI);
  assertEquals(resolved.conflicted, false);
});

Deno.test("resolveManagerSourceThrowsOnConflictingCurrent", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-source-" });
  try {
    const manager = newManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithBinding("wechat", "source-user");
    assertThrows(
      () => resolveManagerSource(manager, { current: SourceTUI }),
      SourceConflictError,
    );
  } finally {
    closeDatabases();
  }
});

Deno.test("resolveManagerPolicyAppliesForcedChannelMode", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-source-" });
  try {
    const manager = newManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithBinding("wechat", "source-user");
    const result = resolveManagerPolicy(
      manager,
      { requested: SourceTUI },
      "plan",
      "plan",
      "agent",
    );
    assertEquals(result.resolution.source, SourceWeChat);
    assertEquals(result.mode, "yolo");
  } finally {
    closeDatabases();
  }
});

Deno.test("resolveManagerPolicyUsesDefaultWhenUnbound", () => {
  const result = resolveManagerPolicy(undefined, {}, "", "", "agent");
  assertEquals(result.mode, "agent");
});
