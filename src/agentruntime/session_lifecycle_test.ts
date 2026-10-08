// Focused tests for the front-end-neutral persisted session lifecycle
// (ported from internal/agentruntime/session_lifecycle.go). The Go package has
// no dedicated lifecycle test file; these cases pin the local/bound creation,
// exact-ID open, workdir-scoped open, and lease-guarded deletion contracts that
// the Go callers rely on.

import { assertEquals, assertThrows } from "@opensac/assert";
import {
  createSession,
  deleteSession,
  deleteSessionWithMutation,
  openSession,
  openSessionForWorkDir,
} from "./session_lifecycle.ts";
import { acquireSessionMutation } from "./execution_admission.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
}

Deno.test("createSession requires a work directory", () => {
  assertThrows(
    () => createSession({ workDir: "  ", sessionDir: tempDir() }),
    Error,
    "session work directory is required",
  );
});

Deno.test("createSession initializes a local session", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  const mgr = createSession({ workDir, sessionDir });
  const header = mgr.getHeader();
  assertEquals(header !== null, true);
  assertEquals(mgr.getSessionDir(), sessionDir);
  assertEquals(header!.cwd, workDir);
});

Deno.test("createSession initializes a bound channel session", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  const mgr = createSession({
    workDir,
    sessionDir,
    id: "bound-session",
    channelType: "wechat",
    channelId: "user-1",
  });
  const header = mgr.getHeader()!;
  assertEquals(header.id, "bound-session");
  assertEquals(header.channelType, "wechat");
  assertEquals(header.channelId, "user-1");
});

Deno.test("openSession opens by exact ID and requires an ID", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  const created = createSession({
    workDir,
    sessionDir,
    id: "exact-session",
  });
  assertEquals(created.getHeader()!.id, "exact-session");

  const reopened = openSession(sessionDir, "exact-session");
  assertEquals(reopened.getHeader()!.id, "exact-session");

  assertThrows(
    () => openSession(sessionDir, "  "),
    Error,
    "session ID is required",
  );
});

Deno.test("openSessionForWorkDir is workdir-scoped", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  createSession({ workDir, sessionDir, id: "scoped-session" });
  const reopened = openSessionForWorkDir(
    workDir,
    sessionDir,
    "scoped-session",
  );
  assertEquals(reopened.getHeader()!.cwd, workDir);
  assertThrows(
    () => openSessionForWorkDir("", sessionDir, "scoped-session"),
    Error,
    "session work directory and ID are required",
  );
});

Deno.test("deleteSession removes a session under the mutation lease", async () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  createSession({ workDir, sessionDir, id: "delete-me" });
  await deleteSession(sessionDir, "delete-me");
  assertThrows(() => openSession(sessionDir, "delete-me"));
});

Deno.test("deleteSessionWithMutation uses a caller-held guard", async () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  createSession({ workDir, sessionDir, id: "guarded-delete" });
  const guard = await acquireSessionMutation(
    undefined,
    sessionDir,
    "guarded-delete",
  );
  deleteSessionWithMutation(sessionDir, "guarded-delete", guard);
  guard.release();
  assertThrows(() => openSession(sessionDir, "guarded-delete"));
});
