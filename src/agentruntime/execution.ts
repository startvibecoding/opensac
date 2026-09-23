// execution_persistence.go, execution_observation.go, and
//
// `ExecutionRuntime` owns the adapter-neutral active run state for one session.
// When configured with a `DurableRunStore` and `RunEventSink` it also owns the
// canonical durable transitions; adapters provide those storage implementations
// plus protocol event projection and any compatibility admission lock.
//
// Deviations from Go: `context.Context` maps to `AbortSignal`, the
// `chan struct{}` completion signal maps to a small `Done` handle, `sync.Mutex`
// is unnecessary because Deno's event loop runs the synchronous store/DAO
// methods without interleaving (the Go `TryLock` fast path therefore always
// succeeds), `json.RawMessage` maps to decoded `unknown`, `time.Time` maps to
// `Date`, `time.Duration` maps to milliseconds, and Go's `(value, error)` pairs
// throw instead.

import type { Message } from "../provider/types.ts";
import {
  type Event as AgentEvent,
  EVENT_COMPACTION_END,
  EVENT_COMPACTION_START,
  EVENT_CONTEXT_PRESSURE,
  EVENT_ERROR,
  EVENT_HOSTED_ITEM,
  EVENT_RETRY,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_APPROVAL_REQUEST,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
  TASK_CANCELED,
  TASK_INCOMPLETE,
  taskStatusIsSuccessful,
} from "../agent/events.ts";
import { readSessionExecutionFacts } from "../session/execution_facts.ts";
import {
  currentRuntimeLeaseBinding,
  type RuntimeLeaseBinding,
  RuntimeLeaseLostError,
  type RuntimeLeasePurpose,
  RuntimeLeaseRunMismatchError,
} from "../session/runtime_lock.ts";
import {
  type ExecutionIntent,
  type RuntimeLeaseSnapshot,
  type SessionRun,
} from "../session/mod.ts";
import { notifyRuntimeStateChanged } from "../session/runtime_lease_bus.ts";
import {
  runAssistantEntryID,
  runTerminalEventID,
} from "../session/run_user_message.ts";
import type { DeliveryPlan, OrderedDeliveryOperationPlan } from "./delivery.ts";
import {
  applyErrorDefaults,
  classifyError,
  diagnosticMessage,
  type ErrorClassificationOptions,
  type ErrorInfo,
  FAILURE_INCOMPLETE,
  PHASE_APPROVAL,
  PHASE_CONTEXT,
  PHASE_MODEL,
  PHASE_TERMINALIZATION,
  PHASE_TOOL,
  PHASE_TRANSPORT,
  RETRY_USER,
  type RetryInfo,
  retryModeForSafety,
  type RunPhase,
  SIDE_EFFECT_MUTATING,
  SIDE_EFFECT_NONE,
  SIDE_EFFECT_READ_ONLY,
  SIDE_EFFECT_UNKNOWN,
  type SideEffectState,
} from "./error_info.ts";
import { wakeRecoveryCoordinators } from "./recovery_coordinator.ts";
import {
  defaultRunRecoveryAction,
  RECOVERY_KEEP_REMOTE,
} from "./run_recovery.ts";
import {
  type RunEvent,
  type RunEventProjector,
  type RunEventSink,
  withAssistantEntryData,
  withRunAttemptData,
  withTerminalErrorInfo,
} from "./run_event.ts";
import {
  isTerminalRunState,
  RUN_STATE_CANCELLED,
  RUN_STATE_CANCELLING,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_INCOMPLETE,
  RUN_STATE_RUNNING,
  RUN_STATE_TERMINALIZING,
  RUN_STATE_TIMED_OUT,
  RUN_STATE_WAITING_APPROVAL,
  RUN_STATE_WAITING_QUESTION,
  type RunState,
} from "./run_state.ts";
import {
  type DurableConversationTurnEventFinisher,
  type DurableConversationTurnFinisher,
  type DurableIntentEventStore,
  type DurableIntentStore,
  type DurableRun,
  type DurableRunEventStore,
  type DurableRunMetadataStore,
  type DurableRunStore,
  type DurableRunUsageStore,
  type DurableTerminalPersistenceStore,
} from "./run_store.ts";

export const DEFAULT_TERMINAL_PERSISTENCE_TIMEOUT_MS = 10_000;
const terminalPersistenceRetryInitialMs = 50;
const terminalPersistenceRetryMaximumMs = 500;

/** The adapter-neutral lifecycle state of a session's execution ownership. */
export type SessionExecutionState = string;

export const SESSION_EXECUTION_IDLE: SessionExecutionState = "idle";
export const SESSION_EXECUTION_RESERVED: SessionExecutionState = "reserved";
export const SESSION_EXECUTION_LOCAL: SessionExecutionState = "local";
export const SESSION_EXECUTION_EXTERNAL: SessionExecutionState = "external";
export const SESSION_EXECUTION_DETACHED: SessionExecutionState =
  "detached_remote";
export const SESSION_EXECUTION_ORPHANED: SessionExecutionState = "orphaned";
export const SESSION_EXECUTION_RECOVERY_FAILED: SessionExecutionState =
  "recovery_failed";
export const SESSION_EXECUTION_INCONSISTENT: SessionExecutionState =
  "inconsistent";
export const SESSION_EXECUTION_UNKNOWN: SessionExecutionState = "unknown";

/** The canonical non-terminal Run projection carried by a snapshot. */
export interface SessionRunSummary {
  id: string;
  status: string;
  source: string;
  model: string;
  mode: string;
  startedAt: Date;
  updatedAt: Date;
}

/** The single Runtime-owned interpretation of the durable execution state. */
export interface SessionExecutionSnapshot {
  sessionId: string;
  sessionExists: boolean;
  activeRun?: SessionRunSummary;
  state: SessionExecutionState;
  phase: string;
  running: boolean;
  busy: boolean;
  canSubmit: boolean;
  canCancelLocal: boolean;
  canCancelRemote: boolean;
  leasePurpose: string;
  leaseEpoch: number;
  leaseExpiresAt?: Date;
  leaseOwnerInstanceId: string;
  leaseOwnerPid: number;
  leaseTokenIdentity: string;
  linkageState: string;
  recoveryAction: string;
  recoveryAttempt: number;
  recoveryLastError: string;
  recoveryNextAt?: Date;
  displayOwnerScope: string;
  remoteRunId: string;
  remoteProvider: string;
  remoteState: string;
}

/** The adapter-neutral result of consuming one Agent Core event. */
export interface AgentEventObservation {
  retry?: RetryInfo;
  error?: ErrorInfo;
}

interface ExecutionFacts {
  phase: RunPhase;
  sideEffects: SideEffectState;
  partialOutput: boolean;
  lastRetry: RetryInfo;
  lastRetryActive: boolean;
  lastError: ErrorInfo;
}

/**
 * The adapter-neutral active run state for one session. See the module header
 * for how Go's concurrency primitives are projected.
 */
export class ExecutionRuntime {
  runId = "";
  startedAt = new Date(0);
  ctx: AbortController | null = null;
  cancelFn: (() => void) | null = null;
  running: { abort(): void } | null = null;
  state: RunState = "";
  finished = false;
  events: RunEventSink | null = null;
  store: DurableRunStore | null = null;
  done: Done | null = null;
  durable: DurableRun | null = null;
  durablePersisted = false;
  startEvent: RunEvent = emptyRunEvent();
  terminalizing = false;
  terminalDone: Done | null = null;
  terminalErr: Error | null = null;
  terminalState: RunState = "";
  terminalMessage = "";
  terminalEvent: RunEvent = emptyRunEvent();
  terminalErrorInfo: ErrorInfo = {};
  terminalEventSet = false;
  terminalPrepared = false;
  terminalEventRecorded = false;
  facts: ExecutionFacts = {
    phase: PHASE_MODEL,
    sideEffects: SIDE_EFFECT_NONE,
    partialOutput: false,
    lastRetry: {},
    lastRetryActive: false,
    lastError: {},
  };
  leaseBinding: RuntimeLeaseBinding | null = null;
  leaseRelease: (() => void) | null = null;
  terminalObserver: ((runId: string, state: RunState) => void) | null = null;
  terminalRetryRunning = false;

  /**
   * Attaches a Runtime-planned outbox to the active durable Run. It must happen
   * before terminalization so the Run/turn/event and delivery rows are
   * committed by one store transaction.
   */
  setDeliveryPlan(runId: string, plan: DeliveryPlan): void {
    if (runId === "") {
      throw new Error("delivery plan Run ID is required");
    }
    if (
      !this.activeLocked(runId) || !this.durablePersisted ||
      this.durable === null
    ) {
      throw new Error(`durable run is not active: ${runId}`);
    }
    if (this.terminalizing || this.terminalPrepared) {
      throw new Error(`durable run is already terminalizing: ${runId}`);
    }
    if (plan.intent.runId === "") plan.intent.runId = runId;
    if (plan.intent.sessionId === "") {
      plan.intent.sessionId = this.durable.sessionId;
    }
    if (
      plan.intent.runId !== runId ||
      plan.intent.sessionId !== this.durable.sessionId
    ) {
      throw new Error("delivery plan identity does not match active Run");
    }
    plan.intent.transportContext = plan.intent.transportContext &&
        typeof plan.intent.transportContext === "object"
      ? { ...(plan.intent.transportContext as Record<string, unknown>) }
      : plan.intent.transportContext;
    this.durable.deliveryPlan = {
      intent: { ...plan.intent },
      operations: plan.operations.map((op: OrderedDeliveryOperationPlan) => ({
        ...op,
      })),
    };
  }

  /**
   * Stages the final assistant transcript entry for the active Run.
   */
  setAssistantMessage(runId: string, entryId: string, message: Message): void {
    if (runId === "") {
      throw new Error("assistant message Run ID is required");
    }
    const staged: Message = { ...message };
    if (!staged.role) staged.role = "assistant";
    if (staged.role !== "assistant" || staged.systemInjected) {
      throw new Error("runtime assistant entry must have assistant role");
    }
    if (
      !this.activeLocked(runId) || !this.durablePersisted ||
      this.durable === null
    ) {
      throw new Error(`durable run is not active: ${runId}`);
    }
    if (this.terminalizing || this.terminalPrepared) {
      throw new Error(`durable run is already terminalizing: ${runId}`);
    }
    if (entryId === "") entryId = runAssistantEntryID(runId);
    if (!staged.timestamp) {
      staged.timestamp =
        this.durable.startedAt && this.durable.startedAt.getTime() !== 0
          ? this.durable.startedAt
          : new Date(0);
    }
    this.durable.assistantEntryId = entryId;
    this.durable.assistantMessage = staged;
  }

