//
// The Go tests create the session through the Manager; the
// tests here use direct DAO session/Run persistence plus the portable lease
// surface, mirroring runtime_lock_test.ts.

import { assert, assertEquals } from "@std/assert";
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

Deno.test("ReadSessionExecutionFactsUsesCanonicalRunAndLease", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-facts-" });
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

Deno.test("ReadSessionExecutionFactsPreservesReleasedLeaseTombstone", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-facts-" });
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

Deno.test("ReadSessionExecutionFactsReportsMissingSession", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-facts-" });
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

Deno.test("CanonicalNonTerminalSessionRunStatuses", () => {
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
