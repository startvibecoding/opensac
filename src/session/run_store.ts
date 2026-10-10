//
// The durable Run lifecycle persistence: canonical Run rows, their first and
// terminal events, delivery-plan finalization, and the read/list projections
// used by recovery and adapters. All SQL stays in the DAO layer.
//
// Deviations from Go: `context.Context` is dropped (the DAO layer is
// synchronous), `json.RawMessage` maps to decoded `unknown` (normalized on
// write), and `time.Time` maps to `Date`.

import {
  ConversationTurnDAO,
  RunDAO,
  type SessionRunRecord,
} from "../dao/mod.ts";
import type { Database } from "../dao/mod.ts";
import { type Message } from "../provider/types.ts";
import { writeRootDatabase } from "./database.ts";
import { entryTurnEnd, generateID, type TurnEndEntry } from "./entry.ts";
import {
  appendTurnEntryTx,
  type ConversationTurn,
  currentLeafTx,
  startConversationTurnTx,
} from "./conversation_turn.ts";
import { bindInputResourcesToRunTx } from "./input_resources.ts";
import {
  bindRuntimeLeaseToRunTx,
  markRuntimeLeaseBound,
  validateRuntimeLeaseTx,
} from "./runtime_lock.ts";
import { reserveRuntimeSubmissionTx } from "./runtime_submission.ts";
import {
  openExistingSessionDB,
  openRootDB,
  parseSessionTimestamp,
} from "./root_db.ts";
import { normalizedRunJSON } from "./run_json.ts";
import {
  isNonTerminalSessionRunStatus,
  isTerminalSessionRunStatus,
  nonTerminalSessionRunStatuses,
} from "./run_status.ts";
import { type SessionRunEvent } from "./session_events.ts";
import {
  appendRunAssistantMessageTx,
  appendRunUserMessageTx,
  runTerminalEventID,
} from "./run_user_message.ts";
import { createDeliveryPlanTx, type DeliveryPlan } from "./delivery_store.ts";

/**
 * The durable lifecycle record for one agent execution.
 */
export interface SessionRun {
  id: string;
  sessionId: string;
  intentId: string;
  retryOf: string;
  attempt: number;
  workDir: string;
  source: string;
  model: string;
  mode: string;
  status: string;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  error: string;
  errorInfo: unknown;
  progress: unknown;
  usage: unknown;
  contextUsage: unknown;
  /**
   * Runtime-prepared resources admitted with this Run. They are bound by the
   * same transaction as the intent/run/start event.
   */
  inputResourceIds: string[];
  /**
   * Admission-only submission digests reserved in the same transaction as the
   * intent, Run, turn, resources, and start event.
   */
  submissionKeyHash: string;
  submissionScope: string;
  submissionFingerprint: string;
  /**
   * The canonical user entry admitted with a conversation Run. It is
   * admission-only; transcript replay remains the source of truth.
   */
  userEntryId: string;
  userMessage?: Message;
  /**
   * The final assistant entry held by the Runtime until terminalization. It is
   * intentionally transient and is committed together with the terminal
   * Run/turn and delivery plan.
   */
  assistantEntryId: string;
  assistantMessage?: Message;
  /**
   * Terminal-only. The terminal transaction creates its outbox rows together
   * with the Run, turn, and terminal event transition.
   */
  deliveryPlan?: DeliveryPlan;
}

function requireConn(db: Database): NonNullable<Database["db"]> {
  const conn = db.db;
  if (conn === null) throw new Error("run database is not open");
  return conn;
}

/**
 * Reports whether an error is the one-active-run-per-session unique index
 * (`idx_session_runs_active_session`) rejecting a Run insert because the
 * session already has a non-terminal Run. The raw SQLite message is a schema
 * detail; callers must classify through this predicate instead of
 * string-matching SQL, and must surface it as "the session is busy", never as
 * an opaque constraint failure.
 */
export function isActiveRunConflictError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err))
    .toLowerCase();
  return message.includes("unique constraint failed: session_runs.session_id");
}

