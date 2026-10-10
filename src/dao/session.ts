import type { DB } from "../db/mod.ts";
import { execChanges, inList, queryAll, queryOptional } from "./database.ts";
import { type EntryRecord } from "./conversation_turn.ts";
import { type SessionRunEventRecord } from "./run.ts";

export interface SessionRecord {
  id: string;
  cwd: string;
  timestamp: string;
  channelType: string;
  channelId: string;
  parentSession: string | null;
  version: number;
  forkBoundarySeq: number;
  seedLength: number;
  forkKind: string;
  expertId: string;
}

export interface SessionCapabilityRecord {
  sessionId: string;
  mode: string;
  displayMode: string;
  delegateMode: number;
  multiAgent: number;
  workflows: number;
  webSearch: number;
  browser: number;
  a2aMaster: number;
  updatedAt: string;
}

export interface SessionCapabilityEventRecord {
  seq: number;
  id: string;
  sessionId: string;
  runId: string;
  eventType: string;
  source: string;
  actor: string;
  capability: string;
  oldValue: string;
  newValue: string;
  timestamp: string;
  data: string;
}

export interface SessionListFilter {
  cwd?: string;
  search?: string;
  messagesOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface SessionDetailAggregates {
  messageCounts: Map<string, number>;
  firstMessages: Map<string, string>;
  latestInfos: Map<string, string>;
  /** Newest entry timestamp per session (ISO string, lexicographic = chronological). */
  latestEntryTimestamps: Map<string, string>;
}

const sessionColumns = `id, cwd, timestamp, parent_session AS parentSession,
  version, channel_type AS channelType, channel_id AS channelId,
  fork_boundary_seq AS forkBoundarySeq, seed_length AS seedLength,
  fork_kind AS forkKind, expert_id AS expertId`;

const capabilityColumns = `session_id AS sessionId, mode,
  display_mode AS displayMode, delegate_mode AS delegateMode,
  multi_agent AS multiAgent, workflows, web_search AS webSearch, browser,
  a2a_master AS a2aMaster, updated_at AS updatedAt`;

const runEventColumns = `seq, session_id AS sessionId, id, run_id AS runId,
  event_type AS eventType, source, status, model, mode, timestamp, data`;

const capabilityEventColumns = `seq, session_id AS sessionId, id,
  run_id AS runId, event_type AS eventType, source, actor, capability,
  old_value AS oldValue, new_value AS newValue, timestamp, data`;

export class SessionDAO {
    private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  detailAggregates(sessionIds: string[]): SessionDetailAggregates {
    const result: SessionDetailAggregates = {
      messageCounts: new Map(),
      firstMessages: new Map(),
      latestInfos: new Map(),
      latestEntryTimestamps: new Map(),
    };
    if (sessionIds.length === 0) return result;
    const db = this.requireDb();
    const { sql, params } = inList(sessionIds);
    const counts = queryAll<{ sessionId: string; messageCount: number }>(
      db,
      `SELECT session_id AS sessionId, COUNT(*) AS messageCount
       FROM entries WHERE session_id IN (${sql}) AND type = ?
       GROUP BY session_id`,
      [...params, "message"],
    );
    for (const row of counts) {
      result.messageCounts.set(row.sessionId, Number(row.messageCount));
    }
    // Any entry is activity: a session's "modified" time is its newest entry,
    // not its creation row, so continuation picks the conversation last used.
    const latest = queryAll<{ sessionId: string; ts: string }>(
      db,
      `SELECT session_id AS sessionId, MAX(timestamp) AS ts
       FROM entries WHERE session_id IN (${sql})
       GROUP BY session_id`,
      params,
    );
    for (const row of latest) {
      if (typeof row.ts === "string" && row.ts !== "") {
        result.latestEntryTimestamps.set(row.sessionId, row.ts);
      }
    }
    const first = queryAll<{ sessionId: string; data: string }>(
      db,
      `SELECT e.session_id AS sessionId, e.data AS data
       FROM entries AS e
       JOIN (SELECT session_id, MIN(seq) AS min_seq FROM entries
             WHERE type = 'message' AND session_id IN (${sql})
             GROUP BY session_id) AS first
         ON e.session_id = first.session_id AND e.seq = first.min_seq`,
      params,
    );
    for (const row of first) result.firstMessages.set(row.sessionId, row.data);

    const infos = queryAll<{ sessionId: string; data: string }>(
      db,
      `SELECT session_id AS sessionId, data FROM entries
       WHERE session_id IN (${sql}) AND type = ? ORDER BY seq DESC`,
      [...params, "session_info"],
    );
    for (const row of infos) {
      if (!result.latestInfos.has(row.sessionId)) {
        result.latestInfos.set(row.sessionId, row.data);
      }
    }
    return result;
  }

