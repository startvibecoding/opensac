// Capability, event, and sequenced-message projections.
//
// These are the read/write projections adapters use to replay a session: the
// persisted per-session capability snapshot, the run/capability lifecycle event
// ledgers, and the cursor-paged message replay. The SQLite-backed `Manager` in
// `manager.ts` owns session state; these functions talk to the DAO directly.
//
// Deviations from Go: `json.RawMessage` maps to decoded `unknown` (parsed on
// read, serialized on write), and `context.Context` is dropped because the DAO
// layer is synchronous.

import { SessionDAO } from "../dao/mod.ts";
import { sessionDir as platformSessionDir } from "../platform/platform.ts";
import { type Database } from "../dao/mod.ts";
import { writeRootDatabase } from "./database.ts";
import {
  type CompactionEntry,
  type ContentOverrideEntry,
  entryCompaction,
  entryContentOverride,
  entryMessage,
  generateID,
  type MessageEntry,
} from "./entry.ts";
import { openExistingSessionDB, parseSessionTimestamp } from "./root_db.ts";
import {
  applySequencedCompactionEntry,
  cloneMessage,
  type SequencedMessage,
} from "./replay.ts";
import { validateRuntimeLeaseTx } from "./runtime_lock.ts";

/** Persisted per-session runtime capability state. */
export interface SessionCapabilities {
  sessionId: string;
  mode: string;
  displayMode: string;
  delegateMode: boolean;
  multiAgent: boolean;
  workflows: boolean;
  webSearch: boolean;
  browser: boolean;
  updatedAt: Date;
}

/** One lifecycle event for a single chat/run execution. */
export interface SessionRunEvent {
  id: string;
  sessionId: string;
  runId: string;
  eventType: string;
  source: string;
  status: string;
  model: string;
  mode: string;
  timestamp: Date;
  data?: unknown;
}

/** One capability state transition. */
export interface SessionCapabilityEvent {
  id: string;
  sessionId: string;
  runId: string;
  eventType: string;
  source: string;
  actor: string;
  capability: string;
  oldValue: string;
  newValue: string;
  timestamp: Date;
  data?: unknown;
}

/** A run lifecycle event with its `session_run_events.seq` cursor. */
export interface SequencedSessionRunEvent {
  seq: number;
  event: SessionRunEvent;
}

/** A capability event with its `session_capability_events.seq` cursor. */
export interface SequencedSessionCapabilityEvent {
  seq: number;
  event: SessionCapabilityEvent;
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function normalizeEventData(data: unknown): string {
  if (data === undefined || data === null) return "{}";
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    JSON.parse(text);
    return text;
  } catch {
    return "{}";
  }
}

function decodeData(data: string): unknown {
  return data === "" ? undefined : JSON.parse(data);
}

function resolveSessionDir(sessionDir: string): string {
  return sessionDir === "" ? platformSessionDir() : sessionDir;
}

function openExisting(sessionDir: string): Database | null {
  const db = openExistingSessionDB(sessionDir);
  return db;
}

/** Loads persisted capabilities for a session, or null when unavailable. */
export function loadSessionCapabilities(
  sessionDir: string,
  sessionId: string,
): SessionCapabilities | null {
  if (sessionId === "") return null;
  const db = openExisting(sessionDir);
  if (db === null) return null;
  let record;
  try {
    record = new SessionDAO(db.db).capability(sessionId);
  } catch {
    return null;
  }
  if (record === undefined) return null;
  return {
    sessionId: record.sessionId,
    mode: record.mode,
    displayMode: record.displayMode,
    delegateMode: record.delegateMode !== 0,
    multiAgent: record.multiAgent !== 0,
    workflows: record.workflows !== 0,
    webSearch: record.webSearch !== 0,
    browser: record.browser !== 0,
    updatedAt: parseSessionTimestamp(record.updatedAt),
  };
}

