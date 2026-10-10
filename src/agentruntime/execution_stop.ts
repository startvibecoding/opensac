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
  SESSION_EXECUTION_DETACHED,
  SESSION_EXECUTION_EXTERNAL,
  SESSION_EXECUTION_IDLE,
  SESSION_EXECUTION_INCONSISTENT,
  SESSION_EXECUTION_LOCAL,
  SESSION_EXECUTION_ORPHANED,
  SESSION_EXECUTION_RECOVERY_FAILED,
  SESSION_EXECUTION_RESERVED,
  SESSION_EXECUTION_UNKNOWN,
  type SessionExecutionSnapshot,
} from "./execution.ts";
import { wakeRecoveryCoordinators } from "./recovery_coordinator.ts";
import {
  defaultRunRecoveryAction,
  RECOVERY_KEEP_REMOTE,
  stopOrphanedSessionRunWithSignal,
} from "./run_recovery.ts";
import { RUN_STATE_CANCELLING } from "./run_state.ts";

/** The adapter-neutral outcome of a stop request. */
export type SessionStopCode = string;

export const SESSION_STOP_ACCEPTED: SessionStopCode = "stop_accepted";
export const SESSION_STOP_REMOTE_ACCEPTED: SessionStopCode =
  "remote_stop_accepted";
export const SESSION_STOP_RECOVERY_STARTED: SessionStopCode =
  "recovery_started";
export const SESSION_STOP_OWNED_ELSEWHERE: SessionStopCode =
  "session_run_owned_elsewhere";
export const SESSION_STOP_REMOTE_UNSUPPORTED: SessionStopCode =
  "remote_stop_unsupported";
export const SESSION_STOP_RESERVED: SessionStopCode = "session_reserved";
export const SESSION_STOP_NO_ACTIVE_RUN: SessionStopCode = "no_active_run";
export const SESSION_STOP_STATE_UNAVAILABLE: SessionStopCode =
  "session_execution_state_unavailable";
export const SESSION_STOP_RECOVERY_FAILED: SessionStopCode =
  "session_recovery_failed";
export const SESSION_STOP_REMOTE_FAILED: SessionStopCode = "remote_stop_failed";
export const SESSION_STOP_TARGET_CHANGED: SessionStopCode =
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
      { code: SESSION_STOP_STATE_UNAVAILABLE, execution: unavailable },
      err,
    );
  }
  const expected = options.expectedRunId ?? "";
  if (
    expected !== "" &&
    (snapshot.activeRun === undefined || snapshot.activeRun.id !== expected)
  ) {
    return { code: SESSION_STOP_TARGET_CHANGED, execution: snapshot };
  }
  switch (snapshot.state) {
    case SESSION_EXECUTION_IDLE: {
      const legacy = requestLegacyLocalStop(
        sessionDir,
        sessionId,
        snapshot,
        options.legacyLocalCancel,
      );
      if (legacy !== null) return legacy;
      return { code: SESSION_STOP_NO_ACTIVE_RUN, execution: snapshot };
    }
    case SESSION_EXECUTION_RESERVED: {
      const legacy = requestLegacyLocalStop(
        sessionDir,
        sessionId,
        snapshot,
        options.legacyLocalCancel,
      );
      if (legacy !== null) return legacy;
      return { code: SESSION_STOP_RESERVED, execution: snapshot };
    }
    case SESSION_EXECUTION_EXTERNAL:
      return { code: SESSION_STOP_OWNED_ELSEWHERE, execution: snapshot };
    case SESSION_EXECUTION_INCONSISTENT:
    case SESSION_EXECUTION_UNKNOWN:
      return { code: SESSION_STOP_STATE_UNAVAILABLE, execution: snapshot };
    case SESSION_EXECUTION_LOCAL:
      return requestLocalSessionStop(sessionDir, snapshot);
    case SESSION_EXECUTION_DETACHED:
      return await requestDetachedRemoteStop(
        ctx,
        sessionDir,
        snapshot,
        options.remoteCancel,
      );
    case SESSION_EXECUTION_ORPHANED:
    case SESSION_EXECUTION_RECOVERY_FAILED: {
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
          { code: SESSION_STOP_RECOVERY_FAILED, execution: latest },
          recoveryErr,
        );
      }
      if (inspectErr !== null) {
        throw new StopStateUnavailableError(
          { code: SESSION_STOP_STATE_UNAVAILABLE, execution: latest },
          inspectErr,
        );
      }
      if (latest.state === SESSION_EXECUTION_IDLE) {
        return { code: SESSION_STOP_RECOVERY_STARTED, execution: latest };
      }
      return passiveSessionStopResult(latest);
    }
    default:
      return { code: SESSION_STOP_STATE_UNAVAILABLE, execution: snapshot };
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
    return { code: SESSION_STOP_ACCEPTED, execution: snapshot };
  }
  return { code: SESSION_STOP_ACCEPTED, execution: latest };
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
        { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
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
    if (latest !== null && latest.state !== SESSION_EXECUTION_LOCAL) {
      return passiveSessionStopResult(latest);
    }
    if (latest !== null) expected = latest;
    throw new StopStateUnavailableError(
      { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
      err,
    );
  }
  if (!accepted) {
    let latest: SessionExecutionSnapshot;
    try {
      latest = inspectSessionExecution(sessionDir, expected.sessionId);
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
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
      expected.activeRun.status = RUN_STATE_CANCELLING;
    }
    return { code: SESSION_STOP_ACCEPTED, execution: expected };
  }
  return { code: SESSION_STOP_ACCEPTED, execution: latest };
}

