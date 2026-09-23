//
// The durable Run delivery outbox: run-level intents plus ordered,
// independently recoverable operations. A terminal transaction creates the plan
// together with the Run transition; recovery claims and fences each operation.
//
// Deviations from Go: `context.Context` is dropped (the DAO layer is
// synchronous), `json.RawMessage` maps to decoded `unknown` (serialized on
// write), and `time.Time` maps to `Date` (millisecond leases use epoch millis).

import { DeliveryDAO, isNoRows } from "../dao/mod.ts";
import type { Database, DeliveryFailureRecord } from "../dao/mod.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";
import { writeRootDatabase } from "./database.ts";
import { normalizedRunJSON } from "./run_json.ts";

/** Thrown when a delivery operation lease was lost to another owner/epoch. */
export class DeliveryLeaseLostError extends Error {
  override name = "DeliveryLeaseLostError";
  constructor() {
    super("delivery operation lease was lost");
  }
}

/** Thrown when a delivery operation is leased or not yet ready. */
export class DeliveryOperationBusyError extends Error {
  override name = "DeliveryOperationBusyError";
  constructor() {
    super("delivery operation is leased or not ready");
  }
}

/** Thrown when a delivery operation row is absent. */
export class DeliveryOperationAbsentError extends Error {
  override name = "DeliveryOperationAbsentError";
  constructor() {
    super("delivery operation was not found");
  }
}

/** Default lease window for an unclaimed operation. */
export const defaultDeliveryLeaseMs = 30_000;

/**
 * The run-level durable outbox identity. `transportContext` is opaque
 * Runtime-owned state and must never be projected into prompts or logs.
 */
