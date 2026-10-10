import { assert, assertEquals } from "../compat/assert.ts";
import type { DB } from "../db/mod.ts";
import {
  ForkDAO,
  ProjectDAO,
  RunDAO,
  SessionDAO,
  type SessionRunRecord,
} from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";
import { test } from "#testing";

const SOURCE = "session-source";

function runRecord(
  sessionId: string,
  overrides: Partial<SessionRunRecord> = {},
): SessionRunRecord {
  return {
    id: `run-${sessionId}`,
    sessionId,
    intentId: "intent-1",
    retryOf: "",
    attempt: 1,
    workDir: "/work",
    source: "cli",
    model: "gpt-4.1",
    mode: "yolo",
    status: "running",
    startedAt: "2026-01-01T00:00:01Z",
    updatedAt: "2026-01-01T00:00:01Z",
    finishedAt: null,
    error: "",
    errorInfoJson: "",
    progressJson: "",
    usageJson: "",
    contextUsageJson: "",
    ...overrides,
  };
}

function insertSourceSession(db: DB): void {
  new SessionDAO(db).insertSession(
    db,
    "sessions",
    SOURCE,
    "/work/repo",
    "2026-01-01T00:00:00Z",
    "",
    4,
    "local",
    "",
    0,
    0,
    "",
    "expert-a",
  );
}

test("fork DAO copies the source session row into the child", () => {
  const db = openTestDb();
  try {
    insertSourceSession(db);
    const dao = new ForkDAO(db);
    dao.insertSessionFrom(db, "session-child", SOURCE, 7, 3, "manual");

    const child = dao.findSession(db, "session-child");
    assert(child);
    assertEquals(child.cwd, "/work/repo", "the cwd is inherited");
    assertEquals(child.parentSession, SOURCE);
    assertEquals(child.forkBoundary, 7);
    assertEquals(child.seedLength, 3);
    assertEquals(child.forkKind, "manual");
    assertEquals(child.channelType, "local", "children start local");
    assertEquals(child.channelId, "");
    assertEquals(dao.result(db, "session-child")?.id, "session-child");
    assertEquals(dao.findSession(db, "missing"), undefined);

    const source = dao.findSession(db, SOURCE);
    assert(source);
    assertEquals(source.forkBoundary, 0, "the source row is untouched");
    assertEquals(source.parentSession, null);
  } finally {
    closeTestDbs();
  }
});

test("fork DAO entry insertion, ordering, and current id", () => {
  const db = openTestDb();
  try {
    insertSourceSession(db);
    const dao = new ForkDAO(db);

    const seqA = dao.insertEntry(db, {
      sessionId: SOURCE,
      seq: 0,
      id: "entry-a",
      type: "message",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      data: `{"role":"user"}`,
    });
    const seqB = dao.insertEntry(db, {
      sessionId: SOURCE,
      seq: 0,
      id: "entry-b",
      type: "message",
      parentId: "entry-a",
      timestamp: "2026-01-01T00:00:02Z",
      data: `{"role":"assistant"}`,
    });
    assert(seqB > seqA, "the autoincrement sequence must increase");

    const entries = dao.listEntries(db, SOURCE);
    assertEquals(entries.map((e) => e.id), ["entry-a", "entry-b"]);
    assertEquals(entries[0].seq, seqA);
    assertEquals(entries[1].parentId, "entry-a");

    assertEquals(dao.entryAtSeq(db, SOURCE, seqA)?.id, "entry-a");
    assertEquals(dao.entryAtSeq(db, SOURCE, 9999), undefined);
    assertEquals(dao.currentEntryId(db, SOURCE), "entry-b");
    assertEquals(dao.currentEntryId(db, "missing"), undefined);
    assertEquals(dao.listEntries(db, "missing"), []);
  } finally {
    closeTestDbs();
  }
});

