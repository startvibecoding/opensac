// (replay core).
//
// The current-branch reconstruction engine: it walks persisted entries,
// applies message content overrides, and folds compaction summaries into the
// live provider replay. It is split out of the (not yet ported) Manager so the
// replay rules have one owner and can be exercised without a database.
//
// Deviations from Go: entries are plain objects discriminated by their `type`
// field rather than Go interface type switches; `json.RawMessage` tool-call
// arguments clone structurally instead of as raw bytes.

import type { ContentBlock, Message } from "../provider/types.ts";
import { createSystemInjectedUserMessage } from "../provider/types.ts";
import {
  type CompactionEntry,
  type ContentOverrideEntry,
  entryCompaction,
  entryContentOverride,
  entryMessage,
  type MessageEntry,
} from "./entry.ts";

/** The reconstructed conversation state after applying compactions. */
export interface ReplayState {
  messages: Message[];
  entryIDs: string[];
}

/** A persisted conversation message with its `entries.seq` cursor. */
export interface SequencedMessage {
  seq: number;
  entryID: string;
  message: Message;
}

/** Metadata shared by every session entry. */
export interface EntryMetadata {
  id: string;
  type: string;
  parentID: string | null;
  timestamp: Date;
}

interface UnknownEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
}

function entryTypeOf(entry: unknown): string {
  const candidate = entry as UnknownEntry | null;
  return candidate !== null && typeof candidate === "object" &&
      typeof candidate.type === "string"
    ? candidate.type
    : "";
}

/**
 * Extracts `(id, type, parentId, timestamp)` from any session entry, matching
 * Go's `getEntryMetadata`. Unknown entries yield empty identity and `now`, so
 * the caller's own validation rejects them.
 */
export function getEntryMetadata(entry: unknown): EntryMetadata {
  const candidate = entry as UnknownEntry | null;
  if (
    candidate === null || typeof candidate !== "object" ||
    typeof candidate.id !== "string" || typeof candidate.type !== "string"
  ) {
    return { id: "", type: "", parentID: null, timestamp: new Date() };
  }
  const parentID = typeof candidate.parentId === "string"
    ? candidate.parentId
    : null;
  const timestamp = candidate.timestamp instanceof Date
    ? candidate.timestamp
    : new Date();
  return { id: candidate.id, type: candidate.type, parentID, timestamp };
}

function cloneJSON<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Deep-copies one provider content block. */
export function cloneContentBlock(block: ContentBlock): ContentBlock {
  const cloned: ContentBlock = { ...block };
  if (block.image !== undefined) cloned.image = { ...block.image };
  if (block.toolCall !== undefined) {
    cloned.toolCall = { ...block.toolCall };
    if (block.toolCall.arguments !== undefined) {
      cloned.toolCall.arguments = cloneJSON(block.toolCall.arguments);
    }
  }
  if (block.cache_control !== undefined) {
    cloned.cache_control = { ...block.cache_control };
  }
  return cloned;
}

/** Deep-copies one provider message so replay cannot alias stored values. */
export function cloneMessage(msg: Message): Message {
  const cloned: Message = { ...msg };
  if (msg.contents !== undefined && msg.contents.length > 0) {
    cloned.contents = msg.contents.map(cloneContentBlock);
  }
  if (msg.usage !== undefined) cloned.usage = { ...msg.usage };
  return cloned;
}

/**
 * Collects the newest content override for each target message entry. The
 * overrides are resolved before any message is appended because an override
 * entry is appended after its target, so a single forward pass cannot see it in
 * time. Later overrides for the same target win.
 */
export function messageContentOverrides(
  entries: readonly unknown[],
): Map<string, Message> {
  const overrides = new Map<string, Message>();
  for (const raw of entries) {
    if (entryTypeOf(raw) !== entryContentOverride) continue;
    const entry = raw as unknown as ContentOverrideEntry;
    if (typeof entry.targetEntryId !== "string" || entry.targetEntryId === "") {
      continue;
    }
    overrides.set(entry.targetEntryId, entry.message);
  }
  return overrides;
}

/**
 * Reconstructs the current conversation branch, applying message overrides and
 * folding each compaction summary into the live replay.
 */
export function buildReplayState(entries: readonly unknown[]): ReplayState {
  const overrides = messageContentOverrides(entries);
  const state: ReplayState = { messages: [], entryIDs: [] };
  for (const raw of entries) {
    const type = entryTypeOf(raw);
    if (type === entryMessage) {
      const entry = raw as unknown as MessageEntry;
      let msg = entry.message;
      const replacement = overrides.get(entry.id);
      if (replacement !== undefined) msg = replacement;
      state.messages.push(cloneMessage(msg));
      state.entryIDs.push(entry.id);
    } else if (type === entryCompaction) {
      applyCompactionEntry(state, raw as unknown as CompactionEntry);
    }
  }
  return state;
}

