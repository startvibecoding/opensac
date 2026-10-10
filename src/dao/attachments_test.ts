import { assert, assertEquals } from "../compat/assert.ts";
import { AttachmentDAO, type AttachmentRecord } from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";
import { test } from "#testing";

function record(overrides: Partial<AttachmentRecord>): AttachmentRecord {
  return {
    id: "",
    sessionId: "",
    runId: "",
    origin: "",
    kind: "",
    filename: "",
    mediaType: "",
    bytes: 0,
    sha256: "",
    storageKey: "",
    status: "",
    createdAt: "",
    expiresAt: "",
    metadata: "",
    ...overrides,
  };
}

// TestAttachmentDAOListStorageReferencesReturnsEveryRow proves the reference
// set covers every session and lifecycle status.
test("attachment DAO list storage references returns every row", () => {
  const db = openTestDb();
  try {
    const now = Date.now();
    const rows: AttachmentRecord[] = [
      record({
        id: "0000000000000001",
        sessionId: "session-a",
        kind: "file",
        storageKey: "artifacts/0000000000000001/content",
        status: "accepted",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
      }),
      record({
        id: "0000000000000002",
        sessionId: "session-b",
        kind: "image",
        storageKey: "artifacts/0000000000000002/content",
        status: "expired",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now - 3_600_000).toISOString(),
      }),
    ];
    for (const row of rows) new AttachmentDAO(null).insert(db, row);

    const references = new AttachmentDAO(db).listStorageReferences(db);
    assertEquals(references.length, rows.length);
    const byId = new Map(references.map((r) => [r.id, r.storageKey]));
    for (const row of rows) {
      assertEquals(byId.get(row.id), row.storageKey);
    }
  } finally {
    closeTestDbs();
  }
});

test("attachment DAO list by session optional status", () => {
  const db = openTestDb();
  try {
    const attachmentDAO = new AttachmentDAO(db);
    const records: AttachmentRecord[] = [
      record({
        id: "att-2",
        sessionId: "session-a",
        runId: "run-1",
        kind: "file",
        filename: "second.txt",
        mediaType: "text/plain",
        bytes: 2,
        status: "generated",
        createdAt: "2026-01-01T00:00:02Z",
      }),
      record({
        id: "att-1",
        sessionId: "session-a",
        runId: "run-1",
        kind: "image",
        filename: "first.png",
        mediaType: "image/png",
        bytes: 1,
        status: "accepted",
        createdAt: "2026-01-01T00:00:01Z",
      }),
      record({
        id: "att-foreign",
        sessionId: "session-b",
        runId: "run-2",
        kind: "file",
        filename: "foreign.txt",
        mediaType: "text/plain",
        bytes: 3,
        status: "generated",
        createdAt: "2026-01-01T00:00:03Z",
      }),
    ];
    for (const rec of records) attachmentDAO.insert(db, rec);

    const all = attachmentDAO.listBySession("session-a", "");
    assert(
      all.length === 2 && all[0].id === "att-1" && all[1].id === "att-2",
      `all rows = ${JSON.stringify(all)}`,
    );
    const generated = attachmentDAO.listBySession("session-a", "generated");
    assert(generated.length === 1 && generated[0].id === "att-2");
    const accepted = attachmentDAO.listBySession("session-a", "accepted");
    assert(accepted.length === 1 && accepted[0].id === "att-1");
    const missing = attachmentDAO.listBySession("session-missing", "");
    assertEquals(missing.length, 0);
  } finally {
    closeTestDbs();
  }
});
