// Translated from internal/serve/delivery_recovery_test.go

import { assert, assertEquals } from "@std/assert";
import { deliveryOperationText } from "../agentruntime/delivery.ts";
import {
  type DurableDeliveryExecutor,
  type DurableDeliveryRequest,
  type DurableDeliveryResult,
  type MessageHandler,
  type Platform,
} from "../messaging/platform.ts";
import {
  createDeliveryPlan,
  type DeliveryIntent,
  type DeliveryOperation,
  type DeliveryPlan,
  ErrDeliveryOperationAbsent,
  getDeliveryOperation,
} from "../session/delivery_store.ts";
import { createSessionRun, type SessionRun } from "../session/run_store.ts";
import { newManager } from "../session/manager.ts";
import { PlatformSupervisor } from "./platform_supervisor.ts";
import {
  deliveryRecoveryRequest,
  type DeliveryRecoveryRuntime,
  reconcileDurableDeliveries,
} from "./delivery_recovery.ts";

class RecoveryPlatform implements Platform, DurableDeliveryExecutor {
  requests: DurableDeliveryRequest[] = [];

  name(): string {
    return "wechat";
  }

  start(_signal: AbortSignal, _handler: MessageHandler): Promise<void> {
    return Promise.resolve();
  }

  stop(): void {}

  sendMessage(
    _signal: AbortSignal,
    _chatId: string,
    _text: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  isConnected(): boolean {
    return true;
  }

  executeDurableDelivery(
    _signal: AbortSignal,
    request: DurableDeliveryRequest,
  ): Promise<DurableDeliveryResult> {
    this.requests.push(request);
    return Promise.resolve({
      status: "delivered",
      providerAssetID: "",
      providerMessageID: "provider-message",
      providerState: new Uint8Array(),
      failureCode: "",
    });
  }
}

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

Deno.test("reconcile durable deliveries replays frozen caption", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const mgr = newManager(await Deno.makeTempDir(), sessionDir);
    mgr.initWithID("recovery-session");
    const sessionId = mgr.getHeader()!.id;
    const now = new Date();
    createSessionRun(
      sessionDir,
      baseRun({
        id: "recovery-run",
        sessionId,
        status: "completed",
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
      }),
    );
    const intent: DeliveryIntent = {
      id: "recovery-intent",
      sessionId,
      runId: "recovery-run",
      platform: "wechat",
      targetId: "chat",
      replyMessageId: "",
      transportContext: { caption: "resume this reply", replyContext: "ctx-1" },
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const plan: DeliveryPlan = {
      intent,
      operations: [
        operation({
          id: "recovery-op",
          intentId: "recovery-intent",
          operationKey: "caption",
          operationKind: "send_text",
          sequence: 1,
          idempotencyKey: "recovery-op",
          payloadDigest: "sha256:caption",
          status: "pending",
          createdAt: now,
          updatedAt: now,
        }),
      ],
    };
    createDeliveryPlan(sessionDir, plan);
    const platform = new RecoveryPlatform();
    const rt: DeliveryRecoveryRuntime = {
      sessionDir,
      platforms: new PlatformSupervisor(),
      deliveryReopened: new Set(),
    };
    rt.platforms!.replace("wechat", platform);
    await reconcileDurableDeliveries(rt, undefined);
    const op = getDeliveryOperation(sessionDir, "recovery-op");
    assert(op !== null, "recovered operation missing");
    assertEquals(op.status, "delivered");
    assertEquals(op.providerMessageId, "provider-message");
    assertEquals(platform.requests.length, 1);
    assertEquals(platform.requests[0].caption, "resume this reply");
    assertEquals(platform.requests[0].intent.targetId, "chat");
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("delivery intent payload selects fallback", () => {
  assertEquals(
    deliveryOperationText(
      { caption: "caption", fallback: "fallback" },
      "send_fallback_text",
    ),
    "fallback",
  );
  assertEquals(
    deliveryOperationText(
      { caption: "caption", fallback: "fallback" },
      "send_text",
    ),
    "caption",
  );
  assertEquals(deliveryOperationText("not-json", "send_text"), "");
});

Deno.test("delivery recovery request rejects missing plan", async () => {
  const rt: DeliveryRecoveryRuntime = {
    sessionDir: await Deno.makeTempDir(),
    platforms: new PlatformSupervisor(),
    deliveryReopened: new Set(),
  };
  try {
    const err = await Promise.resolve().then(() =>
      deliveryRecoveryRequest(
        rt,
        operation({
          id: "missing-op",
          intentId: "missing",
        }),
      )
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assertEquals(err, ErrDeliveryOperationAbsent);
  } finally {
    await Deno.remove(rt.sessionDir, { recursive: true }).catch(() => {});
  }
});
