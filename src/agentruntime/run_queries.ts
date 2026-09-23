//
// Read-only inspection boundaries over the canonical Run rows. Durable
// lifecycle writes remain owned by `ExecutionRuntime`/`RunStore`; these
// functions keep adapters from treating session storage as their own execution
// state store. Go's `context.Context` maps to a dropped argument because the
// DAO layer is synchronous.

import {
  annotateSessionRunError,
  getActiveSessionRun,
  getSessionRun,
  listLatestSessionRuns,
  type SessionRun,
} from "../session/run_store.ts";
import { isNonTerminalSessionRunStatus } from "../session/run_status.ts";

/**
 * Loads one canonical Run row for inspection by an adapter. Durable lifecycle
 * writes remain owned by `ExecutionRuntime`/`RunStore`.
 */
export function getDurableRun(
  sessionDir: string,
  runId: string,
): SessionRun | null {
  return getSessionRun(sessionDir, runId);
}

/**
 * Loads the canonical non-terminal Run for a Session. Callers that need
 * ownership, submit, or cancellation decisions must use an execution-facts
 * inspection instead, since an active row alone does not prove a local
 * execution owner.
 */
export function getActiveDurableRun(
  sessionDir: string,
  sessionId: string,
): SessionRun | null {
  return getActiveSessionRun(sessionDir, sessionId);
}

/**
 * Loads the most recent canonical Run row per session as a read-only
 * projection keyed by session ID. Sessions without any Run are absent from the
 * result.
 */
export function listLatestDurableRunsBySessions(
  sessionDir: string,
  sessionIds: string[],
): Map<string, SessionRun> {
  return listLatestSessionRuns(sessionDir, sessionIds);
}

/**
 * Records a terminal error reason on a canonical Run row that reached a
 * terminal status without one, for example a background run abandoned after
 * interrupted tool execution whose finalizer could no longer persist the
 * reason. It never changes the run status, never revives a terminal run, and is
 * a no-op when the run is missing, still active, or already carries an error.
 * It reports whether the annotation was applied.
 */
export function annotateDurableRunError(
  sessionDir: string,
  runId: string,
  errMsg: string,
): boolean {
  if (runId.trim() === "" || errMsg.trim() === "") return false;
  const run = getDurableRun(sessionDir, runId);
  if (run === null || isNonTerminalSessionRunStatus(run.status)) return false;
  if (run.error.trim() !== "") return false;
  return annotateSessionRunError(sessionDir, runId, errMsg);
}
