import { assert, assertEquals } from "@std/assert";
import {
  beginWaitStats,
  busyRetryStats,
  closeAll,
  open,
  recordBeginWait,
  runInTx,
  SQLITE_EXPVAR_KEY,
  sqliteStatsSnapshot,
} from "./mod.ts";

const SNAPSHOT_KEYS = [
  "beginCount",
  "beginMaxWaitMs",
  "beginTotalWaitMs",
  "busyRetryHits",
  "busyRetryWaitMs",
  "queryCount",
  "queryMaxMs",
  "querySlowCount",
  "querySlowTotalMs",
  "queryTotalMs",
];

// TestSqliteStatsSnapshotPinsExpvarShape keeps the debug endpoint contract
// stable: the expvar key and the published field names must not drift.
Deno.test("sqlite stats snapshot publishes the expvar field set", () => {
  assertEquals(SQLITE_EXPVAR_KEY, "opensac_sqlite");

  const snapshot = sqliteStatsSnapshot();
  assertEquals(Object.keys(snapshot).sort(), SNAPSHOT_KEYS);
  for (const key of SNAPSHOT_KEYS) {
    const value = snapshot[key];
    assert(
      Number.isInteger(value) && value >= 0,
      `${key} must be a non-negative integer, got ${value}`,
    );
  }
});

Deno.test("sqlite stats snapshot reflects begin wait recording", () => {
  const before = sqliteStatsSnapshot();
  recordBeginWait(7);
  const after = sqliteStatsSnapshot();

  assertEquals(after.beginCount, before.beginCount + 1);
  assertEquals(after.beginTotalWaitMs, before.beginTotalWaitMs + 7);
  assert(
    after.beginMaxWaitMs >= 7,
    "a recorded wait participates in the running maximum",
  );
  assertEquals(
    after.busyRetryHits,
    before.busyRetryHits,
    "recording a begin wait must not count as a busy retry",
  );
});

// The begin path is the only writer of the begin counters in production, so a
// committed transaction must move them; without contention no retry may.
Deno.test("runInTx records exactly one begin attempt", () => {
  const dir = Deno.makeTempDirSync({ prefix: "opensac-db-stats-test-" });
  const path = `${dir}/sessions.db`;
  try {
    const db = open(path);
    const beforeBegin = beginWaitStats();
    const beforeBusy = busyRetryStats();

    const result = runInTx(db, (conn) => {
      conn.exec("CREATE TABLE t(a INTEGER)");
      conn.run("INSERT INTO t VALUES (1)");
      return 42;
    });
    assertEquals(result, 42);

    const afterBegin = beginWaitStats();
    assertEquals(afterBegin.count, beforeBegin.count + 1);
    assert(afterBegin.totalMs >= beforeBegin.totalMs);
    assertEquals(
      busyRetryStats().hits,
      beforeBusy.hits,
      "a clean begin must not record a busy retry",
    );
  } finally {
    closeAll();
    Deno.removeSync(dir, { recursive: true });
  }
});
