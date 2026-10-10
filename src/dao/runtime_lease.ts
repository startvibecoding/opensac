import type { DB } from "../db/mod.ts";
import { execChanges, inList, queryAll, queryOptional } from "./database.ts";

export interface RuntimeLeaseRecord {
  sessionId: string;
  ownerId: string;
  ownerPid: number;
  ownerKind: string;
  tokenHash: string;
  epoch: number;
  runId: string;
  purpose: string;
  state: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  updatedAt: number;
}

const columns = `session_id AS sessionId, owner_instance_id AS ownerId,
  owner_pid AS ownerPid, owner_kind AS ownerKind,
  lease_token_hash AS tokenHash, epoch, run_id AS runId, purpose, state,
  acquired_at AS acquiredAt, heartbeat_at AS heartbeatAt,
  expires_at AS expiresAt, updated_at AS updatedAt`;

export class RuntimeLeaseDAO {
  private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  now(executor: DB): number {
    return Number(
      queryOptional<{ now: number }>(
        executor,
        `SELECT CAST(strftime('%s','now') AS INTEGER) AS now`,
      )?.now ?? 0,
    );
  }

  sessionExists(executor: DB, sessionId: string): boolean {
    const row = queryOptional<{ id: string }>(
      executor,
      `SELECT id FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId],
    );
    return row !== undefined;
  }

  find(executor: DB, sessionId: string): RuntimeLeaseRecord | undefined {
    return queryOptional<RuntimeLeaseRecord>(
      executor,
      `SELECT ${columns} FROM session_runtime_leases WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
  }

  /**
   * Returns every lease still marked active. Expiry is deliberately not a
   * filter: a live owner may miss a heartbeat while retaining its identity.
   */
  listHeld(executor: DB): RuntimeLeaseRecord[] {
    return queryAll<RuntimeLeaseRecord>(
      executor,
      `SELECT ${columns} FROM session_runtime_leases
       WHERE state = ? ORDER BY session_id ASC`,
      ["active"],
    );
  }

  insert(executor: DB, record: RuntimeLeaseRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_runtime_leases
        (session_id, owner_instance_id, owner_pid, owner_kind, lease_token_hash,
         epoch, run_id, purpose, state, acquired_at, heartbeat_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sessionId,
        record.ownerId,
        record.ownerPid,
        record.ownerKind,
        record.tokenHash,
        record.epoch,
        record.runId,
        record.purpose,
        record.state,
        record.acquiredAt,
        record.heartbeatAt,
        record.expiresAt,
        record.updatedAt,
      ],
    );
  }

  acquire(
    executor: DB,
    record: RuntimeLeaseRecord,
    previousEpoch: number,
    now: number,
  ): number {
    return execChanges(
      executor,
      `UPDATE session_runtime_leases SET
         owner_instance_id = ?, owner_pid = ?, owner_kind = ?, lease_token_hash = ?,
         epoch = ?, run_id = ?, purpose = ?, state = ?, acquired_at = ?,
         heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE session_id = ? AND epoch = ? AND (state != ? OR expires_at <= ?)`,
      [
        record.ownerId,
        record.ownerPid,
        record.ownerKind,
        record.tokenHash,
        record.epoch,
        record.runId,
        record.purpose,
        "active",
        now,
        now,
        record.expiresAt,
        now,
        record.sessionId,
        previousEpoch,
        "active",
        now,
      ],
    );
  }

  activeRunIds(executor: DB, sessionId: string, statuses: string[]): string[] {
    const { sql, params } = inList(statuses);
    return queryAll<{ id: string }>(
      executor,
      `SELECT id FROM session_runs
       WHERE session_id = ? AND status IN (${sql})
       ORDER BY started_at DESC`,
      [sessionId, ...params],
    ).map((row) => row.id);
  }

  /** Extends the lease owned by the caller (fenced on owner/epoch/token). */
  renew(record: RuntimeLeaseRecord, ttl: number): number {
    return renewLeaseExec(this.requireDb(), record, ttl);
  }

