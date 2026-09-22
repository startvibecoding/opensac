// Ported from internal/session/fork.go
//
// Durable, idempotent session forking. A fork snapshots a source session's
// transcript up to a resolved boundary into a new child session inside the
// source's `fork` runtime lease. The response is a `ForkResult`.
//
// Deviations from Go: the `context.Context` parameter is dropped (the DAO layer
// is synchronous); the two-phase read/child-write transaction is expressed as
// two `runInTx` calls; sentinel errors map to exported error classes.

import { createHash } from "node:crypto";
import {
  ConversationTurnDAO,
  type ConversationTurnRecord,
  ForkDAO,
  isNoRows,
  SessionDAO,
} from "../dao/mod.ts";
import type { DB } from "../db/mod.ts";
import type { Tx } from "../dao/mod.ts";
import type { ContentBlock, Message } from "../provider/types.ts";
import {
  type BranchSummaryEntry,
  entryAdditionalDirectories,
  entryBranchSummary,
  entryCompaction,
  entryContentOverride,
  entryCustom,
  entryCustomMessage,
  entryLabel,
  entryMessage,
  entryModeChange,
  entryModelChange,
  entrySession,
  entrySessionInfo,
  entryThinkingChange,
  entryTurnEnd,
  entryTurnStart,
  generateID,
  type Header,
  type LabelEntry,
  type MessageEntry,
  type SessionInfoEntry,
  type TurnEndEntry,
  type TurnStartEntry,
} from "./entry.ts";
import { stringPtr } from "./conversation_turn.ts";
import { isDecisionEventType } from "./decision_events.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";
import {
  acquireFork,
  RuntimeLeaseBusyError,
  RuntimeSessionNotFoundError,
  SessionRunActiveError,
  validateRuntimeLeaseTx,
} from "./runtime_lock.ts";
import {
  nonTerminalSessionRunStatuses,
  terminalSessionRunStatuses,
} from "./run_status.ts";
import { SessionModifiedError } from "./session_errors.ts";

/** The kind of boundary a fork snapshot was resolved from. */
export type ForkKind = "session" | "message" | "";

/** Reports that the source session does not exist. */
export class ForkSessionNotFoundError extends Error {
  constructor() {
    super("source session not found");
    this.name = "ForkSessionNotFoundError";
  }
}

/** Reports that the source session is active (open turn/run/decision). */
export class ForkSessionActiveError extends Error {
  constructor() {
    super("source session is active");
    this.name = "ForkSessionActiveError";
  }
}

/** Reports that the source has no completed conversation turn to fork. */
export class ForkNoCompletedTurnError extends Error {
  constructor() {
    super("source session has no completed conversation turn");
    this.name = "ForkNoCompletedTurnError";
  }
}

/** Reports that the fork boundary cannot be used. */
export class ForkUnavailableError extends Error {
  constructor() {
    super("fork boundary is unavailable");
    this.name = "ForkUnavailableError";
  }
}

/** Reports that the requested fork boundary is invalid. */
export class ForkInvalidBoundaryError extends Error {
  constructor() {
    super("fork boundary is invalid");
    this.name = "ForkInvalidBoundaryError";
  }
}

/** Reports that a forked entry has no declared reference rewrite policy. */
export class ForkUnsupportedEntryError extends Error {
  constructor(message = "fork contains unsupported entry") {
    super(message);
    this.name = "ForkUnsupportedEntryError";
  }
}

/** Reports a missing fork request ID. */
export class ForkIdempotencyRequiredError extends Error {
  constructor() {
    super("fork request ID is required");
    this.name = "ForkIdempotencyRequiredError";
  }
}

/** Reports an over-long fork request ID. */
export class ForkIdempotencyTooLongError extends Error {
  constructor() {
    super("fork request ID is too long");
    this.name = "ForkIdempotencyTooLongError";
  }
}

