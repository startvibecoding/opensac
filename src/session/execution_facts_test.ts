//
// The Go tests create the session through the Manager; the
// tests here use direct DAO session/Run persistence plus the portable lease
// surface, mirroring runtime_lock_test.ts.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import { RunDAO, SessionDAO } from "../dao/mod.ts";
import {
  acquireExecutionAdmission,
  acquireMutation,
  bindRuntimeLeaseToExistingRun,
  isNonTerminalSessionRunStatus,
  nonTerminalSessionRunStatuses,
  readSessionExecutionFacts,
} from "./mod.ts";
import { openRootDB } from "./root_db.ts";
import { test } from "#testing";

function makeSession(sessionDir: string, id: string): void {
  const db = openRootDB(sessionDir);
  new SessionDAO(db.db).insertSession(
    db.db!,
    "sessions",
    id,
    `/tmp/${id}`,
    new Date().toISOString(),
    "",
    3,
    "local",
    "",
    0,
    0,
    "",
    "",
  );
}

function makeRun(
  sessionDir: string,
  sessionId: string,
  runId: string,
  status: string,
): void {
  const db = openRootDB(sessionDir);
  const now = new Date().toISOString();
  new RunDAO(db.db).insertRun(db.db!, {
    id: runId,
    sessionId,
    intentId: "",
    retryOf: "",
    attempt: 1,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: "",
    errorInfoJson: "{}",
    progressJson: "{}",
    usageJson: "{}",
    contextUsageJson: "{}",
  });
}

test("ReadSessionExecutionFactsUsesCanonicalRunAndLease", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-facts-" });
  try {
    const sessionId = "execution-facts";
    makeSession(sessionDir, sessionId);
    const guard = acquireExecutionAdmission(sessionDir, sessionId);
    try {
      makeRun(sessionDir, sessionId, "run-active", "running");
      const binding = bindRuntimeLeaseToExistingRun(
        sessionDir,
        sessionId,
        "run-active",
      );
      assertEquals(binding.purpose, "execution");
      assertEquals(binding.runId, "run-active");

      const facts = readSessionExecutionFacts(sessionDir, sessionId);
      assert(facts.sessionExists);
      assert(facts.databaseNow.getTime() > 0);
      assertEquals(facts.activeRuns.length, 1);
      assertEquals(facts.activeRuns[0].id, "run-active");
      assert(facts.lease !== null);
      assertEquals(facts.lease!.purpose, "execution");
      assertEquals(facts.lease!.runId, "run-active");
      assert(facts.lease!.valid);
      const held = guard.binding();
      assertEquals(facts.lease!.ownerInstanceId, held.ownerInstanceId);
      assertEquals(facts.lease!.epoch, held.epoch);
      assertEquals(facts.lease!.tokenHash, held.tokenHash);
    } finally {
      guard.release();
    }
  } finally {
    closeAll();
  }
});

test("ReadSessionExecutionFactsKeepsLapsedOwnLeaseValid", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-facts-" });
  try {
    const sessionId = "execution-facts-lapsed";
    makeSession(sessionDir, sessionId);
    const guard = acquireExecutionAdmission(sessionDir, sessionId);
    try {
      // Lapse the heartbeat without a fenced takeover: the row is still ours.
      const db = openRootDB(sessionDir);
      db.db!.run(
        "UPDATE session_runtime_leases SET expires_at = CAST(strftime('%s','now') AS INTEGER) - 1 WHERE session_id = ?",
        sessionId,
      );

      const facts = readSessionExecutionFacts(sessionDir, sessionId);
      assert(facts.lease !== null);
      assertEquals(facts.lease!.state, "active");
      assert(
        facts.lease!.valid,
        "a lapsed lease that still carries our identity is still ours",
      );
    } finally {
      guard.release();
    }
  } finally {
    closeAll();
  }
});

test("BindRuntimeLeaseKeepsLapsedOwnLeaseBindable", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-facts-" });
  try {
    const sessionId = "execution-facts-bind-lapsed";
    makeSession(sessionDir, sessionId);
    const guard = acquireExecutionAdmission(sessionDir, sessionId);
    try {
      makeRun(sessionDir, sessionId, "run-bind-lapsed", "running");
      // Lapse the heartbeat without a fenced takeover: the row is still ours,
      // so binding the Run must not be rejected on wall-clock expiry alone.
      const db = openRootDB(sessionDir);
      db.db!.run(
        "UPDATE session_runtime_leases SET expires_at = CAST(strftime('%s','now') AS INTEGER) - 1 WHERE session_id = ?",
        sessionId,
      );

      const binding = bindRuntimeLeaseToExistingRun(
        sessionDir,
        sessionId,
        "run-bind-lapsed",
      );
      assertEquals(binding.purpose, "execution");
      assertEquals(binding.runId, "run-bind-lapsed");
    } finally {
      guard.release();
    }
  } finally {
    closeAll();
  }
});

test("ReadSessionExecutionFactsPreservesReleasedLeaseTombstone", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-facts-" });
  try {
    const sessionId = "execution-facts-released";
    makeSession(sessionDir, sessionId);
    const lease = acquireMutation(sessionDir, sessionId);
    lease.release();

    const facts = readSessionExecutionFacts(sessionDir, sessionId);
    assert(facts.lease !== null);
    assertEquals(facts.lease!.state, "released");
    assert(!facts.lease!.valid);
    assertEquals(facts.activeRuns.length, 0);
  } finally {
    closeAll();
  }
});

test("ReadSessionExecutionFactsReportsMissingSession", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-facts-" });
  try {
    makeSession(sessionDir, "execution-facts-existing");
    const facts = readSessionExecutionFacts(
      sessionDir,
      "execution-facts-missing",
    );
    assert(!facts.sessionExists);
    assertEquals(facts.activeRuns.length, 0);
    assertEquals(facts.lease, null);
  } finally {
    closeAll();
  }
});

test("CanonicalNonTerminalSessionRunStatuses", () => {
  const want = new Set([
    "created",
    "queued",
    "running",
    "waiting_for_approval",
    "waiting_for_question",
    "cancelling",
    "terminalizing",
  ]);
  const got = nonTerminalSessionRunStatuses();
  assertEquals(got.length, want.size);
  for (const status of got) {
    assert(want.has(status));
    assert(isNonTerminalSessionRunStatus(status));
  }
  assert(!isNonTerminalSessionRunStatus("completed"));
  assert(!isNonTerminalSessionRunStatus("failed"));
});