  insertSession(
    executor: DB,
    table: string,
    id: string,
    cwd: string,
    timestamp: string,
    parent: string,
    version: number,
    channelType: string,
    channelId: string,
    boundary: number,
    seed: number,
    kind: string,
    expertId: string,
  ): void {
    execChanges(
      executor,
      `INSERT INTO ${table}
        (id, cwd, timestamp, parent_session, version, channel_type, channel_id,
         fork_boundary_seq, seed_length, fork_kind, expert_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        cwd,
        timestamp,
        nullableSessionString(parent),
        version,
        channelType,
        channelId,
        boundary,
        seed,
        kind,
        expertId,
      ],
    );
  }

  updateSessionExpertId(
    executor: DB,
    table: string,
    sessionId: string,
    expertId: string,
  ): void {
    execChanges(
      executor,
      `UPDATE ${table} SET expert_id = ? WHERE id = ?`,
      [expertId, sessionId],
    );
  }

  updateSessionCwd(
    executor: DB,
    table: string,
    sessionId: string,
    cwd: string,
  ): void {
    execChanges(
      executor,
      `UPDATE ${table} SET cwd = ? WHERE id = ?`,
      [cwd, sessionId],
    );
  }

  currentLeaf(
    executor: DB,
    table: string,
    sessionId: string,
    excludedType: string,
  ): string {
    return queryOptional<{ id: string }>(
      executor,
      `SELECT id FROM ${table} WHERE session_id = ? AND type != ?
       ORDER BY seq DESC LIMIT 1`,
      [sessionId, excludedType],
    )?.id ?? "";
  }

  insertEntry(
    executor: DB,
    table: string,
    sessionId: string,
    id: string,
    typ: string,
    parent: string | null,
    timestamp: string,
    data: string,
  ): void {
    execChanges(
      executor,
      `INSERT INTO ${table} (session_id, id, type, parent_id, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, id, typ, parent, timestamp, data],
    );
  }

  listForDir(cwd: string): SessionRecord[] {
    return queryAll<SessionRecord>(
      this.requireDb(),
      `SELECT ${sessionColumns} FROM sessions WHERE cwd = ?
       ORDER BY timestamp DESC`,
      [cwd],
    );
  }

  list(filter: SessionListFilter): SessionRecord[] {
    const { where, params } = sessionListWhere(filter);
    return queryAll<SessionRecord>(
      this.requireDb(),
      `SELECT ${sessionColumns} FROM sessions AS s${where}
       ORDER BY s.timestamp DESC${limitClause(filter)}`,
      params,
    );
  }

  count(filter: SessionListFilter): number {
    const { where, params } = sessionListWhere(filter);
    return queryOptional<{ n: number }>(
      this.requireDb(),
      `SELECT COUNT(*) AS n FROM sessions AS s${where}`,
      params,
    )?.n ?? 0;
  }

  findExact(table: string, id: string): string | undefined {
    return queryOptional<{ id: string }>(
      this.requireDb(),
      `SELECT id FROM ${table} WHERE id = ? LIMIT 1`,
      [id],
    )?.id;
  }

  prefixIds(table: string, cwd: string, prefix: string): string[] {
    return queryAll<{ id: string }>(
      this.requireDb(),
      `SELECT id FROM ${table} WHERE cwd = ? AND id LIKE ?`,
      [cwd, `${prefix}%`],
    ).map((row) => row.id);
  }

  timestamp(table: string, id: string): string | undefined {
    return queryOptional<{ timestamp: string }>(
      this.requireDb(),
      `SELECT timestamp FROM ${table} WHERE id = ? LIMIT 1`,
      [id],
    )?.timestamp;
  }

