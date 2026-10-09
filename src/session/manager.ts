// The SQLite-backed Manager.
//
// The Manager owns one session's state and persistence: it loads the session
// header and entry log from the shared sessions.db, reconstructs the current
// branch, and appends new entries under the fenced runtime lease and the
// optimistic leaf check. Listing, detail projection, and deletion helpers live
// next to it.
//
// Deviations from Go: the `sync.RWMutex` is dropped (Deno is single-threaded
// and every method here is synchronous), `context.Context` is dropped (the DAO
// layer is synchronous), and `errors.Is` sentinels map to typed `Error` classes.
// `json.RawMessage` fields decode as plain JSON values.
//
// The transcript-replay core (`buildReplayState`, `getEntryMetadata`,
// `cloneMessage`, the compaction helpers) is owned by `replay.ts`; the
// capability/run-event/sequenced-message projections are owned by
// `session_events.ts`; and the conversation-turn boundary is owned by
// `conversation_turn.ts`. This file wires them together behind the Manager.

import * as path from "@opensac/path";
import {
  BindingDAO,
  type Database,
  SessionDAO,
  StatsDAO,
  type Tx,
} from "../dao/mod.ts";
import {
  type Message,
  totalInputTokens,
  type Usage,
} from "../provider/types.ts";
import { sessionDir as platformSessionDir } from "../platform/platform.ts";
import { truncateWithSuffix } from "../util/truncate.ts";
import {
  type AdditionalDirectoriesEntry,
  type BranchSummaryEntry,
  type CompactionEntry,
  type ContentOverrideEntry,
  entryAdditionalDirectories,
  entryBranchSummary,
  entryCompaction,
  entryContentOverride,
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
  type ModeChangeEntry,
  type ModelChangeEntry,
  type SessionInfoEntry,
  type ThinkingLevelChangeEntry,
  type TurnEndEntry,
  type TurnStartEntry,
} from "./entry.ts";
import {
  endConversationTurn,
  startConversationTurn,
} from "./conversation_turn.ts";
import { openBunDatabase } from "./database.ts";
import { validateBinding } from "./bindings.ts";
import {
  buildReplayState,
  cloneMessage,
  getEntryMetadata,
  lastSummarizedEntryIDLocked,
  latestCompactionLocked,
  type ReplayState,
} from "./replay.ts";
import {
  openExistingSessionDB,
  openRootDB,
  parseSessionTimestamp,
} from "./root_db.ts";
import {
  acquireMutation,
  type RuntimeLeaseGuard,
  RuntimeLeaseLostError,
  RuntimeSessionNotFoundError,
  validateRuntimeLeaseBindingTx,
  validateRuntimeLeaseTx,
} from "./runtime_lock.ts";
import {
  SessionIDExistsError,
  SessionModifiedError,
} from "./session_errors.ts";
import { currentVersion } from "./store.ts";

/** Current persisted session entry-format version (owned by `store.ts`). */
export { currentVersion };

/** The union of every entry the Manager may hold in memory. */
export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | ModeChangeEntry
  | ThinkingLevelChangeEntry
  | AdditionalDirectoriesEntry
  | CompactionEntry
  | ContentOverrideEntry
  | SessionInfoEntry
  | TurnStartEntry
  | TurnEndEntry
  | BranchSummaryEntry
  | LabelEntry;

/** Metadata about a persisted session. */
export interface SessionInfo {
  path: string;
  modTime: Date;
  name: string;
  cwd: string;
  channelType: string;
  channelId: string;
  parentSession: string;
  forkBoundarySeq: number;
  seedLength: number;
  forkKind: string;
  expertId: string;
}

/** Detailed metadata about a session for display. */
export interface SessionDetail extends SessionInfo {
  id: string;
  messageCount: number;
  preview: string;
}

/** Options shared by the session listing functions. */
export interface ListOptions {
  limit: number;
  offset: number;
  messagesOnly: boolean;
  search: string;
}

/** A functional option mutating a `ListOptions`. */
export type ListOption = (options: ListOptions) => void;

/** Limits the number of returned sessions. */
export function withLimit(limit: number): ListOption {
  return (options) => {
    options.limit = limit;
  };
}

/** Offsets the returned sessions. */
export function withOffset(offset: number): ListOption {
  return (options) => {
    options.offset = offset;
  };
}

/**
 * Limits session listings to sessions containing at least one persisted
 * conversation message. This avoids loading transient empty sessions during
 * history pagination.
 */
export function withMessagesOnly(): ListOption {
  return (options) => {
    options.messagesOnly = true;
  };
}

/**
 * Filters sessions by ID, work directory, channel metadata, or persisted
 * message/session-info content. Intended for session listings.
 */
export function withSearch(search: string): ListOption {
  return (options) => {
    options.search = search.trim();
  };
}

