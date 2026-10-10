// Query-execution timing for the synchronous DAO layer.
//
// Go ran blocking `database/sql` calls on goroutines; the Node port executes
// every statement on the single-threaded event loop, so one slow query stalls
// streaming, lease heartbeats, and every other session. These counters are the
// slow-query baseline (P3-4 / §3.7): they surface the `slowQueryThresholdMs`
// offenders through `sqliteStatsSnapshot` (visible at `/debug/vars`) so chunked
// reads and worker offload can be targeted at the real hotspots.

/** Executions at or above this duration are counted as slow. */
export const slowQueryThresholdMs = 50;

interface QueryStats {
  count: number;
  totalMs: number;
  maxMs: number;
  /** The SQL of the slowest execution, truncated (parameterized, no literals). */
  maxSql: string;
  slowCount: number;
  slowTotalMs: number;
}

const stats: QueryStats = {
  count: 0,
  totalMs: 0,
  maxMs: 0,
  maxSql: "",
  slowCount: 0,
  slowTotalMs: 0,
};

/** Records one statement execution timing. */
export function recordQueryTiming(sql: string, elapsedMs: number): void {
  stats.count += 1;
  stats.totalMs += elapsedMs;
  if (elapsedMs > stats.maxMs) {
    stats.maxMs = elapsedMs;
    stats.maxSql = sql.slice(0, 200);
  }
  if (elapsedMs >= slowQueryThresholdMs) {
    stats.slowCount += 1;
    stats.slowTotalMs += elapsedMs;
  }
}

/** Returns the cumulative query-execution counters. */
export function queryStats(): QueryStats {
  return { ...stats };
}

/** Clears the counters. Exposed so tests start from a known baseline. */
export function resetQueryStats(): void {
  stats.count = 0;
  stats.totalMs = 0;
  stats.maxMs = 0;
  stats.maxSql = "";
  stats.slowCount = 0;
  stats.slowTotalMs = 0;
}