  /**
   * Starts one exclusive execution. The caller must finish the run exactly once,
   * including when agent construction fails.
   */
  begin(parent: AbortSignal | undefined, runId: string): AbortSignal {
    if (runId === "") {
      throw new Error("run ID is required");
    }
    if (this.cancelFn !== null && !this.finished) {
      throw new Error(`execution already active: ${this.runId}`);
    }
    const controller = new AbortController();
    if (parent !== undefined) {
      if (parent.aborted) {
        controller.abort(abortReason(parent));
      } else {
        parent.addEventListener(
          "abort",
          () => controller.abort(abortReason(parent)),
          { once: true },
        );
      }
    }
    this.done = new Done();
    this.runId = runId;
    this.startedAt = new Date();
    this.ctx = controller;
    this.cancelFn = () => controller.abort();
    this.running = null;
    this.finished = false;
    this.state = RUN_STATE_RUNNING;
    this.durable = null;
    this.durablePersisted = false;
    this.startEvent = emptyRunEvent();
    this.terminalizing = false;
    this.terminalDone = null;
    this.terminalErr = null;
    this.terminalState = "";
    this.terminalMessage = "";
    this.terminalEvent = emptyRunEvent();
    this.terminalErrorInfo = {};
    this.terminalEventSet = false;
    this.terminalPrepared = false;
    this.terminalEventRecorded = false;
    this.facts = {
      phase: PHASE_MODEL,
      sideEffects: SIDE_EFFECT_NONE,
      partialOutput: false,
      lastRetry: {},
      lastRetryActive: false,
      lastError: {},
    };
    this.leaseBinding = null;
    this.leaseRelease = null;
    this.terminalRetryRunning = false;
    return controller.signal;
  }

  /**
   * Watches the process-local lease loss signal. Losing or voluntarily releasing
   * the lease invalidates the local registration: cancel the loop, then retire
   * the in-memory slot without an unfenced durable terminal write.
   */
  watchLeaseLost(done: Done | null, lost: AbortSignal | undefined): void {
    if (done === null || lost === undefined) return;
    const onLost = () => {
      if (done.closed) return;
      this.cancel();
      const active = this.activeLocked(this.runId);
      if (active) {
        const inner = this.finishInMemory(this.runId, RUN_STATE_FAILED, false);
        this.closeDone(inner);
      } else {
        this.unregisterLocalExecution();
      }
    };
    if (lost.aborted) {
      onLost();
      return;
    }
    lost.addEventListener("abort", onLost, { once: true });
    done.promise.then(() => lost.removeEventListener("abort", onLost));
  }

  waitForApproval(runId: string): void {
    this.waitFor(runId, RUN_STATE_WAITING_APPROVAL);
  }

  waitForQuestion(runId: string): void {
    this.waitFor(runId, RUN_STATE_WAITING_QUESTION);
  }

  private waitFor(runId: string, state: RunState): void {
    if (!this.activeLocked(runId)) {
      throw new Error(`execution is not active: ${runId}`);
    }
    if (this.state !== RUN_STATE_RUNNING) {
      throw new Error(`execution ${runId} is not running: ${this.state}`);
    }
    const previous = this.state;
    this.state = state;
    this.persistNonTerminalTransition(runId, previous, state, state, "");
  }

  /** Returns a run from an approval or question wait to active execution. */
  resume(runId: string): void {
    if (!this.activeLocked(runId)) {
      throw new Error(`execution is not active: ${runId}`);
    }
    if (
      this.state !== RUN_STATE_WAITING_APPROVAL &&
      this.state !== RUN_STATE_WAITING_QUESTION
    ) {
      throw new Error(`execution ${runId} is not waiting: ${this.state}`);
    }
    const previous = this.state;
    this.state = RUN_STATE_RUNNING;
    this.persistNonTerminalTransition(
      runId,
      previous,
      RUN_STATE_RUNNING,
      "resumed",
      "",
    );
  }

  /**
   * Keeps the durable row/event projection in lockstep with in-memory
   * waiting/resume transitions.
   */
  private persistNonTerminalTransition(
    runId: string,
    previous: RunState,
    state: RunState,
    eventType: string,
    message: string,
  ): void {
    const store = this.store;
    const sink = this.events;
    const durable = this.durable;
    const start = this.startEvent;
    if (durable === null) return;
    if (store !== null) {
      try {
        store.update(runId, state, message);
      } catch (err) {
        if (this.activeLocked(runId)) this.state = previous;
        throw new Error(`persist execution ${state}: ${errorMessage(err)}`);
      }
    }
    if (sink !== null) {
      const event: RunEvent = {
        runId,
        sessionId: durable.sessionId,
        eventType,
        status: state,
        timestamp: new Date(),
        source: durable.source,
        model: durable.model,
        mode: durable.mode,
      };
      if (event.sessionId === "") event.sessionId = start.sessionId;
      if (event.source === "") event.source = start.source;
      if (event.model === "") event.model = start.model;
      if (event.mode === "") event.mode = start.mode;
      try {
        sink.record(event);
      } catch (err) {
        let rollbackErr: unknown = null;
        if (store !== null) {
          try {
            store.update(
              runId,
              previous,
              "rollback after event persistence failure",
            );
          } catch (rollback) {
            rollbackErr = rollback;
          }
        }
        if (this.activeLocked(runId)) this.state = previous;
        if (rollbackErr !== null) {
          throw new Error(
            `record execution ${state} event: ${
              errorMessage(err)
            } (rollback failed: ${errorMessage(rollbackErr)})`,
          );
        }
        throw new Error(
          `record execution ${state} event: ${errorMessage(err)}`,
        );
      }
    }
    this.notifyDurableStateChanged();
  }

  private notifyDurableStateChanged(): void {
    const sessionId = this.durable?.sessionId ?? "";
    const source = this.durable?.source ?? "";
    if (sessionId !== "") notifyRuntimeStateChanged(sessionId, source);
  }

  activeLocked(runId: string): boolean {
    return this.cancelFn !== null && !this.finished &&
      (runId === "" || this.runId === runId);
  }

  /** Associates the core agent so cancellation can unblock agent waits. */
  setAgent(a: { abort(): void }): void {
    if (!this.activeLocked("")) return;
    this.running = a;
  }

  /** Requests context cancellation and aborts the core agent if present. */
  cancel(): boolean {
    const cancel = this.cancelFn;
    const a = this.running;
    if (cancel === null || this.finished) return false;
    this.state = RUN_STATE_CANCELLING;
    cancel();
    if (a !== null) a.abort();
    return true;
  }

  /** Attaches the canonical durable run store used by lifecycle helpers. */
  setRunStore(store: DurableRunStore): void {
    this.store = store;
  }

  /** Attaches the durable event sink used by lifecycle helpers. */
  setEventSink(sink: RunEventSink): void {
    this.events = sink;
  }

  /** Installs a lightweight terminal notification for adapters. */
  setTerminalObserver(
    observer: (runId: string, state: RunState) => void,
  ): void {
    this.terminalObserver = observer;
  }

  private notifyTerminalObserver(runId: string, state: RunState): void {
    if (runId === "" || this.terminalObserver === null) return;
    this.terminalObserver(runId, state);
  }

  private runStore(): DurableRunStore | null {
    return this.store;
  }

  /**
   * Starts a run and records its initial durable event through the configured
   * sink.
   */
  beginWithEvent(
    parent: AbortSignal | undefined,
    runId: string,
    event: RunEvent,
  ): AbortSignal {
    if (event.sessionId === "") {
      throw new Error("run start event session ID is required");
    }
    const signal = this.begin(parent, runId);
    event.runId = runId;
    try {
      this.recordEvent(event);
    } catch (err) {
      try {
        this.finishWithState(runId, RUN_STATE_FAILED);
      } catch {
        // best effort compensation
      }
      throw new Error(`record run start event: ${errorMessage(err)}`);
    }
    return signal;
  }

  /**
   * Transitions a run to a terminal state and records its final durable event.
   */
  finishWithEvent(runId: string, state: RunState, event: RunEvent): void {
    if (event.sessionId === "") {
      throw new Error("run terminal event session ID is required");
    }
    if (!isTerminalRunState(state)) {
      throw new Error(`execution terminal state is invalid: ${state}`);
    }
    const durable = this.activeLocked(runId) && this.durablePersisted &&
      this.durable !== null;
    if (durable) {
      this.finishDurableLocked(runId, state, "", event);
      return;
    }
    event.runId = runId;
    if (this.events !== null) {
      try {
        const id = this.events.record(event);
        event.id = id;
      } catch (err) {
        throw new Error(`record run terminal event: ${errorMessage(err)}`);
      }
    }
    this.finishInMemory(runId, state, true);
  }

  /** Persists one adapter-neutral run event when a sink is attached. */
  recordEvent(ev: RunEvent): string {
    if (this.events === null) return "";
    return this.events.record(ev);
  }

  /** Transitions the active run to completed. */
  finish(runId: string): void {
    try {
      this.finishWithState(runId, RUN_STATE_COMPLETED);
    } catch {
      // Go's `Finish` discards the terminal-transition error.
    }
  }

  /** Transitions the active run to an explicit terminal state. */
  finishWithState(runId: string, state: RunState): void {
    const durable = this.activeLocked(runId) && this.durablePersisted &&
      this.durable !== null;
    if (durable) {
      const d = this.durable!;
      const startEvent = this.startEvent;
      this.finishDurableLocked(runId, state, "", {
        sessionId: d.sessionId,
        runId,
        eventType: "finished",
        source: d.source,
        status: state,
        model: d.model,
        mode: d.mode,
        timestamp: new Date(),
        data: startEvent.data,
      });
      return;
    }
    this.finishInMemory(runId, state, true);
  }

  finishInMemory(
    runId: string,
    state: RunState,
    closeDone: boolean,
  ): Done | null {
    if (!isTerminalRunState(state)) {
      throw new Error(`execution terminal state is invalid: ${state}`);
    }
    if (!this.activeLocked(runId)) {
      throw new Error(`execution is not active: ${runId}`);
    }
    const done = this.done;
    if (this.cancelFn !== null) this.cancelFn();
    this.state = state;
    this.cancelFn = null;
    this.ctx = null;
    this.running = null;
    this.finished = true;
    if (closeDone && done !== null) {
      done.close();
      this.done = null;
    }
    this.unregisterLocalExecution();
    return done;
  }

