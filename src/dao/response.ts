import type { DB } from "../db/mod.ts";
import {
  ErrNoRows,
  execChanges,
  inList,
  queryAll,
  queryOne,
} from "./database.ts";

type Blob = Uint8Array | null;

export interface ResponseRunRecord {
  id: number;
  sessionId: string;
  localRunId: string;
  localTurnId: string;
  messageId: number | null;
  responseId: string | null;
  provider: string;
  api: string;
  state: string;
  pollingUrl: string | null;
  lastEventSequence: number | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResponseTurnRecord {
  id: number;
  sessionId: string;
  localTurnId: string;
  messageId: number | null;
  requestId: string | null;
  responseId: string | null;
  previousResponseId: string | null;
  conversationId: string | null;
  provider: string;
  api: string;
  model: string;
  stateMode: string;
  status: string;
  incompleteReason: string | null;
  requestSummaryJson: Blob;
  responseSummaryJson: Blob;
  createdAt: string;
  completedAt: string | null;
}

export interface ResponseItemRecord {
  id: number;
  sessionId: string;
  localTurnId: string;
  responseId: string | null;
  itemId: string | null;
  outputIndex: number;
  itemType: string;
  itemStatus: string | null;
  itemKey: string;
  sanitizedJson: Blob;
  createdAt: string;
  updatedAt: string | null;
}

export interface ToolExecutionRecord {
  id: number;
  sessionId: string;
  localTurnId: string;
  executionKey: string;
  provider: string;
  api: string;
  responseId: string | null;
  providerCallId: string | null;
  toolKind: string;
  toolName: string;
  argsHash: string;
  executionState: string;
  resultSummaryJson: Blob;
  providerMetadataJson: Blob;
  sideEffecting: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface ResponseSessionStateRecord {
  sessionId: string;
  stateMode: string;
  previousResponseId: string | null;
  conversationId: string | null;
  provider: string;
  api: string;
  model: string;
  version: number;
  updatedAt: string;
}

export interface ResponseReplayItemRecord {
  localTurnId: string;
  sanitizedJson: Blob;
}

const runColumns = `id, session_id AS sessionId, local_run_id AS localRunId,
  local_turn_id AS localTurnId, message_id AS messageId, response_id AS responseId,
  provider, api, state, polling_url AS pollingUrl,
  last_event_sequence AS lastEventSequence,
  cancel_requested AS cancelRequested, created_at AS createdAt,
  updated_at AS updatedAt`;

const turnColumns = `id, session_id AS sessionId, local_turn_id AS localTurnId,
  message_id AS messageId, request_id AS requestId, response_id AS responseId,
  previous_response_id AS previousResponseId,
  conversation_id AS conversationId, provider, api, model,
  state_mode AS stateMode, status, incomplete_reason AS incompleteReason,
  request_summary_json AS requestSummaryJson,
  response_summary_json AS responseSummaryJson, created_at AS createdAt,
  completed_at AS completedAt`;

const itemColumns = `id, session_id AS sessionId, local_turn_id AS localTurnId,
  response_id AS responseId, item_id AS itemId, output_index AS outputIndex,
  item_type AS itemType, item_status AS itemStatus, item_key AS itemKey,
  sanitized_json AS sanitizedJson, created_at AS createdAt,
  updated_at AS updatedAt`;

const toolColumns = `id, session_id AS sessionId, local_turn_id AS localTurnId,
  execution_key AS executionKey, provider, api, response_id AS responseId,
  provider_call_id AS providerCallId, tool_kind AS toolKind,
  tool_name AS toolName, args_hash AS argsHash,
  execution_state AS executionState,
  result_summary_json AS resultSummaryJson,
  provider_metadata_json AS providerMetadataJson,
  side_effecting AS sideEffecting, created_at AS createdAt,
  completed_at AS completedAt`;

const stateColumns = `session_id AS sessionId, state_mode AS stateMode,
  previous_response_id AS previousResponseId,
  conversation_id AS conversationId, provider, api, model, version,
  updated_at AS updatedAt`;

export class ResponseDAO {
  constructor(private readonly db: DB | null) {}

