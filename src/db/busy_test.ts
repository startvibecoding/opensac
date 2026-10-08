import { assert, assertEquals } from "@opensac/assert";
import {
  beginWaitStats,
  busyRetryStats,
  isSQLiteBusy,
  isSQLiteReadOnly,
  recordBeginWait,
  recordBusyRetryHit,
  recordBusyRetryWait,
  sleepSync,
  sqliteResultCode,
} from "./busy.ts";

// TestSQLiteResultCodeClassification pins the busy/read-only classification
// that turns a transient SQLITE_BUSY into a retry instead of a hard failure.
Deno.test("sqliteResultCode masks extended result codes", () => {
  assertEquals(sqliteResultCode({ errcode: 5 }), 5);
  assertEquals(sqliteResultCode({ errcode: 6 }), 6);
  // SQLITE_BUSY_SNAPSHOT (261) shares the primary code in its low byte.
  assertEquals(sqliteResultCode({ errcode: 261 }), 5);
  assertEquals(sqliteResultCode({ errcode: 8 }), 8);
  assertEquals(sqliteResultCode(null), undefined);
  assertEquals(sqliteResultCode(undefined), undefined);
  assertEquals(sqliteResultCode("busy"), undefined);
  assertEquals(sqliteResultCode(5), undefined);
  assertEquals(sqliteResultCode({ errcode: "5" }), undefined);
  assertEquals(sqliteResultCode({}), undefined);
});

Deno.test("isSQLiteBusy accepts busy and locked only", () => {
  assert(isSQLiteBusy({ errcode: 5 }), "SQLITE_BUSY is busy");
  assert(isSQLiteBusy({ errcode: 6 }), "SQLITE_LOCKED is busy");
  assert(!isSQLiteBusy({ errcode: 8 }), "SQLITE_READONLY is not busy");
  assert(!isSQLiteBusy({ errcode: 1 }), "SQLITE_ERROR is not busy");
  assert(!isSQLiteBusy(new Error("disk full")), "plain errors are not busy");
});

Deno.test("isSQLiteReadOnly recognizes SQLITE_READONLY only", () => {
  assert(isSQLiteReadOnly({ errcode: 8 }));
  assert(isSQLiteReadOnly({ errcode: 8 | (1 << 8) }), "extended code masks");
  assert(!isSQLiteReadOnly({ errcode: 5 }));
  assert(!isSQLiteReadOnly({}));
});

Deno.test("sleepSync waits for a positive duration only", () => {
  const zeroStart = performance.now();
  sleepSync(0);
  sleepSync(-5);
  assert(
    performance.now() - zeroStart < 50,
    "a non-positive sleep must return immediately",
  );

  const start = performance.now();
  sleepSync(10);
  const elapsed = performance.now() - start;
  assert(elapsed >= 8, `expected >= 8ms sleep, got ${elapsed}ms`);
});

// The counters are process-wide, so the assertions are deltas: they must not
// depend on how many other tests ran before this one.
Deno.test("begin wait stats accumulate count, total, and max", () => {
  const before = beginWaitStats();
  recordBeginWait(3);
  recordBeginWait(11);
  const after = beginWaitStats();

  assertEquals(after.count, before.count + 2);
  assertEquals(after.totalMs, before.totalMs + 14);
  assertEquals(after.maxMs, Math.max(before.maxMs, 11));
  assert(after.maxMs >= before.maxMs);
});

Deno.test("busy retry stats expose a stable snapshot shape", () => {
  const before = busyRetryStats();
  assertEquals(Object.keys(before).sort(), ["hits", "totalWaitMs"]);
  assert(before.hits >= 0 && before.totalWaitMs >= 0);

  // The returned object is a copy: mutating it must not corrupt the counters.
  const snapshot = busyRetryStats();
  snapshot.hits = 999;
  snapshot.totalWaitMs = 999;
  assertEquals(busyRetryStats(), before);
});

// The recorders are what keeps the published contention metrics live; the
// begin path in src/db/db.ts calls them on every transaction begin.
Deno.test("busy retry recorders accumulate hits and slept backoff", () => {
  const before = busyRetryStats();
  recordBusyRetryHit();
  recordBusyRetryWait(200);
  recordBusyRetryWait(400);
  const after = busyRetryStats();

  assertEquals(after.hits, before.hits + 1);
  assertEquals(after.totalWaitMs, before.totalWaitMs + 600);
});
