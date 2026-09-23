//
// The Runtime-owned persistence boundary used by `ExecutionRuntime` to
// coordinate canonical Run rows with in-memory lifecycle transitions, plus the
// adapter-facing `DurableRun`/store interfaces. All canonical persistence is
// delegated to `src/session`; this module owns no SQL.
//
// Deviations from Go: `context.Context` is dropped (the DAO layer is
// synchronous), `<-chan struct{}` maps to `AbortSignal`, `json.RawMessage`
// maps to decoded `unknown`, `time.Time` maps to `Date`, and Go's multiple
// `(binding, ok, error)` returns map to a value object plus typed throws.

import type { Message } from "../provider/types.ts";
import { readSessionExecutionFacts } from "../session/execution_facts.ts";
import {
  bindRuntimeLeaseToExistingRun,
  currentRuntimeLeaseBinding,
  retainRuntimeLease,
  type RuntimeLeaseBinding,
  runtimeLeaseLost,
  RuntimeLeaseLostError,
  RuntimeLeaseRunMismatchError,
} from "../session/runtime_lock.ts";
import type { ConversationTurn, ExecutionIntent } from "../session/mod.ts";
import {
  createExecutionIntentAndSessionRun,
  createExecutionIntentAndSessionRunEvent,
  createExecutionIntentAndSessionRunEventWithTurn,
  createSessionRun,
  createSessionRunAndEvent,
  createSessionRunAndEventWithTurn,
  endConversationTurn,
  finishSessionRunAndConversationTurn,
  getExecutionIntent,
  type SessionRun,
  type SessionRunEvent,
  updateSessionRunErrorInfo,
  updateSessionRunProgress,
  updateSessionRunStatus,
  updateSessionRunUsage,
} from "../session/mod.ts";
import type {
  DeliveryIntent as SessionDeliveryIntent,
  DeliveryOperation as SessionDeliveryOperation,
  DeliveryPlan as SessionDeliveryPlan,
} from "../session/delivery_store.ts";
import type { DeliveryPlan } from "./delivery.ts";
import type { ErrorInfo, RetryInfo } from "./error_info.ts";
import { type RunEvent } from "./run_event.ts";
import { isTerminalRunState, type RunState } from "./run_state.ts";

/**
 * The adapter-neutral lifecycle row for one execution. `inputResourceIds` are
 * Runtime-prepared resources this admission must bind in the same transaction
 * as the intent, Run row, and start event; retries may reference resources the
 * original Run already owns.
 */
export interface DurableRun {
  id: string;
  sessionId: string;
  intentId: string;
  retryOf: string;
  attempt: number;
  workDir: string;
  source: string;
  model: string;
  mode: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string;
  errorInfo: ErrorInfo;
  progress: RetryInfo;
  usage: unknown;
  contextUsage: unknown;
  inputResourceIds: string[];
  submissionKeyHash: string;
  submissionScope: string;
  submissionFingerprint: string;
  userEntryId: string;
  userMessage?: Message;
  assistantEntryId: string;
  assistantMessage?: Message;
  /** Terminal-only: persisted together with the Run/turn/terminal event. */
  deliveryPlan?: DeliveryPlan;
  conversationTurnId: string;
  conversationTurn: boolean;
}

/**
 * The persistence boundary used by `ExecutionRuntime` to coordinate canonical
 * Run rows with in-memory lifecycle transitions.
 */
export interface DurableRunStore {
  create(run: DurableRun): void;
  update(runId: string, state: RunState, message: string): void;
  finish(runId: string, state: RunState, message: string): void;
}

/** Optional extension for stores that persist structured recovery state. */
export interface DurableRunMetadataStore {
  updateErrorInfo(runId: string, info: ErrorInfo): void;
  updateProgress(runId: string, progress: RetryInfo): void;
}

/** Optional metadata extension for providers that expose usage. */
export interface DurableRunUsageStore {
  updateUsage(runId: string, usage: unknown, contextUsage: unknown): void;
}

/** The Runtime-owned persistence boundary for an accepted request intent. */
export interface DurableIntentStore {
  createIntentAndRun(intent: ExecutionIntent, run: DurableRun): void;
  getIntent(intentId: string): ExecutionIntent | null;
}

