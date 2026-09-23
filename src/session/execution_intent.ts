//
// The durable, adapter-neutral record of an accepted user request. Request and
// policy snapshots are opaque to session storage; the shared Runtime owns their
// interpretation.

import { isNoRows, RunDAO } from "../dao/mod.ts";
import { generateID } from "./entry.ts";
import {
  type ConversationTurn,
  startConversationTurnTx,
} from "./conversation_turn.ts";
import { bindInputResourcesToRunTx } from "./input_resources.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";
import { normalizedRunJSON } from "./run_json.ts";
import {
  bindRuntimeLeaseToRunTx,
  markRuntimeLeaseBound,
  validateRuntimeLeaseTx,
} from "./runtime_lock.ts";
import { reserveRuntimeSubmissionTx } from "./runtime_submission.ts";
import { appendRunUserMessageTx } from "./run_user_message.ts";
import { type SessionRun, sessionRunRecord } from "./run_store.ts";
import type { SessionRunEvent } from "./session_events.ts";

/**
 * The durable, adapter-neutral record of an accepted user request.
 */
export interface ExecutionIntent {
  id: string;
  sessionId: string;
  source: string;
  model: string;
  mode: string;
  workDir: string;
  requestFingerprint: string;
  request: unknown;
  policy: unknown;
  createdAt: Date;
}

/** Persists an execution intent inside the caller's session lease fence. */
export function saveExecutionIntent(
  sessionDir: string,
  input: ExecutionIntent,
): void {
  const intent = { ...input };
  if (intent.id === "" || intent.sessionId === "") {
    throw new Error("execution intent ID and session ID are required");
  }
  if (
    !(intent.createdAt instanceof Date) || isNaN(intent.createdAt.getTime())
  ) {
    intent.createdAt = new Date();
  }
  const request = normalizedRunJSON(intent.request);
  const policy = normalizedRunJSON(intent.policy);
  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, intent.sessionId);
    new RunDAO(null).insertIntent(tx, {
      id: intent.id,
      sessionId: intent.sessionId,
      source: intent.source,
      model: intent.model,
      mode: intent.mode,
      workDir: intent.workDir,
      requestFingerprint: intent.requestFingerprint,
      requestJson: request,
      policyJson: policy,
      createdAt: intent.createdAt.toISOString(),
    });
  });
}

/**
 * Atomically admits an immutable execution intent with its first or linked Run.
 * Runtime-owned callers use this instead of writing the two records
 * independently, so a reconnect can always resolve a durable Run back to the
 * request that created it.
 */
export function createExecutionIntentAndSessionRun(
  sessionDir: string,
  intent: ExecutionIntent,
  run: SessionRun,
): void {
  createExecutionIntentAndSessionRunEvent(
    sessionDir,
    intent,
    run,
    emptyRunEvent(),
  );
}

/**
 * Atomically admits an immutable intent, its Run row, and (when supplied) the
 * canonical started event.
 */
export function createExecutionIntentAndSessionRunEvent(
  sessionDir: string,
  intent: ExecutionIntent,
  run: SessionRun,
  event: SessionRunEvent,
): string {
  return createExecutionIntentAndSessionRunEventInternal(
    sessionDir,
    intent,
    run,
    event,
    null,
  );
}

/**
 * Atomically admits an immutable intent, its Run/event, and the conversation
 * turn boundary.
 */
export function createExecutionIntentAndSessionRunEventWithTurn(
  sessionDir: string,
  intent: ExecutionIntent,
  run: SessionRun,
  event: SessionRunEvent,
  turn: ConversationTurn,
): string {
  return createExecutionIntentAndSessionRunEventInternal(
    sessionDir,
    intent,
    run,
    event,
    turn,
  );
}