/** Reports whether a run status is a valid terminal predecessor transition. */
export function allowedRunPredecessors(status: string): string[] {
  switch (status) {
    case "created":
      return ["created"];
    case "queued":
      return ["created", "queued"];
    case "running":
      return [
        "created",
        "queued",
        "running",
        "waiting_for_approval",
        "waiting_for_question",
      ];
    case "waiting_for_approval":
    case "waiting_for_question":
      return ["running", status];
    case "cancelling":
      return [
        "created",
        "queued",
        "running",
        "waiting_for_approval",
        "waiting_for_question",
        "cancelling",
      ];
    case "terminalizing":
      return [
        "created",
        "queued",
        "running",
        "waiting_for_approval",
        "waiting_for_question",
        "cancelling",
        "terminalizing",
      ];
  }
  if (isTerminalSessionRunStatus(status)) {
    return [
      "created",
      "queued",
      "running",
      "waiting_for_approval",
      "waiting_for_question",
      "cancelling",
      "terminalizing",
      status,
    ];
  }
  return [status];
}

interface PreparedRun {
  run: SessionRun;
  finishedAt: string | null;
}

function prepareRun(run: SessionRun): PreparedRun {
  run.attempt = run.attempt <= 0 ? 1 : run.attempt;
  if (
    !(run.startedAt instanceof Date) || isNaN(run.startedAt.getTime())
  ) {
    run.startedAt = new Date();
  }
  if (!(run.updatedAt instanceof Date) || isNaN(run.updatedAt.getTime())) {
    run.updatedAt = run.startedAt;
  }
  const finishedAt = run.finishedAt !== null &&
      run.finishedAt !== undefined &&
      !isNaN(run.finishedAt.getTime())
    ? run.finishedAt.toISOString()
    : null;
  return { run, finishedAt };
}

function validateRunIdentity(run: SessionRun): void {
  if (run.id === "" || run.sessionId === "") {
    throw new Error("session run ID and session ID are required");
  }
  if (run.status === "") {
    throw new Error("session run status is required");
  }
}

export function sessionRunRecord(
  run: SessionRun,
  finishedAt: string | null,
): SessionRunRecord {
  return {
    id: run.id,
    sessionId: run.sessionId,
    intentId: run.intentId,
    retryOf: run.retryOf,
    attempt: run.attempt,
    workDir: run.workDir,
    source: run.source,
    model: run.model,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt,
    error: run.error,
    errorInfoJson: normalizedRunJSON(run.errorInfo),
    progressJson: normalizedRunJSON(run.progress),
    usageJson: normalizedRunJSON(run.usage),
    contextUsageJson: normalizedRunJSON(run.contextUsage),
  };
}

/** Upserts one durable Run row plus its user entry, resources, and lease. */
export function saveSessionRun(sessionDir: string, input: SessionRun): void {
  validateRunIdentity(input);
  const run = { ...input };
  const { finishedAt } = prepareRun(run);
  let boundLease = null;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, run.sessionId);
    new RunDAO(null).upsertRun(tx, sessionRunRecord(run, finishedAt));
    appendRunUserMessageTx(tx, run);
    bindInputResourcesToRunTx(
      tx,
      run.sessionId,
      run.id,
      run.intentId,
      run.inputResourceIds,
    );
    reserveRuntimeSubmissionTx(tx, run);
    if (isNonTerminalSessionRunStatus(run.status)) {
      boundLease = bindRuntimeLeaseToRunTx(
        tx,
        sessionDir,
        run.sessionId,
        run.id,
      );
    }
  });
  markRuntimeLeaseBound(boundLease, run.id);
}

/**
 * Inserts one canonical run row. Unlike `saveSessionRun` it never overwrites an
 * existing identity; duplicate run IDs are an admission error.
 */
export function createSessionRun(sessionDir: string, input: SessionRun): void {
  validateRunIdentity(input);
  const run = { ...input };
  const { finishedAt } = prepareRun(run);
  let boundLease = null;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, run.sessionId);
    new RunDAO(null).insertRun(tx, sessionRunRecord(run, finishedAt));
    appendRunUserMessageTx(tx, run);
    bindInputResourcesToRunTx(
      tx,
      run.sessionId,
      run.id,
      run.intentId,
      run.inputResourceIds,
    );
    reserveRuntimeSubmissionTx(tx, run);
    if (isNonTerminalSessionRunStatus(run.status)) {
      boundLease = bindRuntimeLeaseToRunTx(
        tx,
        sessionDir,
        run.sessionId,
        run.id,
      );
    }
  });
  markRuntimeLeaseBound(boundLease, run.id);
}

/**
 * Atomically inserts a new canonical Run and its first event, plus (when
 * supplied) the conversation turn boundary. Retry attempts use this path so a
 * process loss cannot leave a durable attempt without a replay anchor.
 */
export function createSessionRunAndEvent(
  sessionDir: string,
  run: SessionRun,
  event: SessionRunEvent,
  turn?: ConversationTurn,
): string {
  return createSessionRunAndEventInternal(sessionDir, run, event, turn ?? null);
}

