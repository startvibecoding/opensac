//
// Durable admission identity for one original or retry submission. Only a
// digest of the transport key is persisted.

import { RuntimeSubmissionDAO, type Tx } from "../dao/mod.ts";
import { generateID } from "./entry.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";

const runtimeSubmissionExistsMessage = "runtime submission already exists";
const runtimeSubmissionConflictMessage =
  "runtime submission key conflicts with another request";

/** Thrown when a submission key is already admitted. */
export class RuntimeSubmissionExistsError extends Error {
  override name = "RuntimeSubmissionExistsError";
  constructor() {
    super(runtimeSubmissionExistsMessage);
  }
}

/** Thrown when a submission key conflicts with another request. */
export class RuntimeSubmissionConflictError extends Error {
  override name = "RuntimeSubmissionConflictError";
  constructor() {
    super(runtimeSubmissionConflictMessage);
  }
}

/** The durable admission identity for one original or retry submission. */
export interface RuntimeSubmission {
  id: string;
  sessionId: string;
  scope: string;
  keyHash: string;
  requestFingerprint: string;
  intentId: string;
  runId: string;
  createdAt: Date;
}

/**
 * Carries the canonical Run identity selected by a competing or replayed
 * admission.
 */
export class RuntimeSubmissionError extends Error {
  readonly existing: RuntimeSubmission;
  readonly conflict: boolean;

  constructor(existing: RuntimeSubmission, conflict: boolean) {
    super(
      conflict
        ? `${runtimeSubmissionConflictMessage}: existing Run ${existing.runId}`
        : `${runtimeSubmissionExistsMessage}: Run ${existing.runId}`,
      {
        cause: conflict
          ? new RuntimeSubmissionConflictError()
          : new RuntimeSubmissionExistsError(),
      },
    );
    this.name = "RuntimeSubmissionError";
    this.existing = existing;
    this.conflict = conflict;
  }
}

/** The admission fields a Run supplies to reserve its submission key. */
export interface RuntimeSubmissionRunInput {
  submissionKeyHash: string;
  submissionScope: string;
  submissionFingerprint: string;
  sessionId: string;
  startedAt: Date;
  intentId: string;
  id: string;
}

/**
 * Reserves the submission identity for a Run inside the caller's transaction,
 * resolving the durable winner when a concurrent process wins the unique
 * constraint.
 */
export function reserveRuntimeSubmissionTx(
  tx: Tx,
  run: RuntimeSubmissionRunInput,
): void {
  const keyHash = run.submissionKeyHash.trim();
  if (keyHash === "") return;
  const scope = run.submissionScope.trim();
  if (scope === "") throw new Error("runtime submission scope is required");
  const fingerprint = run.submissionFingerprint.trim();

  const existing = getRuntimeSubmissionTx(tx, run.sessionId, scope, keyHash);
  if (existing !== null) {
    throw new RuntimeSubmissionError(
      existing,
      existing.requestFingerprint !== "" &&
        fingerprint !== "" &&
        existing.requestFingerprint !== fingerprint,
    );
  }

  const createdAt =
    run.startedAt && !Number.isNaN(run.startedAt.getTime())
      ? run.startedAt
      : new Date();
  try {
    new RuntimeSubmissionDAO(null).insert(tx, {
      id: generateID(),
      sessionId: run.sessionId,
      scope,
      keyHash,
      requestFingerprint: fingerprint,
      intentId: run.intentId,
      runId: run.id,
      createdAt: createdAt.toISOString(),
    });
    return;
  } catch (err) {
    // A concurrent process can win the unique constraint after our initial
    // lookup. Resolve the durable winner before returning the typed result.
    const winner = getRuntimeSubmissionTx(tx, run.sessionId, scope, keyHash);
    if (winner !== null) {
      throw new RuntimeSubmissionError(
        winner,
        winner.requestFingerprint !== "" &&
          fingerprint !== "" &&
          winner.requestFingerprint !== fingerprint,
      );
    }
    throw err;
  }
}

function getRuntimeSubmissionTx(
  tx: Tx,
  sessionId: string,
  scope: string,
  keyHash: string,
): RuntimeSubmission | null {
  const record = new RuntimeSubmissionDAO(null).find(
    tx,
    sessionId,
    scope,
    keyHash,
  );
  if (record === undefined) return null;
  return {
    id: record.id,
    sessionId: record.sessionId,
    scope: record.scope,
    keyHash: record.keyHash,
    requestFingerprint: record.requestFingerprint,
    intentId: record.intentId,
    runId: record.runId,
    createdAt: parseSessionTimestamp(record.createdAt),
  };
}

/** Looks up the durable submission for a session/scope/key hash, or null. */
export function getRuntimeSubmission(
  sessionDir: string,
  sessionId: string,
  scope: string,
  keyHash: string,
): RuntimeSubmission | null {
  if (sessionId === "" || scope.trim() === "" || keyHash.trim() === "") {
    return null;
  }
  const db = openRootDB(sessionDir);
  const record = new RuntimeSubmissionDAO(db.db).find(
    db.db!,
    sessionId,
    scope,
    keyHash,
  );
  if (record === undefined) return null;
  return {
    id: record.id,
    sessionId: record.sessionId,
    scope: record.scope,
    keyHash: record.keyHash,
    requestFingerprint: record.requestFingerprint,
    intentId: record.intentId,
    runId: record.runId,
    createdAt: parseSessionTimestamp(record.createdAt),
  };
}