/** Extends intent admission with an atomic started event. */
export interface DurableIntentEventStore extends DurableIntentStore {
  createIntentAndRunWithEvent(
    intent: ExecutionIntent,
    run: DurableRun,
    event: RunEvent,
  ): string;
}

/** Extends atomic Run admission for executions that append a transcript. */
export interface DurableConversationTurnStore extends DurableIntentEventStore {
  createIntentAndRunWithEventAndTurn(
    intent: ExecutionIntent,
    run: DurableRun,
    event: RunEvent,
  ): string;
  createRunWithEventAndTurn(run: DurableRun, event: RunEvent): string;
}

export interface DurableConversationTurnFinisher {
  finishConversationTurn(
    run: DurableRun,
    state: RunState,
    message: string,
  ): void;
}

export interface DurableConversationTurnEventFinisher {
  finishRunAndConversationTurn(
    run: DurableRun,
    state: RunState,
    message: string,
    event: RunEvent,
  ): string;
}

/** Marks the explicit, still-non-terminal persistence window. */
export interface DurableTerminalPersistenceStore {
  markTerminalizing(runId: string, message: string): void;
}

/** Atomically admits a linked Run and its initial event. */
export interface DurableRunEventStore {
  createRunWithEvent(run: DurableRun, event: RunEvent): string;
}

/**
 * Persists the canonical Run row alongside `RunEvent` records. It reuses the
 * existing `session_runs` schema so startup recovery can discover Runs from
 * every adapter.
 */
export class RunStore {
  sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  /**
   * Exposes the process-local loss signal for the Session lease. Persistence
   * methods still validate the durable epoch and token independently.
   */
  leaseLost(sessionId: string): AbortSignal | undefined {
    return runtimeLeaseLost(this.sessionDir, sessionId);
  }

  /**
   * Returns the exact local lease identity for a newly admitted Run. A durable
   * lease row owned elsewhere is an error; absence of a lease row remains a
   * compatibility path for embedded/test stores.
   */
  executionBinding(
    sessionId: string,
    runId: string,
  ): { binding: RuntimeLeaseBinding | null; ok: boolean } {
    if (this.sessionDir.trim() === "") {
      return { binding: null, ok: false };
    }
    const binding = currentRuntimeLeaseBinding(this.sessionDir, sessionId);
    if (binding !== null) {
      if (binding.purpose !== "execution" || binding.runId !== runId) {
        throw new RuntimeLeaseRunMismatchError(runId);
      }
      return { binding, ok: true };
    }
    const facts = readSessionExecutionFacts(this.sessionDir, sessionId);
    if (facts.lease !== null) {
      throw new RuntimeLeaseLostError(sessionId);
    }
    return { binding: null, ok: false };
  }

  /**
   * Transfers one reference of the current execution lease to the Runtime so
   * the adapter's admission guard can be released without revoking authority
   * needed by a terminal-persistence retry.
   */
  retainExecutionLease(
    sessionId: string,
    runId: string,
  ): {
    binding: RuntimeLeaseBinding | null;
    release: (() => void) | null;
    retained: boolean;
  } {
    return retainRuntimeLease(this.sessionDir, sessionId, runId);
  }

  /**
   * Promotes the current recovery/legacy lease before an existing durable Run
   * is reattached to an in-memory `ExecutionRuntime`.
   */
  prepareExistingExecution(sessionId: string, runId: string): void {
    if (this.sessionDir.trim() === "") return;
    bindRuntimeLeaseToExistingRun(this.sessionDir, sessionId, runId);
  }

