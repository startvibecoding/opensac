// Ported from internal/agentruntime/run_recovery.go.
//
// Lease-first orphan convergence for one canonical Session database. Ownership
// is decided only by the fenced recovery lease, never by process-local state;
// an expired row that still carries our identity is still ours. The Go
// goroutine worker pool maps to a bounded asynchronous worker pool so a slow
// adapter callback cannot block other Sessions; the session/DAO layer stays
// synchronous.
//
// Deviations from Go: `context.Context` maps to an optional `AbortSignal`,
// `time.Duration` maps to milliseconds, `time.Time` maps to `Date`, and the
// `(value, error)` pair throws instead.

import {
  acquireRecovery,
  beginSessionRunRecovery,
  convergeSessionRunRecovery,
  getActiveSessionRun,
  listOrphanedSessionRuns,
  markSessionRunRecoveryDetached,
  markSessionRunRecoveryFailed,
  RuntimeLeaseBusyError,
  RuntimeLeaseRunMismatchError,
  RuntimeSessionNotFoundError,
  type SessionExecutionFacts,
  SessionRecoveryNotNeededError,
  type SessionRun,
} from "../session/mod.ts";
import { readSessionExecutionFacts } from "../session/execution_facts.ts";
import {
  decisionEventEnvelope,
  loadRunDecisionRecords,
} from "./decision_events.ts";
import { newDecisionResolutionRecord } from "./decision_record.ts";
import { replayDecisions } from "./decision_replay.ts";
import {
  DecisionApproval,
  DecisionQuestion,
  type DecisionRequest,
  type DecisionResolution,
} from "./decision.ts";
import { type RunEvent } from "./run_event.ts";
import { durableRunStatus, sessionRunEventFromRuntime } from "./run_store.ts";
import {
  type RunState,
  RunStateCancelled,
  RunStateFailed,
} from "./run_state.ts";

export type RecoveryAction = string;

export const RecoveryFailLocal: RecoveryAction = "fail_local";
export const RecoveryKeepRemote: RecoveryAction = "keep_remote";

/** A caller-owned policy that decides how one orphaned Run is reconciled. */
export type RunRecoveryPolicy = (run: SessionRun) => RecoveryAction;

/** The Runtime-owned convergence outcome, in scan order per bucket. */
export interface RunRecoveryResult {
  failed: SessionRun[];
  kept: SessionRun[];
  skipped: SessionRun[];
}

/** Bounded worker-pool size for a full orphan scan. */
export const recoveryWorkerLimit = 8;

/** Default attempt timeout for the startup/admission recovery paths. */
export const defaultRecoveryAttemptTimeoutMs = 10_000;

/** Bounds the fresh persistence context used after an attempt failure. */
export const recoveryFailurePersistenceTimeoutMs = 5_000;

interface RecoveryAttemptResult {
  index: number;
  run: SessionRun;
  action: RecoveryAction;
  err?: Error;
}

/**
 * Fails local Agent loops, which cannot survive process termination.
 * Provider-native remote execution must be retained only by a caller that has
 * resolved a canonical remote run record and capability; `run.source` alone is
 * not evidence that a provider task still exists.
 */
export function defaultRunRecoveryPolicy(_run: SessionRun): RecoveryAction {
  return RecoveryFailLocal;
}

/**
 * Applies one shared startup policy to all durable runs. `beforeFail` may
 * persist adapter-compatible decision cleanup before the Run is marked failed.
 */
export function recoverOrphanedRuns(
  sessionDir: string,
  policy?: RunRecoveryPolicy | null,
  beforeFail?: BeforeFail | null,
): Promise<RunRecoveryResult> {
  return recoverOrphanedRunsWithTrigger(
    undefined,
    sessionDir,
    "startup",
    defaultRecoveryAttemptTimeoutMs,
    policy,
    beforeFail,
  );
}

/** Optional adapter cleanup invoked before an orphaned Run is failed. */
export type BeforeFail = (run: SessionRun) => void | Promise<void>;

/**
 * Runs the shared recovery path for the supplied trigger. `attemptTimeoutMs`
 * bounds each attempt; it does not change ownership.
 */