/**
 * Folds a compaction entry into a replay state, replacing the summarized
 * history with the injected summary plus the preserved tail. A `firstKept`
 * entry that is absent from the branch keeps the full history rather than
 * guessing, so silent compaction loss is observable.
 */
export function applyCompactionEntry(
  state: ReplayState,
  entry: CompactionEntry,
): void {
  const summary = createSystemInjectedUserMessage(entry.summary);
  if (entry.firstKeptEntryId === "") {
    state.messages = [summary];
    state.entryIDs = [""];
    return;
  }

  let firstKept = -1;
  for (let i = 0; i < state.entryIDs.length; i++) {
    if (state.entryIDs[i] === entry.firstKeptEntryId) {
      firstKept = i;
      break;
    }
  }
  if (firstKept < 0) {
    console.warn(
      `[session] warning: compaction ${entry.id} skipped, first kept entry ${
        JSON.stringify(entry.firstKeptEntryId)
      } not found in replay state`,
    );
    return;
  }
  if (firstKept > state.messages.length || firstKept > state.entryIDs.length) {
    console.warn(
      `[session] warning: compaction ${entry.id} skipped, replay state out of sync (firstKept=${firstKept} messages=${state.messages.length} entryIDs=${state.entryIDs.length})`,
    );
    return;
  }

  const nextMessages: Message[] = [summary];
  for (const msg of state.messages.slice(firstKept)) {
    const cloned = cloneMessage(msg);
    cloned.usage = undefined;
    nextMessages.push(cloned);
  }

  const nextEntryIDs: string[] = [""];
  nextEntryIDs.push(...state.entryIDs.slice(firstKept));

  state.messages = nextMessages;
  state.entryIDs = nextEntryIDs;
}

interface SequencedReplayState {
  messages: SequencedMessage[];
  entryIDs: string[];
}

/**
 * Sequenced variant of `applyCompactionEntry` used by the cursor-paged message
 * readers. Each surviving message keeps its `entries.seq` so clients can page
 * from the compacted boundary.
 */
export function applySequencedCompactionEntry(
  state: SequencedReplayState | null,
  entry: CompactionEntry,
  seq: number,
): void {
  if (state === null) return;

  const summary = createSystemInjectedUserMessage(entry.summary);
  if (entry.firstKeptEntryId === "") {
    state.messages = [{ seq, entryID: entry.id, message: summary }];
    state.entryIDs = [entry.id];
    return;
  }

  let firstKept = -1;
  for (let i = 0; i < state.entryIDs.length; i++) {
    if (state.entryIDs[i] === entry.firstKeptEntryId) {
      firstKept = i;
      break;
    }
  }
  if (firstKept < 0) {
    console.warn(
      `[session] warning: sequenced compaction ${entry.id} skipped at seq ${seq}, first kept entry ${
        JSON.stringify(entry.firstKeptEntryId)
      } not found in replay state`,
    );
    return;
  }
  if (firstKept > state.messages.length || firstKept > state.entryIDs.length) {
    console.warn(
      `[session] warning: sequenced compaction ${entry.id} skipped at seq ${seq}, replay state out of sync (firstKept=${firstKept} messages=${state.messages.length} entryIDs=${state.entryIDs.length})`,
    );
    return;
  }

  const nextMessages: SequencedMessage[] = [{
    seq,
    entryID: entry.id,
    message: summary,
  }];
  for (const item of state.messages.slice(firstKept)) {
    const cloned = cloneMessage(item.message);
    cloned.usage = undefined;
    nextMessages.push({
      seq: item.seq,
      entryID: item.entryID,
      message: cloned,
    });
  }

  const nextEntryIDs: string[] = [entry.id];
  nextEntryIDs.push(...state.entryIDs.slice(firstKept));

  state.messages = nextMessages;
  state.entryIDs = nextEntryIDs;
}

/** A zero-valued compaction entry, mirroring Go's zero struct result. */
/** Returns the newest compaction entry, or `null` when none exists. */
export function latestCompactionLocked(
  entries: readonly unknown[],
): CompactionEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entryTypeOf(entries[i]) === entryCompaction) {
      return entries[i] as unknown as CompactionEntry;
    }
  }
  return null;
}

/**
 * Returns the last message entry folded into a compaction summary. It resolves
 * the entry immediately before `firstKeptEntryId`, or the last message when the
 * boundary is empty.
 */
export function lastSummarizedEntryIDLocked(
  entries: readonly unknown[],
  firstKeptEntryID: string,
): string {
  const state = buildReplayState(entries);
  if (firstKeptEntryID === "") {
    for (let i = state.entryIDs.length - 1; i >= 0; i--) {
      if (state.entryIDs[i] !== "") return state.entryIDs[i];
    }
    return "";
  }
  for (let i = 0; i < state.entryIDs.length; i++) {
    if (state.entryIDs[i] !== firstKeptEntryID) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (state.entryIDs[j] !== "") return state.entryIDs[j];
    }
    return "";
  }
  return "";
}
