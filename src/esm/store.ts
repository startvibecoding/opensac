//
// The durable Enable Supervisor Mode objective store backed by the shared
// sessions database. Every read/write goes through the DAO layer
// (`ESMDAO`/`ESMGuidanceDAO`); this module owns only the domain mapping and the
// lifecycle transitions.
//
// Deviations from Go: `context.Context` is dropped because the DAO/DB layer is
// synchronous; Go returns `(objective, error)` pairs for rejected transitions,
// so this port throws the exported sentinel errors instead. Callers only ever
// compare them with `===` (Go's `errors.Is`).

import type { DB } from "../db/mod.ts";
import { ESMDAO, type ESMObjectiveRecord, isNoRows } from "../dao/mod.ts";
import {
  consumeESMGuidance,
  type ESMGuidance,
  generateID,
  listESMGuidance,
  openRootDB,
  saveESMGuidance,
} from "../session/mod.ts";
import {
  blockedAuditLimit,
  canAutoRun,
  isUnfinishedStatus,
  type Objective,
  type Phase,
  phaseAudit,
  phaseComplete,
  phaseCritic,
  phaseWorker,
  type Status,
  statusActive,
  statusBlocked,
  statusComplete,
  statusCompleteCandidate,
  statusPaused,
  statusUsageLimited,
} from "./state.ts";
import { trimStringSlice } from "./report.ts";

/** Thrown when no objective exists for the session. */
export class EsmObjectiveNotFoundError extends Error {
  override name = "EsmObjectiveNotFoundError";
  constructor() {
    super("esm objective not found");
  }
}
/** Thrown when an unfinished objective already exists. */
export class EsmObjectiveExistsError extends Error {
  override name = "EsmObjectiveExistsError";
  constructor() {
    super("esm objective already exists");
  }
}
/** Thrown when the objective text was empty. */
export class EsmInvalidObjectiveError extends Error {
  override name = "EsmInvalidObjectiveError";
  constructor() {
    super("esm objective cannot be empty");
  }
}
/** Thrown when the requested lifecycle transition is not allowed. */
export class EsmInvalidTransitionError extends Error {
  override name = "EsmInvalidTransitionError";
  constructor() {
    super("invalid esm status transition");
  }
}

/**
 * Persists Enable Supervisor Mode state in the shared sessions database.
 */
export class Store {
  private readonly sessionDir: string;
  private readonly clock: () => Date;

  constructor(sessionDir: string, clock: () => Date = () => new Date()) {
    this.sessionDir = sessionDir;
    this.clock = clock;
  }

  /** Returns the current objective for a session. */
  get(sessionID: string): Objective {
    if (sessionID === "") throw new EsmObjectiveNotFoundError();
    const db = openRootDB(this.sessionDir);
    return getObjective(db.db!, sessionID);
  }

  /**
   * Creates a new objective. A completed row may be replaced; unfinished
   * objectives must be edited or cleared explicitly.
   */
  create(sessionID: string, objective: string): Objective {
    objective = objective.trim();
    if (sessionID === "") throw new EsmObjectiveNotFoundError();
    if (objective === "") throw new EsmInvalidObjectiveError();
    const db = openRootDB(this.sessionDir);
    const now = this.timestamp();
    const esmID = "esm-" + generateID();
    db.runInTx((tx) => {
      let existing: Objective | null = null;
      try {
        existing = getObjective(tx, sessionID);
      } catch (err) {
        if (!(err instanceof EsmObjectiveNotFoundError)) throw err;
      }
      if (existing !== null) {
        if (isUnfinishedStatus(existing.status)) {
          throw new EsmObjectiveExistsError();
        }
        new ESMDAO(null).delete(tx, sessionID);
      }
      new ESMDAO(null).insert(tx, {
        sessionId: sessionID,
        esmId: esmID,
        objective,
        status: statusActive,
        tokensUsed: 0,
        timeUsedMs: 0,
        blockedCount: 0,
        blockedReason: "",
        blockedRunId: "",
        completionReason: "",
        completionRunId: "",
        completionReview: "",
        phase: phaseWorker,
        progressSummary: "",
        remainingWork: "[]",
        rejectionCount: 0,
        rejectionRunId: "",
        recoveryCount: 0,
        recoveryReason: "",
        createdAt: now,
        updatedAt: now,
      });
    });
    return this.get(sessionID);
  }

