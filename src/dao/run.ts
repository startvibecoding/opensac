import type { DB } from "../db/mod.ts";
import {
  execChanges,
  inList,
  type Param,
  queryAll,
  queryOptional,
} from "./database.ts";

export interface ExecutionIntentRecord {
  id: string;
  sessionId: string;
  source: string;
  model: string;
  mode: string;
  workDir: string;
  requestFingerprint: string;
  requestJson: string;
  policyJson: string;
  createdAt: string;
}

export interface SessionRunRecord {
  id: string;
  sessionId: string;
  intentId: string;
  retryOf: string;
  attempt: number;
  workDir: string;
  source: string;
  model: string;
  mode: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string;
  errorInfoJson: string;
  progressJson: string;
  usageJson: string;
  contextUsageJson: string;
}

export interface SessionRunEventRecord {
  seq: number;
  id: string;
  sessionId: string;
  runId: string;
  eventType: string;
  source: string;
  status: string;
  model: string;
  mode: string;
  timestamp: string;
  data: string;
}

const runColumns = `id, session_id AS sessionId, intent_id AS intentId,
  retry_of AS retryOf, attempt, work_dir AS workDir, source, model, mode, status,
  started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt,
  error, error_info_json AS errorInfoJson, progress_json AS progressJson,
  usage_json AS usageJson, context_usage_json AS contextUsageJson`;

const intentColumns = `id, session_id AS sessionId, source, model, mode,
  work_dir AS workDir, request_fingerprint AS requestFingerprint,
  request_json AS requestJson, policy_json AS policyJson,
  created_at AS createdAt`;

export class RunDAO {
  constructor(private readonly db: DB | null) {}

