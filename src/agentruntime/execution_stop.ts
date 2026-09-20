// Ported from internal/agentruntime/execution_stop.go.
//
// The canonical stop matrix. Snapshot data is an expectation only: local
// cancellation and recovery revalidate the exact Run/lease binding before
// making a durable change.
//
// Deviation: `context.Context` maps to an optional `AbortSignal`, and Go's
// `(value, error)` pair throws instead.

import {
  acquireRecovery,
  beginSessionRunRecovery,
  markSessionRunRecoveryDetached,
  markSessionRunRecoveryFailed,
  readSessionExecutionFacts,
  type SessionRun,
} from "../session/mod.ts";
import {
  inspectSessionExecution,
  isRemoteResponseTerminal,
  registeredLocalExecution,
  SessionExecutionDetached,
  SessionExecutionExternal,
  SessionExecutionIdle,
  SessionExecutionInconsistent,
  SessionExecutionLocal,
  SessionExecutionOrphaned,
  SessionExecutionRecoveryFailed,
  SessionExecutionReserved,
  type SessionExecutionSnapshot,
  SessionExecutionUnknown,
} from "./execution.ts";
import { wakeRecoveryCoordinators } from "./recovery_coordinator.ts";
import {
  defaultRunRecoveryAction,
  RecoveryKeepRemote,
  stopOrphanedSessionRunWithSignal,
} from "./run_recovery.ts";
import { RunStateCancelling } from "./run_state.ts";

/** The adapter-neutral outcome of a stop request. */
export type SessionStopCode = string;

export const SessionStopAccepted: SessionStopCode = "stop_accepted";
export const SessionStopRemoteAccepted: SessionStopCode =
  "remote_stop_accepted";
export const SessionStopRecoveryStarted: SessionStopCode = "recovery_started";
export const SessionStopOwnedElsewhere: SessionStopCode =
  "session_run_owned_elsewhere";
export const SessionStopRemoteUnsupported: SessionStopCode =
  "remote_stop_unsupported";
export const SessionStopReserved: SessionStopCode = "session_reserved";
export const SessionStopNoActiveRun: SessionStopCode = "no_active_run";
export const SessionStopStateUnavailable: SessionStopCode =
  "session_execution_state_unavailable";
export const SessionStopRecoveryFailed: SessionStopCode =
  "session_recovery_failed";
export const SessionStopRemoteFailed: SessionStopCode = "remote_stop_failed";
export const SessionStopTargetChanged: SessionStopCode =
  "session_run_target_changed";

/** Distinguishes a missing cancel capability from an upstream failure. */
export class RemoteStopUnsupportedError extends Error {
  override name = "RemoteStopUnsupportedError";
}

/** Canonical provider execution identity for a remote stop request. */
export interface RemoteStopRequest {
  sessionId: string;
  runId: string;
  remoteRunId: string;
  provider: string;
  state: string;
}

/** Protocol/provider hooks while all Run/lease ownership stays shared. */
export interface SessionStopOptions {
  /** Scopes a stop request to the Run selected by the caller. */
  expectedRunId?: string;
  remoteCancel?: (
    ctx: AbortSignal | undefined,
    request: RemoteStopRequest,
  ) => Promise<void>;
  beforeOrphanTerminalize?: (run: SessionRun) => void | Promise<void>;
  /**
   * Migration bridge for embedded adapters with a process-local run but no
   * durable `session_runs` row.
   */
  legacyLocalCancel?: () => boolean;
}

/** Returned for both accepted and rejected requests. */
export interface SessionStopResult {
  code: SessionStopCode;
  execution: SessionExecutionSnapshot;
}

/**
 * Applies the canonical stop matrix for one session.
 */
