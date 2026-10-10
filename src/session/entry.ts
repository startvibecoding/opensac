//
// Session entry types and the shared ID generator. Timestamps map from Go
// `time.Time` to `Date`.

import { type Message } from "../provider/types.ts";

/** Identifies the type of a session entry. */
export type EntryType = string;

export const entrySession: EntryType = "session";
export const entryMessage: EntryType = "message";
export const entryModelChange: EntryType = "model_change";
export const entryModeChange: EntryType = "mode_change";
export const entryThinkingChange: EntryType = "thinking_level_change";
export const entryAdditionalDirectories: EntryType = "additional_directories";
export const entryCompaction: EntryType = "compaction";
export const entryContentOverride: EntryType = "content_override";
export const entryBranchSummary: EntryType = "branch_summary";
export const entryCustom: EntryType = "custom";
export const entryCustomMessage: EntryType = "custom_message";
export const entryLabel: EntryType = "label";
export const entrySessionInfo: EntryType = "session_info";
export const entryTurnStart: EntryType = "turn_start";
export const entryTurnEnd: EntryType = "turn_end";

/** Contains common fields for all session entries. */
export interface EntryBase {
  type: EntryType;
  id: string;
  parentId: string | null;
  timestamp: Date;
}

/** The first line of a session file. */
export interface Header {
  type: EntryType;
  version: number;
  id: string;
  timestamp: Date;
  cwd: string;
  parentSession?: string;
  channelType?: string;
  channelId?: string;
  forkBoundarySeq?: number;
  seedLength?: number;
  forkKind?: string;
  /**
   * The bound expert bundle name (empty = no expert identity). Persisted like
   * the channel binding fields so reloads restore identity.
   */
  expertId?: string;
}

/** Contains a conversation message. */
export interface MessageEntry extends EntryBase {
  message: Message;
}

/** Records a model switch. */
export interface ModelChangeEntry extends EntryBase {
  provider: string;
  modelId: string;
}

/** Records a session execution mode change. */
export interface ModeChangeEntry extends EntryBase {
  mode: string;
}

/** Records a thinking level change. */
export interface ThinkingLevelChangeEntry extends EntryBase {
  thinkingLevel: string;
}

/**
 * Records the complete ordered directory set granted to a session. Replacements
 * are replayable session entries.
 */
export interface AdditionalDirectoriesEntry extends EntryBase {
  directories: string[];
}

/** Records a context compaction. */
export interface CompactionEntry extends EntryBase {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  summaryVersion?: number;
  previousCompactionId?: string;
  lastSummarizedEntryId?: string;
}

/**
 * Records an append-only, replayable replacement of a previously persisted
 * message entry's content. Replay substitutes `message` for the target entry;
 * the original entry stays in the log for audit. It is used when a provider
 * permanently refuses content (for example an image flagged by content
 * inspection) and the conversation must continue without it.
 *
 * Replacements are replayable session entries, exactly like directory grants:
 * the log is never mutated or truncated, only overlaid on replay.
 */
export interface ContentOverrideEntry extends EntryBase {
  targetEntryId: string;
  message: Message;
  reason?: string;
  code?: string;
}

/** Records a branch switch summary. */
export interface BranchSummaryEntry extends EntryBase {
  summary: string;
  fromId: string;
}

/** Records a user-defined label on an entry. */
export interface LabelEntry extends EntryBase {
  targetId: string;
  label?: string;
}

/** Stores session metadata. */
export interface SessionInfoEntry extends EntryBase {
  name: string;
  /** "manual" or "auto" */
  source?: string;
}

/**
 * Marks the durable beginning of a logical conversation turn. It is persisted
 * for boundary recovery but is excluded from provider replay.
 */
export interface TurnStartEntry extends EntryBase {
  turnId: string;
  intentId?: string;
  runId?: string;
  attempt?: number;
}

/**
 * Marks the durable terminal boundary of a logical conversation turn. It is
 * persisted for fork resolution and recovery, not model replay.
 */
export interface TurnEndEntry extends EntryBase {
  turnId: string;
  intentId?: string;
  runId?: string;
  status: string;
  stopReason?: string;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Generates a random 16-character hex ID. IDs such as `entries.id` are UNIQUE
 * across the whole shared sessions.db, so the previous 32-bit space made
 * collisions plausible at tens of millions of entries; 64 bits keeps the
 * birthday probability negligible.
 */
export function generateID(): string {
  const b = new Uint8Array(8);
  try {
    crypto.getRandomValues(b);
  } catch {
    // Fallback to timestamp-based ID on crypto failure.
    return (BigInt(Date.now()) * 1000000n)
      .toString(16)
      .padStart(16, "0")
      .slice(-16);
  }
  return toHex(b);
}
