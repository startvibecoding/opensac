// Ported from internal/agentruntime/session_lifecycle.go
//
// Front-end-neutral persisted session lifecycle. Channel binding stays adapter
// policy input, and cascade deletion runs on the same Runtime-owned mutation
// lease as every other session mutation.
//
// Deviation: `AcquireSessionMutation` is async (the lease-first orphan
// reconciliation path is async), so `deleteSession` returns a Promise; Go's
// `defer guard.Release()` maps to `try/finally`.

import type { RuntimeLeaseGuard } from "../session/mod.ts";
import {
  deleteSessionWithMutation as sessionDeleteSessionWithMutation,
  type Manager,
  newManager,
  openByID,
  openByIDExact,
} from "../session/mod.ts";
import {
  acquireSessionMutation,
  type ExecutionAdmissionOptions,
} from "./execution_admission.ts";

/**
 * Describes persisted session identity without coupling it to a front-end
 * protocol. Channel binding remains adapter policy input.
 */
export interface CreateSessionOptions {
  workDir: string;
  sessionDir?: string;
  id?: string;
  channelType?: string;
  channelId?: string;
}

/** Initializes a persisted local or bound channel session. */
export function createSession(opts: CreateSessionOptions): Manager {
  if (opts.workDir.trim() === "") {
    throw new Error("session work directory is required");
  }
  const mgr = newManager(opts.workDir, opts.sessionDir ?? "");
  const channelType = (opts.channelType ?? "").trim();
  if (channelType !== "" && channelType !== "local") {
    mgr.initWithIDAndBinding(
      opts.id ?? "",
      channelType,
      opts.channelId ?? "",
    );
    return mgr;
  }
  mgr.initWithID(opts.id ?? "");
  return mgr;
}

/** Opens a persisted session by exact ID regardless of its workdir. */
export function openSession(sessionDir: string, id: string): Manager {
  if (id.trim() === "") {
    throw new Error("session ID is required");
  }
  return openByIDExact(sessionDir, id);
}

/** Removes a persisted session by ID when it is not active. */
export async function deleteSession(
  sessionDir: string,
  id: string,
): Promise<void> {
  const mgr = openSession(sessionDir, id);
  const guard = await acquireSessionMutation(
    undefined,
    sessionDir,
    id,
    {} as ExecutionAdmissionOptions,
  );
  try {
    sessionDeleteSessionWithMutation(mgr.getFile(), sessionDir, guard);
  } finally {
    guard.release();
  }
}

/**
 * Removes a session while the caller already holds its shared mutation lease.
 * It is the multi-session counterpart of `deleteSession` and keeps cascade
 * deletion on the same Runtime-owned lifecycle without reacquiring a
 * process-local lock.
 */
export function deleteSessionWithMutation(
  sessionDir: string,
  id: string,
  guard: RuntimeLeaseGuard,
): void {
  const mgr = openSession(sessionDir, id);
  sessionDeleteSessionWithMutation(mgr.getFile(), sessionDir, guard);
}

/**
 * Opens a persisted session scoped to its working directory.
 */
export function openSessionForWorkDir(
  workDir: string,
  sessionDir: string,
  id: string,
): Manager {
  if (workDir.trim() === "" || id.trim() === "") {
    throw new Error("session work directory and ID are required");
  }
  return openByID(workDir, sessionDir, id);
}
