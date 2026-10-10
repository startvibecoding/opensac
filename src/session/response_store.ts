//
// The durable Response-API runtime store: turn lineage, sanitized native item
// archives, cross-protocol tool-execution idempotency records, background run
// state, and the compare-and-swap remote session lineage. All SQL stays in the
// DAO layer; every write revalidates the fenced runtime lease.
//
// Deviations from Go: `context.Context` is dropped (the DAO layer is
// synchronous), `json.RawMessage` maps to decoded `unknown` (serialized to the
// BLOB columns), and `time.Time` maps to `Date`.

import {
  ResponseDAO,
  type ResponseItemRecord,
  type ResponseRunRecord,
  type ResponseSessionStateRecord,
  type ResponseTurnRecord,
  type ToolExecutionRecord as DAOToolExecutionRecord,
} from "../dao/mod.ts";
import type { Database } from "../dao/mod.ts";
import { writeRootDatabase } from "./database.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";
import { validateRuntimeLeaseTx } from "./runtime_lock.ts";

/** Upper bound on a single archived JSON payload, matching the Go limit. */
export const maxResponseArchiveJSONBytes = 128 * 1024;

/** Durable lineage and lifecycle summary for one Responses API turn. */
export interface ResponseTurn {
  id: number;
  sessionId: string;
  localTurnId: string;
  messageId: number | null;
  requestId: string;
  responseId: string;
  previousResponseId: string;
  conversationId: string;
  provider: string;
  api: string;
  model: string;
  stateMode: string;
  status: string;
  incompleteReason: string;
  requestSummary: unknown;
  responseSummary: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * One sanitized normalized item. Raw provider request/response bodies must not
 * be passed here.
 */
export interface ResponseItemArchive {
  id: number;
  sessionId: string;
  localTurnId: string;
  responseId: string;
  itemId: string;
  outputIndex: number;
  itemType: string;
  itemStatus: string;
  itemKey: string;
  sanitizedJson: unknown;
  createdAt: Date;
}

/**
 * The cross-protocol idempotency record for a tool invocation. `executionKey`
 * is local and remains the deduplication authority.
 */
export interface ToolExecutionRecord {
  id: number;
  sessionId: string;
  localTurnId: string;
  executionKey: string;
  provider: string;
  api: string;
  responseId: string;
  providerCallId: string;
  toolKind: string;
  toolName: string;
  argsHash: string;
  executionState: string;
  resultSummary: unknown;
  providerMetadata: unknown;
  sideEffecting: boolean;
  createdAt: Date;
  completedAt: Date | null;
}

/** Durable state for a Responses background run. */
export interface ResponseRun {
  id: number;
  sessionId: string;
  localRunId: string;
  localTurnId: string;
  messageId: number | null;
  responseId: string;
  provider: string;
  api: string;
  state: string;
  pollingUrl: string;
  lastEventSequence: number | null;
  cancelRequested: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Compare-and-swap protected remote lineage for a single local session.
 * Provider config supplies defaults; this record keeps concurrent sessions and
 * concurrent turns from sharing mutable remote state.
 */
export interface ResponseSessionState {
  sessionId: string;
  stateMode: string;
  previousResponseId: string;
  conversationId: string;
  provider: string;
  api: string;
  model: string;
  version: number;
  updatedAt: Date;
}

/**
 * Native output items belonging to one local Responses turn, so callers can
 * place them at the corresponding assistant position while rebuilding a
 * complete local conversation.
 */
export interface ResponseReplayTurn {
  localTurnId: string;
  items: unknown[];
}

// ---------------------------------------------------------------------------
// JSON archive helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes, redacts, and bounds an archived JSON payload. Returns `null` for
 * an empty payload. Throws when the payload is invalid JSON or exceeds
 * `maxResponseArchiveJSONBytes`.
 */
export function archiveJSON(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error("invalid JSON");
  }
  const sanitized = redactArchiveValue(decoded);
  const encoded = JSON.stringify(sanitized);
  if (encoded === undefined) throw new Error("invalid JSON");
  const bytes = new TextEncoder().encode(encoded);
  if (bytes.length > maxResponseArchiveJSONBytes) {
    throw new Error(`JSON exceeds ${maxResponseArchiveJSONBytes} bytes`);
  }
  return bytes;
}

/** Decodes a stored archive BLOB/TEXT payload back into a JSON value. */
function decodeArchiveJSON(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Uint8Array) {
    text = new TextDecoder().decode(value);
  } else if (value instanceof ArrayBuffer) {
    text = new TextDecoder().decode(new Uint8Array(value));
  } else {
    text = String(value);
  }
  if (text === "") return undefined;
  return JSON.parse(text);
}

function redactArchiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => redactArchiveValue(nested));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const lower = key.toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
      if (
        lower.includes("authorization") ||
        lower.includes("api_key") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("password") ||
        lower.includes("cookie")
      ) {
        if (isArchiveUsageCounter(lower, nested)) {
          result[key] = nested;
          continue;
        }
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = redactArchiveValue(nested);
    }
    return result;
  }
  return value;
}

/**
 * Preserves well-known numeric usage counters without weakening redaction for
 * credentials such as access_token or id_token.
 */
function isArchiveUsageCounter(key: string, value: unknown): boolean {
  if (typeof value !== "number") return false;
  switch (key.replace(/_/g, "")) {
    case "inputtokens":
    case "outputtokens":
    case "totaltokens":
    case "cachedtokens":
    case "reasoningtokens":
    case "prompttokens":
    case "completiontokens":
    case "cachereadtokens":
    case "cachewritetokens":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Record mapping helpers
// ---------------------------------------------------------------------------

function stringOrEmpty(value: string | null): string {
  return value ?? "";
}

function emptyToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function iso(value: Date): string {
  return value.toISOString();
}

function responseTurnFromRecord(record: ResponseTurnRecord): ResponseTurn {
  return {
    id: record.id,
    sessionId: record.sessionId,
    localTurnId: record.localTurnId,
    messageId: record.messageId,
    requestId: stringOrEmpty(record.requestId),
    responseId: stringOrEmpty(record.responseId),
    previousResponseId: stringOrEmpty(record.previousResponseId),
    conversationId: stringOrEmpty(record.conversationId),
    provider: record.provider,
    api: record.api,
    model: record.model,
    stateMode: record.stateMode,
    status: record.status,
    incompleteReason: stringOrEmpty(record.incompleteReason),
    requestSummary: decodeArchiveJSON(record.requestSummaryJson),
    responseSummary: decodeArchiveJSON(record.responseSummaryJson),
    createdAt: parseSessionTimestamp(record.createdAt),
    completedAt:
      record.completedAt !== null && record.completedAt !== ""
        ? parseSessionTimestamp(record.completedAt)
        : null,
  };
}

function responseItemFromRecord(
  record: ResponseItemRecord,
): ResponseItemArchive {
  return {
    id: record.id,
    sessionId: record.sessionId,
    localTurnId: record.localTurnId,
    responseId: stringOrEmpty(record.responseId),
    itemId: stringOrEmpty(record.itemId),
    outputIndex: record.outputIndex,
    itemType: record.itemType,
    itemStatus: stringOrEmpty(record.itemStatus),
    itemKey: record.itemKey,
    sanitizedJson: decodeArchiveJSON(record.sanitizedJson),
    createdAt: parseSessionTimestamp(record.createdAt),
  };
}

function toolExecutionFromRecord(
  record: DAOToolExecutionRecord,
): ToolExecutionRecord {
  return {
    id: record.id,
    sessionId: record.sessionId,
    localTurnId: record.localTurnId,
    executionKey: record.executionKey,
    provider: record.provider,
    api: record.api,
    responseId: stringOrEmpty(record.responseId),
    providerCallId: stringOrEmpty(record.providerCallId),
    toolKind: record.toolKind,
    toolName: record.toolName,
    argsHash: record.argsHash,
    executionState: record.executionState,
    resultSummary: decodeArchiveJSON(record.resultSummaryJson),
    providerMetadata: decodeArchiveJSON(record.providerMetadataJson),
    sideEffecting: record.sideEffecting,
    createdAt: parseSessionTimestamp(record.createdAt),
    completedAt:
      record.completedAt !== null && record.completedAt !== ""
        ? parseSessionTimestamp(record.completedAt)
        : null,
  };
}

export function responseRunFromRecord(record: ResponseRunRecord): ResponseRun {
  return {
    id: record.id,
    sessionId: record.sessionId,
    localRunId: record.localRunId,
    localTurnId: record.localTurnId,
    messageId: record.messageId,
    responseId: stringOrEmpty(record.responseId),
    provider: record.provider,
    api: record.api,
    state: record.state,
    pollingUrl: stringOrEmpty(record.pollingUrl),
    lastEventSequence: record.lastEventSequence,
    cancelRequested: record.cancelRequested,
    createdAt: parseSessionTimestamp(record.createdAt),
    updatedAt: parseSessionTimestamp(record.updatedAt),
  };
}

function responseSessionStateFromRecord(
  record: ResponseSessionStateRecord,
): ResponseSessionState {
  return {
    sessionId: record.sessionId,
    stateMode: record.stateMode,
    previousResponseId: stringOrEmpty(record.previousResponseId),
    conversationId: stringOrEmpty(record.conversationId),
    provider: record.provider,
    api: record.api,
    model: record.model,
    version: record.version,
    updatedAt: parseSessionTimestamp(record.updatedAt),
  };
}

function requireConn(db: Database): NonNullable<Database["db"]> {
  if (db.db === null) throw new Error("response database is not open");
  return db.db;
}

function reader(sessionDir: string): ResponseDAO {
  return new ResponseDAO(requireConn(openRootDB(sessionDir)));
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function validateResponseTurn(turn: ResponseTurn): void {
  if (turn.sessionId === "") {
    throw new Error("response turn session ID is required");
  }
  if (turn.localTurnId === "") {
    throw new Error("response turn local turn ID is required");
  }
  if (turn.provider === "") {
    throw new Error("response turn provider is required");
  }
  if (turn.api === "") throw new Error("response turn API is required");
  if (turn.model === "") throw new Error("response turn model is required");
  if (turn.stateMode === "") {
    throw new Error("response turn state mode is required");
  }
  if (turn.status === "") throw new Error("response turn status is required");
}

/** Persists one Responses turn summary under a fenced runtime lease. */
export function saveResponseTurn(sessionDir: string, turn: ResponseTurn): void {
  validateResponseTurn(turn);
  let requestSummary: Uint8Array | null;
  let responseSummary: Uint8Array | null;
  try {
    requestSummary = archiveJSON(turn.requestSummary);
  } catch (err) {
    throw new Error(`request summary: ${(err as Error).message}`);
  }
  try {
    responseSummary = archiveJSON(turn.responseSummary);
  } catch (err) {
    throw new Error(`response summary: ${(err as Error).message}`);
  }
  const createdAt =
    turn.createdAt.getTime() === 0 || Number.isNaN(turn.createdAt.getTime())
      ? new Date()
      : turn.createdAt;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, turn.sessionId);
    new ResponseDAO(null).insertTurn(tx, {
      id: 0,
      sessionId: turn.sessionId,
      localTurnId: turn.localTurnId,
      messageId: turn.messageId,
      requestId: emptyToNull(turn.requestId),
      responseId: emptyToNull(turn.responseId),
      previousResponseId: emptyToNull(turn.previousResponseId),
      conversationId: emptyToNull(turn.conversationId),
      provider: turn.provider,
      api: turn.api,
      model: turn.model,
      stateMode: turn.stateMode,
      status: turn.status,
      incompleteReason: emptyToNull(turn.incompleteReason),
      requestSummaryJson: requestSummary,
      responseSummaryJson: responseSummary,
      createdAt: iso(createdAt),
      completedAt: turn.completedAt === null ? null : iso(turn.completedAt),
    });
  });
}

