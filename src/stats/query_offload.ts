// Stats query execution placement for the usage dashboard.
//
// The stats aggregates (`GROUP BY` over the unbounded `request_stats` table)
// measured 124–258ms at 200k rows in the P3 baseline (§3.7-2), and the TUI
// runs the dashboard server in-process, so a slow aggregate stalls streaming
// and lease heartbeats on the same event loop. `createStatsQueryExecutor`
// moves the offline scan into a worker thread; `createInlineStatsQueryExecutor`
// keeps the pre-offload in-process behavior for the one-shot `--cli` mode and
// as the availability fallback.
//
// Both placements run the same `stats.DB` queries over the same `StatsDAO`
// (see stats_call.ts): execution placement is the only difference, so results
// and error shapes are identical. A transport-level worker failure — spawn
// error, crash, or wall-clock timeout — routes the call (and every later call)
// to the in-process executor, mirroring AGENTS.md's availability stance for
// recoverable failures. A query failure surfaces unchanged in both placements.

import { runStatsCall, type StatsCall } from "./stats_call.ts";
import type { Aggregate, DB, Query, RecentPage, Summary } from "./stats.ts";

/** Per-call wall-clock budget for one worker request. */
export const statsQueryTimeoutMs = 30_000;

/**
 * A query failure (bad filter, broken SQL) that must surface exactly like the
 * in-process error instead of triggering the transport fallback.
 */
export class StatsQueryError extends Error {
  override name = "StatsQueryError";
}

/** The worker-side port used by {@link createStatsQueryExecutor}. */
export interface StatsQueryWorkerPort {
  postMessage(value: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** Executes dashboard stats queries, possibly off the main event loop. */
export interface StatsQueryExecutor {
  summary(query: Query): Promise<Summary>;
  timeSeries(query: Query): Promise<Aggregate[]>;
  byProvider(query: Query): Promise<Aggregate[]>;
  byModel(query: Query): Promise<Aggregate[]>;
  recentFiltered(
    query: Query,
    page: number,
    pageSize: number,
  ): Promise<RecentPage>;
  /** Releases worker resources. Safe to call more than once. */
  close(): void;
}

/** Options for {@link createStatsQueryExecutor}. */
export interface StatsQueryExecutorOptions {
  /** Worker factory (tests inject failing or silent workers). */
  spawnWorker?: () => StatsQueryWorkerPort;
  /** Per-call wall-clock budget. Defaults to {@link statsQueryTimeoutMs}. */
  timeoutMs?: number;
}

/** Runs `fn` deferred, converting synchronous throws into rejections. */
function settled<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn);
}

/** Executes every query in-process on the shared connection. */
export function createInlineStatsQueryExecutor(db: DB): StatsQueryExecutor {
  return {
    summary: (query) => settled(() => db.summary(query)),
    timeSeries: (query) => settled(() => db.timeSeries(query)),
    byProvider: (query) => settled(() => db.byProvider(query)),
    byModel: (query) => settled(() => db.byModel(query)),
    recentFiltered: (query, page, pageSize) =>
      settled(() => db.recentFiltered(query, page, pageSize)),
    close: () => {},
  };
}

const defaultWorkerFactory = (): StatsQueryWorkerPort =>
  new Worker(new URL("./stats_worker.ts", import.meta.url), { type: "module" });

/**
 * Creates an executor that runs queries in a worker thread and falls back to
 * the in-process executor whenever the worker cannot serve a call.
 */
export function createStatsQueryExecutor(
  db: DB,
  options: StatsQueryExecutorOptions = {},
): StatsQueryExecutor {
  return new WorkerStatsQueryExecutor(db, options);
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

class WorkerStatsQueryExecutor implements StatsQueryExecutor {
  #db: DB;
  #fallback: StatsQueryExecutor;
  #spawnWorker: () => StatsQueryWorkerPort;
  #timeoutMs: number;
  #worker: StatsQueryWorkerPort | null = null;
  #pending = new Map<number, PendingRequest>();
  #nextID = 1;
  #disabled = false;
  #closed = false;

  constructor(db: DB, options: StatsQueryExecutorOptions) {
    this.#db = db;
    this.#fallback = createInlineStatsQueryExecutor(db);
    this.#spawnWorker = options.spawnWorker ?? defaultWorkerFactory;
    this.#timeoutMs = options.timeoutMs ?? statsQueryTimeoutMs;
  }

  summary(query: Query): Promise<Summary> {
    return this.#dispatch({ method: "summary", query }) as Promise<Summary>;
  }

  timeSeries(query: Query): Promise<Aggregate[]> {
    return this.#dispatch({ method: "timeSeries", query }) as Promise<
      Aggregate[]
    >;
  }

  byProvider(query: Query): Promise<Aggregate[]> {
    return this.#dispatch({ method: "byProvider", query }) as Promise<
      Aggregate[]
    >;
  }

  byModel(query: Query): Promise<Aggregate[]> {
    return this.#dispatch({ method: "byModel", query }) as Promise<Aggregate[]>;
  }

  recentFiltered(
    query: Query,
    page: number,
    pageSize: number,
  ): Promise<RecentPage> {
    return this.#dispatch({
      method: "recentFiltered",
      query,
      page,
      pageSize,
    }) as Promise<RecentPage>;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("stats query executor is closed"));
    this.#terminate();
    this.#fallback.close();
  }

  async #dispatch(call: StatsCall): Promise<unknown> {
    if (this.#closed || this.#disabled) return await this.#inline(call);
    try {
      return await this.#request(call);
    } catch (err) {
      if (err instanceof StatsQueryError) throw err;
      // Spawn error, worker crash, or timeout: serve this and every later call
      // in-process. The fallback runs the same query, so behavior is unchanged
      // and a flaky worker cannot repeatedly stall requests.
      this.#disabled = true;
      this.#terminate();
      return await this.#inline(call);
    }
  }

  #inline(call: StatsCall): Promise<unknown> {
    return settled(() => runStatsCall(this.#db, call));
  }

  #request(call: StatsCall): Promise<unknown> {
    const worker = this.#ensureWorker();
    const id = this.#nextID++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.reject(new Error("stats query timed out"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, dbPath: this.#db.database.db?.path, call });
    });
  }

  #ensureWorker(): StatsQueryWorkerPort {
    if (this.#worker !== null) return this.#worker;
    const worker = this.#spawnWorker();
    worker.onmessage = (event: MessageEvent) => {
      // Wire decode of the worker reply (self-produced data, js.ts precedent).
      const data = event.data as
        | { id: number; ok: true; result: unknown }
        | { id: number; ok: false; phase?: string; error: string };
      const pending = this.#pending.get(data.id);
      if (pending === undefined) return;
      this.#pending.delete(data.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (data.ok) {
        pending.resolve(data.result);
      } else if (data.phase === "query") {
        pending.reject(new StatsQueryError(data.error));
      } else {
        pending.reject(new Error(data.error));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      this.#failAll(new Error(event.message || "stats query worker failed"));
    };
    this.#worker = worker;
    return worker;
  }

  #failAll(err: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  #terminate(): void {
    if (this.#worker !== null) {
      this.#worker.onmessage = null;
      this.#worker.onerror = null;
      this.#worker.terminate();
      this.#worker = null;
    }
  }
}
