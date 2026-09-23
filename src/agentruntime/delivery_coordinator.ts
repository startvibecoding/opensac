//
// The Runtime-owned claim/fence/retry boundary for durable delivery outbox
// operations. It composes the session delivery store, so transports never write
// delivery rows directly and a fenced takeover always wins.
//
// Deviations: `json.RawMessage` maps to decoded `unknown`, `time.Time` maps to
// `Date`, `(DeliveryResult, error)` executor returns map to a
// `DeliveryExecutorOutcome` value object (so a provider checkpoint can survive
// alongside an error), and `ReconcileDue` is async because transports perform
// real network I/O.

import { isTransientDeliveryFailure } from "../dao/mod.ts";
import {
  claimDeliveryOperation,
  DeliveryLeaseLostError,
  type DeliveryOperation,
  DeliveryOperationBusyError,
  listDueDeliveryOperations,
  updateDeliveryOperation,
  updateDeliveryOperationProgress,
} from "../session/delivery_store.ts";
import { generateID } from "../session/mod.ts";

/**
 * The transport-neutral outcome reported by an adapter after it has used a
 * claimed operation. Unknown provider outcomes must use `uncertain` so recovery
 * never blindly duplicates a possibly delivered message.
 */
export interface DeliveryResult {
  status: string;
  providerAssetId: string;
  providerMessageId: string;
  providerState: unknown;
  failureCode: string;
  nextAttemptAt: Date | null;
}

/** An empty `DeliveryResult` with the canonical zero values. */
export function emptyDeliveryResult(): DeliveryResult {
  return {
    status: "",
    providerAssetId: "",
    providerMessageId: "",
    providerState: undefined,
    failureCode: "",
    nextAttemptAt: null,
  };
}

/**
 * Performs one platform operation after the Runtime has claimed it. It may
 * upload/send through a platform SDK but cannot write delivery rows directly.
 */
export type DeliveryExecutor = (
  operation: DeliveryOperation,
) => Promise<DeliveryExecutorOutcome> | DeliveryExecutorOutcome;

/**
 * The TS projection of Go's `(DeliveryResult, error)` executor return: a result
 * that may be partially filled even when `error` is set.
 */
export interface DeliveryExecutorOutcome {
  result: DeliveryResult;
  error: unknown | null;
}

/**
 * Bounds how long a transient delivery failure keeps being retried. Platform
 * transports can be disconnected or rate-limited for minutes, and a small
 * attempt count would abandon the reply long before that.
 */
export const DEFAULT_DELIVERY_RETRY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Reports whether a failed delivery operation may be reopened for another retry
 * window (reconnect recovery or an explicit operator retry). The canonical
 * definition lives in the DAO's transient failure codes, which also backs the
 * reopen SQL fence, so the operator entry cannot authorize a reopen the
 * persistence guard would refuse.
 */
export function deliveryFailureRetryable(failureCode: string): boolean {
  return isTransientDeliveryFailure(failureCode);
}

/**
 * The Runtime-owned claim/fence/retry boundary for durable delivery outbox
 * operations.
 */
export class DeliveryCoordinator {
  sessionDir: string;
  owner: string;
  leaseMs: number;
  /** Wall-clock budget (ms) for transient failures. Zero uses the default. */
  retryWindowMs: number;
  /** Optional hard attempt cap; zero disables it (the window is the bound). */
  maxRetries: number;

  constructor(sessionDir: string, owner: string) {
    this.sessionDir = sessionDir;
    this.owner = owner.trim() === ""
      ? "delivery-worker-" + generateID()
      : owner;
    this.leaseMs = 30_000;
    this.retryWindowMs = DEFAULT_DELIVERY_RETRY_WINDOW_MS;
    this.maxRetries = 0;
  }

  claim(operationId: string, now: Date): DeliveryOperation {
    if (this.sessionDir.trim() === "") {
      throw new Error("delivery coordinator is not configured");
    }
    return claimDeliveryOperation(
      this.sessionDir,
      operationId,
      this.owner,
      now,
      this.leaseMs,
    );
  }

  complete(operation: DeliveryOperation, result: DeliveryResult): void {
    if (!operation) throw new Error("delivery operation is required");
    if (result.status === "") {
      throw new Error("delivery result status is required");
    }
    if (result.status === "retry_wait" && result.nextAttemptAt === null) {
      result.nextAttemptAt = new Date(
        Date.now() + deliveryRetryDelayMs(operation.attemptCount),
      );
    }
    updateDeliveryOperation(
      this.sessionDir,
      operation.id,
      this.owner,
      operation.leaseEpoch,
      result.status,
      result.providerAssetId,
      result.providerMessageId,
      result.providerState,
      result.failureCode,
      result.nextAttemptAt,
    );
  }