  insertIntent(executor: DB, record: ExecutionIntentRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_execution_intents
        (id, session_id, source, model, mode, work_dir, request_fingerprint,
         request_json, policy_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.source,
        record.model,
        record.mode,
        record.workDir,
        record.requestFingerprint,
        record.requestJson,
        record.policyJson,
        record.createdAt,
      ],
    );
  }

  findIntent(intentId: string): ExecutionIntentRecord | undefined {
    return queryOptional<ExecutionIntentRecord>(
      this.requireDb(),
      `SELECT ${intentColumns} FROM session_execution_intents WHERE id = ? LIMIT 1`,
      [intentId],
    );
  }

  insertRun(executor: DB, record: SessionRunRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_runs
        (id, session_id, intent_id, retry_of, attempt, work_dir, source, model,
         mode, status, started_at, updated_at, finished_at, error,
         error_info_json, progress_json, usage_json, context_usage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindRun(record),
    );
  }

  upsertRun(executor: DB, record: SessionRunRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_runs
        (id, session_id, intent_id, retry_of, attempt, work_dir, source, model,
         mode, status, started_at, updated_at, finished_at, error,
         error_info_json, progress_json, usage_json, context_usage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at,
         finished_at = excluded.finished_at,
         error = excluded.error,
         error_info_json = excluded.error_info_json,
         progress_json = excluded.progress_json,
         usage_json = excluded.usage_json,
         context_usage_json = excluded.context_usage_json`,
      bindRun(record),
    );
  }

  insertEvent(executor: DB, record: SessionRunEventRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_run_events
        (id, session_id, run_id, event_type, source, status, model, mode, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        record.id,
        record.sessionId,
        record.runId,
        record.eventType,
        record.source,
        record.status,
        record.model,
        record.mode,
        record.timestamp,
        record.data,
      ],
    );
  }

  findRun(executor: DB, runId: string): SessionRunRecord | undefined {
    return queryOptional<SessionRunRecord>(
      executor,
      `SELECT ${runColumns} FROM session_runs WHERE id = ? LIMIT 1`,
      [runId],
    );
  }

  listRuns(sessionId: string, limit: number): SessionRunRecord[] {
    return queryAll<SessionRunRecord>(
      this.requireDb(),
      `SELECT ${runColumns} FROM session_runs
       WHERE session_id = ? ORDER BY started_at DESC LIMIT ?`,
      [sessionId, limit],
    );
  }

  /**
   * Returns the most recent run row for each of the given sessions keyed by
   * session ID. Ties are broken by the greatest rowid for determinism.
   */
  latestRunBySessions(
    sessionIds: string[],
  ): Map<string, SessionRunRecord> {
    const result = new Map<string, SessionRunRecord>();
    if (sessionIds.length === 0) return result;
    const { sql, params } = inList(sessionIds);
    const records = queryAll<SessionRunRecord>(
      this.requireDb(),
      `SELECT id, session_id AS sessionId, intent_id AS intentId,
              retry_of AS retryOf, attempt, work_dir AS workDir, source, model,
              mode, status, started_at AS startedAt, updated_at AS updatedAt,
              finished_at AS finishedAt, error,
              error_info_json AS errorInfoJson, progress_json AS progressJson,
              usage_json AS usageJson, context_usage_json AS contextUsageJson
       FROM (SELECT *, ROW_NUMBER() OVER (
               PARTITION BY session_id ORDER BY started_at DESC, rowid DESC) AS run_rank
             FROM session_runs WHERE session_id IN (${sql})) AS ranked
       WHERE run_rank = 1 ORDER BY sessionId ASC`,
      params,
    );
    for (const record of records) result.set(record.sessionId, record);
    return result;
  }

  activeRun(
    sessionId: string,
    statuses: string[],
  ): SessionRunRecord | undefined {
    const { sql, params } = inList(statuses);
    return queryOptional<SessionRunRecord>(
      this.requireDb(),
      `SELECT ${runColumns} FROM session_runs
       WHERE session_id = ? AND status IN (${sql})
       ORDER BY started_at DESC LIMIT 1`,
      [sessionId, ...params],
    );
  }

  orphaned(statuses: string[]): SessionRunRecord[] {
    return this.orphanedFrom(this.requireDb(), statuses);
  }

  orphanedFrom(executor: DB, statuses: string[]): SessionRunRecord[] {
    const { sql, params } = inList(statuses);
    return queryAll<SessionRunRecord>(
      executor,
      `SELECT ${runColumns} FROM session_runs
       WHERE status IN (${sql}) ORDER BY started_at ASC`,
      params,
    );
  }

  inputResourceIds(sessionId: string): Map<string, string[]> {
    const rows = queryAll<{ runId: string; id: string }>(
      this.requireDb(),
      `SELECT run_id AS runId, id FROM input_resources
       WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
    const result = new Map<string, string[]>();
    for (const row of rows) {
      if (row.runId !== "" && row.id !== "") {
        const list = result.get(row.runId) ?? [];
        list.push(row.id);
        result.set(row.runId, list);
      }
    }
    return result;
  }

  nextAttempt(sessionId: string, intentId: string): number {
    return queryOptional<{ attempt: number }>(
      this.requireDb(),
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM session_runs
       WHERE session_id = ? AND intent_id = ?`,
      [sessionId, intentId],
    )?.attempt ?? 1;
  }

  latestForIntent(
    sessionId: string,
    intentId: string,
  ): SessionRunRecord | undefined {
    return queryOptional<SessionRunRecord>(
      this.requireDb(),
      `SELECT ${runColumns} FROM session_runs
       WHERE session_id = ? AND intent_id = ?
       ORDER BY attempt DESC, started_at DESC LIMIT 1`,
      [sessionId, intentId],
    );
  }

  sessionId(executor: DB, runId: string): string | undefined {
    return queryOptional<{ sessionId: string }>(
      executor,
      `SELECT session_id AS sessionId FROM session_runs WHERE id = ? LIMIT 1`,
      [runId],
    )?.sessionId;
  }

  updateStatus(
    executor: DB,
    runId: string,
    status: string,
    updatedAt: string,
    finishedAt: string | null,
    message: string,
    predecessors: string[],
  ): number {
    let sql =
      `UPDATE session_runs SET status = ?, updated_at = ?, finished_at = ?, error = ?
       WHERE id = ?`;
    const params: Param[] = [
      status,
      updatedAt,
      finishedAt,
      message,
      runId,
    ];
    if (predecessors.length > 0) {
      const { sql: inSql, params: inParams } = inList(predecessors);
      sql += ` AND status IN (${inSql})`;
      params.push(...inParams);
    }
    return execChanges(executor, sql, params);
  }

  updateJson(
    executor: DB,
    runId: string,
    column: string,
    value: string,
    updatedAt: string,
  ): void {
    execChanges(
      executor,
      `UPDATE session_runs SET ${column} = ?, updated_at = ? WHERE id = ?`,
      [value, updatedAt, runId],
    );
  }

  /**
   * Sets the error message only while the stored error is still empty,
   * preserving any reason an earlier finalizer already recorded. Returns the
   * number of changed rows.
   */
  updateErrorIfEmpty(
    executor: DB,
    runId: string,
    message: string,
    updatedAt: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE session_runs SET error = ?, updated_at = ?
       WHERE id = ? AND (error IS NULL OR error = '')`,
      [message, updatedAt, runId],
    );
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("run database is not open");
    return this.db;
  }
}

function bindRun(r: SessionRunRecord): (string | number | null)[] {
  return [
    r.id,
    r.sessionId,
    r.intentId,
    r.retryOf,
    r.attempt,
    r.workDir,
    r.source,
    r.model,
    r.mode,
    r.status,
    r.startedAt,
    r.updatedAt,
    r.finishedAt,
    r.error,
    r.errorInfoJson,
    r.progressJson,
    r.usageJson,
    r.contextUsageJson,
  ];
}