export interface DeliveryIntent {
  id: string;
  sessionId: string;
  runId: string;
  platform: string;
  targetId: string;
  replyMessageId: string;
  transportContext: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One ordered, independently recoverable outbox step. */
export interface DeliveryOperation {
  id: string;
  intentId: string;
  operationKey: string;
  artifactId: string;
  operationKind: string;
  sequence: number;
  dependsOn: string;
  idempotencyKey: string;
  payloadDigest: string;
  status: string;
  providerAssetId: string;
  providerMessageId: string;
  providerState: unknown;
  attemptCount: number;
  nextAttemptAt: Date | null;
  failureCode: string;
  /** Restarts the transient retry budget after an explicit retry. */
  retryWindowStartedAt: Date | null;
  leaseOwner: string;
  leaseEpoch: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A plan created in the same transaction that terminalizes its Run. */
export interface DeliveryPlan {
  intent: DeliveryIntent;
  operations: DeliveryOperation[];
}

/** The operator-facing view of one delivery operation that needs attention. */
export interface DeliveryFailure {
  operationId: string;
  intentId: string;
  sessionId: string;
  runId: string;
  platform: string;
  targetId: string;
  operationKind: string;
  status: string;
  failureCode: string;
  attemptCount: number;
  updatedAt: Date;
}

function stringValue(value: string | null): string {
  return value ?? "";
}

function requireConn(db: Database): NonNullable<Database["db"]> {
  if (db.db === null) {
    throw new Error("delivery database is not open");
  }
  return db.db;
}

/**
 * Persists a plan outside terminalization only for recovery reconciliation and
 * focused tools. Normal execution must attach the plan to
 * `finishSessionRunAndConversationTurn` instead.
 */
export function createDeliveryPlan(
  sessionDir: string,
  plan: DeliveryPlan,
): void {
  writeRootDatabase(sessionDir, (tx) => {
    createDeliveryPlanTx(tx, plan);
  });
}

/**
 * Shared transaction primitive used by standalone plan persistence and
 * terminal Run finalization. The caller owns commit.
 */
export function createDeliveryPlanTx(
  tx: Parameters<DeliveryDAO["insertIntent"]>[0],
  plan: DeliveryPlan,
): void {
  const dao = new DeliveryDAO(null);
  const intent = { ...plan.intent };
  intent.id = intent.id.trim();
  intent.sessionId = intent.sessionId.trim();
  intent.runId = intent.runId.trim();
  intent.platform = intent.platform.trim();
  if (
    intent.id === "" || intent.sessionId === "" || intent.runId === "" ||
    intent.platform === ""
  ) {
    throw new Error(
      "delivery intent identity, session, run, and platform are required",
    );
  }
  if (plan.operations.length === 0) {
    throw new Error("delivery intent requires at least one operation");
  }
  if (intent.status === "") intent.status = "pending";
  if (intent.status !== "pending") {
    throw new Error("new delivery intent status must be pending");
  }
  if (
    !(intent.createdAt instanceof Date) || isNaN(intent.createdAt.getTime())
  ) {
    intent.createdAt = new Date();
  }
  if (
    !(intent.updatedAt instanceof Date) || isNaN(intent.updatedAt.getTime())
  ) {
    intent.updatedAt = intent.createdAt;
  }
  const transportContext = normalizedRunJSON(intent.transportContext);
  const runExists = dao.runExists(tx, intent.sessionId, intent.runId);
  if (!runExists) {
    throw new Error(
      `delivery Run ${intent.runId} does not belong to session`,
    );
  }
  const changed = dao.insertIntent(tx, {
    id: intent.id,
    sessionId: intent.sessionId,
    runId: intent.runId,
    platform: intent.platform,
    targetId: intent.targetId,
    replyMessageId: intent.replyMessageId,
    transportContext,
    status: intent.status,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
  });
  if (changed === 0) {
    const existingRecord = dao.findIntentByKey(
      tx,
      intent.runId,
      intent.platform,
      intent.targetId,
    );
    const existing = deliveryIntentFromRecord(existingRecord);
    if (
      existing.id !== intent.id ||
      existing.sessionId !== intent.sessionId ||
      existing.replyMessageId !== intent.replyMessageId ||
      normalizedRunJSON(existing.transportContext).trim() !==
        transportContext.trim()
    ) {
      throw new Error("delivery intent conflicts with existing Run projection");
    }
  }

  const operations = [...plan.operations].sort((a, b) =>
    a.sequence - b.sequence
  );
  const seenKeys = new Set<string>();
  const seenSequences = new Set<number>();
  const seenIDs = new Set<string>();
  for (const operation of operations) {
    operation.intentId = intent.id;
    operation.id = operation.id.trim();
    operation.operationKey = operation.operationKey.trim();
    operation.operationKind = operation.operationKind.trim();
    operation.idempotencyKey = operation.idempotencyKey.trim();
    operation.payloadDigest = operation.payloadDigest.trim();
    if (
      operation.id === "" || operation.operationKey === "" ||
      operation.operationKind === "" || operation.sequence <= 0 ||
      operation.idempotencyKey === "" || operation.payloadDigest === ""
    ) {
      throw new Error(
        "delivery operation identity, key, kind, sequence, idempotency key, and digest are required",
      );
    }
    if (seenKeys.has(operation.operationKey)) {
      throw new Error(
        `duplicate delivery operation key ${
          JSON.stringify(operation.operationKey)
        }`,
      );
    }
    if (seenSequences.has(operation.sequence)) {
      throw new Error(
        `duplicate delivery operation sequence ${operation.sequence}`,
      );
    }
    if (operation.dependsOn !== "") {
      if (!seenIDs.has(operation.dependsOn)) {
        throw new Error(
          `delivery operation ${operation.id} depends on a missing or later operation`,
        );
      }
    }
    seenKeys.add(operation.operationKey);
    seenSequences.add(operation.sequence);
    seenIDs.add(operation.id);
    if (operation.artifactId !== "") {
      const exists = dao.attachmentExists(
        tx,
        intent.sessionId,
        intent.runId,
        operation.artifactId,
      );
      if (!exists) {
        throw new Error(
          `delivery artifact ${operation.artifactId} does not belong to Run`,
        );
      }
    }
    if (operation.status === "") operation.status = "pending";
    if (operation.status !== "pending" && operation.status !== "unsupported") {
      throw new Error(
        "new delivery operation status must be pending or unsupported",
      );
    }
    if (
      !(operation.createdAt instanceof Date) ||
      isNaN(operation.createdAt.getTime())
    ) {
      operation.createdAt = intent.createdAt;
    }
    if (
      !(operation.updatedAt instanceof Date) ||
      isNaN(operation.updatedAt.getTime())
    ) {
      operation.updatedAt = operation.createdAt;
    }
    const providerState = normalizedRunJSON(operation.providerState);
    const inserted = dao.insertOperation(tx, {
      id: operation.id,
      intentId: intent.id,
      operationKey: operation.operationKey,
      artifactId: operation.artifactId === "" ? null : operation.artifactId,
      operationKind: operation.operationKind,
      sequence: operation.sequence,
      dependsOn: operation.dependsOn === "" ? null : operation.dependsOn,
      idempotencyKey: operation.idempotencyKey,
      payloadDigest: operation.payloadDigest,
      status: operation.status,
      providerAssetId: operation.providerAssetId ?? "",
      providerMessageId: operation.providerMessageId ?? "",
      providerState,
      attemptCount: operation.attemptCount ?? 0,
      nextAttemptAt: null,
      failureCode: "",
      retryWindowStartedAt: null,
      leaseOwner: "",
      leaseEpoch: 0,
      leaseExpiresAt: null,
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
    });
    if (inserted === 0) {
      const existingRecord = dao.findOperationByKey(
        tx,
        intent.id,
        operation.operationKey,
      );
      if (
        existingRecord.id !== operation.id ||
        stringValue(existingRecord.artifactId) !== operation.artifactId ||
        existingRecord.operationKind !== operation.operationKind ||
        existingRecord.sequence !== operation.sequence ||
        stringValue(existingRecord.dependsOn) !== operation.dependsOn ||
        existingRecord.idempotencyKey !== operation.idempotencyKey ||
        existingRecord.payloadDigest !== operation.payloadDigest
      ) {
        throw new Error(
          `delivery operation ${
            JSON.stringify(operation.operationKey)
          } conflicts with existing projection`,
        );
      }
    }
  }
}

/** Loads one intent and its operations in execution order. */
export function getDeliveryPlan(
  sessionDir: string,
  intentId: string,
): DeliveryPlan | null {
  const db = openRootDB(sessionDir);
  const conn = requireConn(db);
  const dao = new DeliveryDAO(null);
  let record;
  try {
    record = dao.findIntent(conn, intentId);
  } catch (err) {
    if (isNoRows(err)) return null;
    throw err;
  }
  const plan: DeliveryPlan = {
    intent: deliveryIntentFromRecord(record),
    operations: [],
  };
  const operationRecords = dao.listOperations(conn, intentId);
  for (const op of operationRecords) {
    plan.operations.push(deliveryOperationFromRecord(op));
  }
  return plan;
}

/**
 * Atomically claims the next due operation. The lease epoch is incremented on
 * every claim, so a delayed worker cannot overwrite a later retry after its
 * lease expires.
 */
export function claimDeliveryOperation(
  sessionDir: string,
  operationId: string,
  owner: string,
  now: Date,
  leaseMs: number,
): DeliveryOperation {
  operationId = operationId.trim();
  owner = owner.trim();
  if (operationId === "" || owner === "") {
    throw new Error("delivery operation ID and owner are required");
  }
  if (!(now instanceof Date) || isNaN(now.getTime())) now = new Date();
  if (leaseMs <= 0) leaseMs = defaultDeliveryLeaseMs;
  const claimedUntil = new Date(now.getTime() + leaseMs);
  let operation: DeliveryOperation | null = null;
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new DeliveryDAO(null);
    let intentStatus: string;
    try {
      ({ intentStatus } = dao.dependencyStatus(tx, operationId));
    } catch (err) {
      if (isNoRows(err)) throw new DeliveryOperationAbsentError();
      throw err;
    }
    if (
      intentStatus === "delivered" || intentStatus === "failed" ||
      intentStatus === "cancelled"
    ) {
      throw new DeliveryOperationBusyError();
    }
    const nowMillis = now.getTime();
    const leaseMillis = claimedUntil.getTime();
    const result = dao.claim(tx, operationId, owner, nowMillis, leaseMillis);
    if (result !== 1) throw new DeliveryOperationBusyError();
    const loadedRecord = dao.findOperation(tx, operationId);
    operation = deliveryOperationFromRecord(loadedRecord);
  });
  if (operation === null) throw new DeliveryOperationAbsentError();
  return operation;
}

