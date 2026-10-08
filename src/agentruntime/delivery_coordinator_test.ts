//
// Deviations: the Go fixture creates a session through the Manager; this port
// creates the canonical completed Run directly (the session Manager lands with
// the `SessionRuntime` slice), matching `delivery_store_test.ts`. Go's
// `(DeliveryResult, error)` executor returns map to `DeliveryExecutorOutcome`.

import { assert, assertEquals } from "@opensac/assert";
import { closeAll } from "../db/mod.ts";
import {
  createDeliveryPlan,
  type DeliveryIntent,
  type DeliveryOperation,
  type DeliveryPlan,
  getDeliveryOperation,
  reopenFailedDeliveryOperation,
} from "../session/delivery_store.ts";
import { createSessionRun, type SessionRun } from "../session/run_store.ts";
import {
  DEFAULT_DELIVERY_RETRY_WINDOW_MS,
  DeliveryCoordinator,
  deliveryFailureRetryable,
  emptyDeliveryResult,
} from "./delivery_coordinator.ts";

function baseRun(overrides: Partial<SessionRun>): SessionRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: undefined,
    progress: undefined,
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    ...overrides,
  };
}

function operation(overrides: Partial<DeliveryOperation>): DeliveryOperation {
  return {
    id: "",
    intentId: "",
    operationKey: "",
    artifactId: "",
    operationKind: "",
    sequence: 0,
    dependsOn: "",
    idempotencyKey: "",
    payloadDigest: "",
    status: "pending",
    providerAssetId: "",
    providerMessageId: "",
    providerState: undefined,
    attemptCount: 0,
    nextAttemptAt: null,
    failureCode: "",
    retryWindowStartedAt: null,
    leaseOwner: "",
    leaseEpoch: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fixture(): { sessionDir: string; sessionId: string } {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-coordinator-" });
  const sessionId = "coord-session";
  const now = new Date();
  createSessionRun(
    sessionDir,
    baseRun({
      id: "coord-run",
      sessionId,
      status: "completed",
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
    }),
  );
  return { sessionDir, sessionId };
}

function plan(
  sessionId: string,
  intentId: string,
  operations: DeliveryOperation[],
): DeliveryPlan {
  const now = new Date();
  const intent: DeliveryIntent = {
    id: intentId,
    sessionId,
    runId: "coord-run",
    platform: "wechat",
    targetId: "chat",
    replyMessageId: "",
    transportContext: undefined,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  return { intent, operations };
}

Deno.test("DeliveryCoordinatorReconcilesDueOperationAndBoundsRetries", async () => {
  const { sessionDir, sessionId } = fixture();
  try {
    const now = new Date();
    createDeliveryPlan(
      sessionDir,
      plan(sessionId, "coord-intent", [
        operation({
          id: "coord-op",
          intentId: "coord-intent",
          operationKey: "caption",
          operationKind: "send_text",
          sequence: 1,
          idempotencyKey: "coord-op",
          payloadDigest: "sha256:x",
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    );
    const coordinator = new DeliveryCoordinator(sessionDir, "coord-worker");
    const processed = await coordinator.reconcileDue(now, () => ({
      result: emptyDeliveryResult(),
      error: new Error("provider unavailable"),
    }));
    assertEquals(processed, 1);
    const op = getDeliveryOperation(sessionDir, "coord-op")!;
    assertEquals(op.status, "retry_wait");
    assertEquals(op.attemptCount, 1);
    assertEquals(op.failureCode, "transport_error");
    assert(op.nextAttemptAt !== null);
  } finally {
    closeAll();
  }
});

Deno.test("DeliveryCoordinatorPreservesUncertainResult", async () => {
  const { sessionDir, sessionId } = fixture();
  try {
    const now = new Date();
    createDeliveryPlan(
      sessionDir,
      plan(sessionId, "uncertain-intent", [
        operation({
          id: "uncertain-op",
          intentId: "uncertain-intent",
          operationKey: "caption",
          operationKind: "send_text",
          sequence: 1,
          idempotencyKey: "uncertain-op",
          payloadDigest: "sha256:x",
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    );
    const coordinator = new DeliveryCoordinator(sessionDir, "uncertain-worker");
    await coordinator.reconcileDue(now, () => ({
      result: {
        ...emptyDeliveryResult(),
        status: "uncertain",
        failureCode: "provider_timeout",
      },
      error: null,
    }));
    const op = getDeliveryOperation(sessionDir, "uncertain-op")!;
    assertEquals(op.status, "uncertain");
    assertEquals(op.failureCode, "provider_timeout");
  } finally {
    closeAll();
  }
});

Deno.test("DeliveryCoordinatorAppliesRetryLimitToProviderRetryResult", async () => {
  const { sessionDir, sessionId } = fixture();
  try {
    const now = new Date();
    createDeliveryPlan(
      sessionDir,
      plan(sessionId, "retry-limit-intent", [
        operation({
          id: "retry-limit-op",
          intentId: "retry-limit-intent",
          operationKey: "upload",
          operationKind: "upload_artifact",
          sequence: 1,
          idempotencyKey: "retry-limit-op",
          payloadDigest: "sha256:x",
          providerAssetId: "asset-before",
          providerState: { checkpoint: "before" },
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    );
    const coordinator = new DeliveryCoordinator(
      sessionDir,
      "retry-limit-worker",
    );
    coordinator.maxRetries = 1;
    const processed = await coordinator.reconcileDue(now, () => ({
      result: { ...emptyDeliveryResult(), status: "retry_wait" },
      error: null,
    }));
    assertEquals(processed, 1);
    const op = getDeliveryOperation(sessionDir, "retry-limit-op")!;
    assertEquals(op.status, "failed");
    assertEquals(op.failureCode, "delivery_retries_exhausted");
    assertEquals(JSON.stringify(op.providerState), '{"checkpoint":"before"}');
  } finally {
    closeAll();
  }
});

Deno.test("DeliveryCoordinatorPreservesCheckpointOnExecutorError", async () => {
  const { sessionDir, sessionId } = fixture();
  try {
    const now = new Date();
    createDeliveryPlan(
      sessionDir,
      plan(sessionId, "error-checkpoint-intent", [
        operation({
          id: "error-checkpoint-op",
          intentId: "error-checkpoint-intent",
          operationKey: "upload",
          operationKind: "upload_artifact",
          sequence: 1,
          idempotencyKey: "error-checkpoint-op",
          payloadDigest: "sha256:x",
          providerAssetId: "asset-before",
          providerState: { checkpoint: "before" },
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    );
    const coordinator = new DeliveryCoordinator(
      sessionDir,
      "error-checkpoint-worker",
    );
    await coordinator.reconcileDue(now, () => ({
      result: {
        ...emptyDeliveryResult(),
        providerAssetId: "asset-after",
        providerState: { checkpoint: "after" },
      },
      error: new Error("provider response lost"),
    }));
    const op = getDeliveryOperation(sessionDir, "error-checkpoint-op")!;
    assertEquals(op.status, "retry_wait");
    assertEquals(op.providerAssetId, "asset-after");
    assertEquals(JSON.stringify(op.providerState), '{"checkpoint":"after"}');
  } finally {
    closeAll();
  }
});

Deno.test("DeliveryCoordinatorRetriesTransientFailuresWithinTheWindow", async () => {
  const { sessionDir, sessionId } = fixture();
  try {
    const now = new Date();
    createDeliveryPlan(
      sessionDir,
      plan(sessionId, "window-intent", [
        operation({
          id: "window-op",
          intentId: "window-intent",
          operationKey: "caption",
          operationKind: "send_text",
          sequence: 1,
          idempotencyKey: "window-op",
          payloadDigest: "sha256:x",
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    );

    // A young operation keeps being retried well past the old five-attempt cap.
    const coordinator = new DeliveryCoordinator(sessionDir, "window-worker");
    const fail = () => ({
      result: emptyDeliveryResult(),
      error: new Error("provider unavailable"),
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      const processed = await coordinator.reconcileDue(
        new Date(now.getTime() + attempt * 60_000),
        fail,
      );
      assertEquals(processed, 1);
    }
    let op = getDeliveryOperation(sessionDir, "window-op")!;
    assertEquals(op.status, "retry_wait");
    assert(op.attemptCount >= 6, `attemptCount = ${op.attemptCount}`);

    // Past the window the operation is abandoned as before.
    await coordinator.reconcileDue(
      new Date(now.getTime() + DEFAULT_DELIVERY_RETRY_WINDOW_MS + 60_000),
      fail,
    );
    op = getDeliveryOperation(sessionDir, "window-op")!;
    assertEquals(op.status, "failed");
    assertEquals(op.failureCode, "delivery_retries_exhausted");
  } finally {
    closeAll();
  }
});

Deno.test("DeliveryCoordinatorReopenedOperationGetsAFreshWindow", async () => {
  const { sessionDir, sessionId } = fixture();
  try {
    const now = new Date();
    createDeliveryPlan(
      sessionDir,
      plan(sessionId, "reopen-intent", [
        operation({
          id: "reopen-op",
          intentId: "reopen-intent",
          operationKey: "caption",
          operationKind: "send_text",
          sequence: 1,
          idempotencyKey: "reopen-op",
          payloadDigest: "sha256:x",
          createdAt: now,
          updatedAt: now,
        }),
      ]),
    );
    const coordinator = new DeliveryCoordinator(sessionDir, "reopen-worker");
    const fail = () => ({
      result: emptyDeliveryResult(),
      error: new Error("provider unavailable"),
    });
    await coordinator.reconcileDue(
      new Date(now.getTime() + DEFAULT_DELIVERY_RETRY_WINDOW_MS + 60_000),
      fail,
    );
    let op = getDeliveryOperation(sessionDir, "reopen-op")!;
    assertEquals(op.status, "failed");

    const reopenedAt = new Date(
      now.getTime() + DEFAULT_DELIVERY_RETRY_WINDOW_MS + 2 * 60_000,
    );
    assert(reopenFailedDeliveryOperation(sessionDir, "reopen-op", reopenedAt));
    assert(deliveryFailureRetryable("delivery_retries_exhausted"));

    await coordinator.reconcileDue(
      new Date(reopenedAt.getTime() + 60_000),
      fail,
    );
    op = getDeliveryOperation(sessionDir, "reopen-op")!;
    assertEquals(op.status, "retry_wait");
    assert(op.attemptCount >= 2, `attemptCount = ${op.attemptCount}`);
  } finally {
    closeAll();
  }
});