export async function recoverOrphanedRunsWithTrigger(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  trigger: string,
  attemptTimeoutMs: number,
  policy?: RunRecoveryPolicy | null,
  beforeFail?: BeforeFail | null,
): Promise<RunRecoveryResult> {
  const result: RunRecoveryResult = { failed: [], kept: [], skipped: [] };
  const orphans = listOrphanedSessionRuns(sessionDir);
  const workerCount = Math.min(recoveryWorkerLimit, orphans.length);
  let nextIndex = 0;
  const attempts: RecoveryAttemptResult[] = new Array(orphans.length);

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= orphans.length) return;
      const run = orphans[index];
      if (ctx?.aborted) {
        attempts[index] = { index, run, action: "", err: abortError(ctx) };
        continue;
      }
      const reason = trigger === "periodic"
        ? "execution owner lease expired while run was active"
        : "server restarted while run was active";
      const attemptCtx: CombinedSignal = attemptTimeoutMs > 0
        ? combineSignals(ctx, attemptTimeoutMs)
        : { signal: ctx, cleanup: () => {} };
      try {
        const action = await recoverOrphanedRun(
          attemptCtx.signal,
          sessionDir,
          run,
          policy ?? null,
          beforeFail ?? null,
          trigger,
          "owner_lost",
          reason,
          RunStateFailed,
        );
        attempts[index] = { index, run, action };
      } catch (err) {
        attempts[index] = {
          index,
          run,
          action: "",
          err: err instanceof Error ? err : new Error(String(err)),
        };
      } finally {
        attemptCtx.cleanup();
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  let firstErr: Error | undefined;
  for (const attempt of attempts) {
    if (attempt.err !== undefined) {
      if (firstErr === undefined) firstErr = attempt.err;
      continue;
    }
    switch (attempt.action) {
      case RecoveryKeepRemote:
        result.kept.push(attempt.run);
        break;
      case RecoveryFailLocal:
        result.failed.push(attempt.run);
        break;
      default:
        result.skipped.push(attempt.run);
    }
  }
  if (firstErr !== undefined) throw firstErr;
  return result;
}

/**
 * Reconciles the one active Run for a Session before a new local execution is
 * admitted. It acquires its own purpose=recovery lease; callers must not
 * pre-acquire a generic Session lease. A valid owner is skipped, not
 * terminalized. Remotely resumable Runs are retained only when the supplied
 * policy has verified their durable provider state.
 */
export function recoverOrphanedSessionRun(
  sessionDir: string,
  sessionId: string,
  policy?: RunRecoveryPolicy | null,
  beforeFail?: BeforeFail | null,
): Promise<RunRecoveryResult> {
  return recoverOrphanedSessionRunWithSignal(
    undefined,
    sessionDir,
    sessionId,
    policy,
    beforeFail,
  );
}

/** The signal-bounded admission recovery path used by Runtime callers. */
export async function recoverOrphanedSessionRunWithSignal(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  sessionId: string,
  policy?: RunRecoveryPolicy | null,
  beforeFail?: BeforeFail | null,
): Promise<RunRecoveryResult> {
  const result: RunRecoveryResult = { failed: [], kept: [], skipped: [] };
  if (ctx?.aborted) throw abortError(ctx);
  const run = getActiveSessionRun(sessionDir, sessionId);
  if (run === null) return result;
  const action = await recoverOrphanedRun(
    ctx,
    sessionDir,
    run,
    policy ?? null,
    beforeFail ?? null,
    "admission",
    "owner_lost",
    "run remained active when the session became available for a new local execution",
    RunStateFailed,
  );
  if (action === RecoveryKeepRemote) result.kept.push(run);
  else if (action === RecoveryFailLocal) result.failed.push(run);
  else result.skipped.push(run);
  return result;
}

/**
 * Performs the user-triggered form of orphan reconciliation. It uses the same
 * recovery lease/fencing path as automatic recovery but records a cancelled
 * terminal state and a distinct reason.
 */
export function stopOrphanedSessionRun(
  sessionDir: string,
  sessionId: string,
  beforeTerminalize?: BeforeFail | null,
): Promise<RunRecoveryResult> {
  return stopOrphanedSessionRunWithSignal(
    undefined,
    sessionDir,
    sessionId,
    "",
    beforeTerminalize,
  );
}

/**
 * Target-scoped user-triggered orphan convergence. An empty `expectedRunId`
 * preserves the session-wide behavior; a non-empty value prevents a stale
 * caller from terminalizing a newer Run admitted after its initial inspection.
 */
