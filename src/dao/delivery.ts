// Ported from internal/dao/delivery.go

import type { DB } from "../db/mod.ts";
import { execChanges, inList, queryAll, queryOne } from "./database.ts";

export interface DeliveryIntentRecord {
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
}

export interface DeliveryOperationRecord {
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
  /** Restarts the transient retry budget after an explicit retry. */
  retryWindowStartedAt: string | null;
  leaseOwner: string;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryFailureRecord {
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
  updatedAt: string;
}

const intentColumns = `id, session_id AS sessionId, run_id AS runId, platform,
  target_id AS targetId, reply_message_id AS replyMessageId,
  transport_context AS transportContext, status, created_at AS createdAt,
  updated_at AS updatedAt`;

const operationColumns =
  `id, intent_id AS intentId, operation_key AS operationKey,
  artifact_id AS artifactId, operation_kind AS operationKind, sequence,
  depends_on AS dependsOn, idempotency_key AS idempotencyKey,
  payload_digest AS payloadDigest, status, provider_asset_id AS providerAssetId,
  provider_message_id AS providerMessageId, provider_state AS providerState,
  attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
  failure_code AS failureCode,
  retry_window_started_at AS retryWindowStartedAt, lease_owner AS leaseOwner,
  lease_epoch AS leaseEpoch, lease_expires_at AS leaseExpiresAt,
  created_at AS createdAt, updated_at AS updatedAt`;

export class DeliveryDAO {
  constructor(private readonly db: DB | null) {}

  runExists(executor: DB, sessionId: string, runId: string): boolean {
    return queryAll<{ id: string }>(
      executor,
      `SELECT id FROM session_runs WHERE id = ? AND session_id = ? LIMIT 1`,
      [runId, sessionId],
    ).length > 0;
  }

  attachmentExists(
    executor: DB,
    sessionId: string,
    runId: string,
    artifactId: string,
  ): boolean {
    return queryAll<{ id: string }>(
      executor,
      `SELECT id FROM session_attachments
       WHERE id = ? AND session_id = ? AND run_id = ? LIMIT 1`,
      [artifactId, sessionId, runId],
    ).length > 0;
  }

