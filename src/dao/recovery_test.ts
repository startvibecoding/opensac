import { assert, assertEquals } from "../compat/assert.ts";
import { ForkDAO, RecoveryDAO, type RecoveryRecord } from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";
import { test } from "#testing";

const SESSION = "session-recovery";

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    runId: "run-recovery",
    sessionId: SESSION,
    state: "pending",
    triggerSource: "startup",
    reasonCode: "orphaned",
    attempt: 1,
    previousLeaseEpoch: 3,
    lastError: "boom",
    nextRetryAt: 1000,
    startedAt: 10,
    updatedAt: 20,
    completedAt: null,
    ...overrides,
  };
}

// TestRecoveryDAOUpsertBumpsAttemptAndClearsRetryState pins the retry bookkeeping:
// a re-upsert of the same run counts as another attempt and clears the previous
// error/retry deadline instead of overwriting them.
test("recovery DAO upsert counts attempts and clears retry state", () => {
  const db = openTestDb();
  try {
    const dao = new RecoveryDAO(db);
    assertEquals(dao.find(db, "run-recovery"), undefined);

    dao.upsert(db, record());
    const first = dao.find(db, "run-recovery");
    assert(first);
    assertEquals(first.attempt, 1);
    assertEquals(first.state, "pending");
    assertEquals(first.lastError, "boom");
    assertEquals(first.nextRetryAt, 1000);
    assertEquals(first.previousLeaseEpoch, 3);

    dao.upsert(
      db,
      record({
        state: "retrying",
        attempt: 99,
        lastError: "",
        nextRetryAt: null,
        startedAt: 30,
        updatedAt: 40,
      }),
    );
    const second = dao.find(db, "run-recovery");
    assert(second);
    assertEquals(second.attempt, 2, "the stored attempt is incremented");
    assertEquals(second.state, "retrying");
    assertEquals(second.lastError, "", "a new attempt starts without an error");
    assertEquals(second.nextRetryAt, null);
    assertEquals(second.startedAt, 30);
    assertEquals(second.previousLeaseEpoch, 3);
    assertEquals(dao.find(db, "missing"), undefined);
  } finally {
    closeTestDbs();
  }
});

test("recovery DAO update matches run and session together", () => {
  const db = openTestDb();
  try {
    const dao = new RecoveryDAO(db);
    dao.upsert(db, record());

    assertEquals(
      dao.update(db, "run-recovery", SESSION, "completed", "", null, 50, 60),
      true,
    );
    const updated = dao.find(db, "run-recovery");
    assertEquals(updated?.state, "completed");
    assertEquals(updated?.updatedAt, 50);
    assertEquals(updated?.completedAt, 60);

    assertEquals(
      dao.update(
        db,
        "run-recovery",
        "other-session",
        "completed",
        "",
        null,
        0,
        0,
      ),
      false,
      "a mismatched session must not touch the row",
    );
    assertEquals(
      dao.update(db, "missing-run", SESSION, "completed", "", null, 0, 0),
      false,
    );
    assertEquals(dao.find(db, "run-recovery")?.state, "completed");
  } finally {
    closeTestDbs();
  }
});

test("recovery DAO lists open turns with the run that opened them", () => {
  const db = openTestDb();
  try {
    const dao = new RecoveryDAO(db);
    const forkDAO = new ForkDAO(db);

    forkDAO.insertTurn(
      db,
      "turn-1",
      SESSION,
      "intent-1",
      "conversation",
      "open",
      1,
      null,
      "2026-01-01T00:00:01Z",
      null,
    );
    forkDAO.insertRawEntry(
      db,
      SESSION,
      "entry-turn-1",
      "turn_start",
      null,
      "2026-01-01T00:00:01Z",
      `{"turnId":"turn-1","runId":"run-opened"}`,
    );
    forkDAO.insertTurn(
      db,
      "turn-2",
      SESSION,
      "intent-1",
      "conversation",
      "open",
      2,
      null,
      "2026-01-01T00:00:02Z",
      null,
    );
    forkDAO.insertTurn(
      db,
      "turn-3",
      SESSION,
      "intent-1",
      "conversation",
      "closed",
      3,
      3,
      "2026-01-01T00:00:03Z",
      "2026-01-01T00:00:04Z",
    );

    const openTurns = dao.listOpenTurns(db, SESSION);
    assertEquals(
      openTurns.map((turn) => turn.id),
      ["turn-1", "turn-2"],
      "only open turns are listed, ordered by start sequence",
    );
    assertEquals(openTurns[0].runId, "run-opened");
    assertEquals(openTurns[0].intentId, "intent-1");
    assertEquals(
      openTurns[1].runId,
      "",
      "a turn without a turn_start entry reports no run",
    );
    assertEquals(dao.listOpenTurns(db, "missing"), []);
  } finally {
    closeTestDbs();
  }
});
