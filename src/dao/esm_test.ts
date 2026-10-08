import { assert, assertEquals } from "@opensac/assert";
import {
  ESMDAO,
  ESMGuidanceDAO,
  type ESMGuidanceRecord,
  type ESMObjectiveRecord,
} from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";

function objective(
  overrides: Partial<ESMObjectiveRecord> = {},
): ESMObjectiveRecord {
  return {
    sessionId: "session-esm",
    esmId: "esm-1",
    objective: "ship the feature",
    status: "active",
    tokensUsed: 100,
    timeUsedMs: 2000,
    blockedCount: 0,
    blockedReason: "",
    blockedRunId: "",
    completionReason: "",
    completionRunId: "",
    completionReview: "",
    phase: "build",
    progressSummary: "started",
    remainingWork: "everything",
    rejectionCount: 0,
    rejectionRunId: "",
    recoveryCount: 0,
    recoveryReason: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

function guidance(
  overrides: Partial<ESMGuidanceRecord> = {},
): ESMGuidanceRecord {
  return {
    id: "guide-1",
    sessionId: "session-esm",
    objectiveVersion: "v1",
    guidance: "focus on tests",
    status: "pending",
    createdAt: "2026-01-01T00:00:01Z",
    consumedAt: null,
    ...overrides,
  };
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
  } catch (error) {
    assertEquals(
      error instanceof Error ? error.message : String(error),
      message,
    );
    return;
  }
  throw new Error(`expected a throw: ${message}`);
}

Deno.test("ESM DAO round-trips an objective and preserves creation time", () => {
  const db = openTestDb();
  try {
    const dao = new ESMDAO(db);
    assertEquals(dao.get("session-esm"), undefined);

    dao.insert(db, objective());
    const loaded = dao.get("session-esm");
    assert(loaded);
    assertEquals(loaded.objective, "ship the feature");
    assertEquals(loaded.status, "active");
    assertEquals(loaded.createdAt, "2026-01-01T00:00:00Z");

    assertEquals(
      dao.update(
        db,
        objective({
          status: "blocked",
          blockedCount: 1,
          blockedReason: "waiting for review",
          updatedAt: "2026-01-01T01:00:00Z",
        }),
      ),
      true,
    );
    const updated = dao.get("session-esm");
    assert(updated);
    assertEquals(updated.status, "blocked");
    assertEquals(updated.blockedCount, 1);
    assertEquals(updated.updatedAt, "2026-01-01T01:00:00Z");
    assertEquals(
      updated.createdAt,
      "2026-01-01T00:00:00Z",
      "updating must not rewrite the creation time",
    );

    assertEquals(
      dao.update(
        db,
        objective({ sessionId: "missing" }),
      ),
      false,
      "updating an absent session reports no change",
    );

    dao.delete(db, "session-esm");
    assertEquals(dao.get("session-esm"), undefined);
    assertEquals(dao.getFrom(db, "session-esm"), undefined);
  } finally {
    closeTestDbs();
  }
});

Deno.test("ESM DAO rejects invalid records", () => {
  const db = openTestDb();
  try {
    const dao = new ESMDAO(db);
    assertThrows(() => dao.insert(db, null), "esm objective record is invalid");
    assertThrows(
      () => dao.insert(db, objective({ sessionId: "" })),
      "esm objective record is invalid",
    );
    assertThrows(() => dao.update(db, null), "esm objective record is invalid");
    assertThrows(
      () => dao.update(db, objective({ sessionId: "" })),
      "esm objective record is invalid",
    );
  } finally {
    closeTestDbs();
  }
});

Deno.test("ESM DAO lists only runnable objectives", () => {
  const db = openTestDb();
  try {
    const dao = new ESMDAO(db);
    dao.insert(db, objective({ sessionId: "session-c" }));
    dao.insert(db, objective({ sessionId: "session-a", status: "active" }));
    dao.insert(
      db,
      objective({ sessionId: "session-b", status: "complete_candidate" }),
    );
    dao.insert(db, objective({ sessionId: "session-d", status: "blocked" }));
    dao.insert(db, objective({ sessionId: "session-e", status: "done" }));

    assertEquals(dao.listRunnable(), ["session-a", "session-b", "session-c"]);
  } finally {
    closeTestDbs();
  }
});

Deno.test("ESM guidance DAO lists by status and consumes pending rows", () => {
  const db = openTestDb();
  try {
    const dao = new ESMGuidanceDAO(db);
    dao.insert(db, guidance());
    dao.insert(
      db,
      guidance({
        id: "guide-2",
        guidance: "second",
        createdAt: "2026-01-01T00:00:02Z",
      }),
    );
    dao.insert(
      db,
      guidance({
        id: "guide-3",
        sessionId: "session-other",
        createdAt: "2026-01-01T00:00:03Z",
      }),
    );
    dao.insert(
      db,
      guidance({
        id: "guide-4",
        status: "consumed",
        consumedAt: "2026-01-01T00:00:04Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );

    const all = dao.list("session-esm", "", 10);
    assertEquals(
      all.map((row) => row.id),
      ["guide-4", "guide-1", "guide-2"],
      "rows are ordered by creation time and scoped to the session",
    );
    assertEquals(
      dao.list("session-esm", "pending", 10).map((row) => row.id),
      ["guide-1", "guide-2"],
    );
    assertEquals(dao.list("session-esm", "", 1).map((row) => row.id), [
      "guide-4",
    ]);
    assertEquals(dao.list("missing-session", "", 10), []);

    dao.consume(db, "session-esm", "guide-1", "2026-01-01T00:10:00Z");
    const consumed = dao.list("session-esm", "consumed", 10);
    assertEquals(consumed.map((row) => row.id), ["guide-4", "guide-1"]);
    assertEquals(consumed[1].consumedAt, "2026-01-01T00:10:00Z");

    // Consuming twice, or from another session, must not rewrite the row.
    dao.consume(db, "session-esm", "guide-1", "2026-01-01T00:20:00Z");
    dao.consume(db, "session-other", "guide-2", "2026-01-01T00:30:00Z");
    assertEquals(
      dao.list("session-esm", "consumed", 10).find((row) =>
        row.id === "guide-1"
      )?.consumedAt,
      "2026-01-01T00:10:00Z",
    );
    assertEquals(
      dao.list("session-esm", "pending", 10).map((row) => row.id),
      ["guide-2"],
      "a consume from another session must not consume this session's row",
    );
  } finally {
    closeTestDbs();
  }
});