/**
 * Applies a fenced provider result. Terminal updates are idempotent when a
 * retry repeats the same result after an unknown commit.
 */
export function updateDeliveryOperation(
  sessionDir: string,
  operationId: string,
  owner: string,
  epoch: number,
  status: string,
  providerAssetId: string,
  providerMessageId: string,
  providerState: unknown,
  failureCode: string,
  nextAttemptAt: Date | null,
): void {
  operationId = operationId.trim();
  owner = owner.trim();
  status = status.trim();
  if (operationId === "" || owner === "" || epoch <= 0) {
    throw new Error("delivery operation identity and lease are required");
  }
  if (!validDeliveryOperationStatus(status)) {
    throw new Error(
      `invalid delivery operation status ${JSON.stringify(status)}`,
    );
  }
  const providerStateJson = normalizedRunJSON(providerState);
  const updatedAt = new Date();
  const next = nextAttemptAt === null ? null : nextAttemptAt.getTime();
  writeRootDatabase(sessionDir, (tx) => {
    if (status === "retry_wait" && nextAttemptAt === null) {
      throw new Error("retry_wait requires next attempt time");
    }
    const dao = new DeliveryDAO(null);
    const result = dao.updateResult(
      tx,
      operationId,
      owner,
      epoch,
      status,
      providerAssetId.trim(),
      providerMessageId.trim(),
      providerStateJson,
      failureCode.trim(),
      next,
      updatedAt.toISOString(),
    );
    if (result === 1) {
      refreshDeliveryIntentStatusTx(tx, operationId, updatedAt);
      return;
    }
    let currentRecord;
    try {
      currentRecord = dao.currentResult(tx, operationId);
    } catch (err) {
      if (isNoRows(err)) throw new DeliveryOperationAbsentError();
      throw err;
    }
    if (
      currentRecord.status === status &&
      (status === "uploaded" || status === "delivered" ||
        status === "unsupported" || status === "failed" ||
        status === "uncertain") &&
      currentRecord.providerAssetId === providerAssetId.trim() &&
      currentRecord.providerMessageId === providerMessageId.trim() &&
      currentRecord.failureCode === failureCode.trim() &&
      currentRecord.providerState.trim() === providerStateJson.trim()
    ) {
      return;
    }
    throw new DeliveryLeaseLostError();
  });
}