  /**
   * Checkpoints an in-flight provider phase without releasing its lease.
   * `complete` must later use the same operation owner and epoch.
   */
  progress(operation: DeliveryOperation, result: DeliveryResult): void {
    if (!operation) throw new Error("delivery operation is required");
    if (result.status === "") {
      throw new Error("delivery progress status is required");
    }
    updateDeliveryOperationProgress(
      this.sessionDir,
      operation.id,
      this.owner,
      operation.leaseEpoch,
      result.status,
      result.providerAssetId,
      result.providerMessageId,
      result.providerState,
      result.failureCode,
    );
  }

  /**
   * Claims and executes all currently due operations. Errors from a transport
   * are converted to bounded `retry_wait`; callers can explicitly return
   * `status: "uncertain"` when the provider result is ambiguous.
   */
  async reconcileDue(
    now: Date,
    execute: DeliveryExecutor,
  ): Promise<number> {
    if (!execute) {
      throw new Error("delivery coordinator and executor are required");
    }
    const operations = listDueDeliveryOperations(this.sessionDir, now);
    let processed = 0;
    for (const candidate of operations) {
      let operation: DeliveryOperation;
      try {
        operation = this.claim(candidate.id, now);
      } catch (claimErr) {
        if (claimErr instanceof DeliveryOperationBusyError) continue;
        throw claimErr;
      }
      const outcome = await execute(operation);
      const result = outcome.result;
      if (outcome.error !== null && outcome.error !== undefined) {
        // Preserve any checkpoint returned alongside an error. A provider
        // adapter may have completed an upload before discovering that the
        // response was unusable, and that state is still valuable to recovery.
        if (result.providerAssetId === "") {
          result.providerAssetId = operation.providerAssetId;
        }
        if (!hasProviderState(result.providerState)) {
          result.providerState = operation.providerState;
        }
        result.status = "retry_wait";
        result.failureCode = "transport_error";
        result.nextAttemptAt = new Date(
          now.getTime() + deliveryRetryDelayMs(operation.attemptCount),
        );
      }
      if (
        result.status === "retry_wait" && this.retryExhausted(operation, now)
      ) {
        result.status = "failed";
        result.nextAttemptAt = null;
        result.failureCode = "delivery_retries_exhausted";
      }
      if (result.providerAssetId === "") {
        result.providerAssetId = operation.providerAssetId;
      }
      if (!hasProviderState(result.providerState)) {
        result.providerState = operation.providerState;
      }
      if (result.status === "retry_wait" && result.nextAttemptAt === null) {
        result.nextAttemptAt = new Date(
          now.getTime() + deliveryRetryDelayMs(operation.attemptCount),
        );
      }
      try {
        this.complete(operation, result);
      } catch (completeErr) {
        if (completeErr instanceof DeliveryLeaseLostError) continue;
        throw completeErr;
      }
      processed++;
    }
    return processed;
  }

  /**
   * Reports whether a transient delivery failure has consumed its retry budget.
   * The wall-clock window is the production bound; `maxRetries` stays available
   * as an explicit attempt cap for callers that want one.
   */
  retryExhausted(operation: DeliveryOperation, now: Date): boolean {
    if (!operation) return false;
    if (this.maxRetries > 0 && operation.attemptCount >= this.maxRetries) {
      return true;
    }
    const window = this.retryWindowMs > 0
      ? this.retryWindowMs
      : DEFAULT_DELIVERY_RETRY_WINDOW_MS;
    let start = operation.createdAt;
    if (operation.retryWindowStartedAt !== null) {
      // An explicit retry restarts the budget instead of counting from the
      // original creation time.
      start = operation.retryWindowStartedAt;
    }
    if (start === null || start.getTime() === 0) return false;
    return now.getTime() - start.getTime() >= window;
  }
}

export function createDeliveryCoordinator(
  sessionDir: string,
  owner: string,
): DeliveryCoordinator {
  return new DeliveryCoordinator(sessionDir, owner);
}

export function deliveryRetryDelayMs(attempt: number): number {
  if (attempt < 1) attempt = 1;
  if (attempt > 6) attempt = 6;
  return (1 << (attempt - 1)) * 1000;
}

function hasProviderState(state: unknown): boolean {
  if (state === undefined || state === null) return false;
  if (typeof state === "string") return state.length > 0;
  return true;
}
