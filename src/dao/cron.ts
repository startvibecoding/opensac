import type { DB } from "../db/mod.ts";
import { ErrNoRows, execChanges, queryAll, queryOne } from "./database.ts";

/**
 * Database representation of a scheduled job. Times are stored as RFC3339
 * strings to preserve the existing SQLite schema and data.
 */
export interface CronJobRecord {
  id: string;
  sessionId: string;
  name: string;
  prompt: string;
  schedule: string;
  oneShot: boolean;
  mode: string;
  workDir: string;
  a2aTarget: string;
  a2aToken: string;
  enabled: boolean;
  createdAt: string;
  lastRun: string;
  nextRun: string;
  runCount: number;
  lastStatus: string;
  lastError: string;
}

const columns = `id, session_id AS sessionId, name, prompt, schedule,
  oneshot AS oneShot, mode, work_dir AS workDir, a2a_target AS a2aTarget,
  a2a_token AS a2aToken, enabled, created_at AS createdAt, last_run AS lastRun,
  next_run AS nextRun, run_count AS runCount, last_status AS lastStatus,
  last_error AS lastError`;

/** SQL-backed access to cron_jobs. */
export class CronDAO {
  constructor(private readonly db: DB | null) {}

  list(): CronJobRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT ${columns} FROM cron_jobs ORDER BY created_at DESC, id ASC`,
    ).map(normalize);
  }

  get(id: string): CronJobRecord {
    return normalize(
      queryOne<Record<string, unknown>>(
        this.requireDb(),
        `SELECT ${columns} FROM cron_jobs WHERE id = ? LIMIT 1`,
        [id],
      ),
    );
  }

  create(record: CronJobRecord | null): void {
    if (record === null) throw new Error("cron job record is missing");
    execChanges(
      this.requireDb(),
      `INSERT INTO cron_jobs
        (id, session_id, name, prompt, schedule, oneshot, mode, work_dir,
         a2a_target, a2a_token, enabled, created_at, last_run, next_run,
         run_count, last_status, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindRecord(record),
    );
  }

  update(record: CronJobRecord | null): void {
    if (record === null) throw new Error("cron job record is missing");
    const changed = execChanges(
      this.requireDb(),
      `UPDATE cron_jobs SET
         session_id = ?, name = ?, prompt = ?, schedule = ?, oneshot = ?, mode = ?,
         work_dir = ?, a2a_target = ?, a2a_token = ?, enabled = ?, created_at = ?,
         last_run = ?, next_run = ?, run_count = ?, last_status = ?, last_error = ?
       WHERE id = ?`,
      [...bindRecord(record).slice(1), record.id],
    );
    if (changed === 0) throw ErrNoRows;
  }

  delete(id: string): void {
    const changed = execChanges(
      this.requireDb(),
      `DELETE FROM cron_jobs WHERE id = ?`,
      [id],
    );
    if (changed === 0) throw ErrNoRows;
  }

  /**
   * Atomically claims an enabled job whose schedule is due or whose previous
   * running lease has expired.
   */
  claimDue(id: string, now: string, staleBefore: string): boolean {
    const changed = execChanges(
      this.requireDb(),
      `UPDATE cron_jobs
       SET last_status = ?, last_run = ?, last_error = ?
       WHERE id = ? AND enabled = 1
         AND ((last_status = 'running' AND last_run != '' AND last_run <= ?)
              OR (last_status != 'running'
                  AND ((next_run != '' AND next_run <= ?)
                       OR (next_run = '' AND last_run = ''))))`,
      ["running", now, "", id, staleBefore, now],
    );
    return changed === 1;
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("cron database is not open");
    return this.db;
  }
}

// bindRecord returns the insert/update parameter list in column order.
function bindRecord(r: CronJobRecord): (string | number | null)[] {
  return [
    r.id,
    r.sessionId,
    r.name,
    r.prompt,
    r.schedule,
    r.oneShot ? 1 : 0,
    r.mode,
    r.workDir,
    r.a2aTarget,
    r.a2aToken,
    r.enabled ? 1 : 0,
    r.createdAt,
    r.lastRun,
    r.nextRun,
    r.runCount,
    r.lastStatus,
    r.lastError,
  ];
}

function normalize(row: Record<string, unknown>): CronJobRecord {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    name: String(row.name),
    prompt: String(row.prompt),
    schedule: String(row.schedule),
    oneShot: Number(row.oneShot) !== 0,
    mode: String(row.mode),
    workDir: String(row.workDir),
    a2aTarget: String(row.a2aTarget),
    a2aToken: String(row.a2aToken),
    enabled: Number(row.enabled) !== 0,
    createdAt: String(row.createdAt),
    lastRun: String(row.lastRun),
    nextRun: String(row.nextRun),
    runCount: Number(row.runCount),
    lastStatus: String(row.lastStatus),
    lastError: String(row.lastError),
  };
}