  create(runInput: DurableRun): void {
    const run = { ...runInput };
    if (run.id === "" || run.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (run.status === "") run.status = "running";
    createSessionRun(this.sessionDir, durableRunToSessionRun(run));
  }

  update(runId: string, state: RunState, message: string): void {
    if (runId === "" || state === "") {
      throw new Error("durable run ID and state are required");
    }
    updateSessionRunStatus(
      this.sessionDir,
      runId,
      durableRunStatus(state),
      message,
      null,
    );
  }

  finish(runId: string, state: RunState, message: string): void {
    if (!isTerminalRunState(state)) {
      throw new Error(`durable run terminal state is invalid: ${state}`);
    }
    updateSessionRunStatus(
      this.sessionDir,
      runId,
      durableRunStatus(state),
      message,
      new Date(),
    );
  }

  markTerminalizing(runId: string, message: string): void {
    if (runId === "") {
      throw new Error("durable run ID is required");
    }
    updateSessionRunStatus(
      this.sessionDir,
      runId,
      durableRunStatus("terminalizing"),
      message,
      null,
    );
  }

  updateErrorInfo(runId: string, info: ErrorInfo): void {
    if (runId === "") {
      throw new Error("durable run ID is required");
    }
    updateSessionRunErrorInfo(this.sessionDir, runId, marshalErrorInfo(info));
  }

  updateProgress(runId: string, progress: RetryInfo): void {
    if (runId === "") {
      throw new Error("durable run ID is required");
    }
    updateSessionRunProgress(
      this.sessionDir,
      runId,
      marshalRetryInfo(progress),
    );
  }

  updateUsage(runId: string, usage: unknown, contextUsage: unknown): void {
    if (runId === "") {
      throw new Error("durable run ID is required");
    }
    updateSessionRunUsage(this.sessionDir, runId, usage, contextUsage);
  }

  createIntentAndRun(intent: ExecutionIntent, runInput: DurableRun): void {
    const run = { ...runInput };
    if (run.id === "" || run.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (run.status === "") run.status = "running";
    if (run.intentId === "") run.intentId = intent.id;
    createExecutionIntentAndSessionRun(
      this.sessionDir,
      intent,
      durableRunToSessionRun(run),
    );
  }

  createIntentAndRunWithEvent(
    intent: ExecutionIntent,
    runInput: DurableRun,
    event: RunEvent,
  ): string {
    const run = { ...runInput };
    if (run.id === "" || run.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (run.status === "") run.status = "running";
    if (run.intentId === "") run.intentId = intent.id;
    return createExecutionIntentAndSessionRunEvent(
      this.sessionDir,
      intent,
      durableRunToSessionRun(run),
      sessionRunEventFromRuntime(event),
    );
  }

  createIntentAndRunWithEventAndTurn(
    intent: ExecutionIntent,
    runInput: DurableRun,
    event: RunEvent,
  ): string {
    const run = { ...runInput };
    if (run.id === "" || run.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (run.status === "") run.status = "running";
    if (run.intentId === "") run.intentId = intent.id;
    return createExecutionIntentAndSessionRunEventWithTurn(
      this.sessionDir,
      intent,
      durableRunToSessionRun(run),
      sessionRunEventFromRuntime(event),
      {
        id: run.conversationTurnId,
        sessionId: run.sessionId,
        intentId: run.intentId,
        runId: run.id,
        attempt: run.attempt,
        kind: "",
        status: "",
        startSeq: 0,
        endSeq: null,
        startedAt: run.startedAt,
        endedAt: null,
      } satisfies ConversationTurn,
    );
  }

  createRunWithEvent(runInput: DurableRun, event: RunEvent): string {
    const run = { ...runInput };
    if (run.id === "" || run.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (run.status === "") run.status = "running";
    return createSessionRunAndEvent(
      this.sessionDir,
      durableRunToSessionRun(run),
      sessionRunEventFromRuntime(event),
    );
  }

  createRunWithEventAndTurn(runInput: DurableRun, event: RunEvent): string {
    const run = { ...runInput };
    if (run.id === "" || run.sessionId === "") {
      throw new Error("durable run ID and session ID are required");
    }
    if (run.status === "") run.status = "running";
    return createSessionRunAndEventWithTurn(
      this.sessionDir,
      durableRunToSessionRun(run),
      sessionRunEventFromRuntime(event),
      {
        id: run.conversationTurnId,
        sessionId: run.sessionId,
        intentId: run.intentId,
        runId: run.id,
        attempt: run.attempt,
        kind: "",
        status: "",
        startSeq: 0,
        endSeq: null,
        startedAt: run.startedAt,
        endedAt: null,
      } satisfies ConversationTurn,
    );
  }

  finishConversationTurn(
    run: DurableRun,
    state: RunState,
    message: string,
  ): void {
    if (
      !run.conversationTurn || run.conversationTurnId === "" ||
      run.sessionId === ""
    ) {
      return;
    }
    endConversationTurn(
      this.sessionDir,
      run.sessionId,
      run.conversationTurnId,
      durableRunStatus(state),
      message,
      new Date(),
    );
  }

  finishRunAndConversationTurn(
    run: DurableRun,
    state: RunState,
    message: string,
    event: RunEvent,
  ): string {
    if (!run.conversationTurn || run.conversationTurnId === "") {
      throw new Error("conversation turn is not configured");
    }
    const status = durableRunStatus(state);
    return finishSessionRunAndConversationTurn(
      this.sessionDir,
      {
        ...durableRunToSessionRun(run),
        status,
        finishedAt: new Date(),
        error: message,
        deliveryPlan: sessionDeliveryPlan(run.deliveryPlan),
      },
      sessionRunEventFromRuntime(event),
      run.conversationTurnId,
      status,
      message,
    );
  }

  getIntent(intentId: string): ExecutionIntent | null {
    return getExecutionIntent(this.sessionDir, intentId);
  }
}

function durableRunToSessionRun(run: DurableRun): SessionRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    intentId: run.intentId,
    retryOf: run.retryOf,
    attempt: run.attempt,
    workDir: run.workDir,
    source: run.source,
    model: run.model,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    errorInfo: marshalErrorInfo(run.errorInfo),
    progress: marshalRetryInfo(run.progress),
    usage: run.usage,
    contextUsage: run.contextUsage,
    inputResourceIds: [...run.inputResourceIds],
    submissionKeyHash: run.submissionKeyHash,
    submissionScope: run.submissionScope,
    submissionFingerprint: run.submissionFingerprint,
    userEntryId: run.userEntryId,
    userMessage: run.userMessage,
    assistantEntryId: run.assistantEntryId,
    assistantMessage: run.assistantMessage,
  };
}

/**
 * Converts the Runtime delivery plan to the session-owned durable outbox plan.
 * Misconfigured or absent plans stay absent; the terminal transaction only
 * persists a plan when an adapter explicitly attached one.
 */
function sessionDeliveryPlan(
  plan: DeliveryPlan | undefined,
): SessionDeliveryPlan | undefined {
  if (plan === undefined || plan === null) return undefined;
  const intent: SessionDeliveryIntent = {
    id: plan.intent.id,
    sessionId: plan.intent.sessionId,
    runId: plan.intent.runId,
    platform: plan.intent.platform,
    targetId: plan.intent.targetId,
    replyMessageId: plan.intent.replyMessageId,
    transportContext: plan.intent.transportContext,
    status: plan.intent.status,
    createdAt: plan.intent.createdAt,
    updatedAt: plan.intent.createdAt,
  };
  const operations: SessionDeliveryOperation[] = plan.operations.map((op) => ({
    id: op.id,
    intentId: plan.intent.id,
    operationKey: op.operationKey,
    artifactId: op.artifactId,
    operationKind: op.operationKind,
    sequence: op.sequence,
    dependsOn: op.dependsOn,
    idempotencyKey: op.idempotencyKey,
    payloadDigest: op.payloadDigest,
    status: op.status,
    providerAssetId: "",
    providerMessageId: "",
    providerState: undefined,
    attemptCount: 0,
    nextAttemptAt: null,
    failureCode: "",
    retryWindowStartedAt: null,
    leaseOwner: "",
    leaseEpoch: 0,
    createdAt: op.createdAt,
    updatedAt: op.createdAt,
  }));
  return { intent, operations };
}

/** Projects a Runtime run event onto the canonical session event row. */
export function sessionRunEventFromRuntime(event: RunEvent): SessionRunEvent {
  return {
    id: event.id ?? "",
    sessionId: event.sessionId,
    runId: event.runId,
    eventType: event.eventType,
    source: event.source,
    status: event.status,
    model: event.model,
    mode: event.mode,
    timestamp: event.timestamp ?? new Date(),
    data: event.data,
  };
}

/** Maps a canonical Run state onto its persisted status string. */
export function durableRunStatus(state: RunState): string {
  return state === "cancelled" ? "cancelled" : state;
}

function marshalErrorInfo(info: ErrorInfo): unknown {
  if (isEmptyErrorInfo(info)) return {};
  return info;
}

function marshalRetryInfo(info: RetryInfo): unknown {
  if (isEmptyRetryInfo(info)) return {};
  return info;
}

function isEmptyErrorInfo(info: ErrorInfo): boolean {
  return Object.keys(info as Record<string, unknown>).length === 0;
}

function isEmptyRetryInfo(info: RetryInfo): boolean {
  return Object.keys(info as Record<string, unknown>).length === 0;
}