/** Persists per-session runtime capability state. */
export function saveSessionCapabilities(
  sessionDir: string,
  caps: SessionCapabilities,
): void {
  if (caps.sessionId === "") {
    throw new Error("session capability session ID is empty");
  }
  const dir = resolveSessionDir(sessionDir);
  const updatedAt =
    caps.updatedAt instanceof Date && !isNaN(caps.updatedAt.getTime())
      ? caps.updatedAt
      : new Date();
  writeRootDatabase(dir, (tx) => {
    validateRuntimeLeaseTx(tx, dir, caps.sessionId);
    new SessionDAO(null).upsertCapability(tx, {
      sessionId: caps.sessionId,
      mode: caps.mode,
      displayMode: caps.displayMode,
      delegateMode: boolToInt(caps.delegateMode),
      multiAgent: boolToInt(caps.multiAgent),
      workflows: boolToInt(caps.workflows),
      webSearch: boolToInt(caps.webSearch),
      browser: boolToInt(caps.browser),
      // The `a2a_master` column stays in the schema for compatibility, but the
      // A2A mode is gone, so a capability row can never request it again.
      a2aMaster: 0,
      updatedAt: updatedAt.toISOString(),
    });
  });
}

/** Appends a run lifecycle event to the independent run event ledger. */
export function saveSessionRunEvent(
  sessionDir: string,
  ev: SessionRunEvent,
): string {
  if (ev.sessionId === "") {
    throw new Error("session run event session ID is empty");
  }
  if (ev.runId === "") {
    throw new Error("session run event run ID is empty");
  }
  if (ev.eventType === "") {
    throw new Error("session run event type is empty");
  }
  const id = ev.id === "" ? generateID() : ev.id;
  const timestamp =
    ev.timestamp instanceof Date && !isNaN(ev.timestamp.getTime())
      ? ev.timestamp
      : new Date();
  const dir = resolveSessionDir(sessionDir);
  const data = normalizeEventData(ev.data);
  writeRootDatabase(dir, (tx) => {
    validateRuntimeLeaseTx(tx, dir, ev.sessionId);
    new SessionDAO(null).insertRunEvent(tx, {
      seq: 0,
      id,
      sessionId: ev.sessionId,
      runId: ev.runId,
      eventType: ev.eventType,
      source: ev.source,
      status: ev.status,
      model: ev.model,
      mode: ev.mode,
      timestamp: timestamp.toISOString(),
      data,
    });
  });
  return id;
}

/** Returns run events for a session, ordered by insertion. */
export function listSessionRunEvents(
  sessionDir: string,
  sessionId: string,
): SessionRunEvent[] {
  if (sessionId === "") return [];
  const db = openExisting(sessionDir);
  if (db === null) return [];
  return new SessionDAO(db.db).listRunEvents(sessionId).map((record) => ({
    id: record.id,
    sessionId: record.sessionId,
    runId: record.runId,
    eventType: record.eventType,
    source: record.source,
    status: record.status,
    model: record.model,
    mode: record.mode,
    timestamp: parseSessionTimestamp(record.timestamp),
    data: decodeData(record.data),
  }));
}

/**
 * Returns the durable replay cursor for one Run so a disconnected adapter can
 * request only the missing portion of the event stream.
 */
export function latestSessionRunEventSeq(
  sessionDir: string,
  runId: string,
): number {
  if (runId === "") return 0;
  const db = openExisting(sessionDir);
  if (db === null) return 0;
  return new SessionDAO(db.db).maxRunEventSeq(runId);
}

/** Appends a capability transition event to the independent event ledger. */
export function saveSessionCapabilityEvent(
  sessionDir: string,
  ev: SessionCapabilityEvent,
): string {
  if (ev.sessionId === "") {
    throw new Error("session capability event session ID is empty");
  }
  if (ev.eventType === "") {
    throw new Error("session capability event type is empty");
  }
  if (ev.capability === "") {
    throw new Error("session capability event capability is empty");
  }
  const id = ev.id === "" ? generateID() : ev.id;
  const timestamp =
    ev.timestamp instanceof Date && !isNaN(ev.timestamp.getTime())
      ? ev.timestamp
      : new Date();
  const dir = resolveSessionDir(sessionDir);
  const data = normalizeEventData(ev.data);
  writeRootDatabase(dir, (tx) => {
    validateRuntimeLeaseTx(tx, dir, ev.sessionId);
    new SessionDAO(null).insertCapabilityEvent(tx, {
      seq: 0,
      id,
      sessionId: ev.sessionId,
      runId: ev.runId,
      eventType: ev.eventType,
      source: ev.source,
      actor: ev.actor,
      capability: ev.capability,
      oldValue: ev.oldValue,
      newValue: ev.newValue,
      timestamp: timestamp.toISOString(),
      data,
    });
  });
  return id;
}