/** Reports a conflicting idempotency request. */
export class ForkIdempotencyConflictError extends Error {
  constructor() {
    super("fork idempotency request conflicts");
    this.name = "ForkIdempotencyConflictError";
  }
}

/** Options for one idempotent fork request. */
export interface ForkOptions {
  sourceSessionId: string;
  atSeq?: number | null;
  requestId: string;
  titleMode: string;
  /**
   * Overrides the forked session's expert binding when non-null (empty string
   * unbinds); null preserves the source session's binding.
   */
  expertId?: string | null;
}

/** The result of a fork, returned to every front-end. */
export interface ForkResult {
  sessionId: string;
  parentSessionId: string;
  forkKind: ForkKind;
  boundarySeq: number;
  seedLength: number;
}

interface ForkSourceEntry {
  seq: number;
  id: string;
  type: string;
  parentId: string | null;
  timestamp: string;
  data: string;
}

interface ForkSourceFingerprint {
  maxSeq: number;
  leaf: string;
  openTurns: number;
  activeRuns: number;
}

type Phase1 =
  | { kind: "idempotent"; result: ForkResult }
  | {
    kind: "snapshot";
    copyEntries: ForkSourceEntry[];
    turns: ReturnType<typeof scanTurn>[];
    boundary: number;
    forkKind: ForkKind;
    snapshot: ForkSourceFingerprint;
  };

function scanTurn(record: ConversationTurnRecord) {
  const startedAt = parseSessionTimestamp(record.startedAt);
  return {
    id: record.id,
    sessionId: record.sessionId,
    intentId: record.intentId,
    runId: "",
    attempt: 0,
    kind: record.kind,
    status: record.status,
    startSeq: record.startSeq,
    endSeq: record.endSeq,
    startedAt,
    endedAt: record.endedAt === null
      ? null
      : parseSessionTimestamp(record.endedAt),
  };
}

/**
 * Resolves a durable source transcript snapshot into a new child session
 * exactly once per (source, request ID, fingerprint).
 */
