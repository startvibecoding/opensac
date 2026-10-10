//
// FileStore persists workflow state as JSON files. `os.CreateTemp` +
// `os.Rename` map to `runtime.makeTempFile` + `runtime.rename`; `ctx.Err()` maps to
// `signal.aborted`. JSON dates revive back into `Date` objects on load.

import { runtime } from "../platform/runtime.ts";
import type { DirEntry } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import {
  type AgentResult,
  type PhaseState,
  type RunState,
  throwIfAborted,
  type WorkflowLog,
} from "./types.ts";

/** Persists workflow state as JSON files rooted at `dir`. */
export class FileStore {
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** Saves a run state atomically. Throws when the id is empty. */
  async save(state: RunState, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (state === null || state === undefined) {
      throw new Error("workflow state is required");
    }
    if (state.id === "") {
      throw new Error("workflow state id is required");
    }
    await runtime.mkdir(this.#dir, { recursive: true });
    const data = JSON.stringify(state, null, 2);
    const dest = this.#path(state.id);
    const tmp = await runtime.makeTempFile({
      dir: this.#dir,
      prefix: ".tmp-",
      suffix: ".json",
    });
    try {
      await runtime.writeTextFile(tmp, data);
      await runtime.chmod(tmp, 0o644);
      await runtime.rename(tmp, dest);
    } catch (err) {
      try {
        await runtime.remove(tmp);
      } catch {
        // Best effort cleanup.
      }
      throw err;
    }
  }

  /** Loads a run state by id. */
  async load(id: string, signal?: AbortSignal): Promise<RunState> {
    throwIfAborted(signal);
    id = id.trim();
    if (id === "") {
      throw new Error("workflow run id is required");
    }
    const data = await runtime.readTextFile(this.#path(id));
    return reviveRunState(JSON.parse(data) as Record<string, unknown>);
  }

  /** Lists persisted run states, newest first. */
  async list(signal?: AbortSignal): Promise<RunState[]> {
    throwIfAborted(signal);
    let entries: DirEntry[];
    try {
      entries = [];
      for await (const entry of runtime.readDir(this.#dir)) {
        entries.push(entry);
      }
    } catch (err) {
      if (err instanceof runtime.errors.NotFound) {
        return [];
      }
      throw err;
    }
    const states: RunState[] = [];
    for (const entry of entries) {
      if (entry.isDirectory || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const data = await runtime.readTextFile(
          path.join(this.#dir, entry.name),
        );
        states.push(
          reviveRunState(JSON.parse(data) as Record<string, unknown>),
        );
      } catch {
        continue;
      }
    }
    states.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return states;
  }

  #path(id: string): string {
    // Reject ids that could escape the store root.
    if (id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
      throw new Error(`invalid workflow run id ${JSON.stringify(id)}`);
    }
    return path.join(this.#dir, id + ".json");
  }
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

function reviveAgentResult(raw: Record<string, unknown>): AgentResult {
  return {
    ...(raw as unknown as AgentResult),
    startedAt: toDate(raw.startedAt),
    finishedAt:
      raw.finishedAt === undefined ? undefined : toDate(raw.finishedAt),
  };
}

function revivePhaseState(raw: Record<string, unknown>): PhaseState {
  return {
    ...(raw as unknown as PhaseState),
    startedAt: toDate(raw.startedAt),
    finishedAt:
      raw.finishedAt === undefined ? undefined : toDate(raw.finishedAt),
  };
}

function reviveLog(raw: Record<string, unknown>): WorkflowLog {
  return { ...(raw as unknown as WorkflowLog), time: toDate(raw.time) };
}

function reviveRunState(raw: Record<string, unknown>): RunState {
  const results: Record<string, AgentResult> = {};
  const rawResults = (raw.results ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawResults)) {
    results[key] = reviveAgentResult(value as Record<string, unknown>);
  }
  return {
    ...(raw as unknown as RunState),
    startedAt: toDate(raw.startedAt),
    updatedAt: toDate(raw.updatedAt),
    finishedAt:
      raw.finishedAt === undefined ? undefined : toDate(raw.finishedAt),
    phases: (raw.phases as unknown[] | undefined)?.map((p) =>
      revivePhaseState(p as Record<string, unknown>),
    ),
    logs: (raw.logs as unknown[] | undefined)?.map((l) =>
      reviveLog(l as Record<string, unknown>),
    ),
    results,
  };
}

/** Creates a file-backed workflow store rooted at `dir`. */
export function createFileStore(dir: string): FileStore {
  return new FileStore(dir);
}