export async function requestSessionStop(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  sessionId: string,
  options: SessionStopOptions = {},
): Promise<SessionStopResult> {
  let snapshot: SessionExecutionSnapshot;
  try {
    snapshot = inspectSessionExecution(sessionDir, sessionId);
  } catch (err) {
    const unavailable = unknownSnapshot(sessionId);
    throw new StopStateUnavailableError(
      { code: SessionStopStateUnavailable, execution: unavailable },
      err,
    );
  }
  const expected = options.expectedRunId ?? "";
  if (
    expected !== "" &&
    (snapshot.activeRun === undefined || snapshot.activeRun.id !== expected)
  ) {
    return { code: SessionStopTargetChanged, execution: snapshot };
  }
  switch (snapshot.state) {
    case SessionExecutionIdle: {
      const legacy = requestLegacyLocalStop(
        sessionDir,
        sessionId,
        snapshot,
        options.legacyLocalCancel,
      );
      if (legacy !== null) return legacy;
      return { code: SessionStopNoActiveRun, execution: snapshot };
    }
    case SessionExecutionReserved: {
      const legacy = requestLegacyLocalStop(
        sessionDir,
        sessionId,
        snapshot,
        options.legacyLocalCancel,
      );
      if (legacy !== null) return legacy;
      return { code: SessionStopReserved, execution: snapshot };
    }
    case SessionExecutionExternal:
      return { code: SessionStopOwnedElsewhere, execution: snapshot };
    case SessionExecutionInconsistent:
    case SessionExecutionUnknown:
      return { code: SessionStopStateUnavailable, execution: snapshot };
    case SessionExecutionLocal:
      return requestLocalSessionStop(sessionDir, snapshot);
    case SessionExecutionDetached:
      return await requestDetachedRemoteStop(
        ctx,
        sessionDir,
        snapshot,
        options.remoteCancel,
      );
    case SessionExecutionOrphaned:
    case SessionExecutionRecoveryFailed: {
      let recoveryErr: unknown = null;
      try {
        await stopOrphanedSessionRunWithSignal(
          ctx,
          sessionDir,
          sessionId,
          expected,
          options.beforeOrphanTerminalize ?? null,
        );
      } catch (err) {
        recoveryErr = err;
      }
      let latest: SessionExecutionSnapshot;
      let inspectErr: unknown = null;
      try {
        latest = inspectSessionExecution(sessionDir, sessionId);
      } catch (err) {
        inspectErr = err;
        latest = snapshot;
      }
      if (recoveryErr !== null) {
        throw new StopStateUnavailableError(
          { code: SessionStopRecoveryFailed, execution: latest },
          recoveryErr,
        );
      }
      if (inspectErr !== null) {
        throw new StopStateUnavailableError(
          { code: SessionStopStateUnavailable, execution: latest },
          inspectErr,
        );
      }
      if (latest.state === SessionExecutionIdle) {
        return { code: SessionStopRecoveryStarted, execution: latest };
      }
      return passiveSessionStopResult(latest);
    }
    default:
      return { code: SessionStopStateUnavailable, execution: snapshot };
  }
}

/** Carries a canonical stop result together with an optional failure. */
export class StopStateUnavailableError extends Error {
  override name = "StopStateUnavailableError";
  result: SessionStopResult;
  constructor(result: SessionStopResult, cause: unknown) {
    super(errorMessage(cause));
    this.result = result;
  }
}

function requestLegacyLocalStop(
  sessionDir: string,
  sessionId: string,
  snapshot: SessionExecutionSnapshot,
  cancel: (() => boolean) | undefined,
): SessionStopResult | null {
  if (cancel === undefined || !cancel()) return null;
  let latest: SessionExecutionSnapshot;
  try {
    latest = inspectSessionExecution(sessionDir, sessionId);
  } catch {
    return { code: SessionStopAccepted, execution: snapshot };
  }
  return { code: SessionStopAccepted, execution: latest };
}

function requestLocalSessionStop(
  sessionDir: string,
  expectedIn: SessionExecutionSnapshot,
): SessionStopResult {
  let expected = expectedIn;
  const local = localExecutionForStop(sessionDir, expected);
  if (local === null) {
    let latest: SessionExecutionSnapshot;
    try {
      latest = inspectSessionExecution(sessionDir, expected.sessionId);
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SessionStopStateUnavailable, execution: expected },
        err,
      );
    }
    return passiveSessionStopResult(latest);
  }
  let accepted: boolean;
  try {
    accepted = local.runtime.cancelDurable(
      "run cancellation requested by user",
    );
  } catch (err) {
    let latest: SessionExecutionSnapshot | null = null;
    try {
      latest = inspectSessionExecution(sessionDir, expected.sessionId);
    } catch {
      latest = null;
    }
    if (latest !== null && latest.state !== SessionExecutionLocal) {
      return passiveSessionStopResult(latest);
    }
    if (latest !== null) expected = latest;
    throw new StopStateUnavailableError(
      { code: SessionStopStateUnavailable, execution: expected },
      err,
    );
  }
  if (!accepted) {
    let latest: SessionExecutionSnapshot;
    try {
      latest = inspectSessionExecution(sessionDir, expected.sessionId);
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SessionStopStateUnavailable, execution: expected },
        err,
      );
    }
    return passiveSessionStopResult(latest);
  }
  let latest: SessionExecutionSnapshot;
  try {
    latest = inspectSessionExecution(sessionDir, expected.sessionId);
  } catch {
    if (expected.activeRun !== undefined) {
      expected.activeRun.status = RunStateCancelling;
    }
    return { code: SessionStopAccepted, execution: expected };
  }
  return { code: SessionStopAccepted, execution: latest };
}

function localExecutionForStop(
  sessionDir: string,
  expected: SessionExecutionSnapshot,
): { runtime: import("./execution.ts").ExecutionRuntime } | null {
  if (
    expected.activeRun === undefined || expected.state !== SessionExecutionLocal
  ) {
    return null;
  }
  const facts = readSessionExecutionFacts(sessionDir, expected.sessionId);
  const lease = facts.lease;
  if (
    facts.activeRuns.length !== 1 ||
    facts.activeRuns[0].id !== expected.activeRun.id ||
    lease === null || !lease.valid ||
    lease.purpose !== "execution" ||
    lease.runId !== expected.activeRun.id ||
    lease.epoch !== expected.leaseEpoch ||
    lease.ownerInstanceId !== expected.leaseOwnerInstanceId ||
    lease.tokenHash !== expected.leaseTokenIdentity
  ) {
    return null;
  }
  const runtime = registeredLocalExecution(
    facts.databaseIdentity,
    facts.activeRuns[0],
    lease,
  );
  return runtime === null ? null : { runtime };
}

