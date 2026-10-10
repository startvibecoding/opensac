import type { DB } from "../db/mod.ts";
import { execChanges, queryAll, queryOptional } from "./database.ts";

/**
 * Persistence representation of one supervised objective. JSON and timestamp
 * values remain strings to match the existing SQLite schema and replay format.
 */
export interface ESMObjectiveRecord {
  sessionId: string;
  esmId: string;
  objective: string;
  status: string;
  tokensUsed: number;
  timeUsedMs: number;
  blockedCount: number;
  blockedReason: string;
  blockedRunId: string;
  completionReason: string;
  completionRunId: string;
  completionReview: string;
  phase: string;
  progressSummary: string;
  remainingWork: string;
  rejectionCount: number;
  rejectionRunId: string;
  recoveryCount: number;
  recoveryReason: string;
  createdAt: string;
  updatedAt: string;
}

const columns = `session_id AS sessionId, esm_id AS esmId, objective, status,
  tokens_used AS tokensUsed, time_used_ms AS timeUsedMs,
  blocked_count AS blockedCount, blocked_reason AS blockedReason,
  blocked_run_id AS blockedRunId, completion_reason AS completionReason,
  completion_run_id AS completionRunId, completion_review AS completionReview,
  phase, progress_summary AS progressSummary, remaining_work AS remainingWork,
  completion_rejection_count AS rejectionCount,
  completion_rejection_run_id AS rejectionRunId,
  recovery_count AS recoveryCount, recovery_reason AS recoveryReason,
  created_at AS createdAt, updated_at AS updatedAt`;

/** SQL-backed access to session_esm_objectives. */
export class ESMDAO {
    private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  get(sessionId: string): ESMObjectiveRecord | undefined {
    return this.getFrom(this.requireDb(), sessionId);
  }

  getFrom(executor: DB, sessionId: string): ESMObjectiveRecord | undefined {
    return queryOptional<ESMObjectiveRecord>(
      executor,
      `SELECT ${columns} FROM session_esm_objectives WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
  }

  insert(executor: DB, record: ESMObjectiveRecord | null): void {
    if (record === null || record.sessionId === "") {
      throw new Error("esm objective record is invalid");
    }
    execChanges(
      executor,
      `INSERT INTO session_esm_objectives
        (session_id, esm_id, objective, status, tokens_used, time_used_ms,
         blocked_count, blocked_reason, blocked_run_id, completion_reason,
         completion_run_id, completion_review, phase, progress_summary,
         remaining_work, completion_rejection_count, completion_rejection_run_id,
         recovery_count, recovery_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindRecord(record),
    );
  }

  update(executor: DB, record: ESMObjectiveRecord | null): boolean {
    if (record === null || record.sessionId === "") {
      throw new Error("esm objective record is invalid");
    }
    const full = bindRecord(record);
    const params = [...full.slice(1, 19), full[20], full[0]];
    const changed = execChanges(
      executor,
      `UPDATE session_esm_objectives SET
         esm_id = ?, objective = ?, status = ?, tokens_used = ?, time_used_ms = ?,
         blocked_count = ?, blocked_reason = ?, blocked_run_id = ?,
         completion_reason = ?, completion_run_id = ?, completion_review = ?,
         phase = ?, progress_summary = ?, remaining_work = ?,
         completion_rejection_count = ?, completion_rejection_run_id = ?,
         recovery_count = ?, recovery_reason = ?, updated_at = ?
       WHERE session_id = ?`,
      params,
    );
    return changed !== 0;
  }

  delete(executor: DB, sessionId: string): void {
    execChanges(
      executor,
      `DELETE FROM session_esm_objectives WHERE session_id = ?`,
      [sessionId],
    );
  }

  listRunnable(): string[] {
    return queryAll<{ sessionId: string }>(
      this.requireDb(),
      `SELECT session_id AS sessionId FROM session_esm_objectives
       WHERE status IN (?, ?) ORDER BY session_id`,
      ["active", "complete_candidate"],
    ).map((row) => row.sessionId);
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("esm database is not open");
    return this.db;
  }
}

// bindRecord returns the full insert parameter list in column order.
function bindRecord(r: ESMObjectiveRecord): (string | number | null)[] {
  return [
    r.sessionId,
    r.esmId,
    r.objective,
    r.status,
    r.tokensUsed,
    r.timeUsedMs,
    r.blockedCount,
    r.blockedReason,
    r.blockedRunId,
    r.completionReason,
    r.completionRunId,
    r.completionReview,
    r.phase,
    r.progressSummary,
    r.remainingWork,
    r.rejectionCount,
    r.rejectionRunId,
    r.recoveryCount,
    r.recoveryReason,
    r.createdAt,
    r.updatedAt,
  ];
}