  /** Updates the objective text for an unfinished objective. */
  edit(sessionID: string, objective: string): Objective {
    objective = objective.trim();
    if (objective === "") throw new EsmInvalidObjectiveError();
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (!isUnfinishedStatus(current.status)) {
      throw new EsmInvalidTransitionError();
    }
    current.objective = objective;
    current.blockedCount = 0;
    current.blockedReason = "";
    current.blockedRunId = "";
    current.completionReason = "";
    current.completionRunId = "";
    current.completionReview = "";
    current.phase = phaseWorker;
    current.progressSummary = "";
    current.remainingWork = [];
    current.rejectionCount = 0;
    current.rejectionRunId = "";
    current.recoveryCount = 0;
    current.recoveryReason = "";
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /** Deletes the objective for a session. */
  clear(sessionID: string): void {
    const db = openRootDB(this.sessionDir);
    new ESMDAO(null).delete(db.db!, sessionID);
  }

  /** Disables idle continuation for an unfinished objective. */
  pause(sessionID: string): Objective {
    return this.setUserStatus(sessionID, statusPaused);
  }

  /** Records a runtime/provider limit and stops continuation. */
  markUsageLimited(sessionID: string): Objective {
    return this.setRuntimeStatus(sessionID, statusUsageLimited);
  }

  private setUserStatus(sessionID: string, status: Status): Objective {
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (!isUnfinishedStatus(current.status)) {
      throw new EsmInvalidTransitionError();
    }
    current.status = status;
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  private setRuntimeStatus(sessionID: string, status: Status): Objective {
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (current.status !== statusActive) return current;
    current.status = status;
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /** Returns paused/blocked/limited objectives to active when allowed. */
  resume(sessionID: string): Objective {
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    switch (current.status) {
      case statusActive:
        return current;
      case statusPaused:
      case statusBlocked:
      case statusUsageLimited:
        break;
      default:
        throw new EsmInvalidTransitionError();
    }
    current.status = statusActive;
    current.blockedCount = 0;
    current.blockedReason = "";
    current.blockedRunId = "";
    current.completionReason = "";
    current.completionRunId = "";
    current.phase = phaseWorker;
    current.rejectionCount = 0;
    current.rejectionRunId = "";
    current.recoveryCount = 0;
    current.recoveryReason = "";
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /** Records the current role in the worker/critic/audit pipeline. */
  setPhase(sessionID: string, phase: Phase): Objective {
    switch (phase) {
      case phaseWorker:
      case phaseCritic:
      case phaseAudit:
      case phaseComplete:
        break;
      default:
        throw new Error(`invalid esm phase ${JSON.stringify(phase)}`);
    }
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    let validTransition = false;
    switch (phase) {
      case phaseWorker:
        validTransition = current.status === statusActive;
        break;
      case phaseCritic:
      case phaseAudit:
        validTransition = current.status === statusCompleteCandidate;
        break;
      case phaseComplete:
        validTransition = current.status === statusComplete;
        break;
    }
    if (!validTransition) throw new EsmInvalidTransitionError();
    current.phase = phase;
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /**
   * Persists the latest structured worker result so later runs and the TUI can
   * show concrete progress and remaining work.
   */
  recordWorkerProgress(
    sessionID: string,
    summary: string,
    remainingWork: string[],
  ): Objective {
    remainingWork = trimStringSlice(remainingWork);
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (current.status !== statusActive) throw new EsmInvalidTransitionError();
    current.phase = phaseWorker;
    current.progressSummary = summary.trim();
    current.remainingWork = remainingWork;
    current.recoveryCount = 0;
    current.recoveryReason = "";
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /**
   * Persists a recovery diagnosis after an interrupted ESM role. Recovery is
   * observability, not a circuit breaker: an active long-task objective remains
   * active until it completes, is explicitly stopped, or a real blocker is
   * recorded.
   */
  recordRecovery(
    sessionID: string,
    reason: string,
    summary: string,
    remainingWork: string[] | null,
  ): Objective {
    reason = reason.trim();
    summary = summary.trim();
    if (reason === "") {
      throw new Error("recovery requires an interruption reason");
    }
    const db = openRootDB(this.sessionDir);
    if (summary === "") {
      summary =
        "Interrupted ESM role; recovery will continue from the current repository state.";
    }
    db.runInTx((tx) => {
      const current = getObjective(tx, sessionID);
      if (current.status !== statusActive) {
        throw new EsmInvalidTransitionError();
      }
      if (remainingWork === null) remainingWork = current.remainingWork;
      current.status = statusActive;
      current.recoveryCount = current.recoveryCount + 1;
      current.recoveryReason = reason;
      current.progressSummary = summary;
      current.remainingWork = trimStringSlice(remainingWork);
      current.updatedAt = this.now();
      saveObjective(tx, current);
    });
    return this.get(sessionID);
  }

  /**
   * Accumulates one agent run's usage. Usage counters are observability only;
   * ESM no longer enforces token or time limits.
   */
  accountUsage(
    sessionID: string,
    tokens: number,
    durationMS: number,
  ): Objective {
    if (tokens < 0) tokens = 0;
    if (durationMS < 0) durationMS = 0;
    const db = openRootDB(this.sessionDir);
    db.runInTx((tx) => {
      const current = getObjective(tx, sessionID);
      current.tokensUsed += tokens;
      current.timeUsedMs += durationMS;
      current.updatedAt = this.now();
      saveObjective(tx, current);
    });
    return this.get(sessionID);
  }

  /**
   * Accepts the two model-controlled transitions: complete and blocked.
   * Complete records a candidate only; the orchestrator must audit the candidate
   * before marking the objective terminal complete.
   */
  updateFromModel(
    sessionID: string,
    status: Status,
    reason: string,
  ): Objective {
    return this.updateFromModelForRun(sessionID, status, reason, "");
  }

  /**
   * Accepts model-controlled complete/blocked transitions. Complete becomes
   * complete_candidate, never terminal complete. Blocked only becomes terminal
   * after the same blocker repeats in three consecutive ESM agent runs.
   */
  updateFromModelForRun(
    sessionID: string,
    status: Status,
    reason: string,
    runID: string,
  ): Objective {
    reason = reason.trim();
    runID = runID.trim();
    switch (status) {
      case statusComplete:
        if (reason === "") {
          throw new Error("complete status requires verification evidence");
        }
        break;
      case statusBlocked:
        if (reason === "") {
          throw new Error("blocked status requires a concrete reason");
        }
        if (runID === "") {
          throw new Error("blocked status requires an ESM run id");
        }
        break;
      default:
        throw new Error(
          `model may only set esm status to ${
            JSON.stringify(statusComplete)
          } or ${JSON.stringify(statusBlocked)}`,
        );
    }

    const db = openRootDB(this.sessionDir);
    let transitionCurrent: Objective | null = null;
    try {
      db.runInTx((tx) => {
        const current = getObjective(tx, sessionID);
        if (current.status !== statusActive) {
          transitionCurrent = current;
          throw new EsmInvalidTransitionError();
        }
        switch (status) {
          case statusComplete:
            current.status = statusCompleteCandidate;
            current.blockedCount = 0;
            current.blockedReason = "";
            current.blockedRunId = "";
            current.completionReason = reason;
            current.completionRunId = runID;
            current.completionReview = "";
            current.phase = phaseCritic;
            break;
          case statusBlocked: {
            let nextCount = current.blockedCount;
            if (
              current.blockedRunId === runID &&
              sameBlockedReason(current.blockedReason, reason)
            ) {
              // Same run already contributed; keep the count.
            } else if (sameBlockedReason(current.blockedReason, reason)) {
              nextCount++;
            } else {
              nextCount = 1;
            }
            current.status = statusActive;
            current.blockedCount = nextCount;
            current.blockedReason = reason;
            current.blockedRunId = runID;
            if (nextCount >= blockedAuditLimit) {
              current.status = statusBlocked;
            }
            current.completionReason = "";
            current.completionRunId = "";
            current.completionReview = "";
            current.rejectionCount = 0;
            current.rejectionRunId = "";
            break;
          }
        }
        current.updatedAt = this.now();
        saveObjective(tx, current);
      });
    } catch (err) {
      if (err instanceof EsmInvalidTransitionError) {
        throw new EsmInvalidTransitionError();
      }
      throw err;
    }
    if (transitionCurrent !== null) return transitionCurrent;
    return this.get(sessionID);
  }

  /**
   * Marks a completion candidate terminal complete after an independent ESM
   * audit has verified the objective against the current state.
   */
  markCompleteFromAudit(sessionID: string, review: string): Objective {
    review = review.trim();
    if (review === "") {
      throw new Error("complete audit requires a review");
    }
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (current.status !== statusCompleteCandidate) {
      throw new EsmInvalidTransitionError();
    }
    current.status = statusComplete;
    current.blockedCount = 0;
    current.blockedReason = "";
    current.blockedRunId = "";
    current.completionReview = review;
    current.phase = phaseComplete;
    current.remainingWork = [];
    current.rejectionCount = 0;
    current.rejectionRunId = "";
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /**
   * Records a failed completion candidate. A rejected claim means work remains,
   * so unattended continuation stays active.
   */
  rejectCompletionCandidate(sessionID: string, review: string): Objective {
    const current = this.get(sessionID);
    return this.rejectCompletionCandidateForRun(
      sessionID,
      current.completionRunId,
      review,
      null,
    );
  }

  /**
   * Records a critic/audit rejection with its structured missing work. A run
   * contributes at most once to the streak.
   */
  rejectCompletionCandidateForRun(
    sessionID: string,
    runID: string,
    review: string,
    missingWork: string[] | null,
  ): Objective {
    return this.recordCompletionRejection(
      sessionID,
      runID,
      review,
      missingWork,
      statusCompleteCandidate,
    );
  }

  /**
   * Records a worker report rejected before supervisor review while the
   * objective is still active.
   */
  rejectWorkerReport(
    sessionID: string,
    runID: string,
    review: string,
    remainingWork: string[] | null,
  ): Objective {
    return this.recordCompletionRejection(
      sessionID,
      runID,
      review,
      remainingWork,
      statusActive,
    );
  }

  private recordCompletionRejection(
    sessionID: string,
    runID: string,
    review: string,
    remainingWork: string[] | null,
    expectedStatus: Status,
  ): Objective {
    review = review.trim();
    if (review === "") {
      throw new Error("completion rejection requires an audit review");
    }
    runID = runID.trim();
    const db = openRootDB(this.sessionDir);
    let transitionCurrent: Objective | null = null;
    let idempotent = false;
    try {
      db.runInTx((tx) => {
        const current = getObjective(tx, sessionID);
        if (current.status !== expectedStatus) {
          transitionCurrent = current;
          if (runID !== "" && current.rejectionRunId === runID) {
            idempotent = true;
            return;
          }
          throw new EsmInvalidTransitionError();
        }
        let nextCount = current.rejectionCount;
        if (runID === "" || current.rejectionRunId !== runID) {
          nextCount++;
        }
        current.status = statusActive;
        current.completionReview = review;
        current.remainingWork = trimStringSlice(remainingWork ?? []);
        current.rejectionCount = nextCount;
        current.rejectionRunId = runID;
        current.updatedAt = this.now();
        saveObjective(tx, current);
      });
    } catch (err) {
      if (err instanceof EsmInvalidTransitionError) {
        throw new EsmInvalidTransitionError();
      }
      throw err;
    }
    if (idempotent) return transitionCurrent as unknown as Objective;
    return this.get(sessionID);
  }

  /**
   * Stores a completion rejection/review note without changing the current
   * lifecycle state.
   */
  recordCompletionReview(sessionID: string, review: string): Objective {
    review = review.trim();
    if (review === "") {
      throw new Error("completion review cannot be empty");
    }
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (!isUnfinishedStatus(current.status)) {
      throw new EsmInvalidTransitionError();
    }
    current.completionReview = review;
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /**
   * Clears repeated blocker/rejection streaks when an active ESM run finishes
   * without reporting the same condition.
   */
  finishRun(sessionID: string, runID: string): Objective {
    runID = runID.trim();
    if (runID === "") return this.get(sessionID);
    const db = openRootDB(this.sessionDir);
    const current = getObjective(db.db!, sessionID);
    if (current.status !== statusActive) return current;
    let nextBlockedCount = current.blockedCount;
    let nextBlockedReason = current.blockedReason;
    let nextBlockedRunID = current.blockedRunId;
    if (
      current.blockedCount > 0 && current.blockedRunId !== "" &&
      current.blockedRunId !== runID
    ) {
      nextBlockedCount = 0;
      nextBlockedReason = "";
      nextBlockedRunID = "";
    }
    let nextRejectionCount = current.rejectionCount;
    let nextRejectionRunID = current.rejectionRunId;
    if (
      current.rejectionCount > 0 && current.rejectionRunId !== "" &&
      current.rejectionRunId !== runID
    ) {
      nextRejectionCount = 0;
      nextRejectionRunID = "";
    }
    if (
      nextBlockedCount === current.blockedCount &&
      nextRejectionCount === current.rejectionCount
    ) {
      return current;
    }
    current.blockedCount = nextBlockedCount;
    current.blockedReason = nextBlockedReason;
    current.blockedRunId = nextBlockedRunID;
    current.rejectionCount = nextRejectionCount;
    current.rejectionRunId = nextRejectionRunID;
    current.updatedAt = this.now();
    saveObjective(db.db!, current);
    return this.get(sessionID);
  }

  /**
   * Queues user guidance for the session's objective. The guidance is stamped
   * with the objective's current version so adapters can detect stale
   * submissions, and the Supervisor injects it into the next role prompts.
   */
  addGuidance(sessionID: string, text: string): Objective {
    text = text.trim();
    if (text === "") throw new Error("guidance cannot be empty");
    const obj = this.get(sessionID);
    const guidance: ESMGuidance = {
      id: "guidance-" + generateID(),
      sessionId: sessionID,
      objectiveVersion: formatTime(obj.updatedAt),
      guidance: text,
      status: "pending",
      createdAt: new Date(),
    };
    saveESMGuidance(this.sessionDir, guidance);
    return obj;
  }

  /** Returns queued guidance not yet injected into a role run. */
  pendingGuidance(sessionID: string): ESMGuidance[] {
    return listESMGuidance(this.sessionDir, sessionID, "pending", 100);
  }

  /** Marks queued guidance as applied after a role run used it. */
  consumeGuidance(sessionID: string, ids: string[]): void {
    consumeESMGuidance(this.sessionDir, sessionID, ids);
  }

  private now(): Date {
    return new Date(this.clock().getTime());
  }

  private timestamp(): string {
    return formatTime(this.now());
  }
}

// Reads the objective for `sessionID` through the DAO, mapping the DAO
// "no rows" sentinel to EsmObjectiveNotFoundError.
function getObjective(executor: DB, sessionID: string): Objective {
  let record: ESMObjectiveRecord;
  try {
    record = new ESMDAO(null).getFrom(executor, sessionID);
  } catch (err) {
    if (isNoRows(err)) throw new EsmObjectiveNotFoundError();
    throw err;
  }
  return objectiveFromRecord(record);
}

function objectiveFromRecord(record: ESMObjectiveRecord | null): Objective {
  if (record === null) throw new EsmObjectiveNotFoundError();
  let remaining: string[];
  try {
    remaining = JSON.parse(record.remainingWork) as string[];
  } catch (err) {
    throw new Error(
      `decode esm remaining work: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return {
    sessionId: record.sessionId,
    esmId: record.esmId,
    objective: record.objective,
    status: record.status,
    tokensUsed: record.tokensUsed,
    timeUsedMs: record.timeUsedMs,
    blockedCount: record.blockedCount,
    blockedReason: record.blockedReason,
    blockedRunId: record.blockedRunId,
    completionReason: record.completionReason,
    completionRunId: record.completionRunId,
    completionReview: record.completionReview,
    phase: record.phase,
    progressSummary: record.progressSummary,
    remainingWork: remaining,
    rejectionCount: record.rejectionCount,
    rejectionRunId: record.rejectionRunId,
    recoveryCount: record.recoveryCount,
    recoveryReason: record.recoveryReason,
    createdAt: parseTime(record.createdAt),
    updatedAt: parseTime(record.updatedAt),
  };
}

function objectiveRecord(obj: Objective): ESMObjectiveRecord {
  if (obj === null || obj.sessionId === "") {
    throw new Error("esm objective is invalid");
  }
  return {
    sessionId: obj.sessionId,
    esmId: obj.esmId,
    objective: obj.objective,
    status: obj.status,
    tokensUsed: obj.tokensUsed,
    timeUsedMs: obj.timeUsedMs,
    blockedCount: obj.blockedCount,
    blockedReason: obj.blockedReason,
    blockedRunId: obj.blockedRunId,
    completionReason: obj.completionReason,
    completionRunId: obj.completionRunId,
    completionReview: obj.completionReview,
    phase: obj.phase,
    progressSummary: obj.progressSummary,
    remainingWork: encodeStringSlice(obj.remainingWork),
    rejectionCount: obj.rejectionCount,
    rejectionRunId: obj.rejectionRunId,
    recoveryCount: obj.recoveryCount,
    recoveryReason: obj.recoveryReason,
    createdAt: formatTime(obj.createdAt),
    updatedAt: formatTime(obj.updatedAt),
  };
}

/** Formats a Date as the durable RFC3339 representation, or "" for the zero value. */
export function formatTime(value: Date): string {
  if (value.getTime() === 0) return "";
  return value.toISOString();
}

function saveObjective(executor: DB, obj: Objective): void {
  new ESMDAO(null).update(executor, objectiveRecord(obj));
}

function parseTime(value: string): Date {
  if (value === "") return new Date(0);
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return new Date(0);
  return t;
}

function encodeStringSlice(values: string[]): string {
  let trimmed = trimStringSlice(values);
  if (trimmed.length === 0) trimmed = [];
  return JSON.stringify(trimmed);
}

function sameBlockedReason(a: string, b: string): boolean {
  const ta = a.trim().toLowerCase();
  const tb = b.trim().toLowerCase();
  return ta === tb && a.trim() !== "";
}

/**
 * Applies a conservative text heuristic for provider/account limits that should
 * stop unattended continuation.
 */
export function isUsageLimitError(err: unknown): boolean {
  if (err == null) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const markers = [
    "usage limit",
    "rate limit",
    "quota",
    "insufficient_quota",
    "resource_exhausted",
    "billing",
    "too many requests",
  ];
  return markers.some((marker) => msg.includes(marker));
}

/** Re-exported so callers can classify an objective without importing state. */
export { canAutoRun };