/** Returns capability events for a session, ordered by insertion. */
export function listSessionCapabilityEvents(
  sessionDir: string,
  sessionId: string,
): SessionCapabilityEvent[] {
  if (sessionId === "") return [];
  const db = openExisting(sessionDir);
  if (db === null) return [];
  return new SessionDAO(db.db)
    .listCapabilityEvents(sessionId)
    .map((record) => ({
      id: record.id,
      sessionId: record.sessionId,
      runId: record.runId,
      eventType: record.eventType,
      source: record.source,
      actor: record.actor,
      capability: record.capability,
      oldValue: record.oldValue,
      newValue: record.newValue,
      timestamp: parseSessionTimestamp(record.timestamp),
      data: decodeData(record.data),
    }));
}

/**
 * Returns the visible replay messages for a session, preserving each message
 * row's `entries.seq` cursor and applying content overrides and compactions.
 */
export function listSessionMessagesWithSeq(
  sessionDir: string,
  sessionId: string,
): SequencedMessage[] {
  if (sessionId === "") return [];
  const db = openExisting(sessionDir);
  if (db === null) return [];
  const records = new SessionDAO(db.db).messages(sessionId);
  // Content overrides are appended after their target message, so resolve them
  // up front; a single forward pass cannot see the override in time.
  const overrides = new Map<string, MessageEntry["message"]>();
  for (const record of records) {
    if (record.type !== entryContentOverride || record.data === "") continue;
    let entry: ContentOverrideEntry;
    try {
      entry = JSON.parse(record.data) as ContentOverrideEntry;
    } catch {
      continue;
    }
    if (entry.targetEntryId !== "" && entry.targetEntryId !== undefined) {
      overrides.set(entry.targetEntryId, entry.message);
    }
  }

  const state: {
    messages: SequencedMessage[];
    entryIDs: string[];
  } = { messages: [], entryIDs: [] };
  for (const record of records) {
    if (record.data === "") continue;
    if (record.type === entryMessage) {
      let entry: MessageEntry;
      try {
        entry = JSON.parse(record.data) as MessageEntry;
      } catch {
        continue;
      }
      let msg = entry.message;
      const replacement = overrides.get(entry.id);
      if (replacement !== undefined) msg = replacement;
      state.messages.push({
        seq: record.seq,
        entryID: entry.id,
        message: cloneMessage(msg),
      });
      state.entryIDs.push(entry.id);
    } else if (record.type === entryCompaction) {
      let entry: CompactionEntry;
      try {
        entry = JSON.parse(record.data) as CompactionEntry;
      } catch {
        continue;
      }
      applySequencedCompactionEntry(state, entry, record.seq);
    }
  }
  return state.messages;
}

function decodeMessage(record: {
  seq: number;
  data: string;
}): SequencedMessage {
  const entry = JSON.parse(record.data) as MessageEntry;
  return {
    seq: record.seq,
    entryID: entry.id,
    message: cloneMessage(entry.message),
  };
}

/** Returns persisted message rows after `entries.seq`. */
export function listSessionMessagesAfter(
  sessionDir: string,
  sessionId: string,
  afterSeq: number,
  limit: number,
): SequencedMessage[] {
  if (sessionId === "") return [];
  const capped = limit <= 0 || limit > 500 ? 500 : limit;
  const db = openExisting(sessionDir);
  if (db === null) return [];
  const messages: SequencedMessage[] = [];
  for (const record of new SessionDAO(db.db).messagesAfter(
    sessionId,
    afterSeq,
    capped,
  )) {
    if (record.data === "") continue;
    try {
      messages.push(decodeMessage(record));
    } catch {
      continue;
    }
  }
  return messages;
}