/** Returns a persisted Responses turn, or `null` when absent. */
export function getResponseTurn(
  sessionDir: string,
  sessionId: string,
  localTurnId: string,
): ResponseTurn | null {
  if (sessionId === "" || localTurnId === "") {
    throw new Error("session ID and local turn ID are required");
  }
  const record = reader(sessionDir).findTurn(sessionId, localTurnId);
  if (record === undefined) return null;
  return responseTurnFromRecord(record);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Upserts one sanitized native item under a fenced runtime lease. */
export function saveResponseItem(
  sessionDir: string,
  item: ResponseItemArchive,
): void {
  if (
    item.sessionId === "" ||
    item.localTurnId === "" ||
    item.itemType === ""
  ) {
    throw new Error("session ID, local turn ID and item type are required");
  }
  let sanitized: Uint8Array | null;
  try {
    sanitized = archiveJSON(item.sanitizedJson);
  } catch (err) {
    throw new Error(`sanitized item: ${(err as Error).message}`);
  }
  if (sanitized === null) {
    throw new Error("sanitized item is required");
  }
  const createdAt =
    item.createdAt.getTime() === 0 || Number.isNaN(item.createdAt.getTime())
      ? new Date()
      : item.createdAt;
  let itemKey = item.itemKey;
  if (itemKey === "") {
    itemKey =
      item.itemId !== ""
        ? `${item.itemId}:${item.outputIndex}`
        : `output:${item.outputIndex}`;
  }
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, item.sessionId);
    new ResponseDAO(null).upsertItem(tx, {
      id: 0,
      sessionId: item.sessionId,
      localTurnId: item.localTurnId,
      responseId: emptyToNull(item.responseId),
      itemId: emptyToNull(item.itemId),
      outputIndex: item.outputIndex,
      itemType: item.itemType,
      itemStatus: emptyToNull(item.itemStatus),
      itemKey,
      sanitizedJson: sanitized,
      createdAt: iso(createdAt),
      updatedAt: iso(createdAt),
    });
  });
}