/**
 * Persists an in-flight provider phase while retaining the current lease. A
 * subsequent terminal update must use the same owner and epoch, so a stale
 * worker remains fenced throughout upload/send.
 */
export function updateDeliveryOperationProgress(
  sessionDir: string,
  operationId: string,
  owner: string,
  epoch: number,
  status: string,
  providerAssetId: string,
  providerMessageId: string,
  providerState: unknown,
  failureCode: string,
): void {
  operationId = operationId.trim();
  owner = owner.trim();
  status = status.trim();
  if (operationId === "" || owner === "" || epoch <= 0) {
    throw new Error("delivery operation identity and lease are required");
  }
  if (status !== "uploading" && status !== "sending") {
    throw new Error(
      `invalid in-flight delivery operation status ${JSON.stringify(status)}`,
    );
  }
  const providerStateJson = normalizedRunJSON(providerState);
  const now = new Date();
  writeRootDatabase(sessionDir, (tx) => {
    const result = new DeliveryDAO(null).updateProgress(
      tx,
      operationId,
      owner,
      epoch,
      status,
      providerAssetId.trim(),
      providerMessageId.trim(),
      providerStateJson,
      failureCode.trim(),
      now.toISOString(),
    );
    if (result !== 1) throw new DeliveryLeaseLostError();
    refreshDeliveryIntentStatusTx(tx, operationId, now);
  });
}

/**
 * Releases a fenced lease for an explicit retry. It is used by recovery when a
 * provider call did not yield a trustworthy result.
 */
export function requeueDeliveryOperation(
  sessionDir: string,
  operationId: string,
  owner: string,
  epoch: number,
  nextAttemptAt: Date,
  failureCode: string,
): void {
  updateDeliveryOperation(
    sessionDir,
    operationId,
    owner,
    epoch,
    "retry_wait",
    "",
    "",
    null,
    failureCode,
    nextAttemptAt,
  );
}

/**
 * Returns an operation that exhausted its retry budget to `retry_wait` and
 * restarts its retry window. Only a failed operation can be reopened so an
 * in-flight or delivered operation is never clobbered.
 */
