// Ported from internal/serve/openaiapi/run_manager.go (the RunManager, the
// Server-bound GetRun/CancelRun, and the unified FinalizeRun finalizer).
//
// Deviations: Go's sync.RWMutex/sync.Once map to plain fields because Deno is
// single-threaded and these methods are synchronous; the per-run subscriber
// `chan agent.Event` becomes a bounded RunEventStream whose `offer` drops on
// overflow exactly like Go's non-blocking channel send; `Start` consumes an
// `AsyncIterable<Event>` in a detached async task instead of a goroutine;
// Go's `(value, error)` pairs throw typed errors (matching the session_read
// convention); `timePtr` is dropped as a Go-only constructor helper.

import type { Event } from "../../agent/events.ts";
import {
  createDurableRun,
  finishDurableRun,
  updateDurableRun,
} from "../../agentruntime/durable_ops.ts";
import type { DurableRun } from "../../agentruntime/run_store.ts";
import {
  getActiveDurableRun,
  getDurableRun,
} from "../../agentruntime/run_queries.ts";
import {
  recoverOrphanedRuns,
  RecoveryFailLocal,
  RecoveryKeepRemote,
} from "../../agentruntime/run_recovery.ts";
import {
  type RunState,
  RunStateCancelled,
  RunStateCancelling,
  RunStateCompleted,
  RunStateFailed,
  RunStateIncomplete,
  RunStateTimedOut,
} from "../../agentruntime/run_state.ts";
import {
  SessionStopAccepted,
  SessionStopNoActiveRun,
  SessionStopRecoveryStarted,
  SessionStopRemoteAccepted,
  SessionStopTargetChanged,
} from "../../agentruntime/execution_stop.ts";
import type { SessionRun } from "../../session/run_store.ts";
import { isNonTerminalSessionRunStatus } from "../../session/run_status.ts";
import { getSessionDir } from "../../config/settings.ts";
import { clearSessionApprovalsForRun } from "./approval.ts";
import { publishSessionRuntimeForSession } from "./session_runtime_snapshot.ts";
import { publishSessionStreamDone } from "./session_stream.ts";
import { requestSessionStop } from "./session_stop.ts";
import { APISession, ErrSessionNotFound } from "./session_mgr.ts";
import type { Server } from "./server.ts";

const runEventBuffer = 128;

/**
 * RunEventStream is the TS projection of Go's `<-chan agent.Event` run
 * subscription: a bounded async queue whose `next()` resolves with the next
 * event, or `done` once the run finished and the buffered events are drained.
 * `offer` mirrors Go's non-blocking send: a full buffer drops the event.
 */
export class RunEventStream {
  #queue: Event[] = [];
  #waiters: ((result: IteratorResult<Event>) => void)[] = [];
  #closed = false;