async function requestDetachedRemoteStop(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  expected: SessionExecutionSnapshot,
  cancel:
    | ((
      ctx: AbortSignal | undefined,
      request: RemoteStopRequest,
    ) => Promise<void>)
    | undefined,
): Promise<SessionStopResult> {
  if (expected.activeRun === undefined || expected.remoteRunId === "") {
    return { code: SessionStopStateUnavailable, execution: expected };
  }
  if (!expected.canCancelRemote || cancel === undefined) {
    if (isRemoteResponseTerminal(expected.remoteState)) {
      wakeRecoveryCoordinators(sessionDir);
      return { code: SessionStopRecoveryStarted, execution: expected };
    }
    return { code: SessionStopRemoteUnsupported, execution: expected };
  }
  let guard: ReturnType<typeof acquireRecovery>;
  try {
    guard = acquireRecovery(
      sessionDir,
      expected.sessionId,
      expected.activeRun.id,
    );
  } catch {
    let latest: SessionExecutionSnapshot;
    try {
      latest = inspectSessionExecution(sessionDir, expected.sessionId);
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SessionStopStateUnavailable, execution: expected },
        err,
      );
    }
    return passiveSessionStopResult(latest);
  }
  let released = false;
  try {
    const facts = readSessionExecutionFacts(sessionDir, expected.sessionId);
    const binding = guard.binding();
    const lease = facts.lease;
    if (
      facts.activeRuns.length !== 1 ||
      facts.activeRuns[0].id !== expected.activeRun.id ||
      lease === null || !lease.valid ||
      lease.purpose !== "recovery" ||
      lease.runId !== expected.activeRun.id ||
      lease.ownerInstanceId !== binding.ownerInstanceId ||
      lease.tokenHash !== binding.tokenHash ||
      lease.epoch !== binding.epoch ||
      defaultRunRecoveryAction(facts) !== RecoveryKeepRemote
    ) {
      guard.release();
      released = true;
      let latest: SessionExecutionSnapshot;
      try {
        latest = inspectSessionExecution(sessionDir, expected.sessionId);
      } catch (err) {
        throw new StopStateUnavailableError(
          { code: SessionStopStateUnavailable, execution: expected },
          err,
        );
      }
      return passiveSessionStopResult(latest);
    }

    const run = facts.activeRuns[0];
    let recovery;
    try {
      recovery = beginSessionRunRecovery(
        sessionDir,
        run.sessionId,
        run.id,
        "user_stop",
        "remote_run_cancelled_by_user",
        expected.leaseEpoch,
      );
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SessionStopStateUnavailable, execution: expected },
        err,
      );
    }
    const remote = facts.remoteRun;
    if (remote === null) {
      return { code: SessionStopStateUnavailable, execution: expected };
    }
    try {
      await cancel(ctx, {
        sessionId: run.sessionId,
        runId: run.id,
        remoteRunId: remote.localRunId,
        provider: remote.provider,
        state: remote.state,
      });
    } catch (err) {
      if (err instanceof RemoteStopUnsupportedError) {
        markSessionRunRecoveryDetached(sessionDir, run.sessionId, run.id);
        return { code: SessionStopRemoteUnsupported, execution: expected };
      }
      const failure = failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        new Error(`cancel remote run: ${errorMessage(err)}`),
      );
      throw new StopStateUnavailableError(
        { code: SessionStopRemoteFailed, execution: expected },
        failure,
      );
    }
    try {
      markSessionRunRecoveryDetached(sessionDir, run.sessionId, run.id);
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SessionStopStateUnavailable, execution: expected },
        err,
      );
    }
    guard.release();
    released = true;
    wakeRecoveryCoordinators(sessionDir);
    let latest: SessionExecutionSnapshot;
    try {
      latest = inspectSessionExecution(sessionDir, expected.sessionId);
    } catch {
      latest = expected;
    }
    return { code: SessionStopRemoteAccepted, execution: latest };
  } finally {
    if (!released) guard.release();
  }
}

function passiveSessionStopResult(
  snapshot: SessionExecutionSnapshot,
): SessionStopResult {
  let code: SessionStopCode = SessionStopStateUnavailable;
  switch (snapshot.state) {
    case SessionExecutionIdle:
      code = SessionStopNoActiveRun;
      break;
    case SessionExecutionReserved:
      code = SessionStopReserved;
      break;
    case SessionExecutionExternal:
      code = SessionStopOwnedElsewhere;
      break;
    case SessionExecutionDetached:
      code = SessionStopRemoteUnsupported;
      break;
    case SessionExecutionOrphaned:
    case SessionExecutionRecoveryFailed:
      code = SessionStopRecoveryFailed;
      break;
  }
  return { code, execution: snapshot };
}

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

function unknownSnapshot(sessionId: string): SessionExecutionSnapshot {
  return {
    sessionId,
    sessionExists: false,
    state: SessionExecutionUnknown,
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
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