/** Encodes a directory path for use in a session directory name. */
export function encodePath(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

/** Returns the encoded session directory path for a working directory. */
function sessionDirForCwd(cwd: string, sessionDir: string): string {
  return path.join(sessionDir, `--${encodePath(cwd)}--`);
}

/**
 * Formats a timestamp as Go's `20060102-150405` layout using local time
 * components, matching the session handle file naming convention.
 */
function formatStamp(ts: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${
    pad(ts.getHours())
  }${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

function virtualSessionFile(sessionDir: string, id: string, ts: Date): string {
  return path.join(sessionDir, `${formatStamp(ts)}_${id}.db`);
}

function isNotFound(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound;
}

function stringValue(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value;
}

/** Opens a DAO-owned database handle for `pathValue` (cached by src/db). */
function cachedDB(pathValue: string): Database {
  return openBunDatabase(pathValue);
}

/** Reconstructs the shared sessions.db path for a session handle file. */
export function resolveDBPath(sessionFilePath: string): string {
  const clean = path.normalize(sessionFilePath);
  const dir = path.dirname(clean);

  if (path.basename(dir).includes("--")) {
    return path.join(path.dirname(dir), "sessions.db");
  }

  if (clean.includes(`${path.SEPARATOR}channels${path.SEPARATOR}`)) {
    return path.join(dir, "sessions.db");
  }

  if (dir === "." || dir === "") {
    return path.join(platformSessionDir(), "sessions.db");
  }

  return path.join(dir, "sessions.db");
}

/** The result of resolving a write target for an entry append. */
interface EntryWriteTarget {
  dbPath: string;
  sessionID: string;
}

/** The result of resolving a session handle to delete. */
interface DeleteTarget {
  cleanPath: string;
  sessionID: string;
}

/**
 * Manager manages a single session's state and persistence.
 */
export class Manager {
  file = "";
  header: Header | null = null;
  entries: SessionEntry[] = [];
  leafID: string | null = null;
  cwd = "";
  sessionDir = "";
  subAgent = false;

  private tableSession(): string {
    return this.subAgent ? "sub_session" : "sessions";
  }

  private tableEntries(): string {
    return this.subAgent ? "sub_entries" : "entries";
  }

  /** Opens an existing session handle file. */
  static open(pathValue: string): Manager {
    const m = new Manager();
    m.file = pathValue;
    m.load();
    return m;
  }

  /**
   * Refreshes a manager from the shared SQLite session database. Callers that
   * retain a manager while another UI writes the same session reload after
   * acquiring the session runtime lock so the next append uses the current leaf.
   */
  reload(): void {
    if (this.file === "") {
      throw new Error("session manager is not initialized");
    }
    const oldHeader = this.header;
    const oldEntries = this.entries;
    const oldLeaf = this.leafID;
    const oldCwd = this.cwd;
    this.header = null;
    this.entries = [];
    this.leafID = null;
    try {
      this.load();
    } catch (err) {
      this.header = oldHeader;
      this.entries = oldEntries;
      this.leafID = oldLeaf;
      this.cwd = oldCwd;
      throw err;
    }
  }

  /** Initializes a new session with an auto-generated session ID. */
  init(): void {
    this.initWithID("");
  }

  /** Initializes a new session using the provided session ID. */
  initWithID(id: string): void {
    this.initWithBindingLocked(id, "local", "");
  }

  /** Initializes a new session with a channel binding. */
  initWithBinding(channelType: string, channelId: string): void {
    validateBinding(channelType, channelId);
    this.initWithBindingLocked("", channelType, channelId);
  }

  /** Initializes a session with a specific ID and channel binding. */
  initWithIDAndBinding(
    id: string,
    channelType: string,
    channelId: string,
  ): void {
    validateBinding(channelType, channelId);
    this.initWithBindingLocked(id, channelType, channelId);
  }

  private ensureInitialized(): void {
    if (this.file !== "") return;
    this.initWithID("");
  }

  private initWithBindingLocked(
    id: string,
    channelType: string,
    channelId: string,
  ): void {
    const explicitID = id !== "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = new Date();
      let candidate = id;
      if (candidate === "") candidate = generateID();
      this.header = {
        type: entrySession,
        version: currentVersion,
        id: candidate,
        timestamp: now,
        cwd: this.cwd,
        channelType,
        channelId,
      };
      this.entries = [];
      this.leafID = null;

      this.file = path.join(
        this.sessionDir,
        `${formatStamp(now)}_${candidate}.db`,
      );
      let handlePath = "";

      if (this.sessionDir.includes("channels")) {
        const dir = sessionDirForCwd(this.cwd, this.sessionDir);
        Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.file = path.join(dir, `${formatStamp(now)}_${candidate}.db`);
        handlePath = this.file;
      }

      let err: unknown = null;
      try {
        this.writeEntry(this.header);
      } catch (e) {
        err = e;
      }
      if (err === null) {
        if (handlePath !== "") {
          writeHandleFile(handlePath, candidate);
        }
        return;
      }
      if (explicitID || !(err instanceof SessionIDExistsError)) throw err;
    }
    throw new SessionIDExistsError("generate unique session ID");
  }

  /** Returns the session handle file path. */
  getFile(): string {
    return this.file;
  }

  /**
   * Returns the root directory containing this manager's shared sessions
   * database. Runtime extensions use it for auxiliary session tables.
   */
  getSessionDir(): string {
    if (this.sessionDir === "" && this.file !== "") {
      return path.dirname(resolveDBPath(this.file));
    }
    return this.sessionDir;
  }

  /** Returns the session header. */
  getHeader(): Header | null {
    return this.header;
  }

  /** Returns the current leaf entry ID. */
  getLeafID(): string | null {
    return this.leafID;
  }

  /** Returns all messages in the current branch. */
  getMessages(): Message[] {
    return this.getReplayState().messages;
  }

  /** Returns the current branch after applying compaction entries. */
  getReplayState(): ReplayState {
    return buildReplayState(this.entries);
  }

  /** Returns the newest compaction entry in the current session. */
  getLatestCompaction(): CompactionEntry | null {
    return latestCompactionLocked(this.entries);
  }

  /** Returns the newest model binding in the session. */
  getLatestModelChange(): ModelChangeEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.type === entryModelChange) return entry as ModelChangeEntry;
    }
    return null;
  }

  /** Returns the newest session mode in the session. */
  getLatestModeChange(): ModeChangeEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.type === entryModeChange) return entry as ModeChangeEntry;
    }
    return null;
  }

  /** Returns the newest thinking level in the session. */
  getLatestThinkingLevelChange(): ThinkingLevelChangeEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.type === entryThinkingChange) {
        return entry as ThinkingLevelChangeEntry;
      }
    }
    return null;
  }

  /** Returns the latest complete directory-root binding, or null. */
  getLatestAdditionalDirectories(): AdditionalDirectoriesEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.type === entryAdditionalDirectories) {
        const directories = entry as AdditionalDirectoriesEntry;
        return {
          ...directories,
          directories: [...directories.directories],
        };
      }
    }
    return null;
  }

  /** Appends a message entry and returns its ID. */
  appendMessage(msg: Message): string {
    this.ensureInitialized();
    const id = generateID();
    const entry: MessageEntry = {
      type: entryMessage,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      message: msg,
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /**
   * Persists an ordered batch of conversation messages, folding one agent
   * iteration's worth of tool results into a bounded number of write
   * transactions instead of one transaction per message.
   */
  appendMessages(msgs: Message[]): string[] {
    if (msgs.length === 0) return [];
    this.ensureInitialized();

    const ids: string[] = [];
    for (
      let start = 0;
      start < msgs.length;
      start += maxEntriesPerTransaction
    ) {
      const end = Math.min(start + maxEntriesPerTransaction, msgs.length);
      const chunk = msgs.slice(start, end);
      const batch: MessageEntry[] = new Array(chunk.length);
      const now = new Date();
      let parent: string | null = this.leafID;
      for (let i = 0; i < chunk.length; i++) {
        const id = generateID();
        ids.push(id);
        batch[i] = {
          type: entryMessage,
          id,
          parentId: parent,
          timestamp: now,
          message: chunk[i],
        };
        parent = id;
      }
      this.writeEntries(batch);
      for (const entry of batch) this.entries.push(entry);
      this.leafID = ids[ids.length - 1];
    }
    return ids;
  }

  /** Records a model change. */
  appendModelChange(providerName: string, modelId: string): string {
    this.ensureInitialized();
    const id = generateID();
    const entry: ModelChangeEntry = {
      type: entryModelChange,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      provider: providerName,
      modelId,
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /** Records a session execution mode change. */
  appendModeChange(mode: string): string {
    this.ensureInitialized();
    const id = generateID();
    const entry: ModeChangeEntry = {
      type: entryModeChange,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      mode,
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /** Records a thinking level change. */
  appendThinkingLevelChange(level: string): string {
    this.ensureInitialized();
    const id = generateID();
    const entry: ThinkingLevelChangeEntry = {
      type: entryThinkingChange,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      thinkingLevel: level,
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /** Records a complete replacement of the session's additional directories. */
  appendAdditionalDirectories(directories: string[]): string {
    this.ensureInitialized();
    const id = generateID();
    const entry: AdditionalDirectoriesEntry = {
      type: entryAdditionalDirectories,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      directories: [...directories],
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /** Records a context compaction. */
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): string {
    this.ensureInitialized();

    let summaryVersion = 1;
    let previousCompactionId = "";
    const previous = this.getLatestCompaction();
    if (previous !== null) {
      previousCompactionId = previous.id;
      if ((previous.summaryVersion ?? 0) > 0) {
        summaryVersion = (previous.summaryVersion ?? 0) + 1;
      } else {
        summaryVersion = 2;
      }
    }

    const id = generateID();
    const entry: CompactionEntry = {
      type: entryCompaction,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      summaryVersion,
      previousCompactionId,
      lastSummarizedEntryId: lastSummarizedEntryIDLocked(
        this.entries,
        firstKeptEntryId,
      ),
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /**
   * Records an append-only replacement of a persisted message entry's content.
   * The original entry stays in the log for audit; replay substitutes `msg`.
   */
  appendContentOverride(
    targetEntryId: string,
    msg: Message,
    reason: string,
    code: string,
  ): string {
    if (targetEntryId.trim() === "") {
      throw new Error("content override target entry ID is required");
    }
    this.ensureInitialized();

    let found = false;
    for (const entry of this.entries) {
      if (entry.type === entryMessage && entry.id === targetEntryId) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(
        `content override target ${targetEntryId} is not a message entry`,
      );
    }

    const id = generateID();
    const entry: ContentOverrideEntry = {
      type: entryContentOverride,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      targetEntryId,
      message: cloneMessage(msg),
      reason,
      code,
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /** Records a session display name. Retained for compatibility. */
  appendSessionInfo(name: string): string {
    return this.appendSessionTitle(name, "manual");
  }

  /** Records a session display name and its origin. */
  appendSessionTitle(name: string, source: string): string {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("session title is required");
    if (source !== "manual" && source !== "auto") {
      throw new Error("invalid session title source");
    }
    this.ensureInitialized();
    const id = generateID();
    const entry: SessionInfoEntry = {
      type: entrySessionInfo,
      id,
      parentId: this.leafID,
      timestamp: new Date(),
      name: trimmed,
      source,
    };
    this.writeEntry(entry);
    this.entries.push(entry);
    this.leafID = id;
    return id;
  }

  /**
   * Updates the manager's in-memory header after a channel binding change.
   */
  setSessionBinding(channelType: string, channelId: string): void {
    validateBinding(channelType, channelId);
    if (this.header === null) {
      throw new Error("session is not initialized");
    }
    this.header.channelType = channelType;
    this.header.channelId = channelId;
  }

  /**
   * Updates the session's expert binding (empty string unbinds). It patches the
   * in-memory header and persists the sessions row so reloads restore identity.
   */
  setExpertBinding(expertId: string): void {
    if (this.header === null) {
      throw new Error("session is not initialized");
    }
    const sessionId = this.header.id;
    const table = this.tableSession();
    this.withDB((db) => {
      new SessionDAO(db.db).updateSessionExpertId(
        db.db!,
        table,
        sessionId,
        expertId,
      );
    });
    if (this.header === null || this.header.id !== sessionId) {
      throw new Error("session identity changed while updating expert binding");
    }
    this.header.expertId = expertId;
  }

  /** Returns the bound expert bundle name ("" when unbound). */
  getExpertId(): string {
    return this.header === null ? "" : this.header.expertId ?? "";
  }

  /**
   * Changes the persisted working directory of an idle session. The caller
   * ensures the new directory is authorized and rebuilds Runtime resources.
   */
  setWorkDir(cwdRaw: string): void {
    let cwd = cwdRaw.trim();
    if (cwd === "" || !path.isAbsolute(cwd)) {
      throw new Error("session work directory must be an absolute path");
    }
    cwd = path.normalize(cwd);

    if (this.header === null) {
      throw new Error("session is not initialized");
    }
    if (this.header.cwd === cwd) {
      this.cwd = cwd;
      return;
    }
    const sessionId = this.header.id;
    const previousCwd = this.header.cwd;
    this.header.cwd = cwd;
    this.cwd = cwd;

    try {
      this.withDB((db) => {
        new SessionDAO(db.db).updateSessionCwd(
          db.db!,
          this.tableSession(),
          sessionId,
          cwd,
        );
      });
    } catch (err) {
      // Keep the in-memory manager truthful when persistence failed, without
      // overwriting a newer concurrent update.
      if (
        this.header !== null && this.header.id === sessionId &&
        this.header.cwd === cwd
      ) {
        this.header.cwd = previousCwd;
        this.cwd = previousCwd;
      }
      throw err;
    }
  }

  /**
   * Opens the durable conversation-turn boundary used by Session fork
   * resolution.
   */
  startConversationTurn(turnId: string, intentId: string, runId: string): void {
    this.ensureInitialized();
    let sessionDir = this.sessionDir;
    const sessionId = this.header === null ? "" : this.header.id;
    const file = this.file;
    if (sessionDir === "") sessionDir = path.dirname(resolveDBPath(file));
    startConversationTurn(sessionDir, {
      id: turnId,
      sessionId,
      intentId,
      runId,
      attempt: 0,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: new Date(),
      endedAt: null,
    });
    try {
      this.reload();
    } catch (err) {
      try {
        endConversationTurn(
          sessionDir,
          sessionId,
          turnId,
          "failed",
          "turn_reload",
          new Date(),
        );
      } catch (cleanupErr) {
        throw new Error(
          `reload session after starting conversation turn: ${err} (turn cleanup: ${cleanupErr})`,
        );
      }
      throw err;
    }
  }

  /** Closes the durable conversation-turn boundary. */
  endConversationTurn(
    turnId: string,
    status: string,
    stopReason: string,
  ): void {
    if (this.header === null) {
      throw new Error("session manager is not initialized");
    }
    let sessionDir = this.sessionDir;
    const sessionId = this.header.id;
    const file = this.file;
    if (sessionDir === "") sessionDir = path.dirname(resolveDBPath(file));
    endConversationTurn(
      sessionDir,
      sessionId,
      turnId,
      status,
      stopReason,
      new Date(),
    );
    this.reload();
  }

  /** Records a single LLM request's token usage and timing. */
  recordUsage(
    provider: string,
    protocol: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number,
    durationMs: number,
  ): void {
    const sessionId = this.header === null ? "" : this.header.id;
    const now = new Date().toISOString();
    const db = openRootDB(path.dirname(resolveDBPath(this.file)));
    const sessionDir = this.getSessionDir();
    db.runInTx((tx) => {
      validateRuntimeLeaseTx(tx, sessionDir, sessionId);
      new StatsDAO(null).insert(tx, {
        id: 0,
        timestamp: now,
        sessionId,
        provider,
        protocol,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        durationMs,
      });
    });
  }

  /** Records usage from a provider `Usage` struct. */
  recordUsageFromProviderUsage(
    provider: string,
    protocol: string,
    model: string,
    usage: Usage | null | undefined,
    durationMs: number,
  ): void {
    if (usage === null || usage === undefined) return;
    const input = totalInputTokens(usage);
    this.recordUsage(
      provider,
      protocol,
      model,
      input,
      usage.output,
      input + usage.output,
      durationMs,
    );
  }

  /** Runs a callback against the DAO-owned database for this session. */
  withDB(fn: (db: Database) => void): void {
    fn(cachedDB(resolveDBPath(this.file)));
  }

  /**
   * Verifies the session handle/database is writable and resolves the session
   * ID for entry writes.
   */
  private resolveEntryWriteTarget(): EntryWriteTarget {
    const dbPath = resolveDBPath(this.file);
    Deno.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    try {
      Deno.statSync(dbPath);
      const handle = Deno.openSync(dbPath, { write: true });
      handle.close();
    } catch {
      // Missing file is fine — the DB layer creates it.
    }

    let sessionID = "";
    if (this.header !== null) {
      sessionID = this.header.id;
    } else {
      try {
        sessionID = Deno.readTextFileSync(this.file).trim();
      } catch (err) {
        if (isNotFound(err)) sessionID = sessionFileID(this.file);
        else throw err;
      }
    }
    if (sessionID === "") {
      throw new Error("no session ID found for writeEntry");
    }
    return { dbPath, sessionID };
  }

  /** Writes one entry, registering the session header when present. */
  private writeEntry(entry: SessionEntry | Header): void {
    const { dbPath, sessionID } = this.resolveEntryWriteTarget();
    const meta = getEntryMetadata(entry);
    const data = JSON.stringify(entry);

    this.withDB((db) => {
      db.runInTx((tx) => {
        const dao = new SessionDAO(null);
        validateRuntimeLeaseTx(tx, path.dirname(dbPath), sessionID);

        if (meta.type !== entrySession) {
          const currentLeaf = dao.currentLeaf(
            tx,
            this.tableEntries(),
            sessionID,
            entrySession,
          );
          const expectedLeaf = meta.parentID ?? "";
          if (currentLeaf !== expectedLeaf) {
            throw new SessionModifiedError(
              `expected leaf ${JSON.stringify(expectedLeaf)}, current leaf ${
                JSON.stringify(currentLeaf)
              }; reopen the session before writing`,
            );
          }
        }

        if (meta.type === entrySession && this.header !== null) {
          const header = this.header;
          try {
            dao.insertSession(
              tx,
              this.tableSession(),
              sessionID,
              this.cwd,
              header.timestamp.toISOString(),
              stringValue(header.parentSession),
              header.version,
              stringValue(header.channelType),
              stringValue(header.channelId),
              header.forkBoundarySeq ?? 0,
              header.seedLength ?? 0,
              stringValue(header.forkKind),
              stringValue(header.expertId),
            );
          } catch (err) {
            if (isUniqueSessionIDError(err, this.tableSession())) {
              throw new SessionIDExistsError(
                err instanceof Error ? err.message : String(err),
              );
            }
            throw new Error(`register session: ${err}`);
          }
        }

        dao.insertEntry(
          tx,
          this.tableEntries(),
          sessionID,
          meta.id,
          meta.type,
          meta.parentID,
          meta.timestamp.toISOString(),
          data,
        );
      });
    });
  }

  /**
   * Persists a chain of message entries in a single transaction: one lease
   * validation, one leaf check against the first entry's parent, and one insert
   * per entry.
   */
  private writeEntries(batch: MessageEntry[]): void {
    if (batch.length === 0) return;
    const { dbPath, sessionID } = this.resolveEntryWriteTarget();
    const rows = batch.map((entry) => JSON.stringify(entry));

    this.withDB((db) => {
      db.runInTx((tx) => {
        const dao = new SessionDAO(null);
        validateRuntimeLeaseTx(tx, path.dirname(dbPath), sessionID);
        const currentLeaf = dao.currentLeaf(
          tx,
          this.tableEntries(),
          sessionID,
          entrySession,
        );
        const expectedLeaf = batch[0].parentId ?? "";
        if (currentLeaf !== expectedLeaf) {
          throw new SessionModifiedError(
            `expected leaf ${JSON.stringify(expectedLeaf)}, current leaf ${
              JSON.stringify(currentLeaf)
            }; reopen the session before writing`,
          );
        }
        for (let i = 0; i < batch.length; i++) {
          dao.insertEntry(
            tx,
            this.tableEntries(),
            sessionID,
            batch[i].id,
            entryMessage,
            batch[i].parentId,
            batch[i].timestamp.toISOString(),
            rows[i],
          );
        }
      });
    });
  }

  /** Loads the session header and entry log from the shared database. */
  load(): void {
    let sessionID: string;
    try {
      sessionID = Deno.readTextFileSync(this.file).trim();
    } catch (err) {
      if (isNotFound(err)) sessionID = sessionFileID(this.file);
      else throw new Error(`read session handle file: ${err}`);
    }

    if (sessionID === "") {
      throw new Error(`could not determine session ID from ${this.file}`);
    }

    this.withDB((db) => {
      const dao = new SessionDAO(db.db);
      const record = dao.header(this.tableSession(), sessionID);
      if (record === undefined) {
        throw new Error(
          `session ${JSON.stringify(sessionID)} not registered in DB`,
        );
      }

      const ts = parseSessionTimestamp(record.timestamp);
      this.header = {
        type: entrySession,
        version: record.version,
        id: sessionID,
        timestamp: ts,
        cwd: record.cwd,
        parentSession: stringValue(record.parentSession),
        channelType: record.channelType,
        channelId: record.channelId,
        forkBoundarySeq: record.forkBoundarySeq,
        seedLength: record.seedLength,
        forkKind: record.forkKind,
        expertId: record.expertId,
      };
      this.cwd = record.cwd;

      const records = dao.entries(this.tableEntries(), sessionID);
      let corruptRows = 0;
      for (const row of records) {
        if (row.type === entrySession) continue;
        let parsed: SessionEntry;
        try {
          parsed = JSON.parse(row.data) as SessionEntry;
        } catch {
          corruptRows++;
          continue;
        }
        switch (row.type) {
          case entryMessage:
          case entryModelChange:
          case entryModeChange:
          case entryThinkingChange:
          case entryAdditionalDirectories:
          case entryCompaction:
          case entryContentOverride:
          case entrySessionInfo:
          case entryTurnStart:
          case entryTurnEnd:
          case entryBranchSummary:
          case entryLabel:
            this.entries.push(parsed);
            this.leafID = parsed.id;
            break;
          default:
            break;
        }
      }
      if (corruptRows > 0) {
        console.warn(
          `[session] warning: skipped ${corruptRows} corrupt row(s) in ${this.file}`,
        );
      }
    });
  }
}

/** Caps how many entries one `appendMessages` batch persists in a transaction. */
const maxEntriesPerTransaction = 64;

/** Writes a session handle file holding the session ID. */
function writeHandleFile(handlePath: string, sessionID: string): void {
  const handle = Deno.openSync(handlePath, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });
  try {
    handle.writeSync(new TextEncoder().encode(sessionID));
  } finally {
    handle.close();
  }
}

/** Reports whether an error is a UNIQUE failure on `<table>.id`. */
function isUniqueSessionIDError(err: unknown, table: string): boolean {
  const message = (err instanceof Error ? err.message : String(err))
    .toLowerCase();
  return message.includes(
    `unique constraint failed: ${table.toLowerCase()}.id`,
  );
}

/** Creates a new session manager for a new session. */
export function createManager(cwd: string, sessionDir = ""): Manager {
  const m = new Manager();
  m.cwd = cwd;
  m.sessionDir = sessionDir === "" ? platformSessionDir() : sessionDir;
  return m;
}

/**
 * Creates a session manager whose records are stored separately from
 * user-continuable sessions.
 */
export function createSubAgentManager(cwd: string, sessionDir = ""): Manager {
  const m = createManager(cwd, sessionDir);
  m.subAgent = true;
  return m;
}

/** Opens an existing session handle file. */
export function openSession(pathValue: string): Manager {
  return Manager.open(pathValue);
}

/**
 * Continues the most recent session for a directory, or creates a new one.
 */
export function continueRecent(cwd: string, sessionDir = ""): Manager {
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const sessions = listForDir(cwd, dir);
  if (sessions.length > 0) {
    sessions.sort((a, b) => b.modTime.getTime() - a.modTime.getTime());
    return Manager.open(sessions[0].path);
  }
  const m = createManager(cwd, dir);
  m.init();
  return m;
}

/**
 * Opens a session using either an explicit file path or a session ID for the
 * supplied working directory.
 */
export function openByPathOrID(
  cwd: string,
  sessionDir: string,
  value: string,
): Manager {
  if (value === "") throw new Error("session value is empty");
  if (value.endsWith(".db") || value.includes(path.SEPARATOR)) {
    return Manager.open(value);
  }
  return openByID(cwd, sessionDir, value);
}

/** Opens the session for cwd whose session ID matches (prefix aware). */
export function openByID(
  cwd: string,
  sessionDir: string,
  sessionID: string,
): Manager {
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const dbPath = path.join(dir, "sessions.db");
  if (!sessionDBExists(dbPath)) {
    throw new Error(`session ${sessionID} not found for cwd ${cwd}`);
  }

  const db = cachedDB(dbPath);
  const dao = new SessionDAO(db.db);
  const exactID = dao.findExact("sessions", sessionID);
  if (exactID !== undefined) {
    const row = dao.header("sessions", exactID);
    if (row !== undefined && row.cwd === cwd) {
      return openSessionFromDB(exactID, dir);
    }
  }

  const matches = dao.prefixIds("sessions", cwd, sessionID);
  if (matches.length === 0) {
    throw new Error(`session ${sessionID} not found for cwd ${cwd}`);
  }
  if (matches.length > 1) {
    throw new Error(`session ID ${sessionID} is ambiguous for cwd ${cwd}`);
  }
  return openSessionFromDB(matches[0], dir);
}

/** Opens a session by exact session ID regardless of cwd. */
export function openByIDExact(sessionDir: string, sessionID: string): Manager {
  if (sessionID === "") throw new Error("session id is empty");
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const dbPath = path.join(dir, "sessions.db");
  if (!sessionDBExists(dbPath)) {
    throw new Error(`session ${sessionID} not found`);
  }
  return openSessionFromDB(sessionID, dir);
}

/**
 * Atomically creates a new bound session and clears the old one.
 */
export function rotateBoundSession(
  workDir: string,
  sessionDir: string,
  channelType: string,
  channelId: string,
  oldSessionId: string,
): Manager {
  validateBinding(channelType, channelId);
  const db = openRootDB(sessionDir);
  const id = generateID();
  new BindingDAO(db.db).rotate(
    workDir,
    channelType,
    channelId,
    oldSessionId,
    currentVersion,
    id,
    new Date().toISOString(),
  );
  return openByIDExact(sessionDir, id);
}

/** Creates a new session bound to a channel identity. */
export function createBound(
  workDir: string,
  sessionDir: string,
  channelType: string,
  channelId: string,
): Manager {
  validateBinding(channelType, channelId);
  const m = createManager(workDir, sessionDir);
  m.initWithBinding(channelType, channelId);
  return m;
}

/**
 * Reads the replayed directory binding for a session without exposing SQLite
 * details to protocol adapters.
 */
export function latestAdditionalDirectoriesByID(
  sessionDir: string,
  sessionID: string,
): string[] {
  const m = openByIDExact(sessionDir, sessionID);
  const entry = m.getLatestAdditionalDirectories();
  if (entry === null) return [];
  return [...entry.directories];
}

/**
 * Reads the replayed provider/model binding for a session without exposing
 * SQLite details to protocol adapters.
 */
export function latestModelChangeByID(
  sessionDir: string,
  sessionID: string,
): ModelChangeEntry | null {
  const m = openByIDExact(sessionDir, sessionID);
  return m.getLatestModelChange();
}

function sessionDBExists(dbPath: string): boolean {
  try {
    Deno.statSync(dbPath);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Finds the `.db` handle file that contains the given session ID. */
export function findHandleForID(dir: string, sessionID: string): string {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".db")) continue;
    if (
      entry.name === "sessions.db" || entry.name.startsWith("sessions.db-")
    ) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    let data: string;
    try {
      data = Deno.readTextFileSync(filePath);
    } catch {
      continue;
    }
    if (data.trim() === sessionID) return filePath;
    const base = entry.name.replace(/\.db$/, "");
    const idx = base.indexOf("_");
    if (idx >= 0 && base.slice(idx + 1).startsWith(sessionID)) return filePath;
  }
  return "";
}

/** Reconstructs a Manager directly from the database when no handle exists. */
function openSessionFromDB(sessionID: string, dir: string): Manager {
  const m = new Manager();
  m.sessionDir = dir;

  const dbPath = path.join(dir, "sessions.db");
  const db = cachedDB(dbPath);
  const dao = new SessionDAO(db.db);
  let timestampStr = "";
  try {
    timestampStr = dao.timestamp("sessions", sessionID) ?? "";
  } catch (err) {
    console.debug(
      `session open ${JSON.stringify(sessionID)} read timestamp: ${err}`,
    );
  }

  if (timestampStr !== "") {
    const ts = new Date(timestampStr);
    if (!isNaN(ts.getTime())) {
      m.file = path.join(dir, `${formatStamp(ts)}_${sessionID}.db`);
    }
  }
  if (m.file === "") m.file = path.join(dir, `${sessionID}.db`);
  m.load();
  return m;
}

/** Extracts the session ID encoded in a session handle file name. */
export function sessionFileID(filePath: string): string {
  const base = path.basename(filePath).replace(/\.db$/, "");
  const idx = base.indexOf("_");
  if (idx >= 0) return base.slice(idx + 1);
  if (base === "" || base === "active" || base === "sessions") return "";
  if (base.length >= 8) return base;
  return "";
}

function buildListOptions(opts: ListOption[]): ListOptions {
  const options: ListOptions = {
    limit: 0,
    offset: 0,
    messagesOnly: false,
    search: "",
  };
  for (const fn of opts) fn(options);
  return options;
}

/** Lists session records for a given working directory. */
export function listForDir(cwd: string, sessionDir = ""): SessionInfo[] {
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const db = openExistingSessionDB(dir);
  if (db === null) return [];
  const records = new SessionDAO(db.db).listForDir(cwd);
  return records.map((record) => sessionInfoFromRecord(dir, record));
}

/** Lists session records across all working directories. */
export function listAll(
  sessionDir = "",
  opts: ListOption[] = [],
): SessionInfo[] {
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const options = buildListOptions(opts);
  const db = openExistingSessionDB(dir);
  if (db === null) return [];
  const records = new SessionDAO(db.db).list({
    search: options.search,
    messagesOnly: options.messagesOnly,
    limit: options.limit,
    offset: options.offset,
  });
  return records.map((record) => sessionInfoFromRecord(dir, record));
}

function sessionInfoFromRecord(
  dir: string,
  record: {
    id: string;
    timestamp: string;
    cwd: string;
    channelType: string;
    channelId: string;
    parentSession: string | null;
    forkBoundarySeq: number;
    seedLength: number;
    forkKind: string;
    expertId: string;
  },
): SessionInfo {
  const ts = parseSessionTimestamp(record.timestamp);
  return {
    path: virtualSessionFile(dir, record.id, ts),
    modTime: ts,
    name: "",
    cwd: record.cwd,
    channelType: record.channelType,
    channelId: record.channelId,
    parentSession: stringValue(record.parentSession),
    forkBoundarySeq: record.forkBoundarySeq,
    seedLength: record.seedLength,
    forkKind: record.forkKind,
    expertId: record.expertId,
  };
}

/**
 * Returns the number of sessions that contain at least one persisted
 * conversation message.
 */
export function countWithMessages(
  sessionDir = "",
  opts: ListOption[] = [],
): number {
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const options = buildListOptions(opts);
  options.messagesOnly = true;
  const db = openExistingSessionDB(dir);
  if (db === null) return 0;
  return new SessionDAO(db.db).count({
    search: options.search,
    messagesOnly: options.messagesOnly,
  });
}

/** Returns the total number of sessions. */
export function countAll(sessionDir = ""): number {
  const dir = sessionDir === "" ? platformSessionDir() : sessionDir;
  const db = openExistingSessionDB(dir);
  if (db === null) return 0;
  return new SessionDAO(db.db).count({});
}

/** Lists sessions with details (ID, message count, preview). */
export function listForDirDetailed(
  cwd: string,
  sessionDir = "",
): SessionDetail[] {
  return buildSessionDetails(listForDir(cwd, sessionDir));
}

/** Lists sessions with details across all working directories. */
export function listAllDetailed(
  sessionDir = "",
  opts: ListOption[] = [],
): SessionDetail[] {
  return buildSessionDetails(listAll(sessionDir, opts));
}

function buildSessionDetails(sessions: SessionInfo[]): SessionDetail[] {
  if (sessions.length === 0) return [];

  const dbPath = resolveDBPath(sessions[0].path);
  const db = cachedDB(dbPath);

  const ids: string[] = [];
  const idPos = new Map<string, number>();
  sessions.forEach((session, index) => {
    const id = sessionFileID(session.path);
    ids.push(id);
    idPos.set(id, index);
  });

  const details: SessionDetail[] = sessions.map((session) => ({
    ...session,
    id: sessionFileID(session.path),
    messageCount: 0,
    preview: "",
  }));

  const aggregates = new SessionDAO(db.db).detailAggregates(ids);

  for (const [sessionID, count] of aggregates.messageCounts) {
    const idx = idPos.get(sessionID);
    if (idx === undefined) continue;
    details[idx].messageCount = count;
    const data = aggregates.firstMessages.get(sessionID);
    if (data !== undefined && data !== "") {
      try {
        const entry = JSON.parse(data) as MessageEntry;
        if (entry.message.role === "user") {
          let text = entry.message.content ?? "";
          if (text === "") {
            for (const block of entry.message.contents ?? []) {
              if (
                block.type === "text" && block.text !== undefined &&
                block.text !== ""
              ) {
                text = block.text;
                break;
              }
            }
          }
          if (text !== "") {
            details[idx].preview = truncateWithSuffix(text, 60, "...");
          }
        }
      } catch {
        // ignore malformed first message
      }
    }
  }

  for (const [sessionID, data] of aggregates.latestInfos) {
    const idx = idPos.get(sessionID);
    if (idx === undefined) continue;
    try {
      const entry = JSON.parse(data) as SessionInfoEntry;
      details[idx].name = entry.name;
    } catch {
      // ignore malformed session-info entry
    }
  }

  // A session's modification time is its newest entry, not its creation row:
  // `-c` and every "most recent session" surface must pick the conversation
  // last used, which a freshly created but abandoned session is not. The
  // creation timestamp stays the floor (an empty session was modified when
  // it was created) and the identity path keeps embedding it.
  for (const [sessionID, ts] of aggregates.latestEntryTimestamps) {
    const idx = idPos.get(sessionID);
    if (idx === undefined) continue;
    const latest = parseSessionTimestamp(ts);
    if (isNaN(latest.getTime())) continue;
    if (latest.getTime() > details[idx].modTime.getTime()) {
      details[idx].modTime = latest;
    }
  }

  details.sort((a, b) => b.modTime.getTime() - a.modTime.getTime());
  return details;
}

/**
 * Lists every session_id-keyed child table of sessions, ordered child-first so
 * deletion stays safe even if SQLite foreign key enforcement is enabled later.
 */
const sessionChildTables: string[] = [
  "runtime_submissions",
  "input_resource_events",
  "session_run_recoveries",
  "delivery_intents",
  "input_resources",
  "session_attachments",
  "session_execution_intents",
  "session_run_events",
  "session_runs",
  "session_capability_events",
  "session_capabilities",
  "session_esm_objectives",
  "session_esm_guidance",
  "session_metadata",
  "conversation_turns",
  "session_runtime_leases",
  "cron_jobs",
  "response_items",
  "tool_execution_records",
  "response_runs",
  "response_session_state",
  "response_turns",
  "session_channel_tool_generations",
  "session_channel_tools",
  "entries",
];

/** Removes every root-session child row before deleting the session itself. */
function deleteSessionDataTx(tx: Tx, sessionID: string): void {
  new SessionDAO(null).deleteSession(tx, sessionID, sessionChildTables);
}

/**
 * Deletes a session only after acquiring its shared mutation lease. Callers
 * that already hold a mutation lease use `deleteSessionWithMutation`.
 */
export function deleteSession(
  pathValue: string,
  sessionDir: string,
): void {
  const target = deleteSessionTarget(pathValue, sessionDir);
  if (target.sessionID === "") {
    removeSessionHandle(target.cleanPath);
    return;
  }
  let guard: RuntimeLeaseGuard;
  try {
    guard = acquireMutation(sessionDir, target.sessionID);
  } catch (err) {
    if (err instanceof RuntimeSessionNotFoundError) {
      removeSessionHandle(target.cleanPath);
      return;
    }
    // Preserve the typed failure (for example RuntimeLeaseBusyError) so callers
    // can still classify an active execution lease.
    throw err;
  }
  try {
    deleteSessionWithMutationTarget(
      target.cleanPath,
      sessionDir,
      target.sessionID,
      guard,
    );
  } finally {
    guard.release();
  }
}

/**
 * Deletes a session while the caller holds its Runtime-owned mutation lease.
 */
export function deleteSessionWithMutation(
  pathValue: string,
  sessionDir: string,
  guard: RuntimeLeaseGuard,
): void {
  const target = deleteSessionTarget(pathValue, sessionDir);
  deleteSessionWithMutationTarget(
    target.cleanPath,
    sessionDir,
    target.sessionID,
    guard,
  );
}

/**
 * Validates a session handle and resolves the session ID it names. A missing
 * handle is accepted: callers may be cleaning up an already-removed virtual
 * handle, and the durable row remains authoritative.
 */
function deleteSessionTarget(
  pathValue: string,
  sessionDir: string,
): DeleteTarget {
  const cleanPath = path.resolve(path.normalize(pathValue));
  const cleanSessionDir = path.resolve(path.normalize(sessionDir));
  const rel = path.relative(cleanSessionDir, cleanPath);
  if (
    rel === ".." || rel.startsWith(`..${path.SEPARATOR}`)
  ) {
    throw new Error(
      `session path ${pathValue} is outside session directory ${sessionDir}`,
    );
  }
  if (path.extname(cleanPath) !== ".db") {
    throw new Error(`session path ${pathValue} is not a .db file`);
  }
  const base = path.basename(cleanPath);
  if (base === "sessions.db" || base.startsWith("sessions.db-")) {
    throw new Error(
      `refusing to delete shared SQLite database ${pathValue} as a session handle`,
    );
  }

  let sessionID = "";
  try {
    sessionID = Deno.readTextFileSync(cleanPath).trim();
  } catch (err) {
    if (isNotFound(err)) sessionID = sessionFileID(cleanPath);
    else throw new Error(`read session handle ${cleanPath}: ${err}`);
  }
  return { cleanPath, sessionID };
}

function deleteSessionWithMutationTarget(
  cleanPath: string,
  sessionDir: string,
  sessionID: string,
  guard: RuntimeLeaseGuard,
): void {
  const binding = guard.binding();
  if (
    binding.sessionId !== sessionID ||
    binding.purpose !== "mutation" ||
    binding.runId !== "" ||
    binding.databaseIdentity !== runtimeDatabaseIdentity(sessionDir)
  ) {
    throw new RuntimeLeaseLostError();
  }
  const dbPath = resolveDBPath(cleanPath);
  const db = cachedDB(dbPath);
  db.runInTx((tx) => {
    validateRuntimeLeaseBindingTx(tx, sessionDir, sessionID, "", "mutation");
    deleteSessionDataTx(tx, sessionID);
  });
  removeSessionHandle(cleanPath);
}

/** Normalized SQLite identity used to scope process registries. */
function runtimeDatabaseIdentity(sessionDir: string): string {
  return path.resolve(path.normalize(path.join(sessionDir, "sessions.db")));
}

function removeSessionHandle(pathValue: string): void {
  try {
    Deno.statSync(pathValue);
    Deno.removeSync(pathValue);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