/** Lists the ordered sanitized items for one local turn. */
export function listResponseItems(
  sessionDir: string,
  sessionId: string,
  localTurnId: string,
): ResponseItemArchive[] {
  if (sessionId === "" || localTurnId === "") {
    throw new Error("session ID and local turn ID are required");
  }
  const records = reader(sessionDir).listItems(sessionId, localTurnId);
  return records.map((record) => responseItemFromRecord(record));
}

/**
 * Returns the ordered, sanitized native items from completed Responses turns.
 * Callers can pass this sequence to a provider's native replay path instead of
 * reconstructing prior assistant output from plain transcript text.
 */
export function listResponseReplayItems(
  sessionDir: string,
  sessionId: string,
  limit: number,
): unknown[] {
  if (sessionId === "") throw new Error("session ID is required");
  if (limit <= 0 || limit > 5000) limit = 1000;
  const records = reader(sessionDir).listReplayItems(sessionId, limit);
  const items: unknown[] = [];
  for (const record of records) {
    const decoded = decodeArchiveJSON(record.sanitizedJson);
    if (decoded === undefined) {
      throw new Error("stored response replay item is invalid JSON");
    }
    items.push(decoded);
  }
  return items;
}

/**
 * Returns completed native output grouped by local turn, ordered by their
 * original completion order.
 */