function localExecutionForStop(
  sessionDir: string,
  expected: SessionExecutionSnapshot,
): { runtime: import("./execution.ts").ExecutionRuntime } | null {
  if (
    expected.activeRun === undefined ||
    expected.state !== SESSION_EXECUTION_LOCAL
  ) {
    return null;
  }
  const facts = readSessionExecutionFacts(sessionDir, expected.sessionId);
  const lease = facts.lease;
  if (
    facts.activeRuns.length !== 1 ||
    facts.activeRuns[0].id !== expected.activeRun.id ||
    lease === null ||
    !lease.valid ||
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
    return { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected };
  }
  if (!expected.canCancelRemote || cancel === undefined) {
    if (isRemoteResponseTerminal(expected.remoteState)) {
      wakeRecoveryCoordinators(sessionDir);
      return { code: SESSION_STOP_RECOVERY_STARTED, execution: expected };
    }
    return { code: SESSION_STOP_REMOTE_UNSUPPORTED, execution: expected };
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
        { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
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
      lease === null ||
      !lease.valid ||
      lease.purpose !== "recovery" ||
      lease.runId !== expected.activeRun.id ||
      lease.ownerInstanceId !== binding.ownerInstanceId ||
      lease.tokenHash !== binding.tokenHash ||
      lease.epoch !== binding.epoch ||
      defaultRunRecoveryAction(facts) !== RECOVERY_KEEP_REMOTE
    ) {
      guard.release();
      released = true;
      let latest: SessionExecutionSnapshot;
      try {
        latest = inspectSessionExecution(sessionDir, expected.sessionId);
      } catch (err) {
        throw new StopStateUnavailableError(
          { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
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
        { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
        err,
      );
    }
    const remote = facts.remoteRun;
    if (remote === null) {
      return { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected };
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
        return { code: SESSION_STOP_REMOTE_UNSUPPORTED, execution: expected };
      }
      const failure = failRunRecoveryAttempt(
        sessionDir,
        run,
        recovery.attempt,
        new Error(`cancel remote run: ${errorMessage(err)}`),
      );
      throw new StopStateUnavailableError(
        { code: SESSION_STOP_REMOTE_FAILED, execution: expected },
        failure,
      );
    }
    try {
      markSessionRunRecoveryDetached(sessionDir, run.sessionId, run.id);
    } catch (err) {
      throw new StopStateUnavailableError(
        { code: SESSION_STOP_STATE_UNAVAILABLE, execution: expected },
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
    return { code: SESSION_STOP_REMOTE_ACCEPTED, execution: latest };
  } finally {
    if (!released) guard.release();
  }
}

function passiveSessionStopResult(
  snapshot: SessionExecutionSnapshot,
): SessionStopResult {
  let code: SessionStopCode = SESSION_STOP_STATE_UNAVAILABLE;
  switch (snapshot.state) {
    case SESSION_EXECUTION_IDLE:
      code = SESSION_STOP_NO_ACTIVE_RUN;
      break;
    case SESSION_EXECUTION_RESERVED:
      code = SESSION_STOP_RESERVED;
      break;
    case SESSION_EXECUTION_EXTERNAL:
      code = SESSION_STOP_OWNED_ELSEWHERE;
      break;
    case SESSION_EXECUTION_DETACHED:
      code = SESSION_STOP_REMOTE_UNSUPPORTED;
      break;
    case SESSION_EXECUTION_ORPHANED:
    case SESSION_EXECUTION_RECOVERY_FAILED:
      code = SESSION_STOP_RECOVERY_FAILED;
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
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