function createSessionRunAndEventInternal(
  sessionDir: string,
  input: SessionRun,
  inputEvent: SessionRunEvent,
  turn: ConversationTurn | null,
): string {
  validateRunIdentity(input);
  const run = { ...input };
  const { finishedAt } = prepareRun(run);
  const event = { ...inputEvent };
  if (event.eventType === "") {
    throw new Error("session run event type is required");
  }
  if (event.id === "") event.id = generateID();
  if (event.sessionId === "") event.sessionId = run.sessionId;
  if (event.runId === "") event.runId = run.id;
  if (event.sessionId !== run.sessionId || event.runId !== run.id) {
    throw new Error("session run event identity does not match run");
  }
  if (!(event.timestamp instanceof Date) || isNaN(event.timestamp.getTime())) {
    event.timestamp = run.startedAt;
  }
  if (event.status === "") event.status = run.status;
  if (event.source === "") event.source = run.source;
  if (event.model === "") event.model = run.model;
  if (event.mode === "") event.mode = run.mode;
  let boundLease = null;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, run.sessionId);
    const dao = new RunDAO(null);
    dao.insertRun(tx, sessionRunRecord(run, finishedAt));
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
        intentId: turn.intentId === "" ? run.intentId : turn.intentId,
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

/**
 * Atomically closes a conversation turn, its Run row, and the terminal Run
 * event. A missing or already-closed turn is tolerated for recovery/idempotent
 * retries.
 */
