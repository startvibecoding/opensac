//
// The data layer owns the SQLite snapshot/copy transaction; this Runtime
// boundary keeps adapters from implementing their own copy or Agent lifecycle.
// Go's `context.Context` is dropped because the DAO layer is synchronous.

import {
  type ForkOptions as SessionForkOptions,
  type ForkResult as SessionForkResult,
  forkSession,
} from "../session/fork.ts";

/** The front-end-neutral request for a Session prefix fork. */
export type ForkOptions = SessionForkOptions;
export type ForkResult = SessionForkResult;

/** Performs the canonical Session fork operation. */
export function fork(
  sessionDir: string,
  options: ForkOptions,
): ForkResult {
  return forkSession(sessionDir, options);
}

/**
 * The Runtime-owned expert switch operation. It preserves the source session's
 * identity and history while applying `expertId` only to the child branch; an
 * empty `expertId` deliberately creates an unbound child.
 */
export function forkWithExpert(
  sessionDir: string,
  options: ForkOptions,
  expertId: string,
): ForkResult {
  return fork(sessionDir, { ...options, expertId: expertId.trim() });
}