  private closeDone(done: Done | null): void {
    if (done === null) return;
    if (this.done === done) {
      done.close();
      this.done = null;
    }
  }

  /**
   * Requests cancellation and waits for the active execution to terminalize.
   */
  shutdown(message: string): Promise<void> {
    return this.shutdownContext(undefined, message);
  }

  /** The context-bounded form of `shutdown`. */
  async shutdownContext(
    ctx: AbortSignal | undefined,
    message: string,
  ): Promise<void> {
    const { runId, active } = this.active();
    if (!active) return;
    const hasRunner = this.running !== null;
    if (!hasRunner) {
      if (!this.activeLocked(runId)) return;
      this.persistShutdownTerminalLocked(runId, message);
      const done = this.finishInMemory(runId, RUN_STATE_CANCELLED, false);
      this.closeDone(done);
      return;
    }
    await this.shutdownLoopOwned(ctx, runId, message);
  }

  private async shutdownLoopOwned(
    ctx: AbortSignal | undefined,
    runId: string,
    message: string,
  ): Promise<void> {
    if (!this.cancel()) {
      if (!this.active().active) return;
    }
    let updateErr: Error | null = null;
    // A terminal durable transition owns the row while it is writing its event;
    // avoid waiting on that I/O here. The single-threaded runtime never holds
    // the lifecycle lock across an await, so the fast path always proceeds.
    const stillActive = this.activeLocked(runId);
    if (!stillActive) return;
    if (!this.terminalizing) {
      const store = this.runStore();
      if (store !== null) {
        try {
          store.update(runId, RUN_STATE_CANCELLING, message);
        } catch (err) {
          updateErr = new Error(
            `persist run cancellation: ${errorMessage(err)}`,
          );
        }
      }
    }
    try {
      await this.wait(ctx);
    } catch (err) {
      if (updateErr !== null) {
        throw new Error(
          `${updateErr.message}; wait for execution shutdown: ${
            errorMessage(err)
          }`,
        );
      }
      throw err;
    }
    if (updateErr !== null) throw updateErr;
  }

  /**
   * Records the terminal event and durable row for a run that had no loop owner
   * available to perform its normal `finishDurable` transition.
   */
  private persistShutdownTerminalLocked(runId: string, message: string): void {
    const durable = this.durable;
    const startEvent = this.startEvent;
    if (durable === null) return;
    const durableRun = durable;
    const facts = this.facts;
    if (this.terminalEventSet && this.terminalState !== RUN_STATE_CANCELLED) {
      throw new Error(
        `execution terminal state already selected: ${this.terminalState}`,
      );
    }
    let terminalInfo = this.terminalErrorInfo;
    if (!this.terminalEventSet) {
      const event: RunEvent = {
        id: runTerminalEventID(runId, "finished"),
        sessionId: durableRun.sessionId,
        runId,
        eventType: "finished",
        source: durableRun.source,
        status: RUN_STATE_CANCELLED,
        model: durableRun.model,
        mode: durableRun.mode,
        timestamp: new Date(),
      };
      if (event.sessionId === "") event.sessionId = startEvent.sessionId;
      if (event.source === "") event.source = startEvent.source;
      if (event.model === "") event.model = startEvent.model;
      if (event.mode === "") event.mode = startEvent.mode;
      terminalInfo = terminalErrorInfoFor(
        RUN_STATE_CANCELLED,
        message,
        facts,
        durableRun,
      );
      message = terminalInfo.message ?? "";
      event.data = withTerminalErrorInfo(
        withAssistantEntryData(
          withRunAttemptData(event.data, durableRun),
          durableRun.assistantEntryId,
        ),
        terminalInfo,
      );
      this.terminalEvent = event;
      this.terminalEventSet = true;
      this.terminalState = RUN_STATE_CANCELLED;
      this.terminalMessage = message;
      this.terminalErrorInfo = terminalInfo;
      this.facts.lastError = terminalInfo;
    } else if ((terminalInfo.code ?? "") !== "") {
      message = terminalInfo.message ?? "";
      this.terminalMessage = message;
      this.terminalEvent.data = withTerminalErrorInfo(
        this.terminalEvent.data,
        terminalInfo,
      );
    } else {
      terminalInfo = terminalErrorInfoFor(
        RUN_STATE_CANCELLED,
        message,
        facts,
        durableRun,
      );
      message = terminalInfo.message ?? "";
      this.terminalMessage = message;
      this.terminalErrorInfo = terminalInfo;
      this.facts.lastError = terminalInfo;
      this.terminalEvent.data = withTerminalErrorInfo(
        this.terminalEvent.data,
        terminalInfo,
      );
    }
    const event = this.terminalEvent;
    this.terminalizing = true;
    this.terminalErr = null;
    const store = this.store;
    const recorded = this.terminalEventRecorded;
    const atomicFinisher =
      store as unknown as DurableConversationTurnEventFinisher;
    const atomicFinish = hasMethod(store, "finishRunAndConversationTurn") &&
      durableRun.conversationTurn;

    if (!recorded && !atomicFinish) {
      if (this.events !== null) {
        let id: string;
        try {
          id = this.events.record(event);
        } catch (err) {
          this.finishTerminalAttempt(
            new Error(`record shutdown terminal event: ${errorMessage(err)}`),
          );
          throw new Error(
            `record shutdown terminal event: ${errorMessage(err)}`,
          );
        }
        if (this.terminalEvent.id === "") this.terminalEvent.id = id;
        this.terminalEventRecorded = true;
      } else {
        this.terminalEventRecorded = true;
      }
    }
    if ((terminalInfo.code ?? "") !== "") {
      try {
        this.persistErrorInfo(durableRun, terminalInfo);
      } catch (err) {
        this.finishTerminalAttempt(toError(err));
        throw new Error(
          `persist shutdown terminal error: ${errorMessage(err)}`,
        );
      }
    }
    try {
      this.clearRetryProgress(durableRun);
    } catch (err) {
      this.finishTerminalAttempt(toError(err));
      throw new Error(`clear shutdown retry progress: ${errorMessage(err)}`);
    }
    if (store === null) {
      const err = new Error("execution run store is not configured");
      this.finishTerminalAttempt(err);
      throw err;
    }
    if (atomicFinish) {
      let id: string;
      try {
        id = atomicFinisher.finishRunAndConversationTurn(
          durableRun,
          RUN_STATE_CANCELLED,
          message,
          event,
        );
      } catch (err) {
        this.finishTerminalAttempt(
          new Error(
            `finish shutdown durable run and conversation turn: ${
              errorMessage(err)
            }`,
          ),
        );
        throw new Error(
          `finish shutdown durable run and conversation turn: ${
            errorMessage(err)
          }`,
        );
      }
      if (this.terminalEvent.id === "") this.terminalEvent.id = id;
      this.terminalEventRecorded = true;
      const projector = this.events as unknown as RunEventProjector;
      if (this.events !== null && hasMethod(this.events, "project")) {
        projector.project(event, id);
      }
    } else {
      try {
        store.finish(runId, RUN_STATE_CANCELLED, message);
      } catch (err) {
        this.finishTerminalAttempt(
          new Error(`finish shutdown durable run: ${errorMessage(err)}`),
        );
        throw new Error(`finish shutdown durable run: ${errorMessage(err)}`);
      }
    }
    this.terminalizing = false;
    this.terminalErr = null;
  }

