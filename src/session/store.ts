//
// The persistence-backend interface for session state plus the in-memory
// implementation used by tests. The SQLite-backed `Manager` (session.go) is
// still pending and will implement this interface.

import type { Message } from "../provider/types.ts";
import type {
  AdditionalDirectoriesEntry,
  CompactionEntry,
  Header,
  ModeChangeEntry,
  ModelChangeEntry,
  ThinkingLevelChangeEntry,
} from "./entry.ts";
import {
  entryAdditionalDirectories,
  entryCompaction,
  entryMessage,
  entryModeChange,
  entryModelChange,
  entrySession,
  entrySessionInfo,
  entryThinkingChange,
  generateID,
} from "./entry.ts";
import { buildReplayState, latestCompactionLocked } from "./replay.ts";
import type { ReplayState } from "./replay.ts";

/** The session entry-format version persisted in every Header. */
export const currentVersion = 3;

/**
 * The persistence-backend interface for one session. Alternative backends
 * (in-memory for testing, cloud storage, etc.) can implement Store to swap the
 * persistence layer without changing agent or UI code.
 */
export interface Store {
  /** Initializes the store, creating the underlying storage if needed. */
  init(): void;
  /** Initializes the store with a specific ID (empty generates a new one). */
  initWithID(id: string): void;
  /** Persists a conversation message and returns its entry ID. */
  appendMessage(msg: Message): string;
  /** Records a context compaction event. */
  appendCompaction(
    summary: string,
    firstKeptEntryID: string,
    tokensBefore: number,
  ): string;
  /** Records a model switch. */
  appendModelChange(providerName: string, modelID: string): string;
  /** Records a session execution mode change. */
  appendModeChange(mode: string): string;
  /** Records a thinking level change. */
  appendThinkingLevelChange(level: string): string;
  /** Records the complete ordered directory set granted to the session. */
  appendAdditionalDirectories(directories: string[]): string;
  /** Records session metadata. */
  appendSessionInfo(name: string): string;
  /** Returns all messages in the current branch, with compactions applied. */
  getMessages(): Message[];
  /** Returns the full replay state including messages and entry IDs. */
  getReplayState(): ReplayState;
  /** Returns the current leaf entry ID, or null when empty. */
  getLeafID(): string | null;
  /** Returns the most recent compaction entry, or `[zero, false]`. */
  getLatestCompaction(): [CompactionEntry, boolean];
  /** Returns the most recent persisted model binding. */
  getLatestModelChange(): [ModelChangeEntry, boolean];
  /** Returns the most recent persisted session mode. */
  getLatestModeChange(): [ModeChangeEntry, boolean];
  /** Returns the most recent persisted thinking level. */
  getLatestThinkingLevelChange(): [ThinkingLevelChangeEntry, boolean];
  /** Returns the most recent persisted additional-directories set. */
  getLatestAdditionalDirectories(): [AdditionalDirectoriesEntry, boolean];
  /** Returns the session file path (handle file for SQLite). */
  getFile(): string;
  /** Returns the session header with metadata. */
  getHeader(): Header | null;
}

interface StoredEntry {
  type: string;
  [key: string]: unknown;
}

/**
 * In-memory implementation of Store for testing. It does not persist data to
 * disk. The Go `sync.RWMutex` is unnecessary here because every method is
 * synchronous on Deno's single-threaded event loop.
 */
export class MemoryStore implements Store {
  #header: Header | null = null;
  #entries: StoredEntry[] = [];
  #leafID: string | null = null;
  #file = "";

  init(): void {
    this.#header = {
      type: entrySession,
      version: currentVersion,
      id: generateID(),
      timestamp: new Date(),
      cwd: "",
    };
  }

  initWithID(id: string): void {
    this.#header = {
      type: entrySession,
      version: currentVersion,
      id: id === "" ? generateID() : id,
      timestamp: new Date(),
      cwd: "",
    };
  }

  appendMessage(msg: Message): string {
    const id = generateID();
    this.#entries.push({
      type: entryMessage,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      message: msg,
    });
    this.#leafID = id;
    return id;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryID: string,
    tokensBefore: number,
  ): string {
    const id = generateID();
    this.#entries.push({
      type: entryCompaction,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      summary,
      firstKeptEntryId: firstKeptEntryID,
      tokensBefore,
    });
    this.#leafID = id;
    return id;
  }

  appendModelChange(providerName: string, modelID: string): string {
    const id = generateID();
    this.#entries.push({
      type: entryModelChange,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      provider: providerName,
      modelId: modelID,
    });
    this.#leafID = id;
    return id;
  }

  appendModeChange(mode: string): string {
    const id = generateID();
    this.#entries.push({
      type: entryModeChange,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      mode,
    });
    this.#leafID = id;
    return id;
  }

  appendThinkingLevelChange(level: string): string {
    const id = generateID();
    this.#entries.push({
      type: entryThinkingChange,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      thinkingLevel: level,
    });
    this.#leafID = id;
    return id;
  }

  appendAdditionalDirectories(directories: string[]): string {
    const id = generateID();
    this.#entries.push({
      type: entryAdditionalDirectories,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      directories: [...directories],
    });
    this.#leafID = id;
    return id;
  }

  appendSessionInfo(name: string): string {
    const id = generateID();
    this.#entries.push({
      type: entrySessionInfo,
      id,
      parentId: this.#leafID,
      timestamp: new Date(),
      name,
    });
    this.#leafID = id;
    return id;
  }

  getMessages(): Message[] {
    return this.getReplayState().messages;
  }

  getReplayState(): ReplayState {
    return buildReplayState(this.#entries);
  }

  getLeafID(): string | null {
    return this.#leafID;
  }

  getLatestCompaction(): [CompactionEntry, boolean] {
    return latestCompactionLocked(this.#entries);
  }

  getLatestModelChange(): [ModelChangeEntry, boolean] {
    return this.latestByType<ModelChangeEntry>(entryModelChange);
  }

  getLatestModeChange(): [ModeChangeEntry, boolean] {
    return this.latestByType<ModeChangeEntry>(entryModeChange);
  }

  getLatestThinkingLevelChange(): [ThinkingLevelChangeEntry, boolean] {
    return this.latestByType<ThinkingLevelChangeEntry>(entryThinkingChange);
  }

  getLatestAdditionalDirectories(): [AdditionalDirectoriesEntry, boolean] {
    const [entry, ok] = this.latestByType<AdditionalDirectoriesEntry>(
      entryAdditionalDirectories,
    );
    if (!ok) return [entry, false];
    return [{ ...entry, directories: [...entry.directories] }, true];
  }

  getFile(): string {
    return this.#file;
  }

  getHeader(): Header | null {
    return this.#header;
  }

  private latestByType<T>(type: string): [T, false] | [T, true] {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i].type === type) {
        return [this.#entries[i] as unknown as T, true];
      }
    }
    return [undefined as unknown as T, false];
  }
}
