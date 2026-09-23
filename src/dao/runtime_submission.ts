import type { DB } from "../db/mod.ts";
import { ErrNoRows, execChanges, queryOne } from "./database.ts";

export interface RuntimeSubmissionRecord {
  id: string;
  sessionId: string;
  scope: string;
  keyHash: string;
  requestFingerprint: string;
  intentId: string;
  runId: string;
  createdAt: string;
}

const columns = `id, session_id AS sessionId, scope, key_hash AS keyHash,
  request_fingerprint AS requestFingerprint, intent_id AS intentId,
  run_id AS runId, created_at AS createdAt`;

export class RuntimeSubmissionDAO {
  constructor(private readonly db: DB | null) {}

  find(
    executor: DB,
    sessionId: string,
    scope: string,
    keyHash: string,
  ): RuntimeSubmissionRecord {
    return queryOne<RuntimeSubmissionRecord>(
      executor,
      `SELECT ${columns} FROM runtime_submissions
       WHERE session_id = ? AND scope = ? AND key_hash = ? LIMIT 1`,
      [sessionId, scope, keyHash],
    );
  }

  insert(executor: DB, record: RuntimeSubmissionRecord): void {
    execChanges(
      executor,
      `INSERT INTO runtime_submissions
        (id, session_id, scope, key_hash, request_fingerprint, intent_id, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.scope,
        record.keyHash,
        record.requestFingerprint,
        record.intentId,
        record.runId,
        record.createdAt,
      ],
    );
  }
}

export function isNoRows(err: unknown): boolean {
  return err === ErrNoRows;
}
