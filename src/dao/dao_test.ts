// Ported from internal/dao/dao_test.go

import { assert, assertEquals } from "@std/assert";
import { CronDAO, type CronJobRecord, isNoRowsRun } from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";

Deno.test("cron DAO CRUD and claim", () => {
  const database = openTestDb();
  try {
    const cronDAO = new CronDAO(database);
    const record: CronJobRecord = {
      id: "cron-test",
      sessionId: "",
      name: "test",
      prompt: "run",
      schedule: "",
      oneShot: false,
      mode: "yolo",
      workDir: "",
      a2aTarget: "",
      a2aToken: "",
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
      lastRun: "",
      nextRun: "",
      runCount: 0,
      lastStatus: "",
      lastError: "",
    };
    cronDAO.create(record);
    const loaded = cronDAO.get(record.id);
    assert(loaded.name === record.name && loaded.enabled);

    const claimed = cronDAO.claimDue(
      record.id,
      "2026-01-02T00:00:00Z",
      "2025-12-31T00:00:00Z",
    );
    assert(claimed, "expected an unstarted enabled job to be claimed");

    loaded.name = "updated";
    cronDAO.update(loaded);
    cronDAO.delete(record.id);

    let err: unknown;
    try {
      cronDAO.get(record.id);
    } catch (caught) {
      err = caught;
    }
    assert(isNoRowsRun(err), `Get after delete error = ${String(err)}`);
    assertEquals(cronDAO.list().length, 0);
  } finally {
    closeTestDbs();
  }
});
