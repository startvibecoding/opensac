//
// Persists cron jobs in the shared sessions.db database. Query construction
// lives in dao.CronDAO; this type only maps persistence records to the cron
// domain model. Deviations from Go: `time.Time` maps to `Date` with `null` for
// Go's zero time (stored as an empty string), and DAO errors are detected with
// the shared `isNoRowsRun` helper.

import { CronDAO, type CronJobRecord, isNoRowsRun } from "../dao/mod.ts";
import { openBunDatabase, rootDatabasePath } from "../session/database.ts";
import {
  type CronJob,
  type CronStore,
  newCronID,
  runningLeaseTimeoutMs,
} from "./cron.ts";

/**
 * Persists cron jobs in the shared sessions.db database rooted at `sessionDir`.
 */
export class SQLiteCronStore implements CronStore {
  readonly sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  #dao(): CronDAO {
    const db = openBunDatabase(rootDatabasePath(this.sessionDir));
    return new CronDAO(db.db);
  }

  list(): CronJob[] {
    return this.#dao().list().map(cronJobFromRecord);
  }

  get(id: string): CronJob {
    try {
      return cronJobFromRecord(this.#dao().get(id));
    } catch (err) {
      if (isNoRowsRun(err)) throw notFound(id);
      throw err;
    }
  }

  create(job: CronJob): CronJob {
    const record = cronJobRecord(job);
    if (record.id === "") record.id = newCronID();
    if (record.createdAt === "") record.createdAt = formatCronTime(new Date());
    try {
      this.#dao().create(record);
    } catch (err) {
      throw new Error(`create cron job "${record.id}": ${errorMessage(err)}`);
    }
    return cronJobFromRecord(record);
  }

  update(job: CronJob): void {
    const record = cronJobRecord(job);
    try {
      this.#dao().update(record);
    } catch (err) {
      if (isNoRowsRun(err)) throw notFound(record.id);
      throw new Error(`update cron job "${record.id}": ${errorMessage(err)}`);
    }
  }

  delete(id: string): void {
    try {
      this.#dao().delete(id);
    } catch (err) {
      if (isNoRowsRun(err)) throw notFound(id);
      throw new Error(`delete cron job "${id}": ${errorMessage(err)}`);
    }
  }

  /**
   * Atomically marks a due job as running. Only the caller that updates a row
   * may execute it, preventing duplicate runs across scheduler instances.
   */
  claimDue(id: string, now: Date): boolean {
    const stamp = formatCronTime(now);
    const staleBefore = formatCronTime(
      new Date(now.getTime() - runningLeaseTimeoutMs),
    );
    return this.#dao().claimDue(id, stamp, staleBefore);
  }
}

/** Creates a SQLite-backed cron store rooted at `sessionDir`. */
export function newSQLiteCronStore(sessionDir: string): SQLiteCronStore {
  return new SQLiteCronStore(sessionDir);
}

function notFound(id: string): Error {
  return new Error(`cron job "${id}" not found`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cronJobRecord(job: CronJob): CronJobRecord {
  return {
    id: job.id ?? "",
    sessionId: job.sessionId ?? "",
    name: job.name ?? "",
    prompt: job.prompt ?? "",
    schedule: job.schedule ?? "",
    oneShot: job.oneShot ?? false,
    mode: job.mode ?? "",
    workDir: job.workDir ?? "",
    // The A2A target columns stay in the schema for compatibility; the A2A
    // mode was removed, so jobs can no longer dispatch to a remote server.
    a2aTarget: "",
    a2aToken: "",
    enabled: job.enabled ?? false,
    createdAt: formatCronTime(job.createdAt ?? null),
    lastRun: formatCronTime(job.lastRun ?? null),
    nextRun: formatCronTime(job.nextRun ?? null),
    runCount: job.runCount ?? 0,
    lastStatus: job.lastStatus ?? "",
    lastError: job.lastError ?? "",
  };
}

function cronJobFromRecord(record: CronJobRecord): CronJob {
  return {
    id: record.id,
    sessionId: record.sessionId,
    name: record.name,
    prompt: record.prompt,
    schedule: record.schedule,
    oneShot: record.oneShot,
    mode: record.mode,
    workDir: record.workDir,
    enabled: record.enabled,
    createdAt: parseCronTime(record.createdAt),
    lastRun: parseCronTime(record.lastRun),
    nextRun: parseCronTime(record.nextRun),
    runCount: record.runCount,
    lastStatus: record.lastStatus,
    lastError: record.lastError,
  };
}

/** Formats a time as RFC3339 (empty string for Go's zero time). */
export function formatCronTime(t: Date | null): string {
  if (t === null) return "";
  return t.toISOString();
}

/** Parses a stored timestamp, returning `null` for Go's zero time. */
export function parseCronTime(s: string): Date | null {
  if (s === "") return null;
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : t;
}