  /** Waits for the active execution to reach a terminal state. */
  async wait(ctx?: AbortSignal): Promise<void> {
    const done = this.done;
    if (done === null) return;
    if (ctx === undefined) {
      await done.promise;
      return;
    }
    if (ctx.aborted) throw abortReason(ctx);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortReason(ctx));
      ctx.addEventListener("abort", onAbort, { once: true });
      done.promise.then(() => {
        ctx.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /**
   * Reports the current run state. It returns the last terminal state when idle
   * after a run has finished.
   */
  stateValue(): RunState {
    return this.state;
  }

  /** Reports the current run ID and whether a run is active. */
  active(): { runId: string; active: boolean } {
    return {
      runId: this.runId,
      active: this.cancelFn !== null && !this.finished,
    };
  }

  // --- Durable lifecycle ---------------------------------------------------

  /**
   * Starts an exclusive in-memory execution, creates its canonical durable run
   * row, and records the initial event.
   */
  beginDurable(
    parent: AbortSignal | undefined,
    runInput: DurableRun,
    event: RunEvent,
  ): AbortSignal {
    if (runInput.id === "" || runInput.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    const store = this.runStore();
    if (store === null) {
      throw new Error("execution run store is not configured");
    }
    if (hasMethod(store, "createRunWithEvent")) {
      const atomicStore = store as unknown as DurableRunEventStore;
      return this.beginDurableWithStart(
        parent,
        runInput,
        event,
        "create durable run and start event",
        () => {},
        (startEvent) => {
          if (
            runInput.conversationTurn &&
            hasMethod(store, "createRunWithEventAndTurn")
          ) {
            const turnStore = store as unknown as {
              createRunWithEventAndTurn(
                run: DurableRun,
                event: RunEvent,
              ): string;
            };
            return turnStore.createRunWithEventAndTurn(
              withConversationTurnID(runInput),
              startEvent,
            );
          }
          return atomicStore.createRunWithEvent(runInput, startEvent);
        },
      );
    }
    return this.beginDurableSimple(
      parent,
      runInput,
      event,
      "create durable run",
      () => store.create(runInput),
    );
  }

  /**
   * Atomically admits the immutable original request and its first durable Run.
   */
  beginIntentDurable(
    parent: AbortSignal | undefined,
    intent: ExecutionIntent,
    runInput: DurableRun,
    event: RunEvent,
  ): AbortSignal {
    if (intent.id === "" || intent.sessionId === "") {
      throw new Error("execution intent ID and session ID are required");
    }
    if (runInput.id === "" || runInput.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (intent.sessionId !== runInput.sessionId) {
      throw new Error(
        "execution intent and durable run must belong to the same session",
      );
    }
    if (runInput.intentId === "") runInput.intentId = intent.id;
    if (runInput.intentId !== intent.id) {
      throw new Error("durable run intent ID does not match execution intent");
    }
    const store = this.runStore();
    if (store === null || !hasMethod(store, "createIntentAndRun")) {
      throw new Error("execution intent store is not configured");
    }
    if (hasMethod(store, "createIntentAndRunWithEvent")) {
      const atomicStore = store as unknown as DurableIntentEventStore;
      return this.beginDurableWithStart(
        parent,
        runInput,
        event,
        "create durable intent, run, and start event",
        () => {},
        (startEvent) => {
          if (
            runInput.conversationTurn &&
            hasMethod(store, "createIntentAndRunWithEventAndTurn")
          ) {
            const turnStore = store as unknown as {
              createIntentAndRunWithEventAndTurn(
                intent: ExecutionIntent,
                run: DurableRun,
                event: RunEvent,
              ): string;
            };
            return turnStore.createIntentAndRunWithEventAndTurn(
              intent,
              withConversationTurnID(runInput),
              startEvent,
            );
          }
          return atomicStore.createIntentAndRunWithEvent(
            intent,
            runInput,
            startEvent,
          );
        },
      );
    }
    return this.beginDurableSimple(
      parent,
      runInput,
      event,
      "create durable intent and run",
      () =>
        (store as unknown as DurableIntentStore).createIntentAndRun(
          intent,
          runInput,
        ),
    );
  }

  /**
   * Creates a new linked attempt for an existing immutable execution intent.
   */
  beginRetryDurable(
    parent: AbortSignal | undefined,
    runInput: DurableRun,
    event: RunEvent,
  ): { intent: ExecutionIntent; signal: AbortSignal } {
    if (
      runInput.id === "" || runInput.sessionId === "" ||
      runInput.intentId === ""
    ) {
      throw new Error(
        "durable retry requires run ID, session ID, and intent ID",
      );
    }
    if (runInput.retryOf === "") {
      throw new Error("durable retry requires prior run ID");
    }
    if (runInput.attempt < 2) {
      throw new Error("durable retry attempt must be at least 2");
    }
    const store = this.runStore();
    if (store === null || !hasMethod(store, "getIntent")) {
      throw new Error("execution intent store is not configured");
    }
    const intentStore = store as unknown as DurableIntentStore;
    const intent = intentStore.getIntent(runInput.intentId);
    if (intent === null) {
      throw new Error(`execution intent not found: ${runInput.intentId}`);
    }
    if (intent.sessionId !== runInput.sessionId) {
      throw new Error(
        "execution intent and durable retry must belong to the same session",
      );
    }
    if (hasMethod(store, "createRunWithEvent")) {
      const atomicStore = store as unknown as DurableRunEventStore;
      const signal = this.beginDurableWithStart(
        parent,
        runInput,
        event,
        "create durable retry run and start event",
        () => {},
        (startEvent) => {
          if (
            runInput.conversationTurn &&
            hasMethod(store, "createRunWithEventAndTurn")
          ) {
            const turnStore = store as unknown as {
              createRunWithEventAndTurn(
                run: DurableRun,
                event: RunEvent,
              ): string;
            };
            return turnStore.createRunWithEventAndTurn(
              withConversationTurnID(runInput),
              startEvent,
            );
          }
          return atomicStore.createRunWithEvent(runInput, startEvent);
        },
      );
      return { intent, signal };
    }
    const signal = this.beginDurable(parent, runInput, event);
    return { intent, signal };
  }

  private beginDurableSimple(
    parent: AbortSignal | undefined,
    run: DurableRun,
    event: RunEvent,
    operation: string,
    create: () => void,
  ): AbortSignal {
    return this.beginDurableWithStart(
      parent,
      run,
      event,
      operation,
      create,
      null,
    );
  }

  private beginDurableWithStart(
    parent: AbortSignal | undefined,
    runInput: DurableRun,
    event: RunEvent,
    operation: string,
    create: () => void,
    atomicStart: ((startEvent: RunEvent) => string) | null,
  ): AbortSignal {
    const store = this.runStore();
    if (store === null) {
      throw new Error("execution run store is not configured");
    }
    const run = withConversationTurnID(runInput);
    const signal = this.begin(parent, run.id);
    if (hasMethod(store, "leaseLost")) {
      const leaseLost = (store as unknown as {
        leaseLost(sessionId: string): AbortSignal | undefined;
      }).leaseLost(run.sessionId);
      this.watchLeaseLost(this.done, leaseLost);
    }
    this.durable = { ...run };
    this.durablePersisted = false;
    this.startEvent = event;
    event.sessionId = run.sessionId;
    event.runId = run.id;
    event.data = withRunAttemptData(event.data, run);
    if (event.status === "") event.status = RUN_STATE_RUNNING;
    if (atomicStart !== null) {
      let startId: string;
      try {
        startId = atomicStart(event);
      } catch (err) {
        try {
          this.finishWithState(run.id, RUN_STATE_FAILED);
        } catch {
          // best effort compensation
        }
        throw new Error(`${operation}: ${errorMessage(err)}`);
      }
      event.id = startId;
      if (this.activeLocked(run.id)) {
        this.durablePersisted = true;
        this.startEvent = event;
      }
      try {
        this.registerLocalExecution(run);
      } catch (err) {
        throw this.failDurableRegistration(run, toError(err));
      }
      const projector = this.events as unknown as RunEventProjector;
      if (this.events !== null && hasMethod(this.events, "project")) {
        projector.project(event, event.id ?? "");
      }
      notifyRuntimeStateChanged(run.sessionId, run.source);
      return signal;
    }
    try {
      create();
    } catch (err) {
      try {
        this.finishWithState(run.id, RUN_STATE_FAILED);
      } catch {
        // best effort compensation
      }
      throw new Error(`${operation}: ${errorMessage(err)}`);
    }
    if (this.activeLocked(run.id)) {
      this.durablePersisted = true;
    }
    if (this.activeLocked(run.id)) {
      this.startEvent = event;
    }
    try {
      this.registerLocalExecution(run);
    } catch (err) {
      throw this.failDurableRegistration(run, toError(err));
    }
    try {
      this.recordEvent(event);
    } catch (err) {
      const message = `record run start event: ${errorMessage(err)}`;
      try {
        this.finishDurable(run.id, RUN_STATE_FAILED, message, {
          sessionId: run.sessionId,
          runId: run.id,
          eventType: "failed",
          source: run.source,
          status: RUN_STATE_FAILED,
          model: run.model,
          mode: run.mode,
          timestamp: new Date(),
        });
      } catch {
        try {
          store.finish(run.id, RUN_STATE_FAILED, message);
        } catch {
          // ignore best-effort finish failure
        }
        this.finishInMemory(run.id, RUN_STATE_FAILED, true);
      }
      throw new Error(`record run start event: ${errorMessage(err)}`);
    }
    notifyRuntimeStateChanged(run.sessionId, run.source);
    return signal;
  }

  private failDurableRegistration(
    run: DurableRun,
    registrationErr: Error,
  ): Error {
    const message =
      `register local execution binding: ${registrationErr.message}`;
    try {
      this.finishDurable(run.id, RUN_STATE_FAILED, message, {
        sessionId: run.sessionId,
        runId: run.id,
        eventType: "failed",
        source: run.source,
        status: RUN_STATE_FAILED,
        model: run.model,
        mode: run.mode,
        timestamp: new Date(),
      });
    } catch (err) {
      this.cancel();
      return new Error(`${message} (terminalize failed: ${errorMessage(err)})`);
    }
    return new Error(message);
  }

  /** Restores in-memory ownership of an already persisted, non-terminal Run. */
  reattachDurable(
    parent: AbortSignal | undefined,
    runId: string,
    state: RunState,
  ): AbortSignal {
    if (runId === "") throw new Error("run ID is required");
    if (this.runStore() === null) {
      throw new Error("execution run store is not configured");
    }
    if (state === "") state = RUN_STATE_RUNNING;
    if (isTerminalRunState(state)) {
      throw new Error(`cannot reattach terminal execution state: ${state}`);
    }
    const signal = this.begin(parent, runId);
    this.state = state;
    this.durable = emptyDurableRun(runId, "");
    this.durable.status = state;
    this.durablePersisted = true;
    return signal;
  }

  /** Restores an existing row with its full identity. */
  reattachDurableRun(
    parent: AbortSignal | undefined,
    runInput: DurableRun,
    state: RunState,
    startEvent: RunEvent,
  ): AbortSignal {
    if (runInput.id === "" || runInput.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    const store = this.runStore();
    if (store === null) {
      throw new Error("execution run store is not configured");
    }
    if (state === "") state = RUN_STATE_RUNNING;
    if (isTerminalRunState(state)) {
      throw new Error(`cannot reattach terminal execution state: ${state}`);
    }
    const signal = this.begin(parent, runInput.id);
    if (hasMethod(store, "prepareExistingExecution")) {
      try {
        (store as unknown as DurableExecutionOwnershipStore)
          .prepareExistingExecution(runInput.sessionId, runInput.id);
      } catch (err) {
        this.finishInMemory(runInput.id, RUN_STATE_FAILED, true);
        throw new Error(
          `prepare durable execution reattach: ${errorMessage(err)}`,
        );
      }
    }
    const run: DurableRun = { ...runInput };
    if (run.status === "") run.status = state;
    if (startEvent.sessionId === "") startEvent.sessionId = run.sessionId;
    if (startEvent.runId === "") startEvent.runId = run.id;
    if (startEvent.source === "") startEvent.source = run.source;
    if (startEvent.model === "") startEvent.model = run.model;
    if (startEvent.mode === "") startEvent.mode = run.mode;
    this.state = state;
    this.durable = run;
    this.durablePersisted = true;
    this.startEvent = startEvent;
    if (hasMethod(store, "leaseLost")) {
      const leaseLost = (store as unknown as {
        leaseLost(sessionId: string): AbortSignal | undefined;
      }).leaseLost(run.sessionId);
      this.watchLeaseLost(this.done, leaseLost);
    }
    try {
      this.registerLocalExecution(run);
    } catch (err) {
      this.finishInMemory(run.id, RUN_STATE_FAILED, true);
      throw new Error(`register reattached execution: ${errorMessage(err)}`);
    }
    return signal;
  }

  /** Persists a non-terminal state for the active canonical run. */
  updateDurable(runId: string, state: RunState, message: string): void {
    if (isTerminalRunState(state) || state === "") {
      throw new Error(`execution non-terminal state is invalid: ${state}`);
    }
    const { runId: activeID, active } = this.active();
    if (!active || activeID !== runId) {
      throw new Error(`execution is not active: ${runId}`);
    }
    const store = this.runStore();
    if (store === null) {
      throw new Error("execution run store is not configured");
    }
    const previous = this.state;
    try {
      store.update(runId, state, message);
    } catch (err) {
      throw new Error(`persist run update: ${errorMessage(err)}`);
    }
    if (this.activeLocked(runId)) {
      this.state = state;
    } else if (this.state !== state) {
      throw new Error(
        `execution ended while updating ${state} (previous state ${previous})`,
      );
    }
  }

  /** Persists the latest provider and context-window usage for the active Run. */
  recordUsage(runId: string, usage: unknown, contextUsage: unknown): void {
    const { runId: activeID, active } = this.active();
    if (!active || activeID !== runId) {
      throw new Error(`execution is not active: ${runId}`);
    }
    const store = this.runStore();
    if (store === null || !hasMethod(store, "updateUsage")) {
      throw new Error("execution run metadata store is not configured");
    }
    try {
      (store as unknown as DurableRunUsageStore).updateUsage(
        runId,
        usage,
        contextUsage,
      );
    } catch (err) {
      throw new Error(`persist run usage: ${errorMessage(err)}`);
    }
    if (this.durable !== null && this.activeLocked(runId)) {
      this.durable.usage = cloneUnknown(usage);
      this.durable.contextUsage = cloneUnknown(contextUsage);
    }
  }

  /** Requests cancellation and persists the canonical cancelling state. */
  cancelDurable(message: string): boolean {
    const store = this.runStore();
    if (store === null) {
      throw new Error("execution run store is not configured");
    }
    const { runId, active } = this.active();
    if (!active) return false;
    try {
      store.update(runId, RUN_STATE_CANCELLING, message);
    } catch (err) {
      throw new Error(`persist run cancellation: ${errorMessage(err)}`);
    }
    this.notifyDurableStateChanged();
    if (!this.cancel()) return false;
    return true;
  }

  /** Performs one canonical terminal transition and records its final event. */
  finishDurable(
    runId: string,
    state: RunState,
    message: string,
    event: RunEvent,
  ): void {
    if (!isTerminalRunState(state)) {
      throw new Error(`execution terminal state is invalid: ${state}`);
    }
    this.finishDurableLocked(runId, state, message, event);
  }

  /**
   * Keeps the execution lease and local registration active while a transient
   * terminal write is retried.
   */
  async finishDurableWithRetry(
    ctx: AbortSignal | undefined,
    runId: string,
    state: RunState,
    message: string,
    event: RunEvent,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new DOMException(
          "terminal persistence deadline exceeded",
          "TimeoutError",
        ),
      );
    }, DEFAULT_TERMINAL_PERSISTENCE_TIMEOUT_MS);
    const onParentAbort = () => controller.abort(abortReason(ctx));
    if (ctx !== undefined) {
      if (ctx.aborted) controller.abort(abortReason(ctx));
      else ctx.addEventListener("abort", onParentAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      ctx?.removeEventListener("abort", onParentAbort);
    };
    let delay = terminalPersistenceRetryInitialMs;
    let lastErr: Error | null = null;
    try {
      for (;;) {
        try {
          this.finishDurable(runId, state, message, event);
          return;
        } catch (err) {
          lastErr = toError(err);
          if (
            err instanceof RuntimeLeaseLostError ||
            !this.canRetryTerminalPersistence(runId, state)
          ) {
            throw err;
          }
        }
        let lost: AbortSignal | undefined;
        const store = this.runStore();
        if (store !== null && hasMethod(store, "leaseLost")) {
          const sessionId = this.durable?.sessionId ?? "";
          lost = (store as unknown as {
            leaseLost(sessionId: string): AbortSignal | undefined;
          }).leaseLost(sessionId);
        }
        const stop = await waitDelayOrAbort(delay, controller.signal, lost);
        if (stop === "abort") {
          cleanup();
          // The bounded foreground attempt is only a responsiveness limit. Keep
          // retrying in the background until the fenced transaction succeeds or
          // the lease is lost.
          this.startTerminalPersistenceRetry(runId, state, message, event);
          throw new AggregateError([lastErr!, abortReason(controller.signal)]);
        }
        if (stop === "lost") {
          cleanup();
          throw new AggregateError([
            lastErr!,
            new RuntimeLeaseLostError(this.durable?.sessionId ?? ""),
          ]);
        }
        if (delay < terminalPersistenceRetryMaximumMs) {
          delay *= 2;
          if (delay > terminalPersistenceRetryMaximumMs) {
            delay = terminalPersistenceRetryMaximumMs;
          }
        }
      }
    } finally {
      cleanup();
    }
  }

  private canRetryTerminalPersistence(runId: string, state: RunState): boolean {
    return this.activeLocked(runId) && this.terminalEventSet &&
      this.terminalState === state;
  }

  private startTerminalPersistenceRetry(
    runId: string,
    state: RunState,
    message: string,
    event: RunEvent,
  ): void {
    event.data = cloneUnknown(event.data);
    if (
      this.terminalRetryRunning || !this.activeLocked(runId) ||
      !this.terminalEventSet || this.terminalState !== state
    ) {
      return;
    }
    this.terminalRetryRunning = true;
    const done = this.done;
    const store = this.store;
    const sessionId = this.durable?.sessionId ?? "";
    let lost: AbortSignal | undefined;
    if (store !== null && hasMethod(store, "leaseLost") && sessionId !== "") {
      lost = (store as unknown as {
        leaseLost(sessionId: string): AbortSignal | undefined;
      }).leaseLost(sessionId);
    }
    void (async () => {
      try {
        let delay = terminalPersistenceRetryInitialMs;
        for (;;) {
          if (!this.canRetryTerminalPersistence(runId, state)) return;
          let failed: Error | null = null;
          try {
            this.finishDurable(runId, state, message, event);
            return;
          } catch (err) {
            failed = toError(err);
          }
          if (
            failed instanceof RuntimeLeaseLostError ||
            !this.canRetryTerminalPersistence(runId, state)
          ) return;
          const stop = await waitDelayOrAbort(
            delay,
            done?.promise !== undefined ? doneAbortPromise(done!) : undefined,
            lost,
          );
          if (stop !== "timeout") return;
          if (delay < terminalPersistenceRetryMaximumMs) {
            delay *= 2;
            if (delay > terminalPersistenceRetryMaximumMs) {
              delay = terminalPersistenceRetryMaximumMs;
            }
          }
        }
      } finally {
        this.terminalRetryRunning = false;
      }
    })();
  }

  /**
   * The single durable terminal transition owner.
   */
  private finishDurableLocked(
    runId: string,
    state: RunState,
    message: string,
    eventInput: RunEvent,
  ): void {
    if (!this.activeLocked(runId)) {
      const finished = this.finished && this.runId === runId;
      const terminalState = this.state;
      const terminalErr = this.terminalErr;
      if (finished && terminalState === state && terminalErr === null) return;
      throw new Error(`execution is not active: ${runId}`);
    }
    if (this.terminalEventSet && this.terminalState !== state) {
      throw new Error(
        `execution terminal state already selected: ${this.terminalState}`,
      );
    }

    let event = eventInput;
    event.runId = runId;
    if (!event.id) event.id = runTerminalEventID(runId, event.eventType);
    if (event.status === "") event.status = state;
    let durableRun = emptyDurableRun("", "");
    let terminalInfo: ErrorInfo = {};
    if (!this.terminalEventSet) {
      const durable = this.durable;
      const startEvent = this.startEvent;
      if (durable !== null) {
        if (event.sessionId === "") event.sessionId = durable.sessionId;
        if (event.source === "") event.source = durable.source;
        if (event.model === "") event.model = durable.model;
        if (event.mode === "") event.mode = durable.mode;
      }
      if (event.sessionId === "") event.sessionId = startEvent.sessionId;
      if (event.source === "") event.source = startEvent.source;
      if (event.model === "") event.model = startEvent.model;
      if (event.mode === "") event.mode = startEvent.mode;
      if (durable !== null) {
        durableRun = { ...durable };
        if (event.assistantMessage?.role === "assistant") {
          if (!event.assistantEntryId) {
            event.assistantEntryId = runAssistantEntryID(runId);
          }
          durableRun.assistantEntryId = event.assistantEntryId;
          durableRun.assistantMessage = event.assistantMessage;
          durable.assistantEntryId = event.assistantEntryId;
          durable.assistantMessage = event.assistantMessage;
        }
        event.data = withRunAttemptData(event.data, durable);
        event.data = withAssistantEntryData(
          event.data,
          durableRun.assistantEntryId,
        );
      }
      if (state !== RUN_STATE_COMPLETED) {
        terminalInfo = terminalErrorInfoFor(
          state,
          message,
          this.facts,
          durableRun,
        );
        message = terminalInfo.message ?? "";
        event.data = withTerminalErrorInfo(event.data, terminalInfo);
        this.facts.lastError = terminalInfo;
        this.terminalErrorInfo = terminalInfo;
      }
      this.terminalEvent = event;
      this.terminalEventSet = true;
      this.terminalState = state;
      this.terminalMessage = message;
    } else {
      event = this.terminalEvent;
      if (this.durable !== null) durableRun = { ...this.durable };
      if ((this.terminalErrorInfo.code ?? "") !== "") {
        terminalInfo = this.terminalErrorInfo;
        message = terminalInfo.message ?? "";
      } else {
        message = this.terminalMessage;
      }
    }
    const prepared = this.terminalPrepared;
    this.terminalizing = true;
    this.terminalErr = null;
    const recorded = this.terminalEventRecorded;
    const store = this.runStore();
    if (!prepared) {
      if (store !== null && hasMethod(store, "markTerminalizing")) {
        try {
          (store as unknown as DurableTerminalPersistenceStore)
            .markTerminalizing(runId, message);
        } catch (err) {
          this.finishTerminalAttempt(toError(err));
          throw new Error(
            `mark durable run terminalizing: ${errorMessage(err)}`,
          );
        }
      }
      this.terminalPrepared = true;
      if (this.activeLocked(runId)) this.state = RUN_STATE_TERMINALIZING;
      this.notifyDurableStateChanged();
    }
    const atomicFinisher =
      store as unknown as DurableConversationTurnEventFinisher;
    const atomicFinish = hasMethod(store, "finishRunAndConversationTurn") &&
      durableRun.conversationTurn;

    if (!recorded && !atomicFinish) {
      if (this.events !== null) {
        let id: string;
        try {
          id = this.events.record(event);
        } catch (err) {
          this.finishTerminalAttempt(toError(err));
          throw new Error(`record run terminal event: ${errorMessage(err)}`);
        }
        if (!this.terminalEvent.id) this.terminalEvent.id = id;
        this.terminalEventRecorded = true;
      } else {
        this.terminalEventRecorded = true;
      }
    }
    if ((terminalInfo.code ?? "") !== "") {
      try {
        this.persistErrorInfo(durableRun, terminalInfo);
      } catch (err) {
        this.finishTerminalAttempt(toError(err));
        throw new Error(`persist run terminal error: ${errorMessage(err)}`);
      }
    }
    try {
      this.clearRetryProgress(durableRun);
    } catch (err) {
      this.finishTerminalAttempt(toError(err));
      throw new Error(`clear run retry progress: ${errorMessage(err)}`);
    }
    if (store === null) {
      const err = new Error("execution run store is not configured");
      this.finishTerminalAttempt(err);
      throw err;
    }
    if (atomicFinish) {
      let id: string;
      try {
        id = atomicFinisher.finishRunAndConversationTurn(
          durableRun,
          state,
          message,
          event,
        );
      } catch (err) {
        this.finishTerminalAttempt(toError(err));
        throw new Error(
          `finish durable run and conversation turn: ${errorMessage(err)}`,
        );
      }
      if (!this.terminalEvent.id) this.terminalEvent.id = id;
      this.terminalEventRecorded = true;
      const projector = this.events as unknown as RunEventProjector;
      if (this.events !== null && hasMethod(this.events, "project")) {
        projector.project(event, id);
      }
    } else if (
      durableRun.conversationTurn && hasMethod(store, "finishConversationTurn")
    ) {
      const turnStore = store as unknown as DurableConversationTurnFinisher;
      try {
        turnStore.finishConversationTurn(durableRun, state, message);
      } catch (err) {
        if (!isConversationTurnNotOpen(err)) {
          this.finishTerminalAttempt(toError(err));
          throw new Error(`finish conversation turn: ${errorMessage(err)}`);
        }
      }
      try {
        store.finish(runId, state, message);
      } catch (err) {
        this.finishTerminalAttempt(toError(err));
        throw new Error(`finish durable run: ${errorMessage(err)}`);
      }
    } else {
      try {
        store.finish(runId, state, message);
      } catch (err) {
        this.finishTerminalAttempt(toError(err));
        throw new Error(`finish durable run: ${errorMessage(err)}`);
      }
    }
    let done: Done | null;
    try {
      done = this.finishInMemory(runId, state, false);
    } catch (err) {
      this.finishTerminalAttempt(toError(err));
      throw err;
    }
    this.terminalErr = null;
    this.terminalizing = false;
    const wait = this.terminalDone;
    this.terminalDone = null;
    if (wait !== null) wait.close();
    this.closeDone(done);
    if (durableRun.sessionId !== "") {
      notifyRuntimeStateChanged(durableRun.sessionId, durableRun.source);
    }
    this.notifyTerminalObserver(runId, state);
  }

  private finishTerminalAttempt(err: Error): void {
    this.terminalErr = err;
    this.terminalizing = false;
    const wait = this.terminalDone;
    this.terminalDone = null;
    if (wait !== null) wait.close();
  }

  // --- Observation ---------------------------------------------------------

  /**
   * Records a failure that happened before an Agent event stream existed.
   */
  recordFailure(err: unknown, optsIn: ErrorClassificationOptions): ErrorInfo {
    const facts = this.facts;
    const run = this.durable ?? emptyDurableRun("", "");
    const opts: ErrorClassificationOptions = { ...optsIn };
    if (!opts.phase) opts.phase = facts.phase;
    if (!opts.sideEffectState) opts.sideEffectState = facts.sideEffects;
    if (!opts.partialOutput) opts.partialOutput = facts.partialOutput;
    if (!opts.attempt) opts.attempt = facts.lastRetry.attempt;
    if (!opts.maxAttempts) opts.maxAttempts = facts.lastRetry.maxAttempts;
    if (!opts.retryAfterMs) opts.retryAfterMs = facts.lastRetry.retryAfterMs;
    if (!opts.runId) opts.runId = run.id;
    if (!opts.intentId) opts.intentId = run.intentId;
    const info = classifyError(err, opts);
    return this.recordErrorInfo(info);
  }

  /**
   * Records a previously classified, safe failure.
   */
  recordErrorInfo(infoIn: ErrorInfo): ErrorInfo {
    const facts = this.facts;
    const run = this.durable ?? emptyDurableRun("", "");
    const info = enrichErrorInfo(infoIn, facts, run);
    this.facts.lastError = info;
    this.persistErrorInfo(run, info);
    return info;
  }

  /**
   * Normalizes the Agent Core event stream into the shared execution contract.
   */
  observeAgentEvent(ev: AgentEvent): AgentEventObservation {
    if (
      ev.type === EVENT_RUN_FINISHED &&
      ev.assistantMessage?.role === "assistant"
    ) {
      const { runId: activeId, active } = this.active();
      if (active) {
        this.setAssistantMessage(
          activeId,
          ev.assistantEntryId ?? "",
          ev.assistantMessage,
        );
      }
    }
    if (!this.facts.phase) this.facts.phase = PHASE_MODEL;
    switch (ev.type) {
      case EVENT_TEXT_DELTA:
        if ((ev.textDelta ?? "").trim() !== "") this.facts.partialOutput = true;
        break;
      case EVENT_THINK_DELTA:
      case EVENT_HOSTED_ITEM:
        if (
          (ev.thinkDelta ?? "").trim() !== "" || ev.hostedItem !== undefined
        ) {
          this.facts.partialOutput = true;
        }
        break;
      case EVENT_CONTEXT_PRESSURE:
      case EVENT_COMPACTION_START:
      case EVENT_COMPACTION_END:
        this.facts.phase = PHASE_CONTEXT;
        break;
      case EVENT_TOOL_EXECUTION_START:
        this.facts.phase = PHASE_TOOL;
        this.facts.sideEffects = combineSideEffectState(
          this.facts.sideEffects,
          toolSideEffectState(ev.toolName ?? ""),
        );
        break;
      case EVENT_TOOL_EXECUTION_END:
        this.facts.phase = PHASE_TOOL;
        {
          let effect = toolSideEffectState(ev.toolName ?? "");
          if (ev.toolExecutionState === "interrupted") {
            effect = SIDE_EFFECT_UNKNOWN;
          }
          this.facts.sideEffects = combineSideEffectState(
            this.facts.sideEffects,
            effect,
          );
        }
        break;
      case EVENT_TOOL_APPROVAL_REQUEST:
        this.facts.phase = PHASE_APPROVAL;
        break;
      case EVENT_STATUS:
        if ((ev.responseStateFailureClass ?? "") !== "") {
          this.facts.phase = PHASE_TRANSPORT;
        }
        break;
    }
    const facts = this.facts;
    const run = this.durable ?? emptyDurableRun("", "");
    switch (ev.type) {
      case EVENT_RETRY: {
        const retry = retryInfoFromAgentEvent(ev, facts.phase);
        this.facts.lastRetry = retry;
        this.facts.lastRetryActive = true;
        this.persistRetryProgress(run, facts, retry);
        return { retry };
      }
      case EVENT_ERROR: {
        const info = this.errorInfoForAgentFailure(ev.error, facts, run);
        const recorded = this.recordErrorInfo(info);
        return { error: recorded };
      }
      case EVENT_RUN_FINISHED: {
        if (taskStatusIsSuccessful(ev.status ?? "")) {
          this.clearRetryProgress(run);
          return {};
        }
        const info = this.errorInfoForTerminalEvent(ev, facts, run);
        const recorded = this.recordErrorInfo(info);
        this.clearRetryProgress(run);
        return { error: recorded };
      }
    }
    return {};
  }

  private errorInfoForAgentFailure(
    err: unknown,
    facts: ExecutionFacts,
    run: DurableRun,
  ): ErrorInfo {
    return classifyError(err, {
      phase: facts.phase,
      attempt: facts.lastRetry.attempt,
      maxAttempts: facts.lastRetry.maxAttempts,
      retryAfterMs: facts.lastRetry.retryAfterMs,
      sideEffectState: facts.sideEffects,
      partialOutput: facts.partialOutput,
      runId: run.id,
      intentId: run.intentId,
    });
  }

  private errorInfoForTerminalEvent(
    ev: AgentEvent,
    facts: ExecutionFacts,
    run: DurableRun,
  ): ErrorInfo {
    if (ev.error !== undefined && ev.error !== null) {
      return this.errorInfoForAgentFailure(ev.error, facts, run);
    }
    const info: ErrorInfo = {
      phase: facts.phase,
      attempt: facts.lastRetry.attempt,
      maxAttempts: facts.lastRetry.maxAttempts,
      retryAfterMs: facts.lastRetry.retryAfterMs,
      sideEffectState: facts.sideEffects,
      partialOutput: facts.partialOutput,
      runId: run.id,
      intentId: run.intentId,
    };
    switch (ev.status) {
      case TASK_CANCELED:
        return applyErrorDefaults(
          info,
          "run_cancelled",
          "canceled",
          "canceled",
          RETRY_USER,
          false,
          "run.error.cancelled",
        );
      case TASK_INCOMPLETE:
        return applyErrorDefaults(
          info,
          "run_incomplete",
          "incomplete_error",
          FAILURE_INCOMPLETE,
          retryModeForSafety(info),
          false,
          "run.error.incomplete",
        );
      default:
        return classifyError(
          new Error("agent run failed without error detail"),
          {
            phase: facts.phase,
            attempt: facts.lastRetry.attempt,
            maxAttempts: facts.lastRetry.maxAttempts,
            retryAfterMs: facts.lastRetry.retryAfterMs,
            sideEffectState: facts.sideEffects,
            partialOutput: facts.partialOutput,
            runId: run.id,
            intentId: run.intentId,
          },
        );
    }
  }

  private persistRetryProgress(
    run: DurableRun,
    facts: ExecutionFacts,
    retry: RetryInfo,
  ): void {
    const store = this.runStore();
    if (store !== null && hasMethod(store, "updateProgress") && run.id !== "") {
      try {
        (store as unknown as DurableRunMetadataStore).updateProgress(
          run.id,
          retry,
        );
      } catch (err) {
        throw new Error(`persist retry progress: ${errorMessage(err)}`);
      }
    }
    if (run.id === "" || run.sessionId === "") return;
    const data = JSON.stringify({
      state: "retrying",
      attempt: retry.attempt,
      maxAttempts: retry.maxAttempts,
      phase: retry.phase,
      reasonCode: retry.reasonCode,
      retryAfterMs: retry.retryAfterMs,
      continue: retry.continue,
      messageKey: retry.messageKey,
      message: retry.message,
      sideEffectState: facts.sideEffects,
      partialOutput: facts.partialOutput,
    });
    try {
      this.recordEvent({
        sessionId: run.sessionId,
        runId: run.id,
        eventType: "run_retrying",
        source: run.source,
        status: RUN_STATE_RUNNING,
        model: run.model,
        mode: run.mode,
        timestamp: new Date(),
        data,
      });
    } catch (err) {
      throw new Error(`record retry event: ${errorMessage(err)}`);
    }
  }

  private persistErrorInfo(run: DurableRun, info: ErrorInfo): void {
    const store = this.runStore();
    if (
      store === null || !hasMethod(store, "updateErrorInfo") || run.id === ""
    ) return;
    try {
      (store as unknown as DurableRunMetadataStore).updateErrorInfo(
        run.id,
        info,
      );
    } catch (err) {
      throw new Error(`persist error info: ${errorMessage(err)}`);
    }
  }

  private clearRetryProgress(run: DurableRun): void {
    const store = this.runStore();
    if (
      store === null || !hasMethod(store, "updateProgress") || run.id === ""
    ) return;
    try {
      (store as unknown as DurableRunMetadataStore).updateProgress(run.id, {});
    } catch (err) {
      throw new Error(`clear retry progress: ${errorMessage(err)}`);
    }
  }

  // --- Local execution registration ---------------------------------------

  registerLocalExecution(run: DurableRun): void {
    const store = this.runStore();
    if (store === null || !hasMethod(store, "executionBinding")) return;
    const ownershipStore = store as unknown as DurableExecutionOwnershipStore;
    const { binding, ok } = ownershipStore.executionBinding(
      run.sessionId,
      run.id,
    );
    if (!ok || binding === null) return;
    if (
      binding.purpose !== "execution" || binding.sessionId !== run.sessionId ||
      binding.runId !== run.id
    ) {
      throw new RuntimeLeaseRunMismatchError(run.id);
    }
    let bound: RuntimeLeaseBinding = binding;
    let releaseLease: (() => void) | null = null;
    if (hasMethod(store, "retainExecutionLease")) {
      const retention =
        (store as unknown as DurableExecutionLeaseRetentionStore)
          .retainExecutionLease(run.sessionId, run.id);
      if (retention.retained && retention.binding !== null) {
        bound = retention.binding;
        releaseLease = retention.release;
      }
    }
    if (!this.activeLocked(run.id)) {
      if (releaseLease !== null) releaseLease();
      throw new Error(`execution is not active: ${run.id}`);
    }
    this.leaseBinding = bound;
    this.leaseRelease = releaseLease;

    const key = executionRegistrationKey(bound);
    const existing = localExecutionRegistry.get(key);
    if (existing !== undefined && existing.runtime !== this) {
      if (
        this.leaseBinding !== null &&
        executionRegistrationKey(this.leaseBinding) === key
      ) {
        const release = this.leaseRelease;
        this.leaseBinding = null;
        this.leaseRelease = null;
        if (release !== null) release();
      }
      throw new Error(`local execution binding already registered: ${run.id}`);
    }
    localExecutionRegistry.set(key, { binding: bound, runtime: this });
  }

  unregisterLocalExecution(): void {
    const binding = this.leaseBinding;
    const releaseLease = this.leaseRelease;
    this.leaseBinding = null;
    this.leaseRelease = null;
    if (binding === null) {
      if (releaseLease !== null) releaseLease();
      return;
    }
    const key = executionRegistrationKey(binding);
    const current = localExecutionRegistry.get(key);
    if (current !== undefined && current.runtime === this) {
      localExecutionRegistry.delete(key);
    }
    if (releaseLease !== null) releaseLease();
  }
}

// --- Free helpers ----------------------------------------------------------

/** A completion handle equivalent to Go's `chan struct{}`. */
class Done {
  readonly promise: Promise<void>;
  closed = false;
  #resolve!: () => void;
  constructor() {
    this.promise = new Promise<void>((res) => {
      this.#resolve = res;
    });
  }
  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.#resolve();
    }
  }
}

function doneAbortPromise(done: Done): AbortSignal {
  const controller = new AbortController();
  done.promise.then(() => controller.abort());
  return controller.signal;
}

interface DurableExecutionOwnershipStore {
  executionBinding(
    sessionId: string,
    runId: string,
  ): { binding: RuntimeLeaseBinding | null; ok: boolean };
  prepareExistingExecution(sessionId: string, runId: string): void;
}

interface DurableExecutionLeaseRetentionStore {
  retainExecutionLease(sessionId: string, runId: string): {
    binding: RuntimeLeaseBinding | null;
    release: (() => void) | null;
    retained: boolean;
  };
}

interface LocalExecutionRegistration {
  binding: RuntimeLeaseBinding;
  runtime: ExecutionRuntime;
}

const localExecutionRegistry = new Map<string, LocalExecutionRegistration>();

function executionRegistrationKey(binding: RuntimeLeaseBinding): string {
  return `${binding.databaseIdentity}\x00${binding.sessionId}\x00${binding.runId}\x00${binding.epoch}`;
}

/**
 * Resolves the canonical execution state without trusting adapter-local maps.
 * Reading the snapshot may wake recovery coordinators for orphaned or
 * recovery-failed Runs.
 */
export function inspectSessionExecution(
  sessionDir: string,
  sessionId: string,
): SessionExecutionSnapshot {
  const snapshot: SessionExecutionSnapshot = {
    sessionId,
    sessionExists: false,
    state: SESSION_EXECUTION_UNKNOWN,
    phase: "",
    running: false,
    busy: true,
    canSubmit: false,
    canCancelLocal: false,
    canCancelRemote: false,
    leasePurpose: "",
    leaseEpoch: 0,
    leaseOwnerInstanceId: "",
    leaseOwnerPid: 0,
    leaseTokenIdentity: "",
    linkageState: "none",
    recoveryAction: "none",
    recoveryAttempt: 0,
    recoveryLastError: "",
    displayOwnerScope: "unknown",
    remoteRunId: "",
    remoteProvider: "",
    remoteState: "",
  };
  const facts = readSessionExecutionFacts(sessionDir, sessionId);
  snapshot.sessionExists = facts.sessionExists;
  if (!facts.sessionExists) {
    snapshot.phase = "missing";
    return snapshot;
  }
  if (facts.lease !== null) {
    const lease = facts.lease;
    snapshot.leasePurpose = lease.purpose;
    snapshot.leaseEpoch = lease.epoch;
    snapshot.leaseExpiresAt = lease.expiresAt;
    snapshot.leaseOwnerInstanceId = lease.ownerInstanceId;
    snapshot.leaseOwnerPid = lease.ownerPid;
    snapshot.leaseTokenIdentity = lease.tokenHash;
  }
  if (facts.activeRuns.length > 1) {
    snapshot.state = SESSION_EXECUTION_INCONSISTENT;
    snapshot.linkageState = "mismatched";
    return snapshot;
  }
  if (facts.activeRuns.length === 0) {
    if (facts.lease !== null && facts.lease.valid) {
      snapshot.state = SESSION_EXECUTION_RESERVED;
      snapshot.phase = leasePhase(facts.lease.purpose, false);
      snapshot.displayOwnerScope = leaseOwnerScope(sessionDir, facts.lease);
      return snapshot;
    }
    snapshot.state = SESSION_EXECUTION_IDLE;
    snapshot.busy = false;
    snapshot.canSubmit = true;
    snapshot.displayOwnerScope = "none";
    return snapshot;
  }

  const run = facts.activeRuns[0];
  snapshot.activeRun = {
    id: run.id,
    status: run.status,
    source: run.source,
    model: run.model,
    mode: run.mode,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
  if (facts.recovery !== null) {
    snapshot.recoveryAttempt = facts.recovery.attempt;
    snapshot.recoveryLastError = facts.recovery.lastError;
    if (facts.recovery.nextRetryAt !== null) {
      snapshot.recoveryNextAt = facts.recovery.nextRetryAt;
    }
  }
  const lease = facts.lease;
  if (lease === null || !lease.valid) {
    if (defaultRunRecoveryAction(facts) === RECOVERY_KEEP_REMOTE) {
      const remoteTerminal = isRemoteResponseTerminal(
        facts.remoteRun?.state ?? "",
      );
      snapshot.state = SESSION_EXECUTION_DETACHED;
      snapshot.phase = "executing";
      snapshot.running = !remoteTerminal;
      const cancelRequested = facts.remoteRun?.cancelRequested ?? false;
      snapshot.canCancelRemote = !remoteTerminal && !cancelRequested;
      snapshot.recoveryAction = "reattach_remote";
      snapshot.displayOwnerScope = "remote";
      snapshot.remoteRunId = facts.remoteRun?.localRunId ?? "";
      snapshot.remoteProvider = facts.remoteRun?.provider ?? "";
      snapshot.remoteState = facts.remoteRun?.state ?? "";
      if (remoteTerminal) {
        snapshot.phase = "recovering";
        snapshot.recoveryAction = "finalize_remote";
      }
      return snapshot;
    }
    if (facts.recovery !== null && facts.recovery.state === "failed") {
      snapshot.state = SESSION_EXECUTION_RECOVERY_FAILED;
      snapshot.phase = "recovering";
      snapshot.recoveryAction = "retry_recovery";
      snapshot.displayOwnerScope = "none";
      wakeRecoveryCoordinators(sessionDir);
      return snapshot;
    }
    snapshot.state = SESSION_EXECUTION_ORPHANED;
    snapshot.phase = "recovering";
    snapshot.recoveryAction = "recover_orphan";
    snapshot.displayOwnerScope = "none";
    wakeRecoveryCoordinators(sessionDir);
    return snapshot;
  }
  snapshot.displayOwnerScope = leaseOwnerScope(sessionDir, lease);
  if (lease.runId === run.id) {
    snapshot.linkageState = "bound";
  } else if (lease.runId === "" && lease.purpose === "run") {
    snapshot.linkageState = "legacy_unbound";
  } else {
    snapshot.linkageState = "mismatched";
  }

  switch (lease.purpose) {
    case "recovery":
      if (lease.runId !== run.id) {
        snapshot.state = SESSION_EXECUTION_INCONSISTENT;
        return snapshot;
      }
      snapshot.state = SESSION_EXECUTION_RESERVED;
      snapshot.phase = "recovering";
      snapshot.recoveryAction = "retry_recovery";
      return snapshot;
    case "admission":
    case "mutation":
    case "fork":
      snapshot.state = SESSION_EXECUTION_INCONSISTENT;
      snapshot.phase = leasePhase(lease.purpose, true);
      return snapshot;
    case "execution":
      if (lease.runId !== run.id) {
        snapshot.state = SESSION_EXECUTION_INCONSISTENT;
        return snapshot;
      }
      break;
    case "run":
      if (lease.runId !== "" && lease.runId !== run.id) {
        snapshot.state = SESSION_EXECUTION_INCONSISTENT;
        return snapshot;
      }
      break;
    default:
      snapshot.state = SESSION_EXECUTION_INCONSISTENT;
      return snapshot;
  }

  snapshot.phase = "executing";
  if (registeredLocalExecution(facts.databaseIdentity, run, lease) !== null) {
    snapshot.state = SESSION_EXECUTION_LOCAL;
    snapshot.running = true;
    snapshot.canCancelLocal = true;
    snapshot.displayOwnerScope = "local";
    return snapshot;
  }
  const localBinding = currentRuntimeLeaseBinding(sessionDir, sessionId);
  if (
    localBinding !== null && sameLeaseIdentity(localBinding, lease) &&
    lease.purpose === "execution"
  ) {
    snapshot.state = SESSION_EXECUTION_INCONSISTENT;
    snapshot.displayOwnerScope = "local";
    return snapshot;
  }
  snapshot.state = SESSION_EXECUTION_EXTERNAL;
  snapshot.running = true;
  return snapshot;
}

export function registeredLocalExecution(
  databaseIdentity: string,
  run: SessionRun,
  lease: RuntimeLeaseSnapshot,
): ExecutionRuntime | null {
  const binding: RuntimeLeaseBinding = {
    databaseIdentity,
    sessionId: run.sessionId,
    runId: run.id,
    ownerInstanceId: lease.ownerInstanceId,
    tokenHash: lease.tokenHash,
    epoch: lease.epoch,
    purpose: lease.purpose,
  };
  const entry = localExecutionRegistry.get(executionRegistrationKey(binding));
  if (
    entry === undefined || entry.runtime === null ||
    entry.binding.ownerInstanceId !== binding.ownerInstanceId ||
    entry.binding.tokenHash !== binding.tokenHash ||
    entry.binding.purpose !== binding.purpose
  ) {
    return null;
  }
  const { runId: registeredRunId, active } = entry.runtime.active();
  return active && registeredRunId === run.id ? entry.runtime : null;
}

function sameLeaseIdentity(
  binding: RuntimeLeaseBinding,
  lease: RuntimeLeaseSnapshot,
): boolean {
  return binding.sessionId === lease.sessionId &&
    binding.ownerInstanceId === lease.ownerInstanceId &&
    binding.tokenHash === lease.tokenHash &&
    binding.epoch === lease.epoch;
}

export function isRemoteResponseTerminal(state: string): boolean {
  switch (state.trim().toLowerCase()) {
    case "completed":
    case "failed":
    case "incomplete":
    case "cancelled":
    case "canceled":
    case "expired":
      return true;
    default:
      return false;
  }
}

function leasePhase(purpose: RuntimeLeasePurpose, activeRun: boolean): string {
  switch (purpose) {
    case "admission":
      return "admitting";
    case "execution":
    case "run":
      return activeRun ? "executing" : "releasing";
    case "recovery":
      return "recovering";
    default:
      return "reserved";
  }
}

function leaseOwnerScope(
  sessionDir: string,
  lease: RuntimeLeaseSnapshot,
): string {
  const binding = currentRuntimeLeaseBinding(sessionDir, lease.sessionId);
  if (binding !== null && sameLeaseIdentity(binding, lease)) return "local";
  return "external";
}

export function terminalErrorInfoFor(
  state: RunState,
  message: string,
  facts: ExecutionFacts,
  run: DurableRun,
): ErrorInfo {
  if ((facts.lastError.code ?? "") !== "") {
    return enrichErrorInfo(facts.lastError, facts, run);
  }
  const opts: ErrorClassificationOptions = {
    phase: facts.phase,
    attempt: facts.lastRetry.attempt,
    maxAttempts: facts.lastRetry.maxAttempts,
    retryAfterMs: facts.lastRetry.retryAfterMs,
    sideEffectState: facts.sideEffects,
    partialOutput: facts.partialOutput,
    runId: run.id,
    intentId: run.intentId,
  };
  switch (state) {
    case RUN_STATE_CANCELLED:
      return classifyError(
        new DOMException("The operation was aborted.", "AbortError"),
        opts,
      );
    case RUN_STATE_TIMED_OUT:
      return classifyError(
        new DOMException("The operation timed out.", "TimeoutError"),
        opts,
      );
    case RUN_STATE_INCOMPLETE: {
      const info: ErrorInfo = {
        phase: opts.phase,
        attempt: opts.attempt,
        maxAttempts: opts.maxAttempts,
        retryAfterMs: opts.retryAfterMs,
        sideEffectState: opts.sideEffectState,
        partialOutput: opts.partialOutput,
        runId: opts.runId,
        intentId: opts.intentId,
      };
      return applyErrorDefaults(
        info,
        "run_incomplete",
        "incomplete_error",
        FAILURE_INCOMPLETE,
        retryModeForSafety(info),
        false,
        "run.error.incomplete",
      );
    }
    default:
      return classifyError(new Error(message), opts);
  }
}

export function enrichErrorInfo(
  info: ErrorInfo,
  facts: ExecutionFacts,
  run: DurableRun,
): ErrorInfo {
  const out: ErrorInfo = { ...info };
  if (!out.phase) out.phase = facts.phase;
  if (!out.phase) out.phase = PHASE_TERMINALIZATION;
  if (!out.sideEffectState) out.sideEffectState = facts.sideEffects;
  if (!out.sideEffectState) out.sideEffectState = SIDE_EFFECT_NONE;
  if (facts.partialOutput) out.partialOutput = true;
  if (!out.attempt) out.attempt = facts.lastRetry.attempt;
  if (!out.maxAttempts) out.maxAttempts = facts.lastRetry.maxAttempts;
  if (!out.retryAfterMs) out.retryAfterMs = facts.lastRetry.retryAfterMs;
  if (!out.runId) out.runId = run.id;
  if (!out.intentId) out.intentId = run.intentId;
  return out;
}

function retryInfoFromAgentEvent(ev: AgentEvent, phase: RunPhase): RetryInfo {
  if (!phase) phase = PHASE_MODEL;
  const info: RetryInfo = {
    attempt: ev.retryAttempt,
    maxAttempts: ev.retryMaxAttempts,
    phase,
    reasonCode: retryReasonCode(
      ev.retryReason ?? "",
      ev.retryContinue ?? false,
    ),
    retryAfterMs: ev.retryAfterMs,
    continue: ev.retryContinue,
    message: diagnosticMessage(undefined, ev.statusMessage),
  };
  if (info.continue) info.messageKey = "run.retry.continuing";
  else info.messageKey = "run.retrying";
  return info;
}

function retryReasonCode(reason: string, continuation: boolean): string {
  if (continuation) return "continuation";
  const value = reason.toLowerCase();
  if (value.includes("timeout")) return "timeout";
  if (value.includes("empty")) return "empty_response";
  if (value.includes("token") || value.includes("truncat")) {
    return "output_limit";
  }
  if (value.includes("context")) return "context";
  return "provider";
}

function combineSideEffectState(
  current: SideEffectState,
  next: SideEffectState,
): SideEffectState {
  if (current === SIDE_EFFECT_MUTATING || next === SIDE_EFFECT_MUTATING) {
    return SIDE_EFFECT_MUTATING;
  }
  if (current === SIDE_EFFECT_UNKNOWN || next === SIDE_EFFECT_UNKNOWN) {
    return SIDE_EFFECT_UNKNOWN;
  }
  if (current === SIDE_EFFECT_READ_ONLY || next === SIDE_EFFECT_READ_ONLY) {
    return SIDE_EFFECT_READ_ONLY;
  }
  return SIDE_EFFECT_NONE;
}

function toolSideEffectState(name: string): SideEffectState {
  switch (name.trim().toLowerCase()) {
    case "read":
    case "read_file":
    case "list":
    case "list_dir":
    case "glob":
    case "grep":
    case "search":
    case "search_files":
    case "find":
    case "web_search":
      return SIDE_EFFECT_READ_ONLY;
    default:
      return SIDE_EFFECT_UNKNOWN;
  }
}

function withConversationTurnID(run: DurableRun): DurableRun {
  if (run.conversationTurn && run.conversationTurnId === "") {
    return { ...run, conversationTurnId: `turn-${run.id}` };
  }
  return run;
}

function emptyRunEvent(): RunEvent {
  return {
    sessionId: "",
    runId: "",
    eventType: "",
    source: "",
    status: "",
    model: "",
    mode: "",
  };
}

function emptyDurableRun(id: string, sessionId: string): DurableRun {
  return {
    id,
    sessionId,
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(0),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    userMessage: undefined,
    assistantEntryId: "",
    assistantMessage: undefined,
    conversationTurnId: "",
    conversationTurn: false,
  };
}

function hasMethod(obj: unknown, name: string): boolean {
  if (obj === null || obj === undefined) return false;
  return typeof (obj as Record<string, unknown>)[name] === "function";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isConversationTurnNotOpen(err: unknown): boolean {
  return err instanceof Error && err.name === "ConversationTurnNotOpenError";
}

function cloneUnknown(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    // Non-cloneable payloads (functions, proxies) stay shared by reference.
    return value;
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new DOMException("aborted", "AbortError");
}

type StopReason = "timeout" | "abort" | "lost";

async function waitDelayOrAbort(
  delayMs: number,
  signal: AbortSignal | undefined,
  lost: AbortSignal | undefined,
): Promise<StopReason> {
  return await new Promise<StopReason>((resolve) => {
    let settled = false;
    const finish = (reason: StopReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      lost?.removeEventListener("abort", onLost);
      resolve(reason);
    };
    const onAbort = () => finish("abort");
    const onLost = () => finish("lost");
    const timer = setTimeout(() => finish("timeout"), delayMs);
    if (signal?.aborted) {
      finish("abort");
      return;
    }
    if (lost?.aborted) {
      finish("lost");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    lost?.addEventListener("abort", onLost, { once: true });
  });
}
