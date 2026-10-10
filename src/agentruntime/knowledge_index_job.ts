//
// KnowledgeIndexJob tracks one asynchronous scan/index pass. Scans always run
// as background tasks so neither the ACP transport nor any management RPC
// handler can be blocked by a long index; observers poll `progress` or await
// `wait`. The `KnowledgeBaseService.StartIndex`/`IndexJob`/`IndexProgress`
// methods live in `knowledgebase.ts` because TypeScript requires one class body
// per module.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; Go's
// `<-chan struct{}` completion signal maps to a Promise exposed by `done()`.

import { type KnowledgeSnapshot } from "../session/mod.ts";

/** Thrown when the knowledge-base service is unavailable. */
export class KnowledgeBaseServiceMissingError extends Error {
  override name = "KnowledgeBaseServiceMissingError";
  constructor() {
    super("knowledge base service is required");
  }
}

export function knowledgeBaseDisabledError(id: string): Error {
  return new Error(`knowledge base ${id} is disabled`);
}

/**
 * Knowledge indexing phases projected to management surfaces. They describe
 * where a background scan currently is; callers poll them periodically and
 * never block a transport while a scan runs.
 */
export const KNOWLEDGE_INDEX_PHASE_SCANNING = "scanning";
export const KNOWLEDGE_INDEX_PHASE_INDEXING = "indexing";
export const KNOWLEDGE_INDEX_PHASE_ENRICHING = "enriching";
export const KNOWLEDGE_INDEX_PHASE_COMMITTING = "committing";

/** A point-in-time view of one background index job. */
export interface KnowledgeIndexProgress {
  running: boolean;
  phase?: string;
  filesTotal: number;
  filesDone: number;
  chunks: number;
  startedAt?: Date;
  runId?: string;
  error?: string;
}

export class KnowledgeIndexJob {
  progress: KnowledgeIndexProgress;
  private snapshot: KnowledgeSnapshot;
  private err: Error | null;
  private finishedFlag: boolean;
  private readonly waiters: Array<() => void> = [];

  constructor(
    snapshot: KnowledgeSnapshot,
    progress: KnowledgeIndexProgress,
  ) {
    this.snapshot = snapshot;
    this.err = null;
    this.finishedFlag = false;
    this.progress = progress;
  }

  /** Returns a consistent copy of the current progress view. */
  viewProgress(): KnowledgeIndexProgress {
    return { ...this.progress };
  }

  /** Whether the job has reached its terminal state. */
  get finished(): boolean {
    return this.finishedFlag;
  }

  /** Awaits job completion. The returned promise never rejects. */
  done(): Promise<void> {
    if (this.finishedFlag) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Waits until the job finishes or the signal aborts. Cron job execution uses
   * the terminal result; interactive callers return immediately after
   * `StartIndex` and poll `progress` instead.
   */
  async wait(ctx?: AbortSignal): Promise<KnowledgeSnapshot> {
    if (ctx?.aborted) {
      throw abortReason(ctx);
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(abortReason(ctx!));
      };
      const wrapped = () => {
        ctx?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(wrapped);
      if (ctx !== undefined) {
        ctx.addEventListener("abort", onAbort, {
          once: true,
        });
      }
    });
    if (this.err !== null) throw this.err;
    return this.snapshot;
  }

  update(fn: (progress: KnowledgeIndexProgress) => void): void {
    fn(this.progress);
  }

  finish(snapshot: KnowledgeSnapshot, err: Error | null): void {
    if (this.finishedFlag) return;
    this.finishedFlag = true;
    this.snapshot = snapshot;
    this.err = err;
    this.progress.running = false;
    if (err !== null) this.progress.error = err.message;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

export function createKnowledgeIndexJob(): KnowledgeIndexJob {
  return new KnowledgeIndexJob(emptyKnowledgeSnapshot(), {
    running: true,
    filesTotal: 0,
    filesDone: 0,
    chunks: 0,
    startedAt: new Date(),
  });
}

function emptyKnowledgeSnapshot(): KnowledgeSnapshot {
  return {
    id: "",
    knowledgeBaseId: "",
    runId: "",
    status: "",
    schemaVersion: 0,
    fileCount: 0,
    chunkCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    startedAt: new Date(0),
    finishedAt: undefined,
    errorSummary: "",
  };
}

function abortReason(ctx: AbortSignal): Error {
  const reason = ctx.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new DOMException("knowledge index aborted", "AbortError");
}
