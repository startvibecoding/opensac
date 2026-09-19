// Ported from internal/dao/fork.go

import type { DB } from "../db/mod.ts";
import {
  execChanges,
  execReturning,
  inList,
  queryAll,
  queryOne,
} from "./database.ts";

export interface ForkRequestRecord {
  requestKeyHash: string;
  requestFingerprint: string;
  sourceSessionId: string;
  childSessionId: string;
  createdAt: string;
}

export interface ForkSessionRecord {
  id: string;
  cwd: string | null;
  timestamp: string | null;
  parentSession: string | null;
  channelType: string | null;
  channelId: string | null;
  forkBoundary: number;
  seedLength: number;
  forkKind: string | null;
}

export interface ForkEntryRecord {
  sessionId: string;
  seq: number;
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  data: string;
}

export interface ForkFingerprintRecord {
  maxSeq: number;
  leaf: string;
  openTurns: number;
  activeRuns: number;
}

export interface ForkRunWindowRecord {
  startedAt: string;
  finishedAt: string;
  status: string;
}

const requestColumns = `request_key_hash AS requestKeyHash,
  request_fingerprint AS requestFingerprint,
  source_session_id AS sourceSessionId,
  child_session_id AS childSessionId, created_at AS createdAt`;

const sessionColumns = `id, cwd, timestamp, parent_session AS parentSession,
  channel_type AS channelType, channel_id AS channelId,
  fork_boundary_seq AS forkBoundary, seed_length AS seedLength,
  fork_kind AS forkKind`;

const entryColumns = `session_id AS sessionId, seq, id, type,
  parent_id AS parentId, timestamp, data`;

export class ForkDAO {
  constructor(private readonly db: DB | null) {}

  findRequest(
    executor: DB,
    hash: string,
    source: string,
  ): ForkRequestRecord {
    return queryOne<ForkRequestRecord>(
      executor,
      `SELECT ${requestColumns} FROM session_fork_requests
       WHERE request_key_hash = ? AND source_session_id = ? LIMIT 1`,
      [hash, source],
    );
  }

  findSession(executor: DB, id: string): ForkSessionRecord {
    return queryOne<ForkSessionRecord>(
      executor,
      `SELECT ${sessionColumns} FROM sessions WHERE id = ? LIMIT 1`,
      [id],
    );
  }

  activeRunCount(
    executor: DB,
    sessionId: string,
    statuses: string[],
  ): number {
    const { sql, params } = inList(statuses);
    return queryOne<{ n: number }>(
      executor,
      `SELECT COUNT(*) AS n FROM session_runs
       WHERE session_id = ? AND status IN (${sql})`,
      [sessionId, ...params],
    ).n;
  }

  openTurnCount(executor: DB, sessionId: string): number {
    return queryOne<{ n: number }>(
      executor,
      `SELECT COUNT(*) AS n FROM conversation_turns
       WHERE session_id = ? AND status = ?`,
      [sessionId, "open"],
    ).n;
  }

  listEntries(executor: DB, sessionId: string): ForkEntryRecord[] {
    return queryAll<ForkEntryRecord>(
      executor,
      `SELECT ${entryColumns} FROM entries WHERE session_id = ? ORDER BY seq`,
      [sessionId],
    );
  }

  entryAtSeq(
    executor: DB,
    sessionId: string,
    seq: number,
  ): ForkEntryRecord {
    return queryOne<ForkEntryRecord>(
      executor,
      `SELECT ${entryColumns} FROM entries
       WHERE session_id = ? AND seq = ? LIMIT 1`,
      [sessionId, seq],
    );
  }

  fingerprint(
    executor: DB,
    sessionId: string,
    statuses: string[],
  ): ForkFingerprintRecord {
    const maxSeq = queryOne<{ v: number }>(
      executor,
      `SELECT COALESCE(MAX(seq), 0) AS v FROM entries WHERE session_id = ?`,
      [sessionId],
    ).v;
    const leaf = queryOne<{ v: string }>(
      executor,
      `SELECT COALESCE((SELECT id FROM entries WHERE session_id = ?
        ORDER BY seq DESC LIMIT 1), '') AS v`,
      [sessionId],
    ).v;
    const openTurns = queryOne<{ n: number }>(
      executor,
      `SELECT COUNT(*) AS n FROM conversation_turns
       WHERE session_id = ? AND status = ?`,
      [sessionId, "open"],
    ).n;
    const { sql, params } = inList(statuses);
    const activeRuns = queryOne<{ n: number }>(
      executor,
      `SELECT COUNT(*) AS n FROM session_runs
       WHERE session_id = ? AND status IN (${sql})`,
      [sessionId, ...params],
    ).n;
    return { maxSeq: maxSeq, leaf, openTurns, activeRuns };
  }

