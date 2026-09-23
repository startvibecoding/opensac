import { beginWaitStats, busyRetryStats } from "./busy.ts";
import { queryStats } from "./query_stats.ts";

/** The expvar name under which the process-wide SQLite contention metrics are published. */
export const SQLITE_EXPVAR_KEY = "opensac_sqlite";

/**
 * Renders the cumulative contention counters as JSON: transient busy begin
 * retries with their backoff total, and the begin-call attempt count / total
 * wait / slowest single wait. Durations are reported in whole milliseconds.
 */
export function sqliteStatsSnapshot(): Record<string, number> {
  const { hits, totalWaitMs } = busyRetryStats();
  const { count, totalMs, maxMs } = beginWaitStats();
  const query = queryStats();
  return {
    busyRetryHits: hits,
    busyRetryWaitMs: Math.trunc(totalWaitMs),
    beginCount: count,
    beginTotalWaitMs: Math.trunc(totalMs),
    beginMaxWaitMs: Math.trunc(maxMs),
    queryCount: query.count,
    queryTotalMs: Math.trunc(query.totalMs),
    queryMaxMs: Math.trunc(query.maxMs),
    querySlowCount: query.slowCount,
    querySlowTotalMs: Math.trunc(query.slowTotalMs),
  };
}
