//
// Deviation: the Go fixture creates a session through the Manager; these
// tests persist a session/run through the DAO and acquire the
// fenced recovery lease with `AcquireRecovery`. The `context.Context`
// cancellation fixture is dropped because the DAO layer is synchronous.

import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import { SessionDAO } from "../dao/mod.ts";
import {
  acquireExecutionAdmission,
  acquireRecovery,
  beginSessionRunRecovery,
  convergeSessionRunRecovery,
  createSessionRunAndEvent,
  getSessionRun,
  getSessionRunRecovery,
  listConversationTurns,
  listSessionRunEvents,
  markSessionRunRecoveryComplete,
  markSessionRunRecoveryFailed,
  RuntimeLeaseLostError,
  saveSessionRun,
  saveSessionRunEvent,
  type SessionRun,
  type SessionRunEvent,
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

function baseRun(overrides: Partial<SessionRun>): SessionRun {
  const now = new Date();
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: "",
    errorInfo: undefined,
    progress: undefined,
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    ...overrides,
  };
}

test("session run recovery requires a fenced recovery lease", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    makeSession(sessionDir, "recovery-record");
    const now = new Date();
    saveSessionRun(
      sessionDir,
      baseRun({
        id: "run-record",
        sessionId: "recovery-record",
        status: "running",
        startedAt: now,
        updatedAt: now,
      }),
    );
    assertThrows(
      () =>
        beginSessionRunRecovery(
          sessionDir,
          "recovery-record",
          "run-record",
          "startup",
          "owner_lost",
          3,
        ),
      RuntimeLeaseLostError,
    );

    let guard = acquireRecovery(sessionDir, "recovery-record", "run-record");
    const recovery = beginSessionRunRecovery(
      sessionDir,
      "recovery-record",
      "run-record",
      "startup",
      "owner_lost",
      3,
    );
    assertEquals(recovery.attempt, 1);
    assertEquals(recovery.state, "recovering");
    assertEquals(recovery.previousLeaseEpoch, 3);

    const nextRetry = new Date(Date.now() + 60_000);
    markSessionRunRecoveryFailed(
      sessionDir,
      "recovery-record",
      "run-record",
      "database busy",
      nextRetry,
    );
    guard.release();

    const failed = getSessionRunRecovery(sessionDir, "run-record");
    assertEquals(failed?.state, "failed");
    assertEquals(failed?.lastError, "database busy");
    assert(failed?.nextRetryAt instanceof Date);

    guard = acquireRecovery(sessionDir, "recovery-record", "run-record");
    try {
      const retried = beginSessionRunRecovery(
        sessionDir,
        "recovery-record",
        "run-record",
        "periodic",
        "owner_lost",
        guard.binding().epoch - 1,
      );
      assertEquals(retried.attempt, 2);
      assertEquals(retried.state, "recovering");
      assertEquals(retried.lastError, "");
      assertEquals(retried.nextRetryAt, null);

      markSessionRunRecoveryComplete(
        sessionDir,
        "recovery-record",
        "run-record",
      );
      const completed = getSessionRunRecovery(sessionDir, "run-record");
      assertEquals(completed?.state, "completed");
      assert(completed?.completedAt instanceof Date);
    } finally {
      guard.release();
    }
  } finally {
    closeAll();
  }
});

test("converge session run recovery atomically closes run, turn, decisions, and recovery", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    makeSession(sessionDir, "recovery-converge");
    const guard = acquireExecutionAdmission(sessionDir, "recovery-converge");
    const now = new Date();
    const run = baseRun({
      id: "run-converge",
      sessionId: "recovery-converge",
      intentId: "intent-converge",
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    let runStored = false;
    let decisionStored = false;
    try {
      createSessionRunAndEvent(
        sessionDir,
        run,
        {
          id: "event-started",
          sessionId: "",
          runId: "",
          eventType: "started",
          source: "",
          status: "",
          model: "",
          mode: "",
          timestamp: now,
          data: undefined,
        },
        {
          id: "turn-converge",
          sessionId: run.sessionId,
          intentId: run.intentId,
          runId: run.id,
          attempt: 0,
          kind: "conversation",
          status: "",
          startSeq: 0,
          endSeq: null,
          startedAt: now,
          endedAt: null,
        },
      );
      runStored = true;
      const decisionData = {
        decision: {
          id: "approval-1",
          sessionId: "recovery-converge",
          runId: "run-converge",
          kind: "approval",
          status: "pending",
        },
      };
      saveSessionRunEvent(sessionDir, {
        id: "decision-request",
        sessionId: run.sessionId,
        runId: run.id,
        eventType: "approval_requested",
        source: "",
        status: "pending",
        model: "",
        mode: "",
        timestamp: now,
        data: decisionData,
      });
      decisionStored = true;
    } finally {
      guard.release();
    }
    assert(runStored && decisionStored);

    const recoveryGuard = acquireRecovery(
      sessionDir,
      run.sessionId,
      run.id,
    );
    try {
      beginSessionRunRecovery(
        sessionDir,
        run.sessionId,
        run.id,
        "user_stop",
        "cancelled_by_user_after_owner_loss",
        1,
      );
      const finishedAt = new Date();
      run.status = "cancelled";
      run.error = "owner lost";
      run.finishedAt = finishedAt;
      const resolutionData = {
        decision: {
          id: "approval-1",
          sessionId: "recovery-converge",
          runId: "run-converge",
          kind: "approval",
          status: "cancelled",
          value: "deny_once",
        },
      };
      convergeSessionRunRecovery(
        sessionDir,
        run,
        {
          id: "event-recovered",
          sessionId: "",
          runId: "",
          eventType: "recovered",
          source: "",
          status: "cancelled",
          model: "",
          mode: "",
          timestamp: finishedAt,
          data: undefined,
        },
        [
          {
            id: "decision-resolution",
            sessionId: "",
            runId: "",
            eventType: "approval_resolved",
            source: "",
            status: "cancelled",
            model: "",
            mode: "",
            timestamp: finishedAt,
            data: resolutionData,
          } as SessionRunEvent,
        ],
        "cancelled",
        "cancelled_by_user_after_owner_loss",
      );

      const stored = getSessionRun(sessionDir, run.id);
      assertEquals(stored?.status, "cancelled");

      const turns = listConversationTurns(sessionDir, run.sessionId);
      assertEquals(turns.length, 1);
      assertEquals(turns[0].status, "cancelled");
      assert(turns[0].endSeq !== null && turns[0].endSeq !== undefined);

      const events = listSessionRunEvents(sessionDir, run.sessionId);
      let seenResolution = false;
      let seenTerminal = false;
      for (const event of events) {
        seenResolution = seenResolution || event.id === "decision-resolution";
        seenTerminal = seenTerminal || event.id === "event-recovered";
      }
      assert(seenResolution, "decision resolution event missing");
      assert(seenTerminal, "terminal recovery event missing");

      const recovery = getSessionRunRecovery(sessionDir, run.id);
      assertEquals(recovery?.state, "completed");
    } finally {
      recoveryGuard.release();
    }
  } finally {
    closeAll();
  }
});
