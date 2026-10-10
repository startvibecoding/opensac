import type { DB } from "../db/mod.ts";
import { execChanges, queryAll, queryOptional } from "./database.ts";

export interface InputResourceRecord {
  id: string;
  sessionId: string;
  runId: string;
  origin: string;
  eventId: string;
  itemIndex: number;
  itemKey: string;
  kind: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  relativePath: string;
  status: string;
  createdAt: string;
  metadata: string;
}

export interface InputResourceEventRecord {
  id: string;
  sessionId: string;
  resourceId: string;
  runId: string;
  eventType: string;
  status: string;
  timestamp: string;
  data: string;
}

const resourceColumns = `id, session_id AS sessionId, run_id AS runId, origin,
  event_id AS eventId, item_index AS itemIndex, item_key AS itemKey, kind,
  filename, media_type AS mediaType, byte_size AS bytes, sha256,
  relative_path AS relativePath, status, created_at AS createdAt, metadata`;

const eventColumns = `id, session_id AS sessionId, resource_id AS resourceId,
  run_id AS runId, event_type AS eventType, status, timestamp, data`;

export class InputResourceDAO {
  private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  insert(executor: DB, record: InputResourceRecord): void {
    execChanges(
      executor,
      `INSERT INTO input_resources
        (id, session_id, run_id, origin, event_id, item_index, item_key, kind,
         filename, media_type, byte_size, sha256, relative_path, status,
         created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindResource(record),
    );
  }

  find(
    executor: DB,
    sessionId: string,
    resourceId: string,
  ): InputResourceRecord | undefined {
    return queryOptional<InputResourceRecord>(
      executor,
      `SELECT ${resourceColumns} FROM input_resources
       WHERE session_id = ? AND id = ? LIMIT 1`,
      [sessionId, resourceId],
    );
  }

  findByItemKey(
    sessionId: string,
    itemKey: string,
  ): InputResourceRecord | undefined {
    return queryOptional<InputResourceRecord>(
      this.requireDb(),
      `SELECT ${resourceColumns} FROM input_resources
       WHERE session_id = ? AND item_key = ? LIMIT 1`,
      [sessionId, itemKey],
    );
  }

  list(executor: DB, sessionId: string): InputResourceRecord[] {
    return queryAll<InputResourceRecord>(
      executor,
      `SELECT ${resourceColumns} FROM input_resources
       WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
  }

  updateAttachment(
    executor: DB,
    sessionId: string,
    resourceId: string,
    runId: string,
  ): void {
    execChanges(
      executor,
      `UPDATE input_resources SET run_id = ?, status = ?
       WHERE id = ? AND session_id = ?`,
      [runId, "attached", resourceId, sessionId],
    );
  }

  updateStatus(
    executor: DB,
    sessionId: string,
    resourceId: string,
    status: string,
  ): void {
    execChanges(
      executor,
      `UPDATE input_resources SET status = ? WHERE id = ? AND session_id = ?`,
      [status, resourceId, sessionId],
    );
  }

  deleteDraft(executor: DB, sessionId: string, resourceId: string): void {
    execChanges(
      executor,
      `UPDATE input_resources SET status = ?
       WHERE id = ? AND session_id = ? AND status = ? AND run_id = ?`,
      ["deleted", resourceId, sessionId, "prepared", ""],
    );
  }

  createdAt(
    executor: DB,
    sessionId: string,
    resourceId: string,
  ): string | undefined {
    return queryOptional<{ createdAt: string }>(
      executor,
      `SELECT created_at AS createdAt FROM input_resources
       WHERE id = ? AND session_id = ? LIMIT 1`,
      [resourceId, sessionId],
    )?.createdAt;
  }

  appendEvent(executor: DB, record: InputResourceEventRecord): void {
    execChanges(
      executor,
      `INSERT INTO input_resource_events
        (id, session_id, resource_id, run_id, event_type, status, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        record.id,
        record.sessionId,
        record.resourceId,
        record.runId,
        record.eventType,
        record.status,
        record.timestamp,
        record.data,
      ],
    );
  }

  listEvents(sessionId: string): InputResourceEventRecord[] {
    return queryAll<InputResourceEventRecord>(
      this.requireDb(),
      `SELECT ${eventColumns} FROM input_resource_events
       WHERE session_id = ? ORDER BY timestamp ASC, id ASC`,
      [sessionId],
    );
  }

  ownerRun(
    executor: DB,
    resourceId: string,
    sessionId: string,
  ): { runId: string; status: string } | undefined {
    const record = this.find(executor, sessionId, resourceId);
    if (record === undefined) return undefined;
    return { runId: record.runId, status: record.status };
  }

  ownerIntent(
    executor: DB,
    ownerRunId: string,
    sessionId: string,
  ): string | undefined {
    return queryOptional<{ intentId: string }>(
      executor,
      `SELECT intent_id AS intentId FROM session_runs
       WHERE id = ? AND session_id = ? LIMIT 1`,
      [ownerRunId, sessionId],
    )?.intentId;
  }

  private requireDb(): DB {
    if (this.db === null) {
      throw new Error("input resource database is not open");
    }
    return this.db;
  }
}

function bindResource(r: InputResourceRecord): (string | number | null)[] {
  return [
    r.id,
    r.sessionId,
    r.runId,
    r.origin,
    r.eventId,
    r.itemIndex,
    r.itemKey,
    r.kind,
    r.filename,
    r.mediaType,
    r.bytes,
    r.sha256,
    r.relativePath,
    r.status,
    r.createdAt,
    r.metadata,
  ];
}
