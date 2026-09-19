// Ported from internal/session/delivery_store_test.go
//
// Deviation: the Go fixture creates a session through the (not yet ported)
// Manager and a completed Run through `CreateSessionRun`. This port uses a
// literal session ID with the same completed Run.

import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import { createSessionRun, type SessionRun } from "./run_store.ts";
import {
  claimDeliveryOperation,
  createDeliveryPlan,
  type DeliveryIntent,
  type DeliveryOperation,
  type DeliveryPlan,
  ErrDeliveryLeaseLost,
  ErrDeliveryOperationBusy,
  getDeliveryOperation,
  getDeliveryPlan,
  listFailedTransientDeliveryOperations,
  reopenFailedDeliveryOperation,
  updateDeliveryOperation,
} from "./delivery_store.ts";
import { openRootDB } from "./root_db.ts";
import { writeRootDatabase } from "./database.ts";
import { DeliveryDAO } from "../dao/mod.ts";

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

function deliveryFixture(): { sessionDir: string; sessionId: string } {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-delivery-" });
  const sessionId = "delivery-session";
  const started = new Date();
  createSessionRun(
    sessionDir,
    baseRun({
      id: "delivery-run",
      sessionId,
      status: "completed",
      startedAt: started,
      updatedAt: started,
      finishedAt: started,
    }),
  );
  return { sessionDir, sessionId };
}

