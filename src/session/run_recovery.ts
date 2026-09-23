//
// The durable diagnostic/retry state for orphan reconciliation. It never grants
// ownership: the recovery lease remains the sole authority for changing a Run.
//
// Deviations from Go: the `context.Context`-carrying *Context variants are
// dropped (the DAO layer is synchronous), and `time.Time` maps to `Date`.

import {
  ConversationTurnDAO,
  isNoRows,
  RecoveryDAO,
  type RecoveryRecord,
  RunDAO,
  RuntimeLeaseDAO,
} from "../dao/mod.ts";
import type { Tx } from "../dao/mod.ts";
import { entryTurnEnd, generateID, type TurnEndEntry } from "./entry.ts";
import {
  appendTurnEntryTx,
  currentLeafTx,
  normalizeTurnStatus,
} from "./conversation_turn.ts";
import { openRootDB } from "./root_db.ts";
import { isNonTerminalSessionRunStatus } from "./run_status.ts";
import { allowedRunPredecessors, type SessionRun } from "./run_store.ts";
import { normalizedRunJSON } from "./run_json.ts";
import { validateRuntimeLeaseBindingTx } from "./runtime_lock.ts";
import type { SessionRunEvent } from "./session_events.ts";

/** The lifecycle state of a durable recovery attempt. */
export type SessionRunRecoveryState =
  | "recovering"
  | "failed"
  | "completed"
  | "detached_remote";

/**
 * The durable diagnostic and retry state for orphan reconciliation. It never
 * grants ownership; the recovery lease remains the sole authority for changing
 * a Run.
 */
export interface SessionRunRecovery {
  runId: string;
  sessionId: string;
  state: SessionRunRecoveryState;
  triggerSource: string;
  reasonCode: string;
  attempt: number;
  previousLeaseEpoch: number;
  lastError: string;
  nextRetryAt: Date | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function validDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !isNaN(value.getTime());
}

function secondsOf(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

/**
 * Records an attempt while verifying the exact purpose=recovery lease and
 * target Run in the same transaction.
 */
export function beginSessionRunRecovery(
  sessionDir: string,
  sessionId: string,
  runId: string,
  triggerSource: string,
  reasonCode: string,
  previousLeaseEpoch: number,
): SessionRunRecovery {
  if (sessionId.trim() === "" || runId.trim() === "") {
    throw new Error("session recovery identity is required");
  }
  const db = openRootDB(sessionDir);
  return db.runInTx((tx) => {
    validateRuntimeLeaseBindingTx(tx, sessionDir, sessionId, runId, "recovery");
    const now = new RuntimeLeaseDAO(null).now(tx);
    new RecoveryDAO(null).upsert(tx, {
      runId,
      sessionId,
      state: "recovering",
      triggerSource,
      reasonCode,
      attempt: 1,
      previousLeaseEpoch,
      lastError: "",
      nextRetryAt: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    });
    return readSessionRunRecoveryTx(tx, runId);
  });
}

/**
 * Persists a retryable failure under the same fenced recovery owner. A null
 * `nextRetryAt` means retry as soon as a Runtime coordinator observes the row
 * again.
 */
export function markSessionRunRecoveryFailed(
  sessionDir: string,
  sessionId: string,
  runId: string,
  message: string,
  nextRetryAt: Date | null,
): void {
  updateSessionRunRecovery(
    sessionDir,
    sessionId,
    runId,
    "failed",
    message,
    validDate(nextRetryAt) ? nextRetryAt : null,
  );
}

/**
 * Records that a canonical remote record was retained. The response record, not
 * this marker, remains the evidence used to decide whether the provider
 * execution is still recoverable.
 */
export function markSessionRunRecoveryDetached(
  sessionDir: string,
  sessionId: string,
  runId: string,
): void {
  updateSessionRunRecovery(
    sessionDir,
    sessionId,
    runId,
    "detached_remote",
    "",
    null,
  );
}

/** Records successful fenced convergence. */
export function markSessionRunRecoveryComplete(
  sessionDir: string,
  sessionId: string,
  runId: string,
): void {
  updateSessionRunRecovery(
    sessionDir,
    sessionId,
    runId,
    "completed",
    "",
    null,
  );
}

/**
 * Atomically records pending Decision resolutions, closes every open
 * ConversationTurn owned by the Run, writes the terminal Run event and state,
 * and completes the recovery record. The exact local purpose=recovery lease is
 * revalidated inside the transaction so a stale recovery worker cannot commit
 * after another owner takes over.
 */
export function convergeSessionRunRecovery(
  sessionDir: string,
  runInput: SessionRun,
  terminalEventInput: SessionRunEvent,
  decisionEvents: SessionRunEvent[],
  turnStatus: string,
  stopReason: string,
): void {
  const run = { ...runInput };
  if (
    run.id.trim() === "" || run.sessionId.trim() === "" ||
    run.status.trim() === ""
  ) {
    throw new Error("recovered run identity and terminal status are required");
  }
  if (isNonTerminalSessionRunStatus(run.status)) {
    throw new Error(
      `recovered run status must be terminal: ${run.status}`,
    );
  }
  const terminalEvent = { ...terminalEventInput };
  if (terminalEvent.id === "" || terminalEvent.eventType === "") {
    throw new Error("recovery terminal event identity and type are required");
  }
  terminalEvent.sessionId = run.sessionId;
  terminalEvent.runId = run.id;
  if (terminalEvent.status === "") terminalEvent.status = run.status;
  if (!validDate(terminalEvent.timestamp)) {
    terminalEvent.timestamp = new Date();
  }
  if (!validDate(run.finishedAt)) {
    run.finishedAt = new Date(terminalEvent.timestamp);
  }
  if (turnStatus === "") turnStatus = run.status;
  turnStatus = normalizeTurnStatus(turnStatus);

  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseBindingTx(
      tx,
      sessionDir,
      run.sessionId,
      run.id,
      "recovery",
    );

    const allowed = allowedRunPredecessors(run.status);
    const finished = (run.finishedAt as Date).toISOString();
    const changed = new RunDAO(null).updateStatus(
      tx,
      run.id,
      run.status,
      terminalEvent.timestamp.toISOString(),
      finished,
      run.error,
      allowed,
    );
    if (changed !== 1) {
      throw new Error(`recovery target run is no longer active: ${run.id}`);
    }

    const insertEvent = (eventInput: SessionRunEvent): void => {
      const event = { ...eventInput };
      if (event.id === "" || event.eventType === "") {
        throw new Error("recovery event identity and type are required");
      }
      if (event.sessionId === "") event.sessionId = run.sessionId;
      if (event.runId === "") event.runId = run.id;
      if (event.sessionId !== run.sessionId || event.runId !== run.id) {
        throw new Error("recovery event identity does not match run");
      }
      if (!validDate(event.timestamp)) {
        event.timestamp = terminalEvent.timestamp;
      }
      new RunDAO(null).insertEvent(tx, {
        seq: 0,
        id: event.id,
        sessionId: event.sessionId,
        runId: event.runId,
        eventType: event.eventType,
        source: event.source,
        status: event.status,
        model: event.model,
        mode: event.mode,
        timestamp: event.timestamp.toISOString(),
        data: normalizedRunJSON(event.data),
      });
    };
    for (const event of decisionEvents) insertEvent(event);
    insertEvent(terminalEvent);

    const rows = new RecoveryDAO(null).listOpenTurns(tx, run.sessionId);
    const openTurns = rows.filter((row) =>
      row.runId === run.id ||
      (row.runId === "" && run.intentId !== "" && row.intentId === run.intentId)
    );
    for (const turn of openTurns) {
      const parentId = currentLeafTx(tx, run.sessionId);
      const entry: TurnEndEntry = {
        type: entryTurnEnd,
        id: generateID(),
        parentId: parentId === "" ? null : parentId,
        timestamp: terminalEvent.timestamp,
        turnId: turn.id,
        intentId: turn.intentId,
        runId: run.id,
        status: turnStatus,
        ...(stopReason !== "" ? { stopReason } : {}),
      };
      const endSeq = appendTurnEntryTx(tx, run.sessionId, entry, parentId);
      new ConversationTurnDAO(null).close(
        tx,
        run.sessionId,
        turn.id,
        turnStatus,
        endSeq,
        terminalEvent.timestamp.toISOString(),
      );
    }

    const completed = secondsOf(terminalEvent.timestamp);
    try {
      new RecoveryDAO(null).update(
        tx,
        run.id,
        run.sessionId,
        "completed",
        "",
        null,
        completed,
        completed,
      );
    } catch (err) {
      if (isNoRows(err)) {
        throw new Error(
          `session recovery record not found: ${run.id}`,
        );
      }
      throw err;
    }
  });
}

