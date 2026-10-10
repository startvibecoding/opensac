import type { DB } from "../db/mod.ts";
import { execChanges, queryAll, queryOptional } from "./database.ts";

export interface RecoveryRecord {
  runId: string;
  sessionId: string;
  state: string;
  triggerSource: string;
  reasonCode: string;
  attempt: number;
  previousLeaseEpoch: number;
  lastError: string;
  nextRetryAt: number | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface OpenTurnRecord {
  id: string;
  intentId: string;
  runId: string;
}

const columns = `run_id AS runId, session_id AS sessionId, state,
  trigger_source AS triggerSource, reason_code AS reasonCode, attempt,
  previous_lease_epoch AS previousLeaseEpoch, last_error AS lastError,
  next_retry_at AS nextRetryAt, started_at AS startedAt, updated_at AS updatedAt,
  completed_at AS completedAt`;

export class RecoveryDAO {
    private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  upsert(executor: DB, record: RecoveryRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_run_recoveries
        (run_id, session_id, state, trigger_source, reason_code, attempt,
         previous_lease_epoch, last_error, next_retry_at, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         session_id = excluded.session_id,
         state = excluded.state,
         trigger_source = excluded.trigger_source,
         reason_code = excluded.reason_code,
         attempt = attempt + 1,
         previous_lease_epoch = excluded.previous_lease_epoch,
         last_error = '',
         next_retry_at = NULL,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         completed_at = NULL`,
      [
        record.runId,
        record.sessionId,
        record.state,
        record.triggerSource,
        record.reasonCode,
        record.attempt,
        record.previousLeaseEpoch,
        record.lastError,
        record.nextRetryAt,
        record.startedAt,
        record.updatedAt,
        record.completedAt,
      ],
    );
  }

  find(executor: DB, runId: string): RecoveryRecord | undefined {
    return queryOptional<RecoveryRecord>(
      executor,
      `SELECT ${columns} FROM session_run_recoveries WHERE run_id = ? LIMIT 1`,
      [runId],
    );
  }

  update(
    executor: DB,
    runId: string,
    sessionId: string,
    state: string,
    lastError: string,
    nextRetryAt: number | null,
    updatedAt: number | null,
    completedAt: number | null,
  ): boolean {
    const changes = execChanges(
      executor,
      `UPDATE session_run_recoveries
       SET state = ?, last_error = ?, next_retry_at = ?, updated_at = ?, completed_at = ?
       WHERE run_id = ? AND session_id = ?`,
      [state, lastError, nextRetryAt, updatedAt, completedAt, runId, sessionId],
    );
    return changes !== 0;
  }

  listOpenTurns(executor: DB, sessionId: string): OpenTurnRecord[] {
    return queryAll<Record<string, unknown>>(
      executor,
      `SELECT t.id AS id, t.intent_id AS intentId,
        COALESCE((SELECT json_extract(e.data, '$.runId') FROM entries e
          WHERE e.session_id = t.session_id AND e.type = 'turn_start'
          AND json_extract(e.data, '$.turnId') = t.id
          ORDER BY e.seq DESC LIMIT 1), '') AS runId
       FROM conversation_turns AS t
       WHERE t.session_id = ? AND t.status = ?
       ORDER BY t.start_seq`,
      [sessionId, "open"],
    ).map((row) => ({
      id: String(row.id),
      intentId: String(row.intentId),
      runId: String(row.runId),
    }));
  }
}