export function forkSession(
  sessionDir: string,
  optionsInput: ForkOptions,
): ForkResult {
  const options = { ...optionsInput };
  if (options.sourceSessionId.trim() === "") {
    throw new ForkSessionNotFoundError();
  }
  if (options.requestId.trim() === "") {
    throw new ForkIdempotencyRequiredError();
  }
  if (options.requestId.length > 256) {
    throw new ForkIdempotencyTooLongError();
  }
  if (options.titleMode === "") options.titleMode = "increment";
  const sourceId = options.sourceSessionId;
  const requestHash = hashForkRequest(options.requestId);
  const fingerprint = forkFingerprint(options);
  const db = openRootDB(sessionDir);
  const forkDao = new ForkDAO(db.db);

  // Idempotent retries return the original child even if the source has since
  // started another run. The durable request record is authoritative.
  try {
    const existing = forkDao.findRequest(
      db.db!,
      requestHash,
      sourceId,
    );
    if (existing.requestFingerprint !== fingerprint) {
      throw new ForkIdempotencyConflictError();
    }
    return forkResultByDB(db, existing.childSessionId);
  } catch (err) {
    if (!isNoRows(err)) throw err;
  }

  let lease;
  try {
    lease = acquireFork(sessionDir, sourceId);
  } catch (err) {
    if (err instanceof RuntimeSessionNotFoundError) {
      throw new ForkSessionNotFoundError();
    }
    if (
      err instanceof RuntimeLeaseBusyError ||
      err instanceof SessionRunActiveError
    ) {
      throw new ForkSessionActiveError();
    }
    throw err;
  }
  try {
    const phase1 = db.runInTx((tx): Phase1 => {
      validateRuntimeLeaseTx(tx, sessionDir, sourceId);
      const txForkDao = new ForkDAO(null);
      try {
        const existing = txForkDao.findRequest(tx, requestHash, sourceId);
        if (existing.requestFingerprint !== fingerprint) {
          throw new ForkIdempotencyConflictError();
        }
        return {
          kind: "idempotent",
          result: forkResultByIdTx(tx, existing.childSessionId),
        };
      } catch (err) {
        if (!isNoRows(err)) throw err;
      }

      try {
        txForkDao.findSession(tx, sourceId);
      } catch (err) {
        if (isNoRows(err)) throw new ForkSessionNotFoundError();
        throw err;
      }
      if (
        txForkDao.activeRunCount(
          tx,
          sourceId,
          nonTerminalSessionRunStatuses(),
        ) !== 0
      ) {
        throw new ForkSessionActiveError();
      }
      if (txForkDao.openTurnCount(tx, sourceId) !== 0) {
        throw new ForkSessionActiveError();
      }
      if (pendingDecisionsTx(tx, sourceId)) {
        throw new ForkSessionActiveError();
      }

      const entries = loadForkEntriesTx(tx, sourceId);
      const turns = loadForkTurnsTx(tx, sourceId);
      const { boundary, forkKind } = resolveForkBoundaryTx(
        tx,
        sourceId,
        entries,
        turns,
        options.atSeq ?? null,
      );
      if (boundary <= 0) throw new ForkNoCompletedTurnError();
      const copyEntries = entries.filter((entry) => entry.seq <= boundary);
      if (copyEntries.length === 0) throw new ForkNoCompletedTurnError();
      const snapshot = forkSourceFingerprintTx(tx, sourceId);
      return {
        kind: "snapshot",
        copyEntries,
        turns,
        boundary,
        forkKind,
        snapshot,
      };
    });
    if (phase1.kind === "idempotent") return phase1.result;
    const { copyEntries, turns, boundary, forkKind, snapshot } = phase1;

    return db.runInTx((tx) => {
      validateRuntimeLeaseTx(tx, sessionDir, sourceId);
      const current = forkSourceFingerprintTx(tx, sourceId);
      if (
        current.maxSeq !== snapshot.maxSeq || current.leaf !== snapshot.leaf ||
        current.openTurns !== snapshot.openTurns ||
        current.activeRuns !== snapshot.activeRuns
      ) {
        if (
          current.openTurns !== snapshot.openTurns ||
          current.activeRuns !== snapshot.activeRuns
        ) {
          throw new ForkSessionActiveError();
        }
        throw new SessionModifiedError(
          "source changed during fork snapshot",
        );
      }

      let childId = generateID();
      if (childId === sourceId) childId = generateID();
      const entryIdMap = new Map<string, string>();
      for (const entry of copyEntries) entryIdMap.set(entry.id, generateID());
      const turnIdMap = new Map<string, string>();
      for (const turn of turns) {
        if (turn.endSeq !== null && turn.endSeq <= boundary) {
          turnIdMap.set(turn.id, generateID());
        }
      }

      const dao = new ForkDAO(null);
      dao.insertSessionFrom(
        tx,
        childId,
        sourceId,
        boundary,
        copyEntries.length,
        forkKind,
      );
      if (options.expertId !== undefined && options.expertId !== null) {
        new SessionDAO(null).updateSessionExpertId(
          tx,
          "sessions",
          childId,
          options.expertId,
        );
      }
      const seqMap = new Map<number, number>();
      for (const source of copyEntries) {
        const newId = entryIdMap.get(source.id)!;
        let parentId = "";
        if (source.parentId !== null) {
          parentId = entryIdMap.get(source.parentId) ?? "";
        }
        let data = remapForkData(
          source.type,
          source.data,
          entryIdMap,
          turnIdMap,
        );
        if (source.type === entrySession) {
          let header: Header;
          try {
            header = JSON.parse(data) as Header;
          } catch {
            throw new ForkUnsupportedEntryError("session header: invalid JSON");
          }
          header.id = childId;
          header.parentSession = sourceId;
          header.channelType = "local";
          header.channelId = "";
          header.forkBoundarySeq = boundary;
          header.seedLength = copyEntries.length;
          header.forkKind = forkKind;
          if (options.expertId !== undefined && options.expertId !== null) {
            header.expertId = options.expertId;
          }
          data = JSON.stringify(header);
          parentId = "";
        } else {
          data = rewriteForkEntryIdentity(data, newId, parentId);
        }
        const seq = dao.insertEntry(tx, {
          sessionId: childId,
          seq: 0,
          id: newId,
          type: source.type,
          parentId: parentId === "" ? null : parentId,
          timestamp: source.timestamp,
          data,
        });
        seqMap.set(source.seq, seq);
      }
      for (const turn of turns) {
        if (turn.endSeq === null || turn.endSeq > boundary) continue;
        const startSeq = seqMap.get(turn.startSeq);
        const endSeq = seqMap.get(turn.endSeq);
        if (startSeq === undefined || endSeq === undefined) {
          throw new ForkUnsupportedEntryError(
            `turn ${turn.id} boundary mapping`,
          );
        }
        dao.insertTurn(
          tx,
          turnIdMap.get(turn.id)!,
          childId,
          turn.intentId,
          turn.kind,
          turn.status,
          startSeq,
          endSeq,
          turn.startedAt.toISOString(),
          formatOptionalTime(turn.endedAt),
        );
      }
      dao.copyCapabilities(tx, sourceId, childId);
      dao.copyProject(tx, sourceId, childId);
      const childLeaf = currentEntryIdTx(tx, childId);
      const title = nextForkTitleTx(
        tx,
        sourceId,
        childId,
        titleFromEntries(copyEntries),
      );
      if (title !== "") {
        const titleEntry: SessionInfoEntry = {
          type: entrySessionInfo,
          id: generateID(),
          parentId: stringPtr(childLeaf),
          timestamp: new Date(),
          name: title,
          source: "auto",
        };
        dao.insertRawEntry(
          tx,
          childId,
          titleEntry.id,
          titleEntry.type,
          childLeaf === "" ? null : childLeaf,
          titleEntry.timestamp.toISOString(),
          JSON.stringify(titleEntry),
        );
      }
      dao.insertForkRequest(tx, {
        requestKeyHash: requestHash,
        requestFingerprint: fingerprint,
        sourceSessionId: sourceId,
        childSessionId: childId,
        createdAt: new Date().toISOString(),
      });
      return {
        sessionId: childId,
        parentSessionId: sourceId,
        forkKind,
        boundarySeq: boundary,
        seedLength: copyEntries.length,
      };
    });
  } finally {
    lease.release();
  }
}