function updateSessionRunRecovery(
  sessionDir: string,
  sessionId: string,
  runId: string,
  state: SessionRunRecoveryState,
  message: string,
  nextRetryAt: Date | null,
): void {
  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseBindingTx(tx, sessionDir, sessionId, runId, "recovery");
    const now = new RuntimeLeaseDAO(null).now(tx);
    const next = validDate(nextRetryAt) ? secondsOf(nextRetryAt) : null;
    const completed = state === "completed" ? now : null;
    new RecoveryDAO(null).update(
      tx,
      runId,
      sessionId,
      state,
      message,
      next,
      now,
      completed,
    );
  });
}

/**
 * Returns the last durable recovery disposition for a Run. A missing row is
 * represented by `null`.
 */
export function getSessionRunRecovery(
  sessionDir: string,
  runId: string,
): SessionRunRecovery | null {
  if (runId.trim() === "") throw new Error("run ID is required");
  const db = openRootDB(sessionDir);
  try {
    return readSessionRunRecoveryTx(db.db!, runId);
  } catch (err) {
    if (isNoRows(err)) return null;
    throw err;
  }
}

export function readSessionRunRecoveryTx(
  tx: Tx,
  runId: string,
): SessionRunRecovery {
  const record = new RecoveryDAO(null).find(tx, runId);
  return recoveryFromRecord(record);
}

function recoveryFromRecord(record: RecoveryRecord): SessionRunRecovery {
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    state: record.state as SessionRunRecoveryState,
    triggerSource: record.triggerSource,
    reasonCode: record.reasonCode,
    attempt: record.attempt,
    previousLeaseEpoch: record.previousLeaseEpoch,
    lastError: record.lastError,
    nextRetryAt: record.nextRetryAt !== null
      ? new Date(record.nextRetryAt * 1000)
      : null,
    startedAt: new Date(record.startedAt * 1000),
    updatedAt: new Date(record.updatedAt * 1000),
    completedAt: record.completedAt !== null
      ? new Date(record.completedAt * 1000)
      : null,
  };
}