  /**
   * Extends several leases through one executor, intended for a single
   * transaction. The result maps each record's SessionID to its RowsAffected
   * count: 1 still owned, 0 released or displaced.
   */
  renewBatch(
    executor: DB,
    records: RuntimeLeaseRecord[],
    ttl: number,
  ): Map<string, number> {
    const results = new Map<string, number>();
    for (const record of records) {
      results.set(record.sessionId, renewLeaseExec(executor, record, ttl));
    }
    return results;
  }

  release(record: RuntimeLeaseRecord): number {
    return execChanges(
      this.requireDb(),
      `UPDATE session_runtime_leases SET
         state = ?, expires_at = CAST(strftime('%s','now') AS INTEGER),
         heartbeat_at = CAST(strftime('%s','now') AS INTEGER),
         updated_at = CAST(strftime('%s','now') AS INTEGER)
       WHERE session_id = ? AND owner_instance_id = ? AND epoch = ?
         AND lease_token_hash = ? AND state = ?`,
      [
        "released",
        record.sessionId,
        record.ownerId,
        record.epoch,
        record.tokenHash,
        "active",
      ],
    );
  }

  exists(executor: DB, sessionId: string): boolean {
    const row = queryOptional<{ v: number }>(
      executor,
      `SELECT 1 AS v FROM session_runtime_leases WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
    return row !== undefined;
  }

  /**
   * Transitions the caller's lease to purpose=execution. Ownership is proven by
   * the exact owner/epoch/token fence, not wall-clock expiry: a lapsed heartbeat
   * on a row we still own is an availability problem, so an expired-but-owned
   * lease may still bind (a fenced takeover changes the epoch instead).
   */
  bind(
    executor: DB,
    sessionId: string,
    ownerId: string,
    epoch: number,
    tokenHash: string,
    runId: string,
    purposes: string[],
  ): number {
    const { sql, params } = inList(purposes);
    return execChanges(
      executor,
      `UPDATE session_runtime_leases SET
         run_id = ?, purpose = ?, updated_at = CAST(strftime('%s','now') AS INTEGER)
       WHERE session_id = ? AND owner_instance_id = ? AND epoch = ?
         AND lease_token_hash = ? AND state = ?
         AND purpose IN (${sql}) AND (run_id = '' OR run_id = ?)`,
      [
        runId,
        "execution",
        sessionId,
        ownerId,
        epoch,
        tokenHash,
        "active",
        ...params,
        runId,
      ],
    );
  }

  binding(
    executor: DB,
    sessionId: string,
    ownerId: string,
    epoch: number,
    tokenHash: string,
  ): RuntimeLeaseRecord | undefined {
    return queryOptional<RuntimeLeaseRecord>(
      executor,
      `SELECT ${columns} FROM session_runtime_leases
       WHERE session_id = ? AND owner_instance_id = ? AND epoch = ?
         AND lease_token_hash = ? AND state = ? LIMIT 1`,
      [sessionId, ownerId, epoch, tokenHash, "active"],
    );
  }

  runStatus(
    executor: DB,
    runId: string,
    sessionId: string,
  ): string | undefined {
    return queryOptional<{ status: string }>(
      executor,
      `SELECT status FROM session_runs WHERE id = ? AND session_id = ? LIMIT 1`,
      [runId, sessionId],
    )?.status;
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("runtime lease database is not open");
    return this.db;
  }
}

function renewLeaseExec(
  executor: DB,
  record: RuntimeLeaseRecord,
  ttl: number,
): number {
  return execChanges(
    executor,
    `UPDATE session_runtime_leases SET
       heartbeat_at = CAST(strftime('%s','now') AS INTEGER),
       expires_at = CAST(strftime('%s','now') AS INTEGER) + ?,
       updated_at = CAST(strftime('%s','now') AS INTEGER)
     WHERE session_id = ? AND owner_instance_id = ? AND epoch = ?
       AND lease_token_hash = ? AND state = ?`,
    [
      ttl,
      record.sessionId,
      record.ownerId,
      record.epoch,
      record.tokenHash,
      "active",
    ],
  );
}
