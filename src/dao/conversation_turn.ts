import type { DB } from "../db/mod.ts";
import {
  execChanges,
  execReturning,
  isNoRows,
  queryAll,
  queryOne,
} from "./database.ts";

export interface EntryRecord {
  seq: number;
  sessionId: string;
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  data: string;
}

export interface ConversationTurnRecord {
  id: string;
  sessionId: string;
  intentId: string;
  kind: string;
  status: string;
  startSeq: number;
  endSeq: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ConversationTurnState {
  intentId: string;
  status: string;
  runId: string;
}

const entryColumns = `seq, session_id AS sessionId, id, type,
  parent_id AS parentId, timestamp, data`;

const turnColumns = `id, session_id AS sessionId, intent_id AS intentId, kind,
  status, start_seq AS startSeq, end_seq AS endSeq, started_at AS startedAt,
  ended_at AS endedAt`;

export class ConversationTurnDAO {
  constructor(private readonly db: DB | null) {}

  appendEntry(executor: DB, record: EntryRecord): number {
    return execReturning<number>(
      executor,
      `INSERT INTO entries (session_id, id, type, parent_id, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
      [
        record.sessionId,
        record.id,
        record.type,
        record.parentId,
        record.timestamp,
        record.data,
      ],
    );
  }

  entry(executor: DB, id: string): EntryRecord {
    return queryOne<EntryRecord>(
      executor,
      `SELECT ${entryColumns} FROM entries WHERE id = ? LIMIT 1`,
      [id],
    );
  }

  currentLeaf(executor: DB, sessionId: string, excludedType: string): string {
    try {
      const row = queryOne<{ id: string }>(
        executor,
        `SELECT id FROM entries WHERE session_id = ? AND type <> ?
         ORDER BY seq DESC LIMIT 1`,
        [sessionId, excludedType],
      );
      return row.id;
    } catch (err) {
      if (isNoRows(err)) return "";
      throw err;
    }
  }

  state(
    executor: DB,
    sessionId: string,
    turnId: string,
  ): ConversationTurnState {
    return queryOne<ConversationTurnState>(
      executor,
      `SELECT ct.intent_id AS intentId, ct.status AS status,
        COALESCE((SELECT json_extract(e.data, '$.runId') FROM entries e
          WHERE e.session_id = ct.session_id AND e.type = 'turn_start'
          AND json_extract(e.data, '$.turnId') = ct.id
          ORDER BY e.seq DESC LIMIT 1), '') AS runId
       FROM conversation_turns AS ct
       WHERE ct.id = ? AND ct.session_id = ? LIMIT 1`,
      [turnId, sessionId],
    );
  }

  openCount(executor: DB, sessionId: string): number {
    return queryOne<{ n: number }>(
      executor,
      `SELECT COUNT(*) AS n FROM conversation_turns
       WHERE session_id = ? AND status = ?`,
      [sessionId, "open"],
    ).n;
  }

  reopen(executor: DB, turn: ConversationTurnRecord): void {
    execChanges(
      executor,
      `UPDATE conversation_turns
       SET intent_id = ?, status = ?, end_seq = NULL, started_at = ?, ended_at = NULL
       WHERE id = ? AND session_id = ?`,
      [turn.intentId, "open", turn.startedAt, turn.id, turn.sessionId],
    );
  }

  insert(executor: DB, turn: ConversationTurnRecord): void {
    execChanges(
      executor,
      `INSERT INTO conversation_turns
        (id, session_id, intent_id, kind, status, start_seq, end_seq, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        turn.id,
        turn.sessionId,
        turn.intentId,
        turn.kind,
        turn.status,
        turn.startSeq,
        turn.endSeq,
        turn.startedAt,
        turn.endedAt,
      ],
    );
  }

  close(
    executor: DB,
    sessionId: string,
    turnId: string,
    status: string,
    endSeq: number,
    endedAt: string,
  ): void {
    execChanges(
      executor,
      `UPDATE conversation_turns
       SET status = ?, end_seq = ?, ended_at = ?
       WHERE id = ? AND session_id = ? AND status = ?`,
      [status, endSeq, endedAt, turnId, sessionId, "open"],
    );
  }

  list(sessionId: string): ConversationTurnRecord[] {
    return this.listFrom(this.requireDb(), sessionId);
  }

  listFrom(executor: DB, sessionId: string): ConversationTurnRecord[] {
    return queryAll<ConversationTurnRecord>(
      executor,
      `SELECT ${turnColumns} FROM conversation_turns
       WHERE session_id = ? ORDER BY start_seq`,
      [sessionId],
    );
  }

  private requireDb(): DB {
    if (this.db === null) {
      throw new Error("conversation turn database is not open");
    }
    return this.db;
  }
}