test("fork DAO fingerprint counts open turns and active runs", () => {
  const db = openTestDb();
  try {
    insertSourceSession(db);
    const dao = new ForkDAO(db);
    const seq = dao.insertEntry(db, {
      sessionId: SOURCE,
      seq: 0,
      id: "entry-leaf",
      type: "message",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      data: `{}`,
    });
    dao.insertTurn(
      db,
      "turn-open",
      SOURCE,
      "intent-1",
      "conversation",
      "open",
      seq,
      null,
      "2026-01-01T00:00:01Z",
      null,
    );
    dao.insertTurn(
      db,
      "turn-closed",
      SOURCE,
      "intent-1",
      "conversation",
      "closed",
      seq,
      seq,
      "2026-01-01T00:00:01Z",
      "2026-01-01T00:00:02Z",
    );

    const runDAO = new RunDAO(db);
    runDAO.insertRun(db, runRecord(SOURCE));
    runDAO.insertRun(
      db,
      runRecord(SOURCE, {
        id: "run-done",
        status: "completed",
        startedAt: "2026-01-01T00:01:01Z",
      }),
    );

    assertEquals(dao.openTurnCount(db, SOURCE), 1);
    assertEquals(dao.activeRunCount(db, SOURCE, ["running", "pending"]), 1);
    assertEquals(dao.activeRunCount(db, SOURCE, ["completed"]), 1);
    assertEquals(dao.activeRunCount(db, "missing", ["running"]), 0);

    const fingerprint = dao.fingerprint(db, SOURCE, ["running"]);
    assertEquals(fingerprint.maxSeq, seq);
    assertEquals(fingerprint.leaf, "entry-leaf");
    assertEquals(fingerprint.openTurns, 1);
    assertEquals(fingerprint.activeRuns, 1);

    const windows = dao.runWindows(db, SOURCE, ["running", "completed"]);
    assertEquals(windows.length, 2);
    assertEquals(windows[0].status, "running");
    assertEquals(windows[0].finishedAt, null);
    assertEquals(windows[1].finishedAt, null);
    assertEquals(dao.runWindows(db, "missing", ["running"]), []);
  } finally {
    closeTestDbs();
  }
});

test("fork DAO deduplicates fork requests and detects title reuse", () => {
  const db = openTestDb();
  try {
    insertSourceSession(db);
    const dao = new ForkDAO(db);
    dao.insertSessionFrom(db, "session-child", SOURCE, 1, 1, "manual");

    const request = {
      requestKeyHash: "hash-1",
      requestFingerprint: "fp-1",
      sourceSessionId: SOURCE,
      childSessionId: "session-child",
      createdAt: "2026-01-01T00:00:00Z",
    };
    dao.insertForkRequest(db, request);

    const found = dao.findRequest(db, "hash-1", SOURCE);
    assertEquals(found?.childSessionId, "session-child");
    assertEquals(dao.findRequest(db, "hash-2", SOURCE), undefined);
    assertEquals(dao.findRequest(db, "hash-1", "other-source"), undefined);

    dao.insertRawEntry(
      db,
      "session-child",
      "entry-title",
      "plan",
      SOURCE,
      "2026-01-01T00:00:05Z",
      `{"name":"Design doc"}`,
    );
    assert(
      dao.titleExists(db, SOURCE, "plan", "Design doc"),
      "a child entry with the same name must be detected",
    );
    assert(!dao.titleExists(db, SOURCE, "task", "Design doc"));
    assert(!dao.titleExists(db, SOURCE, "plan", "Other name"));
    assert(!dao.titleExists(db, "other-parent", "plan", "Design doc"));
  } finally {
    closeTestDbs();
  }
});

test("fork DAO copies capabilities and project metadata to the child", () => {
  const db = openTestDb();
  try {
    insertSourceSession(db);
    const dao = new ForkDAO(db);
    const sessionDAO = new SessionDAO(db);

    sessionDAO.upsertCapability(db, {
      sessionId: SOURCE,
      mode: "yolo",
      displayMode: "yolo",
      delegateMode: 1,
      multiAgent: 1,
      workflows: 0,
      webSearch: 1,
      browser: 0,
      a2aMaster: 0,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    dao.insertSessionFrom(db, "session-child", SOURCE, 1, 1, "manual");
    dao.copyCapabilities(db, SOURCE, "session-child");

    const capability = sessionDAO.capability("session-child");
    assert(capability);
    assertEquals(capability.mode, "yolo");
    assertEquals(capability.multiAgent, 1);
    assertEquals(capability.webSearch, 1);
    assertEquals(sessionDAO.capability("missing"), undefined);

    new ProjectDAO(db).upsertMetadata({
      sessionId: SOURCE,
      projectId: "project-1",
      pinned: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    dao.copyProject(db, SOURCE, "session-child");

    const metadata = new ProjectDAO(db).metadata("session-child");
    assert(metadata);
    assertEquals(metadata.projectId, "project-1");
    assertEquals(
      metadata.pinned,
      0,
      "a forked session does not inherit the pin",
    );
  } finally {
    closeTestDbs();
  }
});