  linkedRun(
    executor: DB,
    sessionId: string,
    localRunId: string,
  ): ResponseRunRecord {
    return queryOne<ResponseRunRecord>(
      executor,
      `SELECT ${runColumns} FROM response_runs
       WHERE session_id = ?
         AND (local_turn_id = ? OR substr(local_turn_id, 1, length(?) + 1) = ? || ':')
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [sessionId, localRunId, localRunId, localRunId],
    );
  }

  insertRun(executor: DB, record: ResponseRunRecord): void {
    execChanges(
      executor,
      `INSERT INTO response_runs
        (id, session_id, local_run_id, local_turn_id, message_id, response_id,
         provider, api, state, polling_url, last_event_sequence, cancel_requested,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        zeroIDToNull(record.id),
        record.sessionId,
        record.localRunId,
        record.localTurnId,
        record.messageId,
        record.responseId,
        record.provider,
        record.api,
        record.state,
        record.pollingUrl,
        record.lastEventSequence,
        record.cancelRequested ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  findRun(executor: DB, id: number): ResponseRunRecord {
    return queryOne<ResponseRunRecord>(
      executor,
      `SELECT ${runColumns} FROM response_runs WHERE id = ? LIMIT 1`,
      [id],
    );
  }

  insertTurn(executor: DB, record: ResponseTurnRecord): void {
    execChanges(
      executor,
      `INSERT INTO response_turns
        (id, session_id, local_turn_id, message_id, request_id, response_id,
         previous_response_id, conversation_id, provider, api, model, state_mode,
         status, incomplete_reason, request_summary_json, response_summary_json,
         created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, local_turn_id) DO UPDATE SET
         message_id = excluded.message_id, request_id = excluded.request_id,
         response_id = excluded.response_id,
         previous_response_id = excluded.previous_response_id,
         conversation_id = excluded.conversation_id, provider = excluded.provider,
         api = excluded.api, model = excluded.model,
         state_mode = excluded.state_mode, status = excluded.status,
         incomplete_reason = excluded.incomplete_reason,
         request_summary_json = excluded.request_summary_json,
         response_summary_json = excluded.response_summary_json,
         completed_at = excluded.completed_at`,
      bindTurn(record),
    );
  }

  findTurn(sessionId: string, localTurnId: string): ResponseTurnRecord {
    return queryOne<ResponseTurnRecord>(
      this.requireDb(),
      `SELECT ${turnColumns} FROM response_turns
       WHERE session_id = ? AND local_turn_id = ? LIMIT 1`,
      [sessionId, localTurnId],
    );
  }

  upsertItem(executor: DB, record: ResponseItemRecord): void {
    execChanges(
      executor,
      `INSERT INTO response_items
        (id, session_id, local_turn_id, response_id, item_id, output_index,
         item_type, item_status, item_key, sanitized_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, local_turn_id, item_key) DO UPDATE SET
         response_id = excluded.response_id, item_id = excluded.item_id,
         output_index = excluded.output_index, item_type = excluded.item_type,
         item_status = excluded.item_status,
         sanitized_json = excluded.sanitized_json,
         updated_at = excluded.updated_at`,
      bindItem(record),
    );
  }

  listItems(sessionId: string, localTurnId: string): ResponseItemRecord[] {
    return queryAll<ResponseItemRecord>(
      this.requireDb(),
      `SELECT ${itemColumns} FROM response_items
       WHERE session_id = ? AND local_turn_id = ? ORDER BY id ASC`,
      [sessionId, localTurnId],
    );
  }

  listReplayItems(
    sessionId: string,
    limit: number,
  ): ResponseReplayItemRecord[] {
    const { sql, params } = inList(["completed", "incomplete"]);
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT ri.sanitized_json AS sanitizedJson
       FROM response_items AS ri
       JOIN response_turns AS rt
         ON rt.session_id = ri.session_id AND rt.local_turn_id = ri.local_turn_id
       WHERE ri.session_id = ? AND rt.status IN (${sql})
       ORDER BY rt.created_at ASC, ri.output_index ASC, ri.id ASC LIMIT ?`,
      [sessionId, ...params, limit],
    ).map((row) => ({
      localTurnId: "",
      sanitizedJson: (row.sanitizedJson ?? null) as Blob,
    }));
  }

  listReplayTurns(sessionId: string): ResponseReplayItemRecord[] {
    const { sql, params } = inList(["completed", "incomplete"]);
    return queryAll<ResponseReplayItemRecord>(
      this.requireDb(),
      `SELECT rt.local_turn_id AS localTurnId, ri.sanitized_json AS sanitizedJson
       FROM response_turns AS rt
       JOIN response_items AS ri
         ON ri.session_id = rt.session_id AND ri.local_turn_id = rt.local_turn_id
       WHERE rt.session_id = ? AND rt.status IN (${sql})
       ORDER BY rt.created_at ASC, ri.output_index ASC, ri.id ASC`,
      [sessionId, ...params],
    );
  }

  claimTool(
    executor: DB,
    record: ToolExecutionRecord,
  ): { stored: ToolExecutionRecord; created: number } {
    const created = execChanges(
      executor,
      `INSERT INTO tool_execution_records
        (id, session_id, local_turn_id, execution_key, provider, api, response_id,
         provider_call_id, tool_kind, tool_name, args_hash, execution_state,
         result_summary_json, provider_metadata_json, side_effecting, created_at,
         completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(execution_key) DO NOTHING`,
      bindTool(record),
    );
    const stored = this.findTool(executor, record.executionKey);
    return { stored, created };
  }

  findTool(executor: DB, executionKey: string): ToolExecutionRecord {
    return queryOne<ToolExecutionRecord>(
      executor,
      `SELECT ${toolColumns} FROM tool_execution_records
       WHERE execution_key = ? LIMIT 1`,
      [executionKey],
    );
  }

  updateTool(executor: DB, record: ToolExecutionRecord): number {
    const { sql, params } = inList(["running", "retry_requested"]);
    return execChanges(
      executor,
      `UPDATE tool_execution_records SET
         execution_state = ?, result_summary_json = ?, provider_metadata_json = ?,
         completed_at = ?
       WHERE execution_key = ? AND execution_state IN (${sql})`,
      [
        record.executionState,
        record.resultSummaryJson,
        record.providerMetadataJson,
        record.completedAt,
        record.executionKey,
        ...params,
      ],
    );
  }

  reclaimTool(
    executor: DB,
    executionKey: string,
    metadata: Blob,
    state: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE tool_execution_records SET
         execution_state = 'running', result_summary_json = NULL,
         provider_metadata_json = ?, completed_at = NULL
       WHERE execution_key = ? AND execution_state = ?`,
      [metadata, executionKey, state],
    );
  }

  requestToolRecovery(
    executor: DB,
    sessionId: string,
    localTurnId: string,
    providerCallIds: string[],
  ): number {
    const ids = inList(providerCallIds);
    const states = inList(["running", "interrupted"]);
    return execChanges(
      executor,
      `UPDATE tool_execution_records SET
         execution_state = 'retry_requested', result_summary_json = NULL,
         completed_at = NULL
       WHERE session_id = ? AND local_turn_id = ?
         AND provider_call_id IN (${ids.sql})
         AND execution_state IN (${states.sql})`,
      [sessionId, localTurnId, ...ids.params, ...states.params],
    );
  }

  listRequestedToolRecoveries(
    executor: DB,
    sessionId: string,
    localTurnId: string,
    providerCallIds: string[],
  ): ToolExecutionRecord[] {
    const ids = inList(providerCallIds);
    return queryAll<ToolExecutionRecord>(
      executor,
      `SELECT ${toolColumns} FROM tool_execution_records
       WHERE session_id = ? AND local_turn_id = ?
         AND provider_call_id IN (${ids.sql})
         AND execution_state = ? ORDER BY id ASC`,
      [sessionId, localTurnId, ...ids.params, "retry_requested"],
    );
  }

  abandonTools(
    executor: DB,
    sessionId: string,
    localTurnId: string,
    summary: Blob,
    completedAt: string,
  ): number {
    const { sql, params } = inList(["running", "interrupted"]);
    return execChanges(
      executor,
      `UPDATE tool_execution_records SET
         execution_state = 'abandoned', result_summary_json = ?, completed_at = ?
       WHERE session_id = ? AND local_turn_id = ?
         AND execution_state IN (${sql})`,
      [summary, completedAt, sessionId, localTurnId, ...params],
    );
  }

  upsertRun(executor: DB, record: ResponseRunRecord): void {
    execChanges(
      executor,
      `INSERT INTO response_runs
        (id, session_id, local_run_id, local_turn_id, message_id, response_id,
         provider, api, state, polling_url, last_event_sequence, cancel_requested,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, local_run_id) DO UPDATE SET
         local_turn_id = excluded.local_turn_id,
         message_id = excluded.message_id, response_id = excluded.response_id,
         provider = excluded.provider, api = excluded.api, state = excluded.state,
         polling_url = excluded.polling_url,
         last_event_sequence = excluded.last_event_sequence,
         cancel_requested = excluded.cancel_requested,
         updated_at = excluded.updated_at`,
      [
        zeroIDToNull(record.id),
        record.sessionId,
        record.localRunId,
        record.localTurnId,
        record.messageId,
        record.responseId,
        record.provider,
        record.api,
        record.state,
        record.pollingUrl,
        record.lastEventSequence,
        record.cancelRequested ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  getRun(sessionId: string, localRunId: string): ResponseRunRecord {
    return queryOne<ResponseRunRecord>(
      this.requireDb(),
      `SELECT ${runColumns} FROM response_runs
       WHERE session_id = ? AND local_run_id = ? LIMIT 1`,
      [sessionId, localRunId],
    );
  }

  listRunsForSession(sessionId: string, limit: number): ResponseRunRecord[] {
    return queryAll<ResponseRunRecord>(
      this.requireDb(),
      `SELECT ${runColumns} FROM response_runs
       WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
      [sessionId, limit],
    );
  }

  getSessionState(sessionId: string): ResponseSessionStateRecord {
    return queryOne<ResponseSessionStateRecord>(
      this.requireDb(),
      `SELECT ${stateColumns} FROM response_session_state
       WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
  }

  insertSessionState(
    executor: DB,
    record: ResponseSessionStateRecord,
  ): number {
    return execChanges(
      executor,
      `INSERT INTO response_session_state
        (session_id, state_mode, previous_response_id, conversation_id, provider,
         api, model, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      [
        record.sessionId,
        record.stateMode,
        record.previousResponseId,
        record.conversationId,
        record.provider,
        record.api,
        record.model,
        record.version,
        record.updatedAt,
      ],
    );
  }

  updateSessionStateCAS(
    executor: DB,
    record: ResponseSessionStateRecord,
    expectedVersion: number,
  ): number {
    return execChanges(
      executor,
      `UPDATE response_session_state SET
         state_mode = ?, previous_response_id = ?, conversation_id = ?,
         provider = ?, api = ?, model = ?, version = version + 1, updated_at = ?
       WHERE session_id = ? AND version = ?`,
      [
        record.stateMode,
        record.previousResponseId,
        record.conversationId,
        record.provider,
        record.api,
        record.model,
        record.updatedAt,
        record.sessionId,
        expectedVersion,
      ],
    );
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("response database is not open");
    return this.db;
  }
}

export function isNoRowsResponse(err: unknown): boolean {
  return err === ErrNoRows;
}

// Mirrors bun's `nullzero` primary-key behavior: an unset (0) integer key is
// inserted as NULL so SQLite assigns the AUTOINCREMENT rowid.
function zeroIDToNull(id: number): number | null {
  return id === 0 ? null : id;
}

function bindTurn(r: ResponseTurnRecord): (string | number | null | Blob)[] {
  return [
    zeroIDToNull(r.id),
    r.sessionId,
    r.localTurnId,
    r.messageId,
    r.requestId,
    r.responseId,
    r.previousResponseId,
    r.conversationId,
    r.provider,
    r.api,
    r.model,
    r.stateMode,
    r.status,
    r.incompleteReason,
    r.requestSummaryJson,
    r.responseSummaryJson,
    r.createdAt,
    r.completedAt,
  ];
}

function bindItem(r: ResponseItemRecord): (string | number | null | Blob)[] {
  return [
    zeroIDToNull(r.id),
    r.sessionId,
    r.localTurnId,
    r.responseId,
    r.itemId,
    r.outputIndex,
    r.itemType,
    r.itemStatus,
    r.itemKey,
    r.sanitizedJson,
    r.createdAt,
    r.updatedAt,
  ];
}

function bindTool(r: ToolExecutionRecord): (string | number | null | Blob)[] {
  return [
    zeroIDToNull(r.id),
    r.sessionId,
    r.localTurnId,
    r.executionKey,
    r.provider,
    r.api,
    r.responseId,
    r.providerCallId,
    r.toolKind,
    r.toolName,
    r.argsHash,
    r.executionState,
    r.resultSummaryJson,
    r.providerMetadataJson,
    r.sideEffecting ? 1 : 0,
    r.createdAt,
    r.completedAt,
  ];
}
