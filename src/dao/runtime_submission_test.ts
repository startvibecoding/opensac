import { assert, assertEquals } from "../compat/assert.ts";
import { RuntimeSubmissionDAO, type RuntimeSubmissionRecord } from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";
import { test } from "#testing";

function record(
  overrides: Partial<RuntimeSubmissionRecord> = {},
): RuntimeSubmissionRecord {
  return {
    id: "sub-1",
    sessionId: "session-sub",
    scope: "prompt",
    keyHash: "hash-abc",
    requestFingerprint: "fp-abc",
    intentId: "intent-1",
    runId: "run-1",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// TestRuntimeSubmissionDAORoundTrip guards the idempotency key lookup: the
// same (session, scope, key) must resolve the stored intent/run, and any other
// triple must miss so the caller can submit again.
test("runtime submission DAO finds rows by session scope and key", () => {
  const db = openTestDb();
  try {
    const dao = new RuntimeSubmissionDAO(db);
    dao.insert(db, record());

    const found = dao.find(db, "session-sub", "prompt", "hash-abc");
    assert(found);
    assertEquals(found.requestFingerprint, "fp-abc");
    assertEquals(found.intentId, "intent-1");
    assertEquals(found.runId, "run-1");
    assertEquals(found.createdAt, "2026-01-01T00:00:00Z");

    assertEquals(
      dao.find(db, "session-other", "prompt", "hash-abc"),
      undefined,
    );
    assertEquals(
      dao.find(db, "session-sub", "attachment", "hash-abc"),
      undefined,
    );
    assertEquals(
      dao.find(db, "session-sub", "prompt", "hash-other"),
      undefined,
    );
  } finally {
    closeTestDbs();
  }
});
