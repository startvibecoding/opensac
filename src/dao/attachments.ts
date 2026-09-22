// Ported from internal/dao/attachments.go

import type { DB } from "../db/mod.ts";
import { ErrNoRows, execChanges, queryAll, queryOne } from "./database.ts";

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  runId: string;
  origin: string;
  kind: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  storageKey: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  metadata: string;
}

export interface AttachmentStorageReference {
  id: string;
  storageKey: string;
}

const columns = `id, session_id AS sessionId, run_id AS runId, origin, kind,
  filename, media_type AS mediaType, byte_size AS bytes, sha256,
  storage_key AS storageKey, status, created_at AS createdAt,
  expires_at AS expiresAt, metadata`;

export class AttachmentDAO {
  constructor(private readonly db: DB | null) {}

  insert(executor: DB, record: AttachmentRecord | null): void {
    if (record === null) return;
    execChanges(
      executor,
      `INSERT INTO session_attachments
        (id, session_id, run_id, origin, kind, filename, media_type, byte_size,
         sha256, storage_key, status, created_at, expires_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.runId,
        record.origin,
        record.kind,
        record.filename,
        record.mediaType,
        record.bytes,
        record.sha256,
        record.storageKey,
        record.status,
        record.createdAt,
        record.expiresAt,
        record.metadata,
      ],
    );
  }

  find(sessionId: string, attachmentId: string): AttachmentRecord {
    return queryOne<AttachmentRecord>(
      this.requireDb(),
      `SELECT ${columns} FROM session_attachments WHERE session_id = ? AND id = ? LIMIT 1`,
      [sessionId, attachmentId],
    );
  }

  /** Lists the rows of one session filtered by status in creation order. */
  listBySessionStatus(
    sessionId: string,
    status: string,
  ): AttachmentRecord[] {
    return queryAll<AttachmentRecord>(
      this.requireDb(),
      `SELECT ${columns} FROM session_attachments
       WHERE session_id = ? AND status = ?
       ORDER BY created_at ASC, id ASC`,
      [sessionId, status],
    );
  }

  /**
   * Lists the rows of one session in creation order, optionally filtered by
   * status. An empty status returns every row of the session.
   */
  listBySession(sessionId: string, status: string): AttachmentRecord[] {
    const trimmed = status.trim();
    if (trimmed !== "") {
      return queryAll<AttachmentRecord>(
        this.requireDb(),
        `SELECT ${columns} FROM session_attachments
         WHERE session_id = ? AND status = ?
         ORDER BY created_at ASC, id ASC`,
        [sessionId, trimmed],
      );
    }
    return queryAll<AttachmentRecord>(
      this.requireDb(),
      `SELECT ${columns} FROM session_attachments
       WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
  }

  /**
   * Returns the ID and storage key of every attachment row, across sessions
   * and regardless of status. It is the durable side of the private-store
   * reconciliation.
   */
  listStorageReferences(executor: DB): AttachmentStorageReference[] {
    return queryAll<AttachmentStorageReference>(
      executor,
      `SELECT id, storage_key AS storageKey FROM session_attachments
       ORDER BY id ASC`,
    );
  }

  expired(executor: DB, now: string): AttachmentRecord[] {
    return queryAll<AttachmentRecord>(
      executor,
      `SELECT id, storage_key AS storageKey FROM session_attachments
       WHERE expires_at <= ?`,
      [now],
    );
  }

  markExpired(executor: DB, now: string): void {
    execChanges(
      executor,
      `UPDATE session_attachments SET status = ?
       WHERE expires_at <= ? AND status != ?`,
      ["expired", now, "expired"],
    );
  }

  setStatus(
    executor: DB,
    sessionId: string,
    attachmentId: string,
    status: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE session_attachments SET status = ?
       WHERE session_id = ? AND id = ?`,
      [status, sessionId, attachmentId],
    );
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("attachment database is not open");
    return this.db;
  }
}

export function isNoRowsAttachment(err: unknown): boolean {
  return err === ErrNoRows;
}