/** Returns the latest N message entries, in ascending order. */
export function listSessionMessagesLatest(
  sessionDir: string,
  sessionId: string,
  limit: number,
): SequencedMessage[] {
  if (sessionId === "") return [];
  const capped = limit <= 0 || limit > 500 ? 50 : limit;
  const db = openExisting(sessionDir);
  if (db === null) return [];
  const messages: SequencedMessage[] = [];
  for (const record of new SessionDAO(db.db).messagesLatest(
    sessionId,
    capped,
  )) {
    if (record.data === "") continue;
    try {
      messages.push(decodeMessage(record));
    } catch {
      continue;
    }
  }
  messages.reverse();
  return messages;
}

/** Returns messages with `seq < beforeSeq`, newest first limited to `limit`. */
export function listSessionMessagesBefore(
  sessionDir: string,
  sessionId: string,
  beforeSeq: number,
  limit: number,
): SequencedMessage[] {
  if (sessionId === "") return [];
  const capped = limit <= 0 || limit > 500 ? 50 : limit;
  const db = openExisting(sessionDir);
  if (db === null) return [];
  const messages: SequencedMessage[] = [];
  for (const record of new SessionDAO(db.db).messagesBefore(
    sessionId,
    beforeSeq,
    capped,
  )) {
    if (record.data === "") continue;
    try {
      messages.push(decodeMessage(record));
    } catch {
      continue;
    }
  }
  messages.reverse();
  return messages;
}

/** Returns run events with their `session_run_events.seq` cursor. */
export function listSessionRunEventsWithSeq(
  sessionDir: string,
  sessionId: string,
): SequencedSessionRunEvent[] {
  return listSessionRunEventsAfter(sessionDir, sessionId, 0, 0);
}

/** Returns run events after `session_run_events.seq`. */
export function listSessionRunEventsAfter(
  sessionDir: string,
  sessionId: string,
  afterSeq: number,
  limit: number,
): SequencedSessionRunEvent[] {
  if (sessionId === "") return [];
  const capped = limit > 500 ? 500 : limit;
  const db = openExisting(sessionDir);
  if (db === null) return [];
  return new SessionDAO(db.db)
    .runEventsAfter(sessionId, afterSeq, capped)
    .map((record) => ({
      seq: record.seq,
      event: {
        id: record.id,
        sessionId: record.sessionId,
        runId: record.runId,
        eventType: record.eventType,
        source: record.source,
        status: record.status,
        model: record.model,
        mode: record.mode,
        timestamp: parseSessionTimestamp(record.timestamp),
        data: decodeData(record.data),
      },
    }));
}

/** Returns capability events with their seq cursor. */
export function listSessionCapabilityEventsWithSeq(
  sessionDir: string,
  sessionId: string,
): SequencedSessionCapabilityEvent[] {
  return listSessionCapabilityEventsAfter(sessionDir, sessionId, 0, 0);
}

/** Returns capability events after `session_capability_events.seq`. */
export function listSessionCapabilityEventsAfter(
  sessionDir: string,
  sessionId: string,
  afterSeq: number,
  limit: number,
): SequencedSessionCapabilityEvent[] {
  if (sessionId === "") return [];
  const capped = limit > 500 ? 500 : limit;
  const db = openExisting(sessionDir);
  if (db === null) return [];
  return new SessionDAO(db.db)
    .capabilityEventsAfter(sessionId, afterSeq, capped)
    .map((record) => ({
      seq: record.seq,
      event: {
        id: record.id,
        sessionId: record.sessionId,
        runId: record.runId,
        eventType: record.eventType,
        source: record.source,
        actor: record.actor,
        capability: record.capability,
        oldValue: record.oldValue,
        newValue: record.newValue,
        timestamp: parseSessionTimestamp(record.timestamp),
        data: decodeData(record.data),
      },
    }));
}
