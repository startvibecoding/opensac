// Bounded user-pattern line matching, hardened for the Go → TS migration
// hazard of `regexp` (see regex_worker.js).
//
// `compileUserRegExp` blocks the known catastrophic shapes, but shape
// screening is defense in depth, not a proof: a pattern such as `(a|a)+$`
// passes the screen and still backtracks exponentially against one long line.
// `UserRegExpMatcher` runs every match request inside a worker under a
// wall-clock budget: a runaway pattern is interrupted by terminating the
// worker and surfaces as `RegExpMatchTimeoutError` instead of hanging the
// event loop (the caller can then fall back to a literal search).

import { regexWorkerSource as workerSource } from "./regex_worker_source.ts";

import { UserRegExpError } from "./regex.ts";

/** Lines sent to the matching worker per request. */
export const userRegExpMatchChunkLines = 512;

/** Wall-clock budget for one matching-worker request. */
export const userRegExpMatchBudgetMs = 5000;

/** Reports a match request that outran its wall-clock budget. */
export class RegExpMatchTimeoutError extends Error {
  constructor() {
    super("regex matching timed out");
    this.name = "RegExpMatchTimeoutError";
  }
}

/** A bounded line matcher for one compiled pattern. */
export interface UserRegExpMatcher {
  /**
   * Returns the indices of `lines` that contain a match. Indices are local to
   * the supplied slice and strictly increasing.
   */
  match(lines: readonly string[]): Promise<number[]>;
  /** Terminates the matching worker. Safe to call more than once. */
  close(): void;
}

/** Options for {@link createUserRegExpMatcher}. */
export interface UserRegExpMatcherOptions {
  /** Wall-clock budget per request. Defaults to {@link userRegExpMatchBudgetMs}. */
  timeoutMs?: number;
  /** Lines per request. Defaults to {@link userRegExpMatchChunkLines}. */
  chunkLines?: number;
  /** Cancels in-flight matching when aborted. */
  signal?: AbortSignal;
}

const workerUrl =
  "data:application/javascript," + encodeURIComponent(workerSource);

interface PendingRequest {
  id: number;
  resolve: (matched: number[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Creates a matcher that runs `pattern` inside a bounded worker. The pattern
 * is compiled once per worker request exactly like `new RegExp`; the caller is
 * expected to have screened it with `compileUserRegExp` first.
 */
export function createUserRegExpMatcher(
  pattern: string,
  flags = "",
  options: UserRegExpMatcherOptions = {},
): UserRegExpMatcher {
  return new WorkerUserRegExpMatcher(pattern, flags, options);
}

class WorkerUserRegExpMatcher implements UserRegExpMatcher {
  #pattern: string;
  #flags: string;
  #timeoutMs: number;
  #chunkLines: number;
  #signal: AbortSignal | undefined;
  #worker: Worker | null = null;
  #pending: PendingRequest | null = null;
  #nextID = 1;
  #failure: Error | null = null;
  #closed = false;
  #onAbort: (() => void) | null = null;

  constructor(
    pattern: string,
    flags: string,
    options: UserRegExpMatcherOptions,
  ) {
    this.#pattern = pattern;
    this.#flags = flags;
    this.#timeoutMs = options.timeoutMs ?? userRegExpMatchBudgetMs;
    this.#chunkLines = Math.max(
      1,
      options.chunkLines ?? userRegExpMatchChunkLines,
    );
    this.#signal = options.signal;
    if (this.#signal !== undefined) {
      this.#onAbort = () => this.#failPending(abortError());
      this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  async match(lines: readonly string[]): Promise<number[]> {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new Error("regex matcher is closed");
    if (this.#signal?.aborted === true) throw abortError();
    const matched: number[] = [];
    for (let offset = 0; offset < lines.length; offset += this.#chunkLines) {
      const chunk = lines.slice(offset, offset + this.#chunkLines);
      const indices = await this.#request(chunk);
      for (const index of indices) matched.push(offset + index);
    }
    return matched;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#onAbort !== null) {
      this.#signal?.removeEventListener("abort", this.#onAbort);
      this.#onAbort = null;
    }
    this.#failPending(new Error("regex matcher is closed"));
    this.#terminate();
  }

  #request(lines: string[]): Promise<number[]> {
    const worker = this.#ensureWorker();
    const id = this.#nextID++;
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#failPending(new RegExpMatchTimeoutError());
      }, this.#timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      worker.postMessage({
        id,
        pattern: this.#pattern,
        flags: this.#flags,
        lines,
      });
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker !== null) return this.#worker;
    const worker = new Worker(workerUrl, { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const pending = this.#pending;
      if (pending === null || event.data.id !== pending.id) return;
      this.#settlePending();
      const data = event.data as
        | { id: number; ok: true; matched: number[] }
        | { id: number; ok: false; error: string };
      if (data.ok) {
        pending.resolve(data.matched);
      } else {
        const err = new UserRegExpError(`invalid regex: ${data.error}`);
        this.#failure = err;
        this.#terminate();
        pending.reject(err);
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || "regex matching failed");
      this.#failure = err;
      this.#terminate();
      const pending = this.#pending;
      if (pending !== null) {
        this.#settlePending();
        pending.reject(err);
      }
    };
    this.#worker = worker;
    return worker;
  }

  #failPending(err: Error): void {
    const pending = this.#pending;
    if (pending === null) return;
    if (err instanceof RegExpMatchTimeoutError || err.name === "AbortError") {
      this.#failure = this.#failure ?? err;
      this.#terminate();
    }
    this.#settlePending();
    pending.reject(err);
  }

  #settlePending(): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
  }

  #terminate(): void {
    this.#pending = null;
    if (this.#worker !== null) {
      this.#worker.onmessage = null;
      this.#worker.onerror = null;
      this.#worker.terminate();
      this.#worker = null;
    }
  }
}

function abortError(): Error {
  const err = new Error("regex matching aborted");
  err.name = "AbortError";
  return err;
}