  header(table: string, id: string): SessionRecord | undefined {
    const row = queryOptional<Record<string, unknown>>(
      this.requireDb(),
      `SELECT cwd, timestamp, parent_session AS parentSession, version,
              channel_type AS channelType, channel_id AS channelId,
              fork_boundary_seq AS forkBoundarySeq, seed_length AS seedLength,
              fork_kind AS forkKind, expert_id AS expertId
       FROM ${table} WHERE id = ? LIMIT 1`,
      [id],
    );
    if (row === undefined) return undefined;
    return {
      id: "",
      cwd: String(row.cwd),
      timestamp: String(row.timestamp),
      channelType: String(row.channelType),
      channelId: String(row.channelId),
      parentSession: (row.parentSession ?? null) as string | null,
      version: Number(row.version),
      forkBoundarySeq: Number(row.forkBoundarySeq),
      seedLength: Number(row.seedLength),
      forkKind: String(row.forkKind),
      expertId: String(row.expertId),
    };
  }

  entries(table: string, sessionId: string): EntryRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT type, data FROM ${table} WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId],
    ).map(toEntry);
  }

  /**
   * Removes the session row and every child row that references it. `tables`
   * lists the session_id-keyed child tables child-first.
   */
  deleteSession(executor: DB, sessionId: string, tables: string[]): void {
    execChanges(
      executor,
      `DELETE FROM session_fork_requests
       WHERE source_session_id = ? OR child_session_id = ?`,
      [sessionId, sessionId],
    );
    execChanges(
      executor,
      `DELETE FROM delivery_operations
       WHERE intent_id IN (SELECT id FROM delivery_intents WHERE session_id = ?)`,
      [sessionId],
    );
    execChanges(
      executor,
      `DELETE FROM attachment_deliveries
       WHERE attachment_id IN (SELECT id FROM session_attachments WHERE session_id = ?)`,
      [sessionId],
    );
    for (const table of tables) {
      execChanges(
        executor,
        `DELETE FROM ${table} WHERE session_id = ?`,
        [sessionId],
      );
    }
    execChanges(executor, `DELETE FROM sessions WHERE id = ?`, [sessionId]);
  }

  upsertCapability(executor: DB, row: SessionCapabilityRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_capabilities
        (session_id, mode, display_mode, delegate_mode, multi_agent, workflows,
         web_search, browser, a2a_master, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         mode = excluded.mode, display_mode = excluded.display_mode,
         delegate_mode = excluded.delegate_mode, multi_agent = excluded.multi_agent,
         workflows = excluded.workflows, web_search = excluded.web_search,
         browser = excluded.browser, a2a_master = excluded.a2a_master,
         updated_at = excluded.updated_at`,
      [
        row.sessionId,
        row.mode,
        row.displayMode,
        row.delegateMode,
        row.multiAgent,
        row.workflows,
        row.webSearch,
        row.browser,
        row.a2aMaster,
        row.updatedAt,
      ],
    );
  }

  capability(sessionId: string): SessionCapabilityRecord | undefined {
    return queryOptional<SessionCapabilityRecord>(
      this.requireDb(),
      `SELECT ${capabilityColumns} FROM session_capabilities
       WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
  }

  insertRunEvent(executor: DB, row: SessionRunEventRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_run_events
        (id, session_id, run_id, event_type, source, status, model, mode, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.sessionId,
        row.runId,
        row.eventType,
        row.source,
        row.status,
        row.model,
        row.mode,
        row.timestamp,
        row.data,
      ],
    );
  }

  listRunEvents(sessionId: string): SessionRunEventRecord[] {
    return this.listRunEventsFrom(this.requireDb(), sessionId);
  }

  listRunEventsFrom(executor: DB, sessionId: string): SessionRunEventRecord[] {
    return queryAll<SessionRunEventRecord>(
      executor,
      `SELECT ${runEventColumns} FROM session_run_events
       WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId],
    );
  }

  maxRunEventSeq(runId: string): number {
    return queryOptional<{ seq: number }>(
      this.requireDb(),
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM session_run_events WHERE run_id = ?`,
      [runId],
    )?.seq ?? 0;
  }

  insertCapabilityEvent(
    executor: DB,
    row: SessionCapabilityEventRecord,
  ): void {
    execChanges(
      executor,
      `INSERT INTO session_capability_events
        (id, session_id, run_id, event_type, source, actor, capability,
         old_value, new_value, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.sessionId,
        row.runId,
        row.eventType,
        row.source,
        row.actor,
        row.capability,
        row.oldValue,
        row.newValue,
        row.timestamp,
        row.data,
      ],
    );
  }

  listCapabilityEvents(sessionId: string): SessionCapabilityEventRecord[] {
    return queryAll<SessionCapabilityEventRecord>(
      this.requireDb(),
      `SELECT ${capabilityEventColumns} FROM session_capability_events
       WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId],
    );
  }

  messages(sessionId: string): EntryRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT seq, type, data FROM entries
       WHERE session_id = ? AND type IN (?, ?, ?) ORDER BY seq ASC`,
      [sessionId, "message", "compaction", "content_override"],
    ).map(toEntry);
  }

  simpleEntries(sessionId: string): EntryRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT seq, data FROM entries WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId],
    ).map(toEntry);
  }

  messagesAfter(
    sessionId: string,
    after: number,
    limit: number,
  ): EntryRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT seq, data FROM entries
       WHERE session_id = ? AND type = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
      [sessionId, "message", after, limit],
    ).map(toEntry);
  }

  messagesLatest(sessionId: string, limit: number): EntryRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT seq, data FROM entries
       WHERE session_id = ? AND type = ?
       ORDER BY seq DESC LIMIT ?`,
      [sessionId, "message", limit],
    ).map(toEntry);
  }

  messagesBefore(
    sessionId: string,
    before: number,
    limit: number,
  ): EntryRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT seq, data FROM entries
       WHERE session_id = ? AND type = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
      [sessionId, "message", before, limit],
    ).map(toEntry);
  }

  runEventsAfter(
    sessionId: string,
    after: number,
    limit: number,
  ): SessionRunEventRecord[] {
    if (limit > 0) {
      return queryAll<SessionRunEventRecord>(
        this.requireDb(),
        `SELECT ${runEventColumns} FROM session_run_events
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [sessionId, after, limit],
      );
    }
    return queryAll<SessionRunEventRecord>(
      this.requireDb(),
      `SELECT ${runEventColumns} FROM session_run_events
       WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
      [sessionId, after],
    );
  }

  capabilityEventsAfter(
    sessionId: string,
    after: number,
    limit: number,
  ): SessionCapabilityEventRecord[] {
    if (limit > 0) {
      return queryAll<SessionCapabilityEventRecord>(
        this.requireDb(),
        `SELECT ${capabilityEventColumns} FROM session_capability_events
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [sessionId, after, limit],
      );
    }
    return queryAll<SessionCapabilityEventRecord>(
      this.requireDb(),
      `SELECT ${capabilityEventColumns} FROM session_capability_events
       WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
      [sessionId, after],
    );
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("session database is not open");
    return this.db;
  }
}

function nullableSessionString(value: string): string | null {
  return value === "" ? null : value;
}

function sessionListWhere(
  filter: SessionListFilter,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.cwd) {
    clauses.push(`s.cwd = ?`);
    params.push(filter.cwd);
  }
  if (filter.messagesOnly) {
    clauses.push(
      `EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.type = 'message')`,
    );
  }
  if (filter.search) {
    const p = `%${filter.search}%`;
    clauses.push(
      `(s.id LIKE ? COLLATE NOCASE OR s.cwd LIKE ? COLLATE NOCASE OR s.channel_type LIKE ? COLLATE NOCASE OR s.channel_id LIKE ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.data LIKE ? COLLATE NOCASE))`,
    );
    params.push(p, p, p, p, p);
  }
  return {
    where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function limitClause(filter: SessionListFilter): string {
  let clause = "";
  if ((filter.limit ?? 0) > 0) clause += ` LIMIT ${filter.limit}`;
  if ((filter.offset ?? 0) > 0) clause += ` OFFSET ${filter.offset}`;
  return clause;
}

// toEntry fills the fields a partial entry SELECT leaves undefined with the Go
// zero values so callers always see a complete EntryRecord.
function toEntry(row: Record<string, unknown>): EntryRecord {
  return {
    seq: Number(row.seq ?? 0),
    sessionId: String(row.sessionId ?? ""),
    id: String(row.id ?? ""),
    type: String(row.type ?? ""),
    parentId: (row.parentId ?? null) as string | null,
    timestamp: String(row.timestamp ?? ""),
    data: String(row.data ?? ""),
  };
}
