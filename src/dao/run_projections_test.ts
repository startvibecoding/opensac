import { assert, assertEquals } from "@std/assert";
import {
  ProjectDAO,
  RunDAO,
  type SessionMetadataRecord,
  type SessionRunRecord,
} from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";

function run(overrides: Partial<SessionRunRecord>): SessionRunRecord {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 1,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: "",
    updatedAt: "",
    finishedAt: null,
    error: "",
    errorInfoJson: "{}",
    progressJson: "{}",
    usageJson: "{}",
    contextUsageJson: "{}",
    ...overrides,
  };
}

Deno.test("run DAO latest run by sessions picks newest per session", () => {
  const database = openTestDb();
  try {
    const runDAO = new RunDAO(database);
    const seed: SessionRunRecord[] = [
      run({
        id: "run-a1",
        sessionId: "session-a",
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
      }),
      run({
        id: "run-a2",
        sessionId: "session-a",
        status: "failed",
        startedAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:01Z",
      }),
      run({
        id: "run-b1",
        sessionId: "session-b",
        status: "running",
        startedAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      }),
      run({
        id: "run-c1",
        sessionId: "session-c",
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ];
    for (const record of seed) runDAO.insertRun(database, record);

    const latest = runDAO.latestRunBySessions([
      "session-a",
      "session-b",
      "session-missing",
    ]);
    assertEquals(latest.size, 2);
    assert(
      latest.get("session-a")!.id === "run-a2" &&
        latest.get("session-a")!.status === "failed",
    );
    assertEquals(latest.get("session-b")!.id, "run-b1");
    assert(!latest.has("session-missing"));

    const empty = runDAO.latestRunBySessions([]);
    assertEquals(empty.size, 0);
  } finally {
    closeTestDbs();
  }
});

Deno.test("project DAO metadata batch counts and clear", () => {
  const database = openTestDb();
  try {
    const projectDAO = new ProjectDAO(database);
    projectDAO.insert({
      id: "project-1",
      name: "One",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const meta = (
      sessionId: string,
      projectId: string | null,
      pinned: number,
      updatedAt: string,
    ): SessionMetadataRecord => ({
      sessionId,
      projectId,
      pinned,
      updatedAt,
    });
    projectDAO.upsertMetadata(
      meta("session-a", "project-1", 1, "2026-01-01T00:00:01Z"),
    );
    projectDAO.upsertMetadata(
      meta("session-b", "project-1", 0, "2026-01-01T00:00:02Z"),
    );
    projectDAO.upsertMetadata(
      meta("session-c", null, 1, "2026-01-01T00:00:03Z"),
    );

    const records = projectDAO.metadataForSessions([
      "session-a",
      "session-c",
      "session-missing",
    ]);
    assertEquals(records.length, 2);
    assert(
      records[0].sessionId === "session-a" &&
        records[1].sessionId === "session-c",
    );
    assert(
      records[0].projectId === "project-1" && records[0].pinned === 1,
    );

    let counts = projectDAO.sessionCountsByProject();
    assertEquals(counts.get("project-1"), 2);

    projectDAO.clearMetadataProject("project-1");
    counts = projectDAO.sessionCountsByProject();
    assertEquals(counts.size, 0);
    const record = projectDAO.metadata("session-a");
    assert(record !== null && record.projectId === null && record.pinned === 1);
  } finally {
    closeTestDbs();
  }
});
