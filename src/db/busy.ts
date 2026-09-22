// Ported from internal/db/busy.go
//
// SQLite writer contention: every non-read-only transaction begins with
// BEGIN IMMEDIATE and takes the single writer lock up front. The bounded retry
// below absorbs a transient SQLITE_BUSY/SQLITE_LOCKED outcome instead of
// turning it into a hard failure.

/** The result code for SQLITE_BUSY / SQLITE_LOCKED. */
export function sqliteResultCode(err: unknown): number | undefined {
  if (err == null || typeof err !== "object") return undefined;
  const code = (err as { errcode?: unknown }).errcode;
  if (typeof code === "number") return code & 0xff;
  return undefined;
}

/**
 * Reports whether `err` is SQLITE_BUSY (5) or SQLITE_LOCKED (6): another writer
 * holds the lock right now, which is transient rather than a permanent failure.
 */
export function isSQLiteBusy(err: unknown): boolean {
  const code = sqliteResultCode(err);
  return code === 5 || code === 6;
}

/**
 * Reports whether `err` is SQLITE_READONLY (8): the file or its directory
 * forbids writes, which a rebuild would "fix" only by destroying data the user
 * did not intend to replace.
 */
export function isSQLiteReadOnly(err: unknown): boolean {
  return sqliteResultCode(err) === 8;
}

/** Synchronously sleeps for `ms` milliseconds without yielding the event loop. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contention counters (ported from the atomic counters in busy.go)
// ─────────────────────────────────────────────────────────────────────────────

const busyRetryCounters = { hits: 0, waitMs: 0 };
const beginWaitCounters = { count: 0, totalMs: 0, maxMs: 0 };

/**
 * Returns the cumulative begin-retry hit count and the total backoff time slept
 * between attempts since process start.
 */
export function busyRetryStats(): { hits: number; totalWaitMs: number } {
  return {
    hits: busyRetryCounters.hits,
    totalWaitMs: busyRetryCounters.waitMs,
  };
}

/**
 * Returns the cumulative transaction begin attempt count, the total wall time
 * spent inside begin calls, and the slowest single begin since process start.
 */
export function beginWaitStats(): {
  count: number;
  totalMs: number;
  maxMs: number;
} {
  return {
    count: beginWaitCounters.count,
    totalMs: beginWaitCounters.totalMs,
    maxMs: beginWaitCounters.maxMs,
  };
}

export function recordBeginWait(elapsedMs: number): void {
  beginWaitCounters.count += 1;
  beginWaitCounters.totalMs += elapsedMs;
  if (elapsedMs > beginWaitCounters.maxMs) {
    beginWaitCounters.maxMs = elapsedMs;
  }
}