function rewriteForkEntryIdentity(
  raw: string,
  id: string,
  parentId: string,
): string {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new ForkUnsupportedEntryError(
      `entry identity: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  value.id = id;
  value.parentId = parentId === "" ? null : parentId;
  return JSON.stringify(value);
}

function hashForkRequest(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
}

function forkFingerprint(options: ForkOptions): string {
  const seq = options.atSeq !== undefined && options.atSeq !== null
    ? String(options.atSeq)
    : "";
  // SQLite text values must not contain embedded NUL bytes: use a stable
  // printable delimiter for the idempotency snapshot instead.
  return `${options.sourceSessionId}|${seq}|${options.titleMode}`;
}

function formatOptionalTime(value: Date | null): string | null {
  if (value === null) return null;
  return value.toISOString();
}

function loadForkEntriesTx(tx: Tx, sessionId: string): ForkSourceEntry[] {
  return new ForkDAO(null).listEntries(tx, sessionId).map((record) => ({
    seq: record.seq,
    id: record.id,
    type: record.type,
    parentId: record.parentId,
    timestamp: record.timestamp,
    data: record.data,
  }));
}

function forkSourceFingerprintTx(
  tx: Tx,
  sessionId: string,
): ForkSourceFingerprint {
  const record = new ForkDAO(null).fingerprint(
    tx,
    sessionId,
    nonTerminalSessionRunStatuses(),
  );
  return {
    maxSeq: record.maxSeq,
    leaf: record.leaf,
    openTurns: record.openTurns,
    activeRuns: record.activeRuns,
  };
}

function pendingDecisionsTx(tx: Tx, sessionId: string): boolean {
  const records = new SessionDAO(null).listRunEventsFrom(tx, sessionId);
  const pending = new Set<string>();
  for (const record of records) {
    if (!isDecisionEventType(record.eventType)) continue;
    let envelope: { decision?: { id?: string; status?: string } };
    try {
      envelope = JSON.parse(record.data) as typeof envelope;
    } catch {
      continue;
    }
    const id = envelope.decision?.id ?? "";
    if (id === "") continue;
    if (envelope.decision?.status === "pending") {
      pending.add(id);
    } else {
      pending.delete(id);
    }
  }
  return pending.size !== 0;
}

function loadForkTurnsTx(tx: Tx, sessionId: string) {
  return new ConversationTurnDAO(null).listFrom(tx, sessionId).map(scanTurn);
}

function resolveForkBoundaryTx(
  tx: Tx,
  sessionId: string,
  entries: ForkSourceEntry[],
  turns: ReturnType<typeof scanTurn>[],
  atSeq: number | null,
): { boundary: number; forkKind: ForkKind } {
  if (turns.length === 0) {
    return resolveLegacyForkBoundaryTx(tx, sessionId, entries, atSeq);
  }
  if (atSeq === null) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn.endSeq !== null && turn.status !== "open") {
        return {
          boundary: absorbForkMetadata(entries, turn.endSeq),
          forkKind: "session",
        };
      }
    }
    throw new ForkNoCompletedTurnError();
  }
  if (atSeq <= 0) throw new ForkInvalidBoundaryError();
  let record;
  try {
    record = new ForkDAO(null).entryAtSeq(tx, sessionId, atSeq);
  } catch (err) {
    if (isNoRows(err)) throw new ForkInvalidBoundaryError();
    throw err;
  }
  if (record.type !== entryMessage) throw new ForkUnavailableError();
  let message: MessageEntry;
  try {
    message = JSON.parse(record.data) as MessageEntry;
  } catch {
    throw new ForkUnavailableError();
  }
  if (message.message?.role !== "assistant") throw new ForkUnavailableError();
  for (const turn of turns) {
    if (
      turn.endSeq === null || atSeq < turn.startSeq || atSeq > turn.endSeq
    ) {
      continue;
    }
    let lastMessageSeq = 0;
    let lastMessage: MessageEntry | null = null;
    for (const candidate of entries) {
      if (
        candidate.seq < turn.startSeq || candidate.seq > turn.endSeq ||
        candidate.type !== entryMessage
      ) {
        continue;
      }
      let candidateMessage: MessageEntry;
      try {
        candidateMessage = JSON.parse(candidate.data) as MessageEntry;
      } catch {
        continue;
      }
      lastMessageSeq = candidate.seq;
      lastMessage = candidateMessage;
    }
    if (
      lastMessageSeq !== atSeq || lastMessage === null ||
      lastMessage.message?.role !== "assistant" ||
      !hasAssistantText(lastMessage.message) ||
      (lastMessage.message.contents?.length ?? 0) > 0 &&
        hasToolCall(lastMessage.message.contents)
    ) {
      throw new ForkUnavailableError();
    }
    return {
      boundary: absorbForkMetadata(entries, turn.endSeq),
      forkKind: "message",
    };
  }
  throw new ForkUnavailableError();
}

interface LegacyForkBoundary {
  startSeq: number;
  endSeq: number;
}

/**
 * Gives pre-turn-index sessions a conservative compatibility path. A completed
 * durable Run is usable only when its time interval maps to exactly one
 * non-overlapping transcript message interval.
 */
function resolveLegacyForkBoundaryTx(
  tx: Tx,
  sessionId: string,
  entries: ForkSourceEntry[],
  atSeq: number | null,
): { boundary: number; forkKind: ForkKind } {
  const records = new ForkDAO(null).runWindows(
    tx,
    sessionId,
    terminalSessionRunStatuses(),
  );
  interface RunWindow {
    start: Date;
    end: Date;
  }
  const windows: RunWindow[] = [];
  for (const record of records) {
    const start = parseSessionTimestamp(record.startedAt);
    const end = parseSessionTimestamp(record.finishedAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
    if (end.getTime() <= start.getTime()) continue;
    if (
      windows.length > 0 &&
      start.getTime() <= windows[windows.length - 1].end.getTime()
    ) {
      throw new ForkUnavailableError();
    }
    windows.push({ start, end });
  }
  if (windows.length === 0) throw new ForkNoCompletedTurnError();
  const boundaries: LegacyForkBoundary[] = [];
  for (const window of windows) {
    let first = 0;
    let last = 0;
    for (const entry of entries) {
      if (entry.type !== entryMessage) continue;
      const ts = parseSessionTimestamp(entry.timestamp);
      if (
        isNaN(ts.getTime()) || ts.getTime() < window.start.getTime() ||
        ts.getTime() > window.end.getTime()
      ) {
        continue;
      }
      if (first === 0) first = entry.seq;
      last = entry.seq;
    }
    if (first === 0 || last === 0) continue;
    boundaries.push({ startSeq: first, endSeq: last });
  }
  if (boundaries.length === 0) throw new ForkNoCompletedTurnError();
  if (atSeq === null) {
    return {
      boundary: absorbForkMetadata(
        entries,
        boundaries[boundaries.length - 1].endSeq,
      ),
      forkKind: "session",
    };
  }
  for (const boundary of boundaries) {
    if (atSeq < boundary.startSeq || atSeq > boundary.endSeq) continue;
    let selected: MessageEntry | null = null;
    let selectedSeq = 0;
    let lastSeq = 0;
    for (const entry of entries) {
      if (
        entry.seq < boundary.startSeq || entry.seq > boundary.endSeq ||
        entry.type !== entryMessage
      ) {
        continue;
      }
      let message: MessageEntry;
      try {
        message = JSON.parse(entry.data) as MessageEntry;
      } catch {
        throw new ForkUnavailableError();
      }
      lastSeq = entry.seq;
      if (entry.seq === atSeq) {
        selected = message;
        selectedSeq = entry.seq;
      }
    }
    if (
      selectedSeq === 0 || selectedSeq !== lastSeq || selected === null ||
      selected.message?.role !== "assistant" ||
      !hasAssistantText(selected.message) ||
      hasToolCall(selected.message.contents)
    ) {
      throw new ForkUnavailableError();
    }
    return {
      boundary: absorbForkMetadata(entries, boundary.endSeq),
      forkKind: "message",
    };
  }
  throw new ForkUnavailableError();
}

function hasToolCall(contents: ContentBlock[] | undefined): boolean {
  for (const block of contents ?? []) {
    if (block.type === "toolCall" || block.toolCall !== undefined) return true;
  }
  return false;
}

function hasAssistantText(message: Message): boolean {
  if ((message.content ?? "").trim() !== "") return true;
  for (const block of message.contents ?? []) {
    if (block.type === "text" && (block.text ?? "").trim() !== "") return true;
  }
  return false;
}

function absorbForkMetadata(
  entries: ForkSourceEntry[],
  endSeq: number,
): number {
  let boundary = endSeq;
  for (const entry of entries) {
    if (entry.seq <= endSeq) continue;
    if (entry.type === entryTurnStart) break;
    boundary = entry.seq;
  }
  return boundary;
}

function remapForkData(
  sourceType: string,
  raw: string,
  entryIds: Map<string, string>,
  turnIds: Map<string, string>,
): string {
  const remapEntryId = (value: string): string => entryIds.get(value) ?? value;
  const remapTurnId = (value: string): string => turnIds.get(value) ?? value;
  switch (sourceType) {
    case entrySession:
    case entryMessage:
    case entryModelChange:
    case entryModeChange:
    case entryThinkingChange:
    case entryAdditionalDirectories:
    case entrySessionInfo:
      return raw;
    case entryCompaction: {
      const entry = JSON.parse(raw) as {
        firstKeptEntryId: string;
        previousCompactionId?: string;
        lastSummarizedEntryId?: string;
      };
      entry.firstKeptEntryId = remapEntryId(entry.firstKeptEntryId);
      if (entry.previousCompactionId) {
        entry.previousCompactionId = remapEntryId(entry.previousCompactionId);
      }
      if (entry.lastSummarizedEntryId) {
        entry.lastSummarizedEntryId = remapEntryId(
          entry.lastSummarizedEntryId,
        );
      }
      return JSON.stringify(entry);
    }
    case entryContentOverride: {
      const entry = JSON.parse(raw) as { targetEntryId: string };
      entry.targetEntryId = remapEntryId(entry.targetEntryId);
      return JSON.stringify(entry);
    }
    case entryBranchSummary: {
      const entry = JSON.parse(raw) as BranchSummaryEntry;
      entry.fromId = remapEntryId(entry.fromId);
      return JSON.stringify(entry);
    }
    case entryLabel: {
      const entry = JSON.parse(raw) as LabelEntry;
      entry.targetId = remapEntryId(entry.targetId);
      return JSON.stringify(entry);
    }
    case entryTurnStart: {
      const entry = JSON.parse(raw) as TurnStartEntry;
      entry.turnId = remapTurnId(entry.turnId);
      return JSON.stringify(entry);
    }
    case entryTurnEnd: {
      const entry = JSON.parse(raw) as TurnEndEntry;
      entry.turnId = remapTurnId(entry.turnId);
      return JSON.stringify(entry);
    }
    case entryCustom:
    case entryCustomMessage:
      throw new ForkUnsupportedEntryError(
        `custom entry type ${sourceType} has no declared reference rewrite policy`,
      );
    default:
      throw new ForkUnsupportedEntryError(`unknown entry type ${sourceType}`);
  }
}

function currentEntryIdTx(tx: Tx, sessionId: string): string {
  try {
    return new ForkDAO(null).currentEntryId(tx, sessionId);
  } catch (err) {
    if (isNoRows(err)) return "";
    throw err;
  }
}

function titleFromEntries(entries: ForkSourceEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== entrySessionInfo) continue;
    try {
      const entry = JSON.parse(entries[i].data) as SessionInfoEntry;
      return entry.name;
    } catch {
      return "Session";
    }
  }
  return "Session";
}

function nextForkTitleTx(
  tx: Tx,
  parentId: string,
  _childId: string,
  base: string,
): string {
  if (base.trim() === "") return "";
  const dao = new ForkDAO(null);
  for (let index = 1; index < 10000; index++) {
    const candidate = `${base} (${index})`;
    if (!dao.titleExists(tx, parentId, entrySessionInfo, candidate)) {
      return candidate;
    }
  }
  throw new ForkUnsupportedEntryError("unable to allocate fork title");
}

function forkResultByIdTx(tx: Tx, childId: string): ForkResult {
  return forkResultFromRecord(new ForkDAO(null).result(tx, childId));
}

function forkResultByDB(db: { db: DB | null }, childId: string): ForkResult {
  if (db.db === null) throw new Error("fork database is not open");
  return forkResultFromRecord(new ForkDAO(db.db).result(db.db, childId));
}

function forkResultFromRecord(
  record: import("../dao/mod.ts").ForkSessionRecord,
): ForkResult {
  return {
    sessionId: record.id,
    parentSessionId: record.parentSession ?? "",
    forkKind: (record.forkKind ?? "") as ForkKind,
    boundarySeq: record.forkBoundary,
    seedLength: record.seedLength,
  };
}
