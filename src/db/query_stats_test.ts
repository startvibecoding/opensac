import { assert, assertEquals } from "@opensac/assert";
import {
  queryStats,
  recordQueryTiming,
  resetQueryStats,
  slowQueryThresholdMs,
} from "./query_stats.ts";

Deno.test("recordQueryTiming accumulates totals and tracks the slowest SQL", () => {
  resetQueryStats();
  recordQueryTiming("SELECT 1", 5);
  recordQueryTiming("SELECT very_slow", 80);
  const q = queryStats();
  assertEquals(q.count, 2);
  assertEquals(q.totalMs, 85);
  assertEquals(q.maxMs, 80);
  assertEquals(q.maxSql, "SELECT very_slow");
  assertEquals(q.slowCount, 1);
  assertEquals(q.slowTotalMs, 80);
});

Deno.test("recordQueryTiming counts only threshold crossings as slow", () => {
  resetQueryStats();
  recordQueryTiming("fast", slowQueryThresholdMs - 1);
  recordQueryTiming("boundary", slowQueryThresholdMs);
  const q = queryStats();
  assertEquals(q.count, 2);
  assertEquals(q.slowCount, 1);
  assert(q.maxSql === "boundary");
});

Deno.test("recordQueryTiming truncates retained SQL", () => {
  resetQueryStats();
  recordQueryTiming("x".repeat(500), 100);
  const q = queryStats();
  assert(q.maxSql.length === 200);
});

Deno.test("resetQueryStats restores the baseline", () => {
  resetQueryStats();
  recordQueryTiming("SELECT 1", 10);
  resetQueryStats();
  const q = queryStats();
  assertEquals(q.count, 0);
  assertEquals(q.totalMs, 0);
  assertEquals(q.maxMs, 0);
  assertEquals(q.maxSql, "");
  assertEquals(q.slowCount, 0);
  assertEquals(q.slowTotalMs, 0);
});