  insertIntent(executor: DB, record: DeliveryIntentRecord): number {
    return execChanges(
      executor,
      `INSERT INTO delivery_intents
        (id, session_id, run_id, platform, target_id, reply_message_id,
         transport_context, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, platform, target_id) DO NOTHING`,
      [
        record.id,
        record.sessionId,
        record.runId,
        record.platform,
        record.targetId,
        record.replyMessageId,
        record.transportContext,
        record.status,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  findIntentByKey(
    executor: DB,
    runId: string,
    platform: string,
    targetId: string,
  ): DeliveryIntentRecord {
    return queryOne<DeliveryIntentRecord>(
      executor,
      `SELECT ${intentColumns} FROM delivery_intents
       WHERE run_id = ? AND platform = ? AND target_id = ? LIMIT 1`,
      [runId, platform, targetId],
    );
  }

  findIntent(executor: DB, intentId: string): DeliveryIntentRecord {
    return queryOne<DeliveryIntentRecord>(
      executor,
      `SELECT ${intentColumns} FROM delivery_intents WHERE id = ? LIMIT 1`,
      [intentId],
    );
  }

  insertOperation(executor: DB, record: DeliveryOperationRecord): number {
    return execChanges(
      executor,
      `INSERT INTO delivery_operations
        (id, intent_id, operation_key, artifact_id, operation_kind, sequence,
         depends_on, idempotency_key, payload_digest, status, provider_asset_id,
         provider_message_id, provider_state, attempt_count, next_attempt_at,
         failure_code, retry_window_started_at, lease_owner, lease_epoch,
         lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id, operation_key) DO NOTHING`,
      bindOperation(record),
    );
  }

  findOperationByKey(
    executor: DB,
    intentId: string,
    key: string,
  ): DeliveryOperationRecord {
    return queryOne<DeliveryOperationRecord>(
      executor,
      `SELECT ${operationColumns} FROM delivery_operations
       WHERE intent_id = ? AND operation_key = ? LIMIT 1`,
      [intentId, key],
    );
  }

  listOperations(executor: DB, intentId: string): DeliveryOperationRecord[] {
    return queryAll<DeliveryOperationRecord>(
      executor,
      `SELECT ${operationColumns} FROM delivery_operations
       WHERE intent_id = ? ORDER BY sequence ASC`,
      [intentId],
    );
  }

  dependencyStatus(
    executor: DB,
    operationId: string,
  ): { intentStatus: string; dependsOn: string } {
    return queryOne<{ intentStatus: string; dependsOn: string }>(
      executor,
      `SELECT i.status AS intentStatus, COALESCE(o.depends_on, '') AS dependsOn
       FROM delivery_operations AS o
       JOIN delivery_intents AS i ON i.id = o.intent_id
       WHERE o.id = ? LIMIT 1`,
      [operationId],
    );
  }

  claim(
    executor: DB,
    operationId: string,
    owner: string,
    now: number,
    expires: number,
  ): number {
    return execChanges(
      executor,
      `UPDATE delivery_operations SET
         lease_owner = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?,
         attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'uploading', 'sending', 'retry_wait')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND (depends_on IS NULL OR depends_on = '' OR EXISTS (
               SELECT 1 FROM delivery_operations dependency
               WHERE dependency.id = delivery_operations.depends_on
                 AND dependency.intent_id = delivery_operations.intent_id
                 AND dependency.status IN ('uploaded', 'delivered', 'unsupported')))`,
      [owner, expires, new Date(now).toISOString(), operationId, now, now],
    );
  }

  findOperation(executor: DB, operationId: string): DeliveryOperationRecord {
    return queryOne<DeliveryOperationRecord>(
      executor,
      `SELECT ${operationColumns} FROM delivery_operations WHERE id = ? LIMIT 1`,
      [operationId],
    );
  }

  updateResult(
    executor: DB,
    operationId: string,
    owner: string,
    epoch: number,
    status: string,
    assetId: string,
    messageId: string,
    state: string,
    failure: string,
    next: number | null,
    updatedAt: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE delivery_operations SET
         status = ?, provider_asset_id = ?, provider_message_id = ?,
         provider_state = ?, failure_code = ?, next_attempt_at = ?,
         lease_owner = '', lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ?`,
      [
        status,
        assetId,
        messageId,
        state,
        failure,
        next,
        updatedAt,
        operationId,
        owner,
        epoch,
      ],
    );
  }

  currentResult(executor: DB, operationId: string): DeliveryOperationRecord {
    return queryOne<DeliveryOperationRecord>(
      executor,
      `SELECT status, provider_asset_id AS providerAssetId,
              provider_message_id AS providerMessageId,
              provider_state AS providerState, failure_code AS failureCode
       FROM delivery_operations WHERE id = ? LIMIT 1`,
      [operationId],
    );
  }

  updateProgress(
    executor: DB,
    operationId: string,
    owner: string,
    epoch: number,
    status: string,
    assetId: string,
    messageId: string,
    state: string,
    failure: string,
    updatedAt: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE delivery_operations SET
         status = ?, provider_asset_id = ?, provider_message_id = ?,
         provider_state = ?, failure_code = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_epoch = ?`,
      [
        status,
        assetId,
        messageId,
        state,
        failure,
        updatedAt,
        operationId,
        owner,
        epoch,
      ],
    );
  }

  reopenTransientFailure(
    executor: DB,
    operationId: string,
    windowStartedAt: string,
    updatedAt: string,
  ): number {
    const { sql, params } = inList(transientDeliveryFailureCodes());
    return execChanges(
      executor,
      `UPDATE delivery_operations SET
         status = ?, failure_code = ?, next_attempt_at = NULL,
         retry_window_started_at = ?, updated_at = ?
       WHERE id = ? AND status = ? AND failure_code IN (${sql})`,
      [
        "retry_wait",
        "",
        windowStartedAt,
        updatedAt,
        operationId,
        "failed",
        ...params,
      ],
    );
  }

  failedTransientIdsByPlatform(executor: DB, platform: string): string[] {
    const { sql, params } = inList(transientDeliveryFailureCodes());
    return queryAll<{ id: string }>(
      executor,
      `SELECT o.id AS id FROM delivery_operations AS o
       JOIN delivery_intents AS i ON i.id = o.intent_id
       WHERE i.platform = ? AND o.status = ? AND o.failure_code IN (${sql})
       ORDER BY o.sequence ASC, o.created_at ASC`,
      [platform, "failed", ...params],
    ).map((row) => row.id);
  }

  listFailureRows(
    executor: DB,
    sessionId: string,
    limit: number,
  ): DeliveryFailureRecord[] {
    if (limit <= 0 || limit > deliveryFailureLimitMax) {
      limit = deliveryFailureLimitMax;
    }
    const { sql, params } = inList(["failed", "uncertain"]);
    if (sessionId !== "") {
      return queryAll<DeliveryFailureRecord>(
        executor,
        `SELECT o.id AS operationId, o.intent_id AS intentId, i.session_id AS sessionId,
                i.run_id AS runId, i.platform AS platform, i.target_id AS targetId,
                o.operation_kind AS operationKind, o.status AS status,
                o.failure_code AS failureCode, o.attempt_count AS attemptCount,
                o.updated_at AS updatedAt
         FROM delivery_operations AS o
         JOIN delivery_intents AS i ON i.id = o.intent_id
         WHERE o.status IN (${sql}) AND i.session_id = ?
         ORDER BY o.updated_at DESC LIMIT ?`,
        [...params, sessionId, limit],
      );
    }
    return queryAll<DeliveryFailureRecord>(
      executor,
      `SELECT o.id AS operationId, o.intent_id AS intentId, i.session_id AS sessionId,
              i.run_id AS runId, i.platform AS platform, i.target_id AS targetId,
              o.operation_kind AS operationKind, o.status AS status,
              o.failure_code AS failureCode, o.attempt_count AS attemptCount,
              o.updated_at AS updatedAt
       FROM delivery_operations AS o
       JOIN delivery_intents AS i ON i.id = o.intent_id
       WHERE o.status IN (${sql})
       ORDER BY o.updated_at DESC LIMIT ?`,
      [...params, limit],
    );
  }

  reopenDependentFailures(
    executor: DB,
    intentId: string,
    windowStartedAt: string,
    updatedAt: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE delivery_operations SET
         status = ?, failure_code = ?, next_attempt_at = NULL,
         retry_window_started_at = ?, updated_at = ?
       WHERE intent_id = ? AND status = ? AND failure_code = ?`,
      [
        "retry_wait",
        "",
        windowStartedAt,
        updatedAt,
        intentId,
        "failed",
        "dependency_failed",
      ],
    );
  }

  dueIds(now: number): string[] {
    const states = inList(["pending", "uploading", "sending", "retry_wait"]);
    return queryAll<{ id: string }>(
      this.requireDb(),
      `SELECT id FROM delivery_operations
       WHERE status IN (${states.sql})
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY sequence ASC, created_at ASC`,
      [...states.params, now, now],
    ).map((row) => row.id);
  }

  intentId(executor: DB, operationId: string): string {
    return queryOne<{ intentId: string }>(
      executor,
      `SELECT intent_id AS intentId FROM delivery_operations WHERE id = ? LIMIT 1`,
      [operationId],
    ).intentId;
  }

  aggregate(
    executor: DB,
    intentId: string,
  ): { total: number; terminal: number; failed: number; uncertain: number } {
    const row = queryOne<Record<string, unknown>>(
      executor,
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('uploaded','delivered','unsupported') THEN 1 ELSE 0 END) AS terminal,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END) AS uncertain
       FROM delivery_operations WHERE intent_id = ?`,
      [intentId],
    );
    return {
      total: Number(row.total ?? 0),
      terminal: Number(row.terminal ?? 0),
      failed: Number(row.failed ?? 0),
      uncertain: Number(row.uncertain ?? 0),
    };
  }

  /**
   * Terminalizes operations that can no longer run because a prerequisite
   * failed or became uncertain. The loop handles chains in one transaction.
   */
  propagateDependencyFailures(
    executor: DB,
    intentId: string,
    updatedAt: string,
  ): void {
    for (;;) {
      const changed = execChanges(
        executor,
        `UPDATE delivery_operations
         SET status = CASE dependency.status
               WHEN 'uncertain' THEN 'uncertain' ELSE 'failed' END,
             failure_code = CASE dependency.status
               WHEN 'uncertain' THEN 'dependency_uncertain' ELSE 'dependency_failed' END,
             next_attempt_at = NULL, lease_owner = '', lease_expires_at = NULL,
             updated_at = ?
         FROM delivery_operations dependency
         WHERE delivery_operations.intent_id = ?
           AND delivery_operations.depends_on = dependency.id
           AND dependency.intent_id = delivery_operations.intent_id
           AND dependency.status IN ('failed', 'uncertain')
           AND delivery_operations.status IN ('pending', 'retry_wait')`,
        [updatedAt, intentId],
      );
      if (changed === 0) return;
    }
  }

  updateIntentStatus(
    executor: DB,
    intentId: string,
    status: string,
    updatedAt: string,
  ): void {
    execChanges(
      executor,
      `UPDATE delivery_intents SET status = ?, updated_at = ? WHERE id = ?`,
      [status, updatedAt, intentId],
    );
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("delivery database is not open");
    return this.db;
  }
}

/** Caps one failure projection so a long-broken platform cannot flood. */
export const deliveryFailureLimitMax = 200;

function transientDeliveryFailureCodes(): string[] {
  return ["delivery_retries_exhausted", "transport_error"];
}

/** Reports whether a failed operation with this code may be reopened. */
export function isTransientDeliveryFailure(failureCode: string): boolean {
  return transientDeliveryFailureCodes().includes(failureCode);
}

function bindOperation(
  r: DeliveryOperationRecord,
): (string | number | null)[] {
  return [
    r.id,
    r.intentId,
    r.operationKey,
    r.artifactId,
    r.operationKind,
    r.sequence,
    r.dependsOn,
    r.idempotencyKey,
    r.payloadDigest,
    r.status,
    r.providerAssetId,
    r.providerMessageId,
    r.providerState,
    r.attemptCount,
    r.nextAttemptAt,
    r.failureCode,
    r.retryWindowStartedAt,
    r.leaseOwner,
    r.leaseEpoch,
    r.leaseExpiresAt,
    r.createdAt,
    r.updatedAt,
  ];
}