export function reopenFailedDeliveryOperation(
  sessionDir: string,
  operationId: string,
  now: Date,
): boolean {
  if (operationId.trim() === "") {
    throw new Error("delivery operation ID is required");
  }
  if (!(now instanceof Date) || isNaN(now.getTime())) now = new Date();
  const stamp = now.toISOString();
  let reopened = false;
  writeRootDatabase(sessionDir, (tx) => {
    const dao = new DeliveryDAO(null);
    const changed = dao.reopenTransientFailure(
      tx,
      operationId,
      stamp,
      stamp,
    );
    if (changed !== 1) return;
    reopened = true;
    const intentId = dao.intentId(tx, operationId);
    // Operations that were terminalized only because this dependency failed
    // must get another chance, otherwise a reopened caption would still be
    // followed by a permanently failed attachment.
    dao.reopenDependentFailures(tx, intentId, stamp, stamp);
    refreshDeliveryIntentStatusByIdTx(tx, intentId, now);
  });
  return reopened;
}

/**
 * Returns one platform's operations that exhausted their retry budget on a
 * transport-level failure, in delivery order. Reconnect recovery uses it to
 * grant another retry window.
 */
export function listFailedTransientDeliveryOperations(
  sessionDir: string,
  platform: string,
): string[] {
  if (sessionDir.trim() === "" || platform.trim() === "") return [];
  const db = openRootDB(sessionDir);
  const conn = requireConn(db);
  return new DeliveryDAO(null).failedTransientIdsByPlatform(conn, platform);
}

/**
 * Lists operations that need operator attention (failed or uncertain),
 * optionally narrowed to one session.
 */
export function listDeliveryFailures(
  sessionDir: string,
  sessionId: string,
  limit: number,
): DeliveryFailure[] {
  if (sessionDir.trim() === "") return [];
  const db = openRootDB(sessionDir);
  const conn = requireConn(db);
  const rows: DeliveryFailureRecord[] = new DeliveryDAO(null).listFailureRows(
    conn,
    sessionId,
    limit,
  );
  return rows.map((row) => ({
    operationId: row.operationId,
    intentId: row.intentId,
    sessionId: row.sessionId,
    runId: row.runId,
    platform: row.platform,
    targetId: row.targetId,
    operationKind: row.operationKind,
    status: row.status,
    failureCode: row.failureCode,
    attemptCount: row.attemptCount,
    updatedAt: parseSessionTimestamp(row.updatedAt),
  }));
}

/**
 * Recomputes the intent aggregate after an operation result. An intent is
 * delivered only when all operations are delivered/unsupported; failed and
 * uncertain operations remain visible.
 */
export function refreshDeliveryIntentStatus(
  sessionDir: string,
  intentId: string,
): void {
  writeRootDatabase(sessionDir, (tx) => {
    refreshDeliveryIntentStatusByIdTx(tx, intentId, new Date());
  });
}

/**
 * Returns recoverable operations whose retry time is due or whose previous
 * worker lease has expired. It is intentionally a read; callers must claim each
 * row through `claimDeliveryOperation` before executing.
 */
export function listDueDeliveryOperations(
  sessionDir: string,
  now: Date,
): DeliveryOperation[] {
  if (!(now instanceof Date) || isNaN(now.getTime())) now = new Date();
  const db = openRootDB(sessionDir);
  const operationIds = new DeliveryDAO(requireConn(db)).dueIds(now.getTime());
  const operations: DeliveryOperation[] = [];
  for (const operationId of operationIds) {
    const operation = getDeliveryOperation(sessionDir, operationId);
    if (operation !== null) operations.push(operation);
  }
  return operations;
}

/**
 * Loads one operation without exposing transport credentials or requiring
 * callers to know its parent intent ID.
 */
export function getDeliveryOperation(
  sessionDir: string,
  operationId: string,
): DeliveryOperation | null {
  const db = openRootDB(sessionDir);
  const conn = requireConn(db);
  let record;
  try {
    record = new DeliveryDAO(null).findOperation(conn, operationId);
  } catch (err) {
    if (isNoRows(err)) throw new DeliveryOperationAbsentError();
    throw err;
  }
  return deliveryOperationFromRecord(record);
}