export function listResponseReplayTurns(
  sessionDir: string,
  sessionId: string,
  limit: number,
): ResponseReplayTurn[] {
  if (sessionId === "") throw new Error("session ID is required");
  if (limit <= 0 || limit > 1000) limit = 500;
  const records = reader(sessionDir).listReplayTurns(sessionId);
  const byTurn = new Map<string, number>();
  const seenCalls = new Map<string, Set<string>>();
  const turns: ResponseReplayTurn[] = [];
  for (const record of records) {
    const turnId = record.localTurnId;
    const decoded = decodeArchiveJSON(record.sanitizedJson);
    if (decoded === undefined) {
      throw new Error("stored response replay item is invalid JSON");
    }
    // Older archives may contain both the streamed output_item and a
    // response.completed snapshot for one function call. Gate replay by
    // provider call identity so those historical duplicates are not sent back
    // to the provider as two calls.
    if (decoded !== null && typeof decoded === "object") {
      const identity = decoded as {
        type?: unknown;
        id?: unknown;
        call_id?: unknown;
      };
      if (
        identity.type === "function_call" ||
        identity.type === "custom_tool_call"
      ) {
        let callId =
          typeof identity.call_id === "string" ? identity.call_id : "";
        if (callId === "" && typeof identity.id === "string") {
          callId = identity.id;
        }
        if (callId !== "") {
          let seen = seenCalls.get(turnId);
          if (seen === undefined) {
            seen = new Set<string>();
            seenCalls.set(turnId, seen);
          }
          const key = `${identity.type as string}\u0000${callId}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
      }
    }
    let index = byTurn.get(turnId);
    if (index === undefined) {
      if (turns.length >= limit) break;
      index = turns.length;
      byTurn.set(turnId, index);
      turns.push({ localTurnId: turnId, items: [] });
    }
    turns[index].items.push(decoded);
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Tool execution records
// ---------------------------------------------------------------------------

/**
 * Atomically claims an execution key. A `false` created result means another
 * request already owns the key and its record must be consulted before
 * executing a side effect.
 */
export function claimToolExecutionRecord(
  sessionDir: string,
  record: ToolExecutionRecord,
): { record: ToolExecutionRecord; created: boolean } {
  if (
    record.sessionId === "" ||
    record.executionKey === "" ||
    record.toolName === "" ||
    record.argsHash === ""
  ) {
    throw new Error(
      "session ID, execution key, tool name and args hash are required",
    );
  }
  const createdAt =
    record.createdAt.getTime() === 0 || Number.isNaN(record.createdAt.getTime())
      ? new Date()
      : record.createdAt;
  let resultSummary: Uint8Array | null;
  let providerMetadata: Uint8Array | null;
  try {
    resultSummary = archiveJSON(record.resultSummary);
  } catch (err) {
    throw new Error(`result summary: ${(err as Error).message}`);
  }
  try {
    providerMetadata = archiveJSON(record.providerMetadata);
  } catch (err) {
    throw new Error(`provider metadata: ${(err as Error).message}`);
  }
  let claimed: ToolExecutionRecord | null = null;
  let created = false;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, record.sessionId);
    const result = new ResponseDAO(null).claimTool(tx, {
      id: 0,
      sessionId: record.sessionId,
      localTurnId: record.localTurnId,
      executionKey: record.executionKey,
      provider: record.provider,
      api: record.api,
      responseId: emptyToNull(record.responseId),
      providerCallId: emptyToNull(record.providerCallId),
      toolKind: record.toolKind,
      toolName: record.toolName,
      argsHash: record.argsHash,
      executionState: record.executionState,
      resultSummaryJson: resultSummary,
      providerMetadataJson: providerMetadata,
      sideEffecting: record.sideEffecting,
      createdAt: iso(createdAt),
      completedAt: null,
    });
    if (result === undefined) return;
    claimed = toolExecutionFromRecord(result.stored);
    created = result.created > 0;
  });
  const result = claimed as ToolExecutionRecord | null;
  if (result === null) {
    throw new Error("tool execution claim returned no record");
  }
  if (
    result.sessionId !== record.sessionId ||
    result.localTurnId !== record.localTurnId ||
    result.provider !== record.provider ||
    result.api !== record.api ||
    result.toolName !== record.toolName ||
    result.argsHash !== record.argsHash ||
    (record.providerCallId !== "" &&
      result.providerCallId !== record.providerCallId)
  ) {
    throw new Error(
      `execution key collision for ${JSON.stringify(record.executionKey)}`,
    );
  }
  return { record: result, created };
}

/** Publishes a tool-execution result; only an actively-owned record may write. */
export function updateToolExecutionRecord(
  sessionDir: string,
  record: ToolExecutionRecord,
): void {
  if (record.executionKey === "" || record.executionState === "") {
    throw new Error("execution key and execution state are required");
  }
  let resultSummary: Uint8Array | null;
  let providerMetadata: Uint8Array | null;
  try {
    resultSummary = archiveJSON(record.resultSummary);
  } catch (err) {
    throw new Error(`result summary: ${(err as Error).message}`);
  }
  try {
    providerMetadata = archiveJSON(record.providerMetadata);
  } catch (err) {
    throw new Error(`provider metadata: ${(err as Error).message}`);
  }
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, record.sessionId);
    const count = new ResponseDAO(null).updateTool(tx, {
      id: 0,
      sessionId: record.sessionId,
      localTurnId: record.localTurnId,
      executionKey: record.executionKey,
      provider: record.provider,
      api: record.api,
      responseId: emptyToNull(record.responseId),
      providerCallId: emptyToNull(record.providerCallId),
      toolKind: record.toolKind,
      toolName: record.toolName,
      argsHash: record.argsHash,
      executionState: record.executionState,
      resultSummaryJson: resultSummary,
      providerMetadataJson: providerMetadata,
      sideEffecting: record.sideEffecting,
      createdAt: iso(record.createdAt),
      completedAt: record.completedAt === null ? null : iso(record.completedAt),
    });
    if (count === 0) {
      throw new Error(
        `tool execution ${JSON.stringify(
          record.executionKey,
        )} is no longer writable`,
      );
    }
  });
}

/**
 * Atomically reopens a tool record after a process interruption. Read-only
 * running/interrupted records are eligible automatically; side-effecting
 * records require the explicit `retry_requested` state set by the confirmation
 * API.
 */
export function reclaimInterruptedToolExecution(
  sessionDir: string,
  executionKey: string,
): boolean {
  if (sessionDir === "" || executionKey === "") {
    throw new Error("session directory and execution key are required");
  }
  let reclaimed = false;
  writeRootDatabase(sessionDir, (tx) => {
    const record = new ResponseDAO(null).findTool(tx, executionKey);
    if (record === undefined) return;
    validateRuntimeLeaseTx(tx, sessionDir, record.sessionId);
    const state = record.executionState;
    const sideEffecting = record.sideEffecting;
    const eligible =
      (!sideEffecting && (state === "running" || state === "interrupted")) ||
      state === "retry_requested";
    if (!eligible) return;
    const reason =
      state === "retry_requested" ? "user_confirmed" : "automatic_read_only";
    let meta: Record<string, unknown> = {};
    const existing = decodeArchiveJSON(record.providerMetadataJson);
    if (existing !== null && typeof existing === "object") {
      meta = { ...(existing as Record<string, unknown>) };
    }
    meta["recoveryReason"] = reason;
    meta["recoveryAt"] = new Date().toISOString();
    const metadataJSON = archiveJSON(meta);
    const n = new ResponseDAO(null).reclaimTool(
      tx,
      executionKey,
      metadataJSON,
      state,
    );
    if (n !== 1) return;
    reclaimed = true;
  });
  return reclaimed;
}

/**
 * Marks selected interrupted tool calls for an explicit user-confirmed retry.
 * It never changes completed records and does not itself execute any tool.
 */
export function requestToolExecutionRecovery(
  sessionDir: string,
  sessionId: string,
  localTurnId: string,
  providerCallIds: string[],
): number {
  return requestToolExecutionRecoveryRecords(
    sessionDir,
    sessionId,
    localTurnId,
    providerCallIds,
  ).count;
}

/**
 * Records explicit user confirmation and returns only matching interrupted
 * calls. The records are retained as audit evidence while recovery starts as a
 * fresh execution; terminal Runs are never reactivated to consume these
 * records.
 */
export function requestToolExecutionRecoveryRecords(
  sessionDir: string,
  sessionId: string,
  localTurnId: string,
  providerCallIds: string[],
): { records: ToolExecutionRecord[]; count: number } {
  if (
    sessionDir === "" ||
    sessionId === "" ||
    localTurnId === "" ||
    providerCallIds.length === 0
  ) {
    throw new Error("session, local turn and provider call IDs are required");
  }
  for (const id of providerCallIds) {
    if (id.trim() === "") {
      throw new Error("provider call IDs must not be empty");
    }
  }
  const result: { records: ToolExecutionRecord[]; count: number } = {
    records: [],
    count: 0,
  };
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const dao = new ResponseDAO(null);
    result.count = dao.requestToolRecovery(
      tx,
      sessionId,
      localTurnId,
      providerCallIds,
    );
    const records = dao.listRequestedToolRecoveries(
      tx,
      sessionId,
      localTurnId,
      providerCallIds,
    );
    result.records = records.map((record) => toolExecutionFromRecord(record));
  });
  return result;
}

/**
 * Marks uncertain executions as explicitly abandoned. It never retries a tool
 * or invents a tool output; callers use it only after they have established
 * that no runtime owns the session lock.
 */
export function abandonInterruptedToolExecutionRecords(
  sessionDir: string,
  sessionId: string,
  localTurnId: string,
): number {
  if (sessionId === "" || localTurnId === "") {
    throw new Error("session ID and local turn ID are required");
  }
  const details = archiveJSON({
    content:
      "Tool execution explicitly abandoned after interruption; it was not retried.",
    isError: true,
    reason: "manual_abandon",
  });
  let count = 0;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    count = new ResponseDAO(null).abandonTools(
      tx,
      sessionId,
      localTurnId,
      details,
      new Date().toISOString(),
    );
  });
  return count;
}

// ---------------------------------------------------------------------------
// Background runs
// ---------------------------------------------------------------------------

/** Upserts the durable state for a Responses background run. */
export function saveResponseRun(sessionDir: string, run: ResponseRun): void {
  if (
    run.sessionId === "" ||
    run.localRunId === "" ||
    run.provider === "" ||
    run.api === "" ||
    run.state === ""
  ) {
    throw new Error(
      "session ID, local run ID, provider, API and state are required",
    );
  }
  const createdInvalid =
    run.createdAt.getTime() === 0 || Number.isNaN(run.createdAt.getTime());
  const createdAt = createdInvalid ? new Date() : run.createdAt;
  const updatedAt =
    createdInvalid ||
    run.updatedAt.getTime() === 0 ||
    Number.isNaN(run.updatedAt.getTime())
      ? createdAt
      : run.updatedAt;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, run.sessionId);
    new ResponseDAO(null).upsertRun(tx, {
      id: 0,
      sessionId: run.sessionId,
      localRunId: run.localRunId,
      localTurnId: run.localTurnId,
      messageId: run.messageId,
      responseId: emptyToNull(run.responseId),
      provider: run.provider,
      api: run.api,
      state: run.state,
      pollingUrl: emptyToNull(run.pollingUrl),
      lastEventSequence: run.lastEventSequence,
      cancelRequested: run.cancelRequested,
      createdAt: iso(createdAt),
      updatedAt: iso(updatedAt),
    });
  });
}

/** Returns a persisted Responses run, or `null` when absent. */
export function getResponseRun(
  sessionDir: string,
  sessionId: string,
  localRunId: string,
): ResponseRun | null {
  if (sessionId === "" || localRunId === "") {
    throw new Error("session ID and local run ID are required");
  }
  const record = reader(sessionDir).getRun(sessionId, localRunId);
  if (record === undefined) return null;
  return responseRunFromRecord(record);
}

/** Lists the Responses runs for a session, oldest first. */
export function listResponseRuns(
  sessionDir: string,
  sessionId: string,
  limit: number,
): ResponseRun[] {
  if (sessionId === "") throw new Error("session ID is required");
  if (limit <= 0 || limit > 500) limit = 100;
  const records = reader(sessionDir).listRunsForSession(sessionId, limit);
  return records.map((record) => responseRunFromRecord(record));
}

// ---------------------------------------------------------------------------
// Remote session lineage
// ---------------------------------------------------------------------------

/**
 * Returns the durable remote lineage for a local session. A missing record
 * means the caller must use its configured default, normally replay mode.
 */
export function getResponseSessionState(
  sessionDir: string,
  sessionId: string,
): ResponseSessionState | null {
  if (sessionId === "") throw new Error("session ID is required");
  const record = reader(sessionDir).getSessionState(sessionId);
  if (record === undefined) return null;
  return responseSessionStateFromRecord(record);
}

/**
 * Advances a session lineage only when the caller observed `expectedVersion`.
 * It prevents two concurrent turns from silently branching a
 * previous_response_id chain.
 */
export function compareAndSwapResponseSessionState(
  sessionDir: string,
  state: ResponseSessionState,
  expectedVersion: number,
): boolean {
  if (state.sessionId === "" || state.stateMode === "") {
    throw new Error("session ID and state mode are required");
  }
  const invalid =
    state.updatedAt.getTime() === 0 || Number.isNaN(state.updatedAt.getTime());
  const updatedAt = invalid ? new Date() : state.updatedAt;
  let changed = false;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, state.sessionId);
    const dao = new ResponseDAO(null);
    if (expectedVersion === 0) {
      const n = dao.insertSessionState(tx, {
        sessionId: state.sessionId,
        stateMode: state.stateMode,
        previousResponseId: emptyToNull(state.previousResponseId),
        conversationId: emptyToNull(state.conversationId),
        provider: state.provider,
        api: state.api,
        model: state.model,
        version: 1,
        updatedAt: iso(updatedAt),
      });
      changed = n === 1;
      return;
    }
    const n = dao.updateSessionStateCAS(
      tx,
      {
        sessionId: state.sessionId,
        stateMode: state.stateMode,
        previousResponseId: emptyToNull(state.previousResponseId),
        conversationId: emptyToNull(state.conversationId),
        provider: state.provider,
        api: state.api,
        model: state.model,
        version: 0,
        updatedAt: iso(updatedAt),
      },
      expectedVersion,
    );
    changed = n === 1;
  });
  return changed;
}
