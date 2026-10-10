//
// Runtime-owned entry points for canonical Run lifecycle transitions when no
// live `ExecutionRuntime` is available. All persistence is delegated to
// `RunStore`; this module owns no SQL.

import { listSessionRunEvents } from "../session/mod.ts";
import { type SessionRun } from "../session/mod.ts";
import { type RunEvent, SessionRunEventSink } from "./run_event.ts";
import { type RunState } from "./run_state.ts";
import { type DurableRun, RunStore } from "./run_store.ts";

/**
 * Creates a canonical row before an in-memory `ExecutionRuntime` is available.
 */
export function createDurableRun(sessionDir: string, run: DurableRun): void {
  new RunStore(sessionDir).create(run);
}

/** Applies a canonical non-terminal transition for a recovered/external run. */
export function updateDurableRun(
  sessionDir: string,
  runId: string,
  state: RunState,
  message: string,
): void {
  new RunStore(sessionDir).update(runId, state, message);
}

/** Applies a Runtime-owned terminal transition. Idempotent and monotonic. */
export function finishDurableRun(
  sessionDir: string,
  runId: string,
  state: RunState,
  message: string,
): void {
  new RunStore(sessionDir).finish(runId, state, message);
}

/**
 * Terminalizes a local orphan and records the corresponding recovery event as
 * one shared operation.
 */
export function recoverDurableRun(
  sessionDir: string,
  run: SessionRun,
  state: RunState,
  message: string,
  event: RunEvent,
): void {
  if (run.id === "" || run.sessionId === "") {
    throw new Error("recovered run identity is required");
  }
  if (message === "") message = "run recovered without a live execution owner";
  if (event.sessionId === "") event.sessionId = run.sessionId;
  if (event.runId === "") event.runId = run.id;
  if (event.source === "") event.source = run.source;
  if (event.model === "") event.model = run.model;
  if (event.mode === "") event.mode = run.mode;
  if (event.status === "") event.status = state;
  if (!event.id) event.id = `recovery_${run.id}_${state}`;
  // Record the deterministic recovery event before terminalizing the row. If
  // row persistence fails, a retry finds the same event and does not append a
  // duplicate projection.
  let events: ReturnType<typeof listSessionRunEvents>;
  try {
    events = listSessionRunEvents(sessionDir, run.sessionId);
  } catch (err) {
    throw new Error(`check recovered run event: ${errorMessage(err)}`);
  }
  let found = events.some((existing) => existing.id === event.id);
  if (!found) {
    try {
      new SessionRunEventSink(sessionDir).record(event);
    } catch (err) {
      // Another recovery worker may have inserted the deterministic event
      // between the read and insert. Re-read before treating a uniqueness error
      // as a failed recovery so the operation remains idempotent.
      let latest: ReturnType<typeof listSessionRunEvents>;
      try {
        latest = listSessionRunEvents(sessionDir, run.sessionId);
      } catch (listErr) {
        throw new Error(
          `record recovered run event: ${
            errorMessage(err)
          } (verify existing event: ${errorMessage(listErr)})`,
        );
      }
      found = latest.some((existing) => existing.id === event.id);
      if (!found) {
        throw new Error(`record recovered run event: ${errorMessage(err)}`);
      }
    }
  }
  try {
    finishDurableRun(sessionDir, run.id, state, message);
  } catch (err) {
    throw new Error(`finish recovered run: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