function refreshDeliveryIntentStatusTx(
  tx: unknown,
  operationId: string,
  now: Date,
): void {
  const dao = new DeliveryDAO(null);
  const intentId = dao.intentId(
    tx as Parameters<DeliveryDAO["intentId"]>[0],
    operationId,
  );
  refreshDeliveryIntentStatusByIdTx(tx, intentId, now);
}

function refreshDeliveryIntentStatusByIdTx(
  tx: unknown,
  intentId: string,
  now: Date,
): void {
  // A terminal prerequisite can never make its dependent operation valid.
  // Resolve dependent operations before calculating the intent aggregate.
  const dao = new DeliveryDAO(null);
  const executor = tx as Parameters<
    DeliveryDAO["propagateDependencyFailures"]
  >[0];
  dao.propagateDependencyFailures(executor, intentId, now.toISOString());
  const { total, terminal, failed, uncertain } = dao.aggregate(
    executor,
    intentId,
  );
  const resolved = terminal + failed + uncertain;
  let status = "pending";
  if (total > 0 && terminal === total) {
    status = "delivered";
  } else if (failed > 0 && resolved === total) {
    status = "failed";
  } else if (uncertain > 0 && resolved === total) {
    status = "uncertain";
  }
  dao.updateIntentStatus(executor, intentId, status, now.toISOString());
}

/** Reports whether a status is a valid delivery operation state. */
export function validDeliveryOperationStatus(status: string): boolean {
  return [
    "pending",
    "uploading",
    "uploaded",
    "sending",
    "retry_wait",
    "delivered",
    "unsupported",
    "failed",
    "uncertain",
  ].includes(status);
}

function deliveryIntentFromRecord(
  record: {
    id: string;
    sessionId: string;
    runId: string;
    platform: string;
    targetId: string;
    replyMessageId: string;
    transportContext: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  },
): DeliveryIntent {
  return {
    id: record.id,
    sessionId: record.sessionId,
    runId: record.runId,
    platform: record.platform,
    targetId: record.targetId,
    replyMessageId: record.replyMessageId,
    transportContext: record.transportContext === ""
      ? undefined
      : JSON.parse(record.transportContext),
    status: record.status,
    createdAt: parseSessionTimestamp(record.createdAt),
    updatedAt: parseSessionTimestamp(record.updatedAt),
  };
}

function deliveryOperationFromRecord(
  record: {
    id: string;
    intentId: string;
    operationKey: string;
    artifactId: string | null;
    operationKind: string;
    sequence: number;
    dependsOn: string | null;
    idempotencyKey: string;
    payloadDigest: string;
    status: string;
    providerAssetId: string;
    providerMessageId: string;
    providerState: string;
    attemptCount: number;
    nextAttemptAt: number | null;
    failureCode: string;
    retryWindowStartedAt: string | null;
    leaseOwner: string;
    leaseEpoch: number;
    leaseExpiresAt: number | null;
    createdAt: string;
    updatedAt: string;
  },
): DeliveryOperation {
  return {
    id: record.id,
    intentId: record.intentId,
    operationKey: record.operationKey,
    artifactId: stringValue(record.artifactId),
    operationKind: record.operationKind,
    sequence: record.sequence,
    dependsOn: stringValue(record.dependsOn),
    idempotencyKey: record.idempotencyKey,
    payloadDigest: record.payloadDigest,
    status: record.status,
    providerAssetId: record.providerAssetId,
    providerMessageId: record.providerMessageId,
    providerState: record.providerState === ""
      ? undefined
      : JSON.parse(record.providerState),
    attemptCount: record.attemptCount,
    nextAttemptAt: record.nextAttemptAt === null
      ? null
      : new Date(record.nextAttemptAt),
    failureCode: record.failureCode,
    retryWindowStartedAt: record.retryWindowStartedAt === null ||
        record.retryWindowStartedAt === ""
      ? null
      : parseSessionTimestamp(record.retryWindowStartedAt),
    leaseOwner: record.leaseOwner,
    leaseEpoch: record.leaseEpoch,
    createdAt: parseSessionTimestamp(record.createdAt),
    updatedAt: parseSessionTimestamp(record.updatedAt),
  };
}