export async function stopOrphanedSessionRunWithSignal(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  sessionId: string,
  expectedRunId: string,
  beforeTerminalize?: BeforeFail | null,
): Promise<RunRecoveryResult> {
  const result: RunRecoveryResult = { failed: [], kept: [], skipped: [] };
  if (ctx?.aborted) throw abortError(ctx);
  const run = getActiveSessionRun(sessionDir, sessionId);
  if (run === null) return result;
  if (expectedRunId !== "" && run.id !== expectedRunId) return result;
  const action = await recoverOrphanedRun(
    ctx,
    sessionDir,
    run,
    null,
    beforeTerminalize ?? null,
    "user_stop",
    "cancelled_by_user_after_owner_loss",
    "run cancelled by user after its execution owner was lost",
    RunStateCancelled,
  );
  if (action === RecoveryKeepRemote) result.kept.push(run);
  else if (action === RecoveryFailLocal) result.failed.push(run);
  else result.skipped.push(run);
  return result;
}

async function recoverOrphanedRun(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  run: SessionRun,
  policy: RunRecoveryPolicy | null,
  beforeFail: BeforeFail | null,
  trigger: string,
  reasonCode: string,
  reason: string,
  terminalState: RunState,
): Promise<RecoveryAction> {
  if (ctx?.aborted) throw abortError(ctx);
  let facts = readSessionExecutionFacts(sessionDir, run.sessionId);
  if (!facts.sessionExists) {
    throw new RuntimeSessionNotFoundError(run.id);
  }
  if (facts.activeRuns.length === 0) return "";
  if (facts.activeRuns.length !== 1 || facts.activeRuns[0].id !== run.id) {
    throw new RuntimeLeaseRunMismatchError(run.id);
  }
  if (facts.lease !== null && facts.lease.valid) {
    // The lease may be external execution, an admission hand-off, or another
    // recovery worker. None can be overridden merely because this process has
    // no matching in-memory runtime.
    return "";
  }
  if (
    (trigger === "startup" || trigger === "periodic") &&
    facts.recovery !== null && facts.recovery.state === "failed" &&
    facts.recovery.nextRetryAt !== null &&
    facts.databaseNow.getTime() < facts.recovery.nextRetryAt.getTime()
  ) {
    return "";
  }
  let previousEpoch = 0;
  if (facts.lease !== null) previousEpoch = facts.lease.epoch;

  let guard;
  try {
    guard = acquireRecovery(sessionDir, run.sessionId, run.id);
  } catch (err) {
    if (
      err instanceof RuntimeLeaseBusyError ||
      err instanceof SessionRecoveryNotNeededError
    ) {
      return "";
    }
    throw err;
  }
  try {
    if (ctx?.aborted) throw abortError(ctx);
    // Acquisition and terminalization are separate transactions. Re-read all
    // facts under the acquired epoch and require the exact recovery binding
    // before consulting policy or writing any terminal state.
    facts = readSessionExecutionFacts(sessionDir, run.sessionId);
    const binding = guard.binding();
    if (facts.activeRuns.length === 0) return "";
    if (
      facts.activeRuns.length !== 1 || facts.activeRuns[0].id !== run.id ||
      facts.lease === null || !facts.lease.valid ||
      facts.lease.purpose !== "recovery" || facts.lease.runId !== run.id ||
      facts.lease.ownerInstanceId !== binding.ownerInstanceId ||
      facts.lease.tokenHash !== binding.tokenHash ||
      facts.lease.epoch !== binding.epoch
    ) {
      throw new RuntimeLeaseRunMismatchError(run.id);
    }
    run = facts.activeRuns[0];
    const recovery = beginSessionRunRecovery(
      sessionDir,
      run.sessionId,
      run.id,
      trigger,
      reasonCode,
      previousEpoch,
    );
    if (ctx?.aborted) {
      throw failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        abortError(ctx),
      );
    }
    const action = policy !== null
      ? policy(run)
      : defaultRunRecoveryAction(facts);
    if (action === RecoveryKeepRemote) {
      markSessionRunRecoveryDetached(sessionDir, run.sessionId, run.id);
      return RecoveryKeepRemote;
    }
    if (beforeFail !== null) {
      try {
        await beforeFail(run);
      } catch (err) {
        throw failRunRecoveryAttempt(
          sessionDir,
          run,
          recovery.attempt,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      if (ctx?.aborted) {
        throw failRunRecoveryAttempt(
          sessionDir,
          run,
          recovery.attempt,
          abortError(ctx),
        );
      }
    }
    let decisionEvents;
    try {
      decisionEvents = recoveryDecisionResolutionEvents(
        sessionDir,
        run,
        reasonCode,
        reason,
      );
    } catch (err) {
      throw failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        new Error(
          `resolve recovery decisions: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    let data: unknown;
    try {
      data = JSON.stringify({ reason, code: reasonCode });
    } catch (err) {
      throw failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        new Error(
          `marshal recovery reason: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    if (ctx?.aborted) {
      throw failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        abortError(ctx),
      );
    }
    const finishedAt = new Date();
    run.status = durableRunStatus(terminalState);
    run.error = reason;
    run.finishedAt = finishedAt;
    const terminalEvent: RunEvent = {
      id: `recovery_${run.id}_${terminalState}`,
      sessionId: run.sessionId,
      runId: run.id,
      eventType: "recovered",
      source: "agentruntime",
      status: terminalState,
      model: run.model,
      mode: run.mode,
      timestamp: finishedAt,
      data,
    };
    try {
      convergeSessionRunRecovery(
        sessionDir,
        run,
        sessionRunEventFromRuntime(terminalEvent),
        decisionEvents,
        terminalState,
        reason,
      );
    } catch (err) {
      throw failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        new Error(
          `recover orphaned run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    return RecoveryFailLocal;
  } finally {
    guard.release();
  }
}

function recoveryDecisionResolutionEvents(
  sessionDir: string,
  run: SessionRun,
  reasonCode: string,
  reason: string,
): ReturnType<typeof sessionRunEventFromRuntime>[] {
  const records = loadRunDecisionRecords(sessionDir, run.sessionId, run.id);
  const pending = replayDecisions(records);
  const ids = [...pending.keys()].sort();
  const result: ReturnType<typeof sessionRunEventFromRuntime>[] = [];
  for (const id of ids) {
    const requestRecord = pending.get(id)!;
    const request: DecisionRequest = {
      id: requestRecord.id,
      sessionId: run.sessionId,
      runId: run.id,
      kind: requestRecord.kind,
    };
    let value = "";
    let eventType = "decision_resolved";
    switch (requestRecord.kind) {
      case DecisionApproval:
        value = "deny_once";
        eventType = "approval_resolved";
        break;
      case DecisionQuestion:
        eventType = "question_resolved";
    }
    const resolution: DecisionResolution = {
      id,
      kind: requestRecord.kind,
      status: "cancelled",
      value,
    };
    const record = newDecisionResolutionRecord(request, resolution, {
      reason,
      code: reasonCode,
    });
    result.push(sessionRunEventFromRuntime({
      id: `recovery_decision_${run.id}_${id}`,
      sessionId: run.sessionId,
      runId: run.id,
      eventType,
      source: "agentruntime",
      status: "cancelled",
      model: run.model,
      mode: run.mode,
      timestamp: new Date(),
      data: decisionEventEnvelope(record),
    }));
  }
  return result;
}

export function defaultRunRecoveryAction(
  facts: SessionExecutionFacts,
): RecoveryAction {
  if (facts.activeRuns.length !== 1 || facts.remoteRun === null) {
    return RecoveryFailLocal;
  }
  const run = facts.activeRuns[0];
  const remote = facts.remoteRun;
  if (
    run.source !== "responses_background" ||
    remote.sessionId !== run.sessionId ||
    remote.responseId === "" || remote.provider === "" ||
    remote.api !== "openai-responses"
  ) {
    return RecoveryFailLocal;
  }
  return RecoveryKeepRemote;
}

/**
 * Persists the retryable failure marker under a fresh bounded budget so the
 * next coordinator observes `recovery_failed` instead of a stale row, then
 * rethrows the originating cause.
 */
function failRunRecoveryAttempt(
  sessionDir: string,
  run: SessionRun,
  attempt: number,
  cause: Error,
): Error {
  let delayMs = 1_000;
  for (let i = 1; i < attempt && delayMs < 60_000; i++) {
    delayMs *= 2;
    if (delayMs > 60_000) delayMs = 60_000;
  }
  const nextRetryAt = new Date(Date.now() + delayMs);
  markSessionRunRecoveryFailed(
    sessionDir,
    run.sessionId,
    run.id,
    cause.message,
    nextRetryAt,
  );
  return cause;
}

/** A combined parent/timeout signal plus its cleanup hook. */
interface CombinedSignal {
  signal: AbortSignal | undefined;
  cleanup: () => void;
}

function combineSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): CombinedSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException("recovery attempt deadline exceeded", "TimeoutError"),
    );
  }, timeoutMs);
  const onParentAbort = () => {
    if (parent !== undefined) controller.abort(abortError(parent));
  };
  if (parent !== undefined) {
    if (parent.aborted) {
      controller.abort(abortError(parent));
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new DOMException("recovery aborted", "AbortError");
}