function createExecutionIntentAndSessionRunEventInternal(
  sessionDir: string,
  intentInput: ExecutionIntent,
  runInput: SessionRun,
  eventInput: SessionRunEvent,
  turn: ConversationTurn | null,
): string {
  const intent = { ...intentInput };
  const run = { ...runInput };
  const event = { ...eventInput };
  if (intent.id === "" || intent.sessionId === "") {
    throw new Error("execution intent ID and session ID are required");
  }
  if (run.id === "" || run.sessionId === "" || run.status === "") {
    throw new Error("session run ID, session ID, and status are required");
  }
  if (intent.sessionId !== run.sessionId) {
    throw new Error(
      "execution intent and session run must belong to the same session",
    );
  }
  if (run.intentId === "") run.intentId = intent.id;
  if (run.intentId !== intent.id) {
    throw new Error("session run intent ID does not match execution intent");
  }
  if (
    !(intent.createdAt instanceof Date) || isNaN(intent.createdAt.getTime())
  ) {
    intent.createdAt = new Date();
  }
  if (!(run.startedAt instanceof Date) || isNaN(run.startedAt.getTime())) {
    run.startedAt = intent.createdAt;
  }
  if (!(run.updatedAt instanceof Date) || isNaN(run.updatedAt.getTime())) {
    run.updatedAt = run.startedAt;
  }
  if (run.attempt <= 0) run.attempt = 1;

  const request = normalizedRunJSON(intent.request);
  const policy = normalizedRunJSON(intent.policy);
  const finishedAt = run.finishedAt !== null && run.finishedAt !== undefined &&
      !isNaN(run.finishedAt.getTime())
    ? run.finishedAt.toISOString()
    : null;

  let boundLease = null;
  openRootDB(sessionDir).runInTx((tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, run.sessionId);
    const dao = new RunDAO(null);
    dao.insertIntent(tx, {
      id: intent.id,
      sessionId: intent.sessionId,
      source: intent.source,
      model: intent.model,
      mode: intent.mode,
      workDir: intent.workDir,
      requestFingerprint: intent.requestFingerprint,
      requestJson: request,
      policyJson: policy,
      createdAt: intent.createdAt.toISOString(),
    });
    dao.insertRun(tx, sessionRunRecord(run, finishedAt));
    if (event.eventType !== "") {
      if (event.id === "") event.id = generateID();
      if (event.sessionId === "") event.sessionId = run.sessionId;
      if (event.runId === "") event.runId = run.id;
      if (
        !(event.timestamp instanceof Date) || isNaN(event.timestamp.getTime())
      ) {
        event.timestamp = run.startedAt;
      }
      if (event.status === "") event.status = run.status;
      if (event.source === "") event.source = run.source;
      if (event.model === "") event.model = run.model;
      if (event.mode === "") event.mode = run.mode;
      dao.insertEvent(tx, {
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
    }
    if (turn !== null) {
      if (
        turn.sessionId !== run.sessionId ||
        (turn.runId !== "" && turn.runId !== run.id)
      ) {
        throw new Error("conversation turn identity does not match run");
      }
      const normalizedTurn = {
        ...turn,
        runId: turn.runId === "" ? run.id : turn.runId,
        intentId: turn.intentId === "" ? intent.id : turn.intentId,
      };
      startConversationTurnTx(tx, normalizedTurn);
    }
    appendRunUserMessageTx(tx, run);
    bindInputResourcesToRunTx(
      tx,
      run.sessionId,
      run.id,
      run.intentId,
      run.inputResourceIds,
    );
    reserveRuntimeSubmissionTx(tx, run);
    boundLease = bindRuntimeLeaseToRunTx(tx, sessionDir, run.sessionId, run.id);
  });
  markRuntimeLeaseBound(boundLease, run.id);
  return event.id;
}

/** Loads one execution intent by ID, or `null` when absent. */
export function getExecutionIntent(
  sessionDir: string,
  intentId: string,
): ExecutionIntent | null {
  if (intentId === "") throw new Error("execution intent ID is required");
  const db = openRootDB(sessionDir);
  let record;
  try {
    record = new RunDAO(db.db).findIntent(intentId);
  } catch (err) {
    if (isNoRows(err)) return null;
    throw err;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    source: record.source,
    model: record.model,
    mode: record.mode,
    workDir: record.workDir,
    requestFingerprint: record.requestFingerprint,
    request: decodeJSON(record.requestJson),
    policy: decodeJSON(record.policyJson),
    createdAt: parseSessionTimestamp(record.createdAt),
  };
}

function emptyRunEvent(): SessionRunEvent {
  return {
    id: "",
    sessionId: "",
    runId: "",
    eventType: "",
    source: "",
    status: "",
    model: "",
    mode: "",
    timestamp: new Date(),
    data: undefined,
  };
}

function decodeJSON(value: string): unknown {
  if (value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