  /** Non-blocking send used by RunManager.Publish. Returns false when full. */
  offer(ev: Event): boolean {
    if (this.#closed || this.#queue.length >= runEventBuffer) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.#queue.push(ev);
    return true;
  }

  /** Closes the subscription; buffered events remain readable. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      waiter({ value: undefined as unknown as Event, done: true });
    }
  }

  next(): Promise<IteratorResult<Event>> {
    const buffered = this.#queue.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({
        value: undefined as unknown as Event,
        done: true,
      });
    }
    return new Promise<IteratorResult<Event>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return { next: () => this.next() };
  }
}

class RunEventSubscription {
  readonly stream = new RunEventStream();
  #removed = false;

  get removed(): boolean {
    return this.#removed;
  }

  markRemoved(): void {
    this.#removed = true;
  }
}

/** managedRun tracks one in-memory run: its cancel func, subscribers, and hook. */
class ManagedRun {
  readonly id: string;
  readonly sessionId: string;
  cancel: (() => void) | null = null;
  subs = new Map<RunEventSubscription, void>();
  hook: ((ev: Event) => void) | null = null;
  finalizedOnce = false;

  constructor(id: string, sessionId: string) {
    this.id = id;
    this.sessionId = sessionId;
  }
}

export class RunManager {
  readonly #sessionDir: string;
  readonly #runs = new Map<string, ManagedRun>();
  readonly #finalized = new Set<string>();

  constructor(sessionDir: string) {
    this.#sessionDir = sessionDir;
  }

  /**
   * create is a compatibility bridge for legacy embedded fixtures. Production
   * handlers must admit Runs through ExecutionRuntime.BeginDurable or
   * BeginIntentDurable, then call register only for in-memory fan-out.
   */
  create(run: SessionRun): void {
    if (!run) throw new Error("run manager is nil");
    const durable: DurableRun = {
      id: run.id,
      sessionId: run.sessionId,
      intentId: "",
      retryOf: "",
      attempt: 0,
      workDir: run.workDir,
      source: run.source,
      model: run.model,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      errorInfo: {},
      progress: {},
      usage: run.usage,
      contextUsage: run.contextUsage,
      inputResourceIds: [],
      submissionKeyHash: "",
      submissionScope: "",
      submissionFingerprint: "",
      userEntryId: "",
      assistantEntryId: "",
      conversationTurnId: "",
      conversationTurn: false,
    };
    createDurableRun(this.#sessionDir, durable);
    this.#finalized.delete(run.id);
    this.#runs.set(run.id, new ManagedRun(run.id, run.sessionId));
  }

  /**
   * register adds an in-memory run entry without persisting the canonical row.
   * ExecutionRuntime owns durable row creation for migrated lifecycle paths.
   */
  register(run: SessionRun): void {
    if (!run || run.id === "" || run.sessionId === "") {
      throw new Error("run ID and session ID are required");
    }
    this.#finalized.delete(run.id);
    this.#runs.set(run.id, new ManagedRun(run.id, run.sessionId));
  }

  attach(runId: string, sessionId: string, cancel: () => void): void {
    if (runId === "" || sessionId === "") {
      throw new Error("run ID and session ID are required");
    }
    let run = this.#runs.get(runId);
    if (!run) {
      run = new ManagedRun(runId, sessionId);
      this.#runs.set(runId, run);
    }
    run.cancel = cancel;
  }

  #closeSubscribers(run: ManagedRun | undefined): void {
    if (!run) return;
    for (const sub of run.subs.keys()) {
      sub.stream.close();
    }
    run.subs = new Map();
  }

  start(runId: string, events: AsyncIterable<Event>): void {
    if (runId === "" || !events) {
      throw new Error("run ID and event stream are required");
    }
    if (!this.#runs.has(runId)) {
      throw new Error(`run ${JSON.stringify(runId)} is not active`);
    }
    void (async () => {
      for await (const ev of events) {
        this.publish(runId, ev);
      }
      const run = this.#runs.get(runId);
      if (run) this.#closeSubscribers(run);
    })();
  }

  subscribe(runId: string): { events: RunEventStream; cancel: () => void } {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run ${JSON.stringify(runId)} is not active`);
    const sub = new RunEventSubscription();
    run.subs.set(sub, undefined);
    const cancel = () => {
      if (sub.removed) return;
      sub.markRemoved();
      const current = this.#runs.get(runId);
      if (current) current.subs.delete(sub);
    };
    return { events: sub.stream, cancel };
  }

  setHook(runId: string, hook: ((ev: Event) => void) | null): void {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`run ${JSON.stringify(runId)} is not active`);
    run.hook = hook;
  }

  publish(runId: string, ev: Event): void {
    const run = this.#runs.get(runId);
    if (run?.hook) run.hook(ev);
    for (const sub of run?.subs.keys() ?? []) {
      sub.stream.offer(ev);
    }
  }

  /**
   * cancel is retained for legacy embedded callers. Serve protocol handlers
   * use the Runtime stop matrix so external ownership and target Run fencing
   * are preserved.
   */
  cancel(runId: string): boolean {
    // Check if the run exists in the database first.
    let run: SessionRun | null = null;
    try {
      run = getDurableRun(this.#sessionDir, runId);
    } catch {
      return false;
    }
    if (!run) return false;
    // If the run is already in a terminal state, don't cancel.
    if (
      run.status === "completed" || run.status === "incomplete" ||
      run.status === "expired" || run.status === "failed" ||
      run.status === "cancelled"
    ) {
      return false;
    }
    const mr = this.#runs.get(runId);
    if (mr?.cancel) mr.cancel();
    // Even if no in-memory cancel func, update the DB status.
    // This handles the case where the run exists only in DB (e.g. after server restart).
    try {
      updateDurableRun(
        this.#sessionDir,
        runId,
        RunStateCancelling,
        "run cancellation requested",
      );
    } catch {
      // Go ignores the update error (`_ =`).
    }
    return true;
  }

  /**
   * finish is a compatibility bridge for non-durable embedded finalizers.
   * Durable production Runs finish through ExecutionRuntime.FinishDurable.
   */
  finish(runId: string, status: string, message: string): void {
    finishDurableRun(
      this.#sessionDir,
      runId,
      runStateFromStatus(status),
      message,
    );
    const run = this.#runs.get(runId);
    if (run) {
      this.#closeSubscribers(run);
      this.#runs.delete(runId);
    }
  }

  /**
   * finalizeOnce executes fn exactly once for the given run.
   * Returns true if fn was executed, false if it was already called for this
   * run or if the run does not exist in the memory map.
   */
  finalizeOnce(runId: string, fn: () => void): boolean {
    if (this.#finalized.has(runId)) return false;
    let run = this.#runs.get(runId);
    // If the run is not in memory (e.g. it was created by a different process
    // or the map was cleaned), create a temporary entry for idempotency.
    if (!run) {
      run = new ManagedRun(runId, "");
      const existing = this.#runs.get(runId);
      if (existing) run = existing;
      else this.#runs.set(runId, run);
    }
    if (run.finalizedOnce) return false;
    run.finalizedOnce = true;
    this.#finalized.add(runId);
    fn();
    return true;
  }

  /**
   * recoverOrphanedRuns scans the database for runs that are still in a
   * non-terminal state after a server restart and marks them as failed. This
   * must be called once during server startup.
   * recoverOrphanedRuns is retained for older startup integrations; the Serve
   * server now owns a Runtime RecoveryCoordinator instead.
   */
  recoverOrphanedRuns(): Promise<void> {
    return this.recoverOrphanedRunsExcept(null);
  }

  /**
   * recoverOrphanedRunsExcept marks orphaned local executions as failed unless
   * skip identifies a run whose lifecycle is owned by another durable runtime.
   */
  async recoverOrphanedRunsExcept(
    skip: ((run: SessionRun) => boolean) | null,
  ): Promise<void> {
    const policy = skip
      ? (run: SessionRun) => skip(run) ? RecoveryKeepRemote : RecoveryFailLocal
      : undefined;
    await recoverOrphanedRuns(this.#sessionDir, policy ?? null, null);
  }

  /**
   * get is a compatibility query for legacy fixtures. Production code uses the
   * agentruntime durable query boundary directly.
   */
  get(runId: string): SessionRun | null {
    return getDurableRun(this.#sessionDir, runId);
  }

  /**
   * active is a compatibility query for legacy fixtures. Production ownership
   * decisions use InspectSessionExecution.
   */
  active(sessionId: string): SessionRun | null {
    return getActiveDurableRun(this.#sessionDir, sessionId);
  }
}

/** runStateFromStatus maps a legacy run status string to a canonical RunState. */
export function runStateFromStatus(status: string): RunState {
  const value = (status ?? "").trim().toLowerCase();
  switch (value) {
    case "completed":
      return RunStateCompleted;
    case "incomplete":
      return RunStateIncomplete;
    case "cancelled":
    case "canceled":
      return RunStateCancelled;
    case "timed_out":
    case "timeout":
    case "expired":
      return RunStateTimedOut;
    default:
      return RunStateFailed;
  }
}

/** getRun projects the Server's canonical Run lookup (Go's (*Server).GetRun). */
export function getRun(server: Server, id: string): SessionRun {
  if (!server || !server.settings || id === "") throw ErrSessionNotFound;
  const run = getDurableRun(getSessionDir(server.settings), id);
  if (!run) throw ErrSessionNotFound;
  return run;
}

/** cancelRun projects the Server's Run cancellation (Go's (*Server).CancelRun). */
export async function cancelRun(server: Server, id: string): Promise<void> {
  if (!server || !server.settings || id === "") throw ErrSessionNotFound;
  const run = getDurableRun(getSessionDir(server.settings), id);
  if (!run) throw ErrSessionNotFound;
  const { result, err } = await requestSessionStop(
    server,
    run.sessionId,
    run.id,
  );
  if (err) throw err;
  switch (result.code) {
    case SessionStopAccepted:
    case SessionStopRemoteAccepted:
    case SessionStopRecoveryStarted:
      return;
    case SessionStopNoActiveRun:
      throw ErrSessionNotFound;
    case SessionStopTargetChanged:
      throw ErrSessionNotFound;
    default:
      throw new Error(`run cancellation rejected: ${result.code}`);
  }
}

/**
 * finalizeRun is the unified, idempotent finalizer for any run exit path.
 * It must be called exactly once per run: from the handler defer, from
 * stop/cancel, or from the RunExecutor completion path.
 *
 * It performs:
 *  1. Mark run as terminalizing in APISession
 *  2. Clear pending approvals for this run
 *  3. Finish run in APISession (release in-memory state)
 *  4. Update RunManager persistent state
 *  5. Publish final runtime snapshot
 *  6. Publish stream done event
 */
export function finalizeRun(
  server: Server,
  sess: APISession | null,
  runId: string,
  status: string,
  errMsg: string,
): void {
  if (!server || !sess || runId === "") return;
  // The Runtime terminal observer may clear the adapter's in-memory durable
  // marker before this projection callback runs. Recover the durable identity
  // from the canonical Run row so a committed Run can never fall through to
  // the legacy RunManager finalizer and be moved back to terminalizing.
  let durable = sess.isDurableRun(runId);
  if (!durable && server.settings) {
    try {
      const run = getDurableRun(getSessionDir(server.settings), runId);
      if (run && !isNonTerminalSessionRunStatus(run.status)) {
        durable = true;
        sess.markDurableRun(runId);
      }
    } catch {
      // Go ignores the lookup error and keeps the legacy path.
    }
  }
  if (durable) {
    // Durable persistence is authoritative. A failed FinishDurable attempt
    // deliberately leaves the Run active and retryable; consuming FinalizeOnce
    // or clearing adapter state here would recreate the cross-process split
    // brain this lifecycle is designed to prevent.
    if (server.settings) {
      let run: SessionRun | null = null;
      try {
        run = getDurableRun(getSessionDir(server.settings), runId);
      } catch {
        run = null;
      }
      if (!run || isNonTerminalSessionRunStatus(run.status)) {
        publishSessionRuntimeForSession(server, sess);
        return;
      }
      const execution = sess.executionRuntime();
      if (execution) {
        const { runId: activeID, active } = execution.active();
        if (active && activeID === runId) {
          publishSessionRuntimeForSession(server, sess);
          return;
        }
      }
    }
  }
  // Use finalizeOnce to ensure the finalization logic runs at most once per run.
  if (server.runManager) {
    server.runManager.finalizeOnce(runId, () => {
      finalizeRunInternal(server, sess, runId, status, errMsg);
    });
  } else {
    finalizeRunInternal(server, sess, runId, status, errMsg);
  }
}

function finalizeRunInternal(
  server: Server,
  sess: APISession,
  runId: string,
  status: string,
  errMsg: string,
): void {
  // 1. Mark terminalizing
  sess.markRunTerminalizing(runId);
  // 2. Clear pending approvals
  clearSessionApprovalsForRun(
    server,
    sess,
    runId,
    "cancelled",
    "run ended before the approval was resolved",
  );
  // 3. Release in-memory run state
  sess.finishRun(runId);
  // 4. Persist terminal state
  if (server.runManager && !sess.isDurableRun(runId)) {
    try {
      server.runManager.finish(runId, status, errMsg);
    } catch {
      // Go ignores the finish error (`_ =`).
    }
  }
  if (sess.isDurableRun(runId)) {
    sess.clearDurableRun(runId);
  }
  // 5. Publish final runtime snapshot
  publishSessionRuntimeForSession(server, sess);
  // 6. Publish stream done
  publishSessionStreamDone(server, sess.id, runId, status);
  // Notify integrations only after the run and its terminal event are persisted.
  const observer = server.runComplete;
  if (observer) observer(sess.id, runId, status, errMsg);
}
