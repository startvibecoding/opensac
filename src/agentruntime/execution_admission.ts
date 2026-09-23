//
// Front-end-neutral admission/lease acquisition. A stale durable Run blocking
// admission is reconciled through the same lease-first Runtime recovery path
// before retrying; a valid local or external owner is never displaced.
//
// Deviation: `context.Context` maps to an optional `AbortSignal` and
// `time.Duration` maps to milliseconds.

import {
  acquireExecutionAdmission as sessionAcquireExecutionAdmission,
  acquireMutation,
  RuntimeLeaseBusyError,
  type RuntimeLeaseGuard,
  SessionRecoveryRequiredError,
  type SessionRun,
  SessionRunActiveError,
} from "../session/mod.ts";
import {
  recoverOrphanedSessionRunWithSignal,
  type RunRecoveryPolicy,
} from "./run_recovery.ts";

/** Raised when a session has a recoverable detached remote execution. */
export class DetachedRemoteExecutionError extends Error {
  override name = "DetachedRemoteExecutionError";
}

/** Controls how a caller waits for ownership and reconciles an orphan. */
export interface ExecutionAdmissionOptions {
  wait?: boolean;
  pollIntervalMs?: number;
  recoveryPolicy?: RunRecoveryPolicy | null;
  beforeRecover?: ((run: SessionRun) => void | Promise<void>) | null;
}

/**
 * Obtains the explicit admission lease for a new Run, reconciling a stale
 * durable Run through the shared recovery path first if needed.
 */
export async function acquireExecutionAdmission(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  sessionId: string,
  options: ExecutionAdmissionOptions = {},
): Promise<RuntimeLeaseGuard> {
  const pollInterval = (options.pollIntervalMs ?? 0) > 0
    ? options.pollIntervalMs!
    : 50;
  for (;;) {
    let guard: RuntimeLeaseGuard;
    try {
      guard = sessionAcquireExecutionAdmission(sessionDir, sessionId);
      return guard;
    } catch (err) {
      if (err instanceof SessionRecoveryRequiredError) {
        const result = await recoverOrphanedSessionRunWithSignal(
          ctx,
          sessionDir,
          sessionId,
          options.recoveryPolicy ?? null,
          options.beforeRecover ?? null,
        );
        if (result.kept.length > 0) {
          throw new DetachedRemoteExecutionError(
            `session has a recoverable detached remote execution: ${
              result.kept[0].id
            }`,
          );
        }
        if (result.failed.length > 0) continue;
        if (!options.wait) throw new RuntimeLeaseBusyError(sessionId);
      } else if (err instanceof RuntimeLeaseBusyError) {
        if (!options.wait) throw err;
      } else {
        throw err;
      }
    }
    await waitForPoll(ctx, pollInterval);
  }
}

/**
 * Waits for (or immediately attempts) an explicit mutation lease, reconciling
 * an orphaned local Run through the shared recovery path first if needed.
 */
export async function acquireSessionMutation(
  ctx: AbortSignal | undefined,
  sessionDir: string,
  sessionId: string,
  options: ExecutionAdmissionOptions = {},
): Promise<RuntimeLeaseGuard> {
  const pollInterval = (options.pollIntervalMs ?? 0) > 0
    ? options.pollIntervalMs!
    : 50;
  for (;;) {
    let guard: RuntimeLeaseGuard;
    try {
      guard = acquireMutation(sessionDir, sessionId);
      return guard;
    } catch (err) {
      if (err instanceof SessionRunActiveError) {
        const result = await recoverOrphanedSessionRunWithSignal(
          ctx,
          sessionDir,
          sessionId,
          options.recoveryPolicy ?? null,
          options.beforeRecover ?? null,
        );
        if (result.kept.length > 0) {
          throw new DetachedRemoteExecutionError(
            `session has a recoverable detached remote execution: ${
              result.kept[0].id
            }`,
          );
        }
        if (result.failed.length > 0) continue;
        if (!options.wait) throw new RuntimeLeaseBusyError(sessionId);
      } else if (err instanceof RuntimeLeaseBusyError) {
        if (!options.wait) throw err;
      } else {
        throw err;
      }
    }
    await waitForPoll(ctx, pollInterval);
  }
}

function waitForPoll(ctx: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ctx !== undefined) ctx.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(ctx));
    };
    if (ctx !== undefined) {
      if (ctx.aborted) {
        clearTimeout(timer);
        reject(abortReason(ctx));
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined) return new Error(String(reason));
  return new DOMException("admission aborted", "AbortError");
}