export function finishSessionRunAndConversationTurn(
  sessionDir: string,
  input: SessionRun,
  inputEvent: SessionRunEvent,
  turnId: string,
  turnStatus: string,
  stopReason: string,
): string {
  if (input.id === "" || input.sessionId === "" || input.status === "") {
    throw new Error("session run identity and terminal status are required");
  }
  if (inputEvent.eventType === "") {
    throw new Error("session run event type is required");
  }
  const run = { ...input };
  const event = { ...inputEvent };
  if (event.id === "") {
    event.id = runTerminalEventID(run.id, event.eventType);
    if (event.id === "") event.id = generateID();
  }
  event.sessionId = run.sessionId;
  event.runId = run.id;
  if (!(event.timestamp instanceof Date) || isNaN(event.timestamp.getTime())) {
    event.timestamp = new Date();
  }
  if (event.status === "") event.status = run.status;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, run.sessionId);
    const dao = new RunDAO(null);
    const allowed = allowedRunPredecessors(run.status);
    const finished = run.finishedAt !== null &&
        run.finishedAt !== undefined &&
        !isNaN(run.finishedAt.getTime())
      ? run.finishedAt.toISOString()
      : null;
    const changed = dao.updateStatus(
      tx,
      run.id,
      run.status,
      new Date().toISOString(),
      finished,
      run.error,
      allowed,
    );
    if (changed === 0) {
      const record = dao.findRun(tx, run.id);
      if (record === undefined) {
        throw new Error(`session run ${run.id} not found`);
      }
      if (record.status !== run.status) {
        throw new Error(
          `invalid session run transition ${JSON.stringify(record.status)} -> ${
            JSON.stringify(run.status)
          }`,
        );
      }
    }
    appendRunAssistantMessageTx(tx, run);
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
    if (turnId !== "") {
      const turnDao = new ConversationTurnDAO(null);
      const state = turnDao.state(tx, run.sessionId, turnId);
      if (state !== undefined && state.status === "open") {
        const parentId = currentLeafTx(tx, run.sessionId);
        const entry: TurnEndEntry = {
          type: entryTurnEnd,
          id: generateID(),
          parentId: parentId === "" ? null : parentId,
          timestamp: event.timestamp,
          turnId,
          status: turnStatus,
          ...(state.intentId !== "" ? { intentId: state.intentId } : {}),
          ...(state.runId !== "" ? { runId: state.runId } : {}),
          ...(stopReason !== "" ? { stopReason } : {}),
        };
        const endSeq = appendTurnEntryTx(tx, run.sessionId, entry, parentId);
        turnDao.close(
          tx,
          run.sessionId,
          turnId,
          turnStatus,
          endSeq,
          event.timestamp.toISOString(),
        );
      }
    }
    if (run.deliveryPlan !== undefined) {
      const plan = run.deliveryPlan;
      const intent = { ...plan.intent };
      if (intent.sessionId === "") intent.sessionId = run.sessionId;
      if (intent.runId === "") intent.runId = run.id;
      if (intent.sessionId !== run.sessionId || intent.runId !== run.id) {
        throw new Error("delivery plan identity does not match terminal Run");
      }
      try {
        createDeliveryPlanTx(tx, { intent, operations: plan.operations });
      } catch (err) {
        throw new Error(
          `create terminal delivery plan: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  });
  return event.id;
}

export function sessionRunFromRecord(record: SessionRunRecord): SessionRun {
  return {
    id: record.id,
    sessionId: record.sessionId,
    intentId: record.intentId,
    retryOf: record.retryOf,
    attempt: record.attempt,
    workDir: record.workDir,
    source: record.source,
    model: record.model,
    mode: record.mode,
    status: record.status,
    startedAt: parseSessionTimestamp(record.startedAt),
    updatedAt: parseSessionTimestamp(record.updatedAt),
    finishedAt: record.finishedAt !== null && record.finishedAt !== ""
      ? parseSessionTimestamp(record.finishedAt)
      : null,
    error: record.error,
    errorInfo: decodeJSON(record.errorInfoJson),
    progress: decodeJSON(record.progressJson),
    usage: decodeJSON(record.usageJson),
    contextUsage: decodeJSON(record.contextUsageJson),
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
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

/** Loads one Run by ID, or `null` when absent. */
export function getSessionRun(
  sessionDir: string,
  runId: string,
): SessionRun | null {
  if (runId === "") throw new Error("run ID is required");
  const db = openRootDB(sessionDir);
  const conn = requireConn(db);
  const record = new RunDAO(null).findRun(conn, runId);
  if (record === undefined) return null;
  const run = sessionRunFromRecord(record);
  loadInputResourceIDs(db, [run]);
  return run;
}

/** Loads the sole non-terminal Run for a session, or `null`. */
export function getActiveSessionRun(
  sessionDir: string,
  sessionId: string,
): SessionRun | null {
  if (sessionId === "") return null;
  const db = openRootDB(sessionDir);
  const record = new RunDAO(requireConn(db)).activeRun(
    sessionId,
    nonTerminalSessionRunStatuses(),
  );
  if (record === undefined) return null;
  return getSessionRun(sessionDir, record.id);
}

/** Lists the most recent Runs for a session in descending start order. */
export function listSessionRuns(
  sessionDir: string,
  sessionId: string,
  limit: number,
): SessionRun[] {
  if (sessionId === "") return [];
  if (limit <= 0 || limit > 500) limit = 100;
  const db = openRootDB(sessionDir);
  const records = new RunDAO(requireConn(db)).listRuns(sessionId, limit);
  const result = records.map(sessionRunFromRecord);
  loadInputResourceIDs(db, result);
  return result;
}

/**
 * Returns the most recent durable Run of each given session as a read-only
 * projection keyed by session ID.
 */
export function listLatestSessionRuns(
  sessionDir: string,
  sessionIds: string[],
): Map<string, SessionRun> {
  const result = new Map<string, SessionRun>();
  if (sessionIds.length === 0) return result;
  const db = openExistingSessionDB(sessionDir);
  if (db === null) return result;
  const records = new RunDAO(requireConn(db)).latestRunBySessions(sessionIds);
  for (const [sessionId, record] of records) {
    result.set(sessionId, sessionRunFromRecord(record));
  }
  return result;
}

function loadInputResourceIDs(db: Database, runs: SessionRun[]): void {
  if (runs.length === 0) return;
  const sessionId = runs[0].sessionId;
  const byRun = new RunDAO(requireConn(db)).inputResourceIds(sessionId);
  for (const run of runs) {
    run.inputResourceIds = byRun.get(run.id) ?? [];
  }
}

/**
 * Returns the next ordered user-visible attempt for an ExecutionIntent. Callers
 * must hold their Runtime admission lock while using the returned value.
 */
export function nextSessionRunAttempt(
  sessionDir: string,
  sessionId: string,
  intentId: string,
): number {
  if (sessionId === "" || intentId === "") {
    throw new Error("session ID and execution intent ID are required");
  }
  const db = openRootDB(sessionDir);
  let attempt = new RunDAO(requireConn(db)).nextAttempt(sessionId, intentId);
  if (attempt < 2) attempt = 2;
  return attempt;
}

/**
 * Returns the highest-attempt Run in an immutable intent chain, or `null`.
 */
export function latestSessionRunForIntent(
  sessionDir: string,
  sessionId: string,
  intentId: string,
): SessionRun | null {
  if (sessionId === "" || intentId === "") {
    throw new Error("session ID and execution intent ID are required");
  }
  const db = openRootDB(sessionDir);
  const record = new RunDAO(requireConn(db)).latestForIntent(
    sessionId,
    intentId,
  );
  if (record === undefined) return null;
  return getSessionRun(sessionDir, record.id);
}

/** Applies a fenced Run status transition. */
export function updateSessionRunStatus(
  sessionDir: string,
  runId: string,
  status: string,
  message: string,
  finishedAt: Date | null,
): void {
  if (runId === "" || status === "") {
    throw new Error("run ID and status are required");
  }
  const finishedValue = finishedAt !== null && !isNaN(finishedAt.getTime())
    ? finishedAt.toISOString()
    : "";
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new RunDAO(null);
    const sessionId = dao.sessionId(tx, runId);
    if (sessionId === undefined) {
      throw new Error(`session run ${runId} not found`);
    }
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const allowed = allowedRunPredecessors(status);
    const changed = dao.updateStatus(
      tx,
      runId,
      status,
      new Date().toISOString(),
      finishedValue === "" ? null : finishedValue,
      message,
      allowed,
    );
    if (changed === 0) {
      const record = dao.findRun(tx, runId);
      if (record === undefined) {
        throw new Error(`session run ${runId} not found`);
      }
      if (record.status === status) return;
      throw new Error(
        `invalid session run transition ${JSON.stringify(record.status)} -> ${
          JSON.stringify(status)
        }`,
      );
    }
  });
}

/**
 * Records a terminal error reason on a run row that reached a terminal status
 * without one. It never changes the run status and is a no-op when the run
 * already carries an error. Returns whether the annotation was applied.
 */
export function annotateSessionRunError(
  sessionDir: string,
  runId: string,
  message: string,
): boolean {
  if (runId === "") throw new Error("run ID is required");
  if (message.trim() === "") return false;
  let applied = false;
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new RunDAO(null);
    const sessionId = dao.sessionId(tx, runId);
    if (sessionId === undefined) return;
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const changed = dao.updateErrorIfEmpty(
      tx,
      runId,
      message,
      new Date().toISOString(),
    );
    if (changed === 0) return;
    applied = true;
  });
  return applied;
}

/** Stores the structured terminal/recovery error. */
export function updateSessionRunErrorInfo(
  sessionDir: string,
  runId: string,
  info: unknown,
): void {
  if (runId === "") throw new Error("run ID is required");
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new RunDAO(null);
    const sessionId = dao.sessionId(tx, runId);
    if (sessionId === undefined) {
      throw new Error(`session run ${runId} not found`);
    }
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    dao.updateJson(
      tx,
      runId,
      "error_info_json",
      normalizedRunJSON(info),
      new Date().toISOString(),
    );
  });
}

/** Persists the latest non-terminal retry/recovery projection. */
export function updateSessionRunProgress(
  sessionDir: string,
  runId: string,
  progress: unknown,
): void {
  if (runId === "") throw new Error("run ID is required");
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new RunDAO(null);
    const sessionId = dao.sessionId(tx, runId);
    if (sessionId === undefined) {
      throw new Error(`session run ${runId} not found`);
    }
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    dao.updateJson(
      tx,
      runId,
      "progress_json",
      normalizedRunJSON(progress),
      new Date().toISOString(),
    );
  });
}

/**
 * Persists token and context-window usage independently from terminalization so
 * reconnects can inspect partial or recovered runs.
 */
export function updateSessionRunUsage(
  sessionDir: string,
  runId: string,
  usage: unknown,
  contextUsage: unknown,
): void {
  if (runId === "") throw new Error("run ID is required");
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new RunDAO(null);
    const sessionId = dao.sessionId(tx, runId);
    if (sessionId === undefined) {
      throw new Error(`session run ${runId} not found`);
    }
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const now = new Date().toISOString();
    dao.updateJson(tx, runId, "usage_json", normalizedRunJSON(usage), now);
    dao.updateJson(
      tx,
      runId,
      "context_usage_json",
      normalizedRunJSON(contextUsage),
      now,
    );
  });
}

/**
 * Returns all runs that are in a non-terminal state. Used during server startup
 * to recover runs that were active when the previous instance stopped.
 */
export function listOrphanedSessionRuns(sessionDir: string): SessionRun[] {
  const db = openRootDB(sessionDir);
  const records = new RunDAO(requireConn(db)).orphaned(
    nonTerminalSessionRunStatuses(),
  );
  return records.map(sessionRunFromRecord);
}
