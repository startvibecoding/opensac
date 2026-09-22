// Ported from internal/session/bindings_test.go
//
// The Manager-based bound-session setup is replaced with direct channel-tool
// persistence so the portable binding surface is exercised without the
// not-yet-ported session Manager.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import { SessionDAO } from "../dao/mod.ts";
import {
  type ChannelToolConfig,
  findBinding,
  getChannelToolGeneration,
  listBindings,
  listChannelTools,
  setChannelTools,
  validateBinding,
} from "./bindings.ts";
import { openRootDB } from "./root_db.ts";

Deno.test("channel tools persist for a session", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const sessionId = "session-channel-tools";
    const db = openRootDB(sessionDir);
    new SessionDAO(db.db).insertSession(
      db.db!,
      "sessions",
      sessionId,
      "/tmp/channel-tools",
      new Date().toISOString(),
      "",
      3,
      "feishu",
      "chat-123",
      0,
      0,
      "",
      "",
    );
    const want: ChannelToolConfig[] = [
      { toolName: "bash", enabled: false },
      { toolName: "read", enabled: true },
    ];
    setChannelTools(sessionDir, sessionId, want);
    const got = listChannelTools(sessionDir, sessionId);
    assertEquals(got.length, want.length);
    // Ordered by tool name: bash, read.
    assertEquals(got[0], want[0]);
    assertEquals(got[1], want[1]);
    assert(getChannelToolGeneration(sessionDir, sessionId) >= 1);
  } finally {
    closeAll();
  }
});

Deno.test("channel binding validation", () => {
  validateBinding("", "");
  validateBinding("local", "");
  validateBinding("wechat", "user-1");
  validateBinding("feishu", "chat-1");
  assertThrows(() => validateBinding("local", "id"));
  assertThrows(() => validateBinding("wechat", ""));
  assertThrows(() => validateBinding("email", "id"));
});

Deno.test("find binding returns null for missing identity", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    // Ensure the schema exists before querying.
    openRootDB(sessionDir);
    assertEquals(findBinding(sessionDir, "wechat", "nobody"), null);
    assertEquals(listBindings(sessionDir), []);
  } finally {
    closeAll();
  }
});