function operation(
  overrides: Partial<DeliveryOperation>,
): DeliveryOperation {
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
    status: "",
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

function createDeliveryFixturePlan(
  sessionDir: string,
  sessionId: string,
): DeliveryPlan {
  const now = new Date();
  const intent: DeliveryIntent = {
    id: "delivery-intent",
    sessionId,
    runId: "delivery-run",
    platform: "wechat",
    targetId: "chat",
    replyMessageId: "",
    transportContext: { caption: "hello" },
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  const plan: DeliveryPlan = {
    intent,
    operations: [
      operation({
        id: "delivery-op-caption",
        operationKey: "caption",
        operationKind: "send_text",
        sequence: 1,
        idempotencyKey: "delivery-op-caption",
        payloadDigest: "sha256:caption",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
      operation({
        id: "delivery-op-file",
        operationKey: "file",
        operationKind: "send_artifact",
        sequence: 2,
        dependsOn: "delivery-op-caption",
        idempotencyKey: "delivery-op-file",
        payloadDigest: "sha256:file",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
    ],
  };
  createDeliveryPlan(sessionDir, plan);
  return plan;
}

function expectThrows(fn: () => void, expected: Error): void {
  try {
    fn();
  } catch (err) {
    assertEquals(err, expected);
    return;
  }
  throw new Error(`expected throw: ${expected.message}`);
}

function intentStatus(sessionDir: string, intentId: string): string {
  const row = openRootDB(sessionDir).db!.get<{ status: string }>(
    `SELECT status FROM delivery_intents WHERE id = ?`,
    intentId,
  );
  return row?.status ?? "";
}

Deno.test("delivery claim fences expired worker and honors dependency", () => {
  const { sessionDir, sessionId } = deliveryFixture();
  try {
    const plan = createDeliveryFixturePlan(sessionDir, sessionId);
    const now = new Date();
    expectThrows(
      () =>
        claimDeliveryOperation(
          sessionDir,
          plan.operations[1].id,
          "worker-a",
          now,
          60_000,
        ),
      ErrDeliveryOperationBusy,
    );
    const claimed = claimDeliveryOperation(
      sessionDir,
      plan.operations[0].id,
      "worker-a",
      now,
      60_000,
    );
    assertEquals(claimed.leaseOwner, "worker-a");
    assertEquals(claimed.leaseEpoch, 1);
    assertEquals(claimed.attemptCount, 1);
    expectThrows(
      () =>
        claimDeliveryOperation(
          sessionDir,
          plan.operations[0].id,
          "worker-b",
          now,
          60_000,
        ),
      ErrDeliveryOperationBusy,
    );
    expectThrows(
      () =>
        updateDeliveryOperation(
          sessionDir,
          claimed.id,
          "worker-b",
          claimed.leaseEpoch,
          "delivered",
          "",
          "msg-a",
          null,
          "",
          null,
        ),
      ErrDeliveryLeaseLost,
    );
    updateDeliveryOperation(
      sessionDir,
      claimed.id,
      "worker-a",
      claimed.leaseEpoch,
      "delivered",
      "",
      "msg-a",
      null,
      "",
      null,
    );
    const dependent = claimDeliveryOperation(
      sessionDir,
      plan.operations[1].id,
      "worker-b",
      now,
      60_000,
    );
    assertEquals(dependent.leaseEpoch, 1);
    updateDeliveryOperation(
      sessionDir,
      dependent.id,
      "worker-b",
      dependent.leaseEpoch,
      "retry_wait",
      "",
      "",
      null,
      "timeout",
      new Date(now.getTime() + 60_000),
    );
    assertEquals(intentStatus(sessionDir, plan.intent.id), "pending");
  } finally {
    closeAll();
  }
});

Deno.test("delivery claim can recover expired lease", () => {
  const { sessionDir, sessionId } = deliveryFixture();
  try {
    const plan = createDeliveryFixturePlan(sessionDir, sessionId);
    const first = claimDeliveryOperation(
      sessionDir,
      plan.operations[0].id,
      "worker-a",
      new Date(Date.now() - 60_000),
      1000,
    );
    const second = claimDeliveryOperation(
      sessionDir,
      plan.operations[0].id,
      "worker-b",
      new Date(),
      60_000,
    );
    assertEquals(second.leaseEpoch, first.leaseEpoch + 1);
    assertEquals(second.leaseOwner, "worker-b");
    expectThrows(
      () =>
        updateDeliveryOperation(
          sessionDir,
          plan.operations[0].id,
          "worker-a",
          first.leaseEpoch,
          "delivered",
          "",
          "stale",
          null,
          "",
          null,
        ),
      ErrDeliveryLeaseLost,
    );
  } finally {
    closeAll();
  }
});

Deno.test("uploaded phase counts as terminal after dependent send", () => {
  const { sessionDir, sessionId } = deliveryFixture();
  try {
    const plan = createDeliveryFixturePlan(sessionDir, sessionId);
    const now = new Date();
    const upload = claimDeliveryOperation(
      sessionDir,
      plan.operations[0].id,
      "worker-a",
      now,
      60_000,
    );
    const state = { provider_asset_id: "asset-1" };
    updateDeliveryOperation(
      sessionDir,
      upload.id,
      "worker-a",
      upload.leaseEpoch,
      "uploaded",
      "asset-1",
      "",
      state,
      "",
      null,
    );
    const send = claimDeliveryOperation(
      sessionDir,
      plan.operations[1].id,
      "worker-a",
      now,
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      send.id,
      "worker-a",
      send.leaseEpoch,
      "delivered",
      "asset-1",
      "message-1",
      state,
      "",
      null,
    );
    const loaded = getDeliveryPlan(sessionDir, plan.intent.id)!;
    assertEquals(loaded.intent.status, "delivered");
    updateDeliveryOperation(
      sessionDir,
      upload.id,
      "worker-a",
      upload.leaseEpoch,
      "uploaded",
      "asset-1",
      "",
      state,
      "",
      null,
    );
  } finally {
    closeAll();
  }
});

Deno.test("delivery failure cascades to dependent operation", () => {
  const { sessionDir, sessionId } = deliveryFixture();
  try {
    const plan = createDeliveryFixturePlan(sessionDir, sessionId);
    const now = new Date();
    const upload = claimDeliveryOperation(
      sessionDir,
      plan.operations[0].id,
      "worker-a",
      now,
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      upload.id,
      "worker-a",
      upload.leaseEpoch,
      "failed",
      "",
      "",
      null,
      "provider_rejected",
      null,
    );
    const dependent = getDeliveryOperation(
      sessionDir,
      plan.operations[1].id,
    )!;
    assertEquals(dependent.status, "failed");
    assertEquals(dependent.failureCode, "dependency_failed");
    assertEquals(intentStatus(sessionDir, plan.intent.id), "failed");
  } finally {
    closeAll();
  }
});

Deno.test("uncertain delivery cascades uncertain dependent", () => {
  const { sessionDir, sessionId } = deliveryFixture();
  try {
    const plan = createDeliveryFixturePlan(sessionDir, sessionId);
    const now = new Date();
    const upload = claimDeliveryOperation(
      sessionDir,
      plan.operations[0].id,
      "worker-a",
      now,
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      upload.id,
      "worker-a",
      upload.leaseEpoch,
      "uncertain",
      "",
      "",
      null,
      "provider_timeout",
      null,
    );
    const dependent = getDeliveryOperation(
      sessionDir,
      plan.operations[1].id,
    )!;
    assertEquals(dependent.status, "uncertain");
    assertEquals(dependent.failureCode, "dependency_uncertain");
    assertEquals(intentStatus(sessionDir, plan.intent.id), "uncertain");
  } finally {
    closeAll();
  }
});

Deno.test("reopen failed delivery operation restarts retry window", () => {
  const { sessionDir } = deliveryFixture();
  try {
    createDeliveryFixturePlan(sessionDir, "delivery-session");
    assert(
      !reopenFailedDeliveryOperation(
        sessionDir,
        "delivery-op-caption",
        new Date(),
      ),
    );
    const claimed = claimDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      new Date(),
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      claimed.leaseEpoch,
      "failed",
      "",
      "",
      null,
      "delivery_retries_exhausted",
      null,
    );
    const reopenedAt = new Date();
    assert(
      reopenFailedDeliveryOperation(
        sessionDir,
        "delivery-op-caption",
        reopenedAt,
      ),
    );
    const op = getDeliveryOperation(sessionDir, "delivery-op-caption")!;
    assertEquals(op.status, "retry_wait");
    assertEquals(op.failureCode, "");
    assertEquals(op.nextAttemptAt, null);
    assert(op.retryWindowStartedAt !== null);
    assert(
      Math.abs(op.retryWindowStartedAt.getTime() - reopenedAt.getTime()) <=
        1000,
    );
    assert(
      !reopenFailedDeliveryOperation(
        sessionDir,
        "delivery-op-caption",
        new Date(),
      ),
    );
  } finally {
    closeAll();
  }
});

Deno.test("list failed transient delivery operations", () => {
  const { sessionDir } = deliveryFixture();
  try {
    createDeliveryFixturePlan(sessionDir, "delivery-session");
    const claimed = claimDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      new Date(),
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      claimed.leaseEpoch,
      "failed",
      "",
      "",
      null,
      "delivery_retries_exhausted",
      null,
    );
    // The dependent operation cannot be claimed while its dependency is failed,
    // so mark it failed through the unleased row identity instead.
    writeRootDatabase(sessionDir, (tx) => {
      new DeliveryDAO(null).updateResult(
        tx,
        "delivery-op-file",
        "",
        0,
        "failed",
        "",
        "",
        "{}",
        "delivery_projection_missing",
        null,
        new Date().toISOString(),
      );
    });
    assertEquals(
      listFailedTransientDeliveryOperations(sessionDir, "wechat"),
      ["delivery-op-caption"],
    );
    assertEquals(
      listFailedTransientDeliveryOperations(sessionDir, "feishu"),
      [],
    );
  } finally {
    closeAll();
  }
});

Deno.test("reopen failed delivery operation recovers dependent failures", () => {
  const { sessionDir } = deliveryFixture();
  try {
    createDeliveryFixturePlan(sessionDir, "delivery-session");
    const claimed = claimDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      new Date(),
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      claimed.leaseEpoch,
      "failed",
      "",
      "",
      null,
      "delivery_retries_exhausted",
      null,
    );
    const fileBefore = getDeliveryOperation(sessionDir, "delivery-op-file")!;
    assertEquals(fileBefore.status, "failed");
    assertEquals(fileBefore.failureCode, "dependency_failed");
    assert(
      reopenFailedDeliveryOperation(
        sessionDir,
        "delivery-op-caption",
        new Date(),
      ),
    );
    const fileAfter = getDeliveryOperation(sessionDir, "delivery-op-file")!;
    assertEquals(fileAfter.status, "retry_wait");
    assertEquals(fileAfter.failureCode, "");
  } finally {
    closeAll();
  }
});

Deno.test("reopen failed delivery operation refuses permanent failures", () => {
  const { sessionDir } = deliveryFixture();
  try {
    createDeliveryFixturePlan(sessionDir, "delivery-session");
    const claimed = claimDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      new Date(),
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      "delivery-op-caption",
      "test-worker",
      claimed.leaseEpoch,
      "failed",
      "",
      "",
      null,
      "unsupported_media_kind",
      null,
    );
    assert(
      !reopenFailedDeliveryOperation(
        sessionDir,
        "delivery-op-caption",
        new Date(),
      ),
    );
    const op = getDeliveryOperation(sessionDir, "delivery-op-caption")!;
    assertEquals(op.status, "failed");
    assertEquals(op.failureCode, "unsupported_media_kind");
  } finally {
    closeAll();
  }
});