  runWindows(
    executor: DB,
    sessionId: string,
    statuses: string[],
  ): ForkRunWindowRecord[] {
    const { sql, params } = inList(statuses);
    return queryAll<ForkRunWindowRecord>(
      executor,
      `SELECT started_at AS startedAt, finished_at AS finishedAt, status
       FROM session_runs WHERE session_id = ? AND status IN (${sql})
       ORDER BY started_at, updated_at`,
      [sessionId, ...params],
    );
  }

  insertSessionFrom(
    executor: DB,
    child: string,
    source: string,
    boundary: number,
    seed: number,
    kind: string,
  ): void {
    execChanges(
      executor,
      `INSERT INTO sessions
        (id, cwd, timestamp, parent_session, version, channel_type, channel_id,
         fork_boundary_seq, seed_length, fork_kind, expert_id)
       SELECT ?, cwd, timestamp, ?, version, 'local', '', ?, ?, ?, expert_id
       FROM sessions WHERE id = ?`,
      [child, source, boundary, seed, kind, source],
    );
  }

  insertEntry(executor: DB, record: ForkEntryRecord): number {
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

  insertTurn(
    executor: DB,
    id: string,
    session: string,
    intent: string,
    kind: string,
    status: string,
    start: number,
    end: number | null,
    started: string,
    ended: string | null,
  ): void {
    execChanges(
      executor,
      `INSERT INTO conversation_turns
        (id, session_id, intent_id, kind, status, start_seq, end_seq, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, session, intent, kind, status, start, end, started, ended],
    );
  }

  copyCapabilities(executor: DB, source: string, child: string): void {
    execChanges(
      executor,
      `INSERT INTO session_capabilities
        (session_id, mode, display_mode, delegate_mode, multi_agent, workflows,
         web_search, browser, a2a_master, updated_at)
       SELECT ?, mode, display_mode, delegate_mode, multi_agent, workflows,
              web_search, browser, a2a_master, updated_at
       FROM session_capabilities WHERE session_id = ?`,
      [child, source],
    );
  }

  copyProject(executor: DB, source: string, child: string): void {
    execChanges(
      executor,
      `INSERT INTO session_metadata (session_id, project_id, pinned, updated_at)
       SELECT ?, project_id, 0, updated_at FROM session_metadata
       WHERE session_id = ?`,
      [child, source],
    );
  }

  currentEntryId(executor: DB, session: string): string {
    return queryOne<{ id: string }>(
      executor,
      `SELECT id FROM entries WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
      [session],
    ).id;
  }

  titleExists(
    executor: DB,
    parent: string,
    typ: string,
    title: string,
  ): boolean {
    return queryOne<{ n: number }>(
      executor,
      `SELECT COUNT(*) AS n FROM entries AS e
       JOIN sessions AS s ON s.id = e.session_id
       WHERE s.parent_session = ? AND e.type = ?
         AND json_extract(e.data, '$.name') = ?`,
      [parent, typ, title],
    ).n > 0;
  }

  insertForkRequest(executor: DB, record: ForkRequestRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_fork_requests
        (request_key_hash, request_fingerprint, source_session_id, child_session_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        record.requestKeyHash,
        record.requestFingerprint,
        record.sourceSessionId,
        record.childSessionId,
        record.createdAt,
      ],
    );
  }

  insertRawEntry(
    executor: DB,
    session: string,
    id: string,
    typ: string,
    parent: string | null,
    timestamp: string,
    data: string,
  ): void {
    execChanges(
      executor,
      `INSERT INTO entries (session_id, id, type, parent_id, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [session, id, typ, parent, timestamp, data],
    );
  }

  result(executor: DB, id: string): ForkSessionRecord {
    return this.findSession(executor, id);
  }
}
