// Ported from internal/serve/delivery_recovery.go
//
// The serve process' background durable-outbox worker. It intentionally polls
// through the PlatformSupervisor: a disabled or disconnected platform is left
// pending and is picked up when that platform is reconnected, while every
// actual provider call still goes through the shared claim/fence/retry
// coordinator.
//
// The Go `*channelRuntime` receiver maps to a narrow `DeliveryRecoveryRuntime`
// view; the run.go slice owns the concrete struct. Deviations: `context.Context`
// maps to an optional `AbortSignal`; Go's buffered-32 result of the coordinator
// is unchanged (the shared TS DeliveryCoordinator already models it); the
// `deliveryDone` channel becomes the returned loop Promise the caller stores;
// `log.Printf` maps to `console.error` (Go's standard logger writes to stderr).

import {
  DeliveryCoordinator,
  type DeliveryExecutorOutcome,
  emptyDeliveryResult,
} from "../agentruntime/delivery_coordinator.ts";
import { type SessionAttachment } from "../agentruntime/attachment.ts";
import { AttachmentService } from "../agentruntime/input.ts";
import { defaultAttachmentPolicy } from "../agentruntime/attachment.ts";
import { deliveryOperationText } from "../agentruntime/delivery.ts";
import type { PlatformSupervisor } from "./platform_supervisor.ts";
import {
  type DurableDeliveryExecutor,
  type DurableDeliveryRequest,
} from "../messaging/platform.ts";
import { isNoRows } from "../dao/mod.ts";
import type { ContentBlock } from "../provider/types.ts";
import {
  type DeliveryOperation,
  type DeliveryPlan,
  ErrDeliveryOperationAbsent,
  getDeliveryPlan,
  listFailedTransientDeliveryOperations,
  reopenFailedDeliveryOperation,
} from "../session/delivery_store.ts";
import { listSessionMessagesWithSeq } from "../session/session_events.ts";
import { runAssistantEntryID } from "../session/run_user_message.ts";

/** How often the background worker sweeps the durable outbox. */
export const durableDeliveryRecoveryIntervalMs = 5_000;

/**
 * Narrow view of the run.go `channelRuntime` fields the recovery worker needs.
 * `deliveryReopened` mirrors Go's `map[string]struct{}` bookkeeping.
 */
export interface DeliveryRecoveryRuntime {
  sessionDir: string;
  platforms: PlatformSupervisor | null;
  deliveryReopened: Set<string>;
}

/**
 * Runs the durable-delivery recovery loop until the signal aborts. Run once at
 * startup so an already-connected transport can pick up rows left by the
 * previous process without waiting for the first tick. The returned promise is
 * the projection of Go's `deliveryDone` channel: callers store it and await it
 * during shutdown to know the worker exited.
 */
export async function runDeliveryRecovery(
  rt: DeliveryRecoveryRuntime,
  signal: AbortSignal | undefined,
): Promise<void> {
  await reconcileDurableDeliveries(rt, signal);
  while (signal === undefined || !signal.aborted) {
    await sleep(durableDeliveryRecoveryIntervalMs, signal);
    if (signal !== undefined && signal.aborted) return;
    await reconcileDurableDeliveries(rt, signal);
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Sweeps every connected durable-delivery platform's due operations. */
export async function reconcileDurableDeliveries(
  rt: DeliveryRecoveryRuntime,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (rt.platforms === null || rt.sessionDir.trim() === "") return;
  for (const name of ["wechat", "feishu"]) {
    const platform = rt.platforms.get(name);
    if (platform === undefined || !platform.isConnected()) continue;
    const executor = platform as Partial<DurableDeliveryExecutor>;
    if (typeof executor.executeDurableDelivery !== "function") continue;
    reopenFailedDeliveries(rt, name);
    const coordinator = new DeliveryCoordinator(
      rt.sessionDir,
      "serve-delivery-recovery-" + name,
    );
    let processed: number;
    try {
      processed = await coordinator.reconcileDue(
        new Date(),
        async (
          operation: DeliveryOperation,
        ): Promise<DeliveryExecutorOutcome> => {
          let request: DurableDeliveryRequest;
          try {
            request = await deliveryRecoveryRequest(rt, operation);
          } catch (projectionErr) {
            // A missing plan/attachment cannot become valid by retrying the
            // provider. Keep the failure durable and visible to operators.
            if (
              projectionErr === ErrDeliveryOperationAbsent ||
              isNoRows(projectionErr)
            ) {
              return {
                result: {
                  ...emptyDeliveryResult(),
                  status: "failed",
                  failureCode: "delivery_projection_missing",
                },
                error: null,
              };
            }
            return { result: emptyDeliveryResult(), error: projectionErr };
          }
          try {
            const result = await executor.executeDurableDelivery!(
              signal ?? new AbortController().signal,
              request,
            );
            return {
              result: {
                status: result.status,
                providerAssetId: result.providerAssetID,
                providerMessageId: result.providerMessageID,
                providerState: result.providerState,
                failureCode: result.failureCode,
                nextAttemptAt: result.nextAttemptAt ?? null,
              },
              error: null,
            };
          } catch (executeErr) {
            return { result: emptyDeliveryResult(), error: executeErr };
          }
        },
      );
    } catch (err) {
      console.error(
        `[serve] durable ${name} delivery recovery failed: ${message(err)}`,
      );
      continue;
    }
    if (processed > 0) {
      console.error(
        `[serve] durable ${name} delivery recovery processed ${processed} operation(s)`,
      );
    }
  }
}

/**
 * Gives operations that exhausted a retry window another chance while the
 * platform is connected. A disconnected or rate-limited platform can outlast
 * one retry window, and without this the reply would be permanently lost even
 * after the transport recovered. Each operation is reopened at most once per
 * process, so a genuinely undeliverable target cannot loop forever across
 * reconnects.
 */
export function reopenFailedDeliveries(
  rt: DeliveryRecoveryRuntime,
  platform: string,
): void {
  if (rt.sessionDir.trim() === "") return;
  let ids: string[];
  try {
    ids = listFailedTransientDeliveryOperations(rt.sessionDir, platform);
  } catch (err) {
    console.error(
      `[serve] list failed ${platform} deliveries: ${message(err)}`,
    );
    return;
  }
  for (const id of ids) {
    if (!markDeliveryReopened(rt, platform, id)) continue;
    let reopened: boolean;
    try {
      reopened = reopenFailedDeliveryOperation(rt.sessionDir, id, new Date());
    } catch (err) {
      console.error(
        `[serve] reopen ${platform} delivery ${id}: ${message(err)}`,
      );
      continue;
    }
    if (reopened) {
      console.error(
        `[serve] reopened ${platform} delivery ${id} for another retry window`,
      );
    }
  }
}

/** Reports whether this process has not yet reopened the operation. */
export function markDeliveryReopened(
  rt: DeliveryRecoveryRuntime,
  platform: string,
  operationId: string,
): boolean {
  const key = platform + "\x00" + operationId;
  if (rt.deliveryReopened.has(key)) return false;
  rt.deliveryReopened.add(key);
  return true;
}

/** Builds the transport request for one claimed durable operation. */
// Synchronous like the Go builder: every step is local persistence or a
// closure; throws project Go's returned errors.
export function deliveryRecoveryRequest(
  rt: DeliveryRecoveryRuntime,
  operation: DeliveryOperation,
): DurableDeliveryRequest {
  const plan: DeliveryPlan | null = getDeliveryPlan(
    rt.sessionDir,
    operation.intentId,
  );
  if (plan === null) throw ErrDeliveryOperationAbsent;
  const request: DurableDeliveryRequest = {
    intent: plan.intent,
    operation,
    caption: "",
    artifactKind: "file",
    artifactFilename: "",
    artifactMediaType: "",
  };
  for (const candidate of plan.operations) {
    if (candidate.id === operation.dependsOn) {
      request.dependency = candidate;
      break;
    }
  }
  request.caption = deliveryOperationText(
    plan.intent.transportContext,
    operation.operationKind,
  );
  if (
    request.caption === "" &&
    (operation.operationKind === "send_text" ||
      operation.operationKind === "send_fallback_text")
  ) {
    request.caption = loadAssistantDeliveryCaption(
      rt.sessionDir,
      plan.intent.sessionId,
      plan.intent.runId,
    );
  }
  if (operation.artifactId === "") return request;
  const attachments = new AttachmentService(
    rt.sessionDir,
    defaultAttachmentPolicy(),
  );
  const artifact: SessionAttachment = attachments.Get(
    plan.intent.sessionId,
    operation.artifactId,
  );
  request.artifactKind = artifact.kind;
  request.artifactFilename = artifact.filename;
  request.artifactMediaType = artifact.mediaType;
  request.openArtifact = async (_signal: AbortSignal) => {
    const { file } = await attachments.Open(artifact.sessionId, artifact.id);
    return file.readable;
  };
  return request;
}

export function loadAssistantDeliveryCaption(
  sessionDir: string,
  sessionId: string,
  runId: string,
): string {
  const messages = listSessionMessagesWithSeq(sessionDir, sessionId);
  const targetId = runAssistantEntryID(runId);
  for (const message of messages) {
    if (
      message.entryID === targetId && message.message.role === "assistant"
    ) {
      return deliveryMessageText(
        message.message.content ?? "",
        message.message.contents ?? [],
      );
    }
  }
  // Never fall back to the latest assistant entry: a missing deterministic
  // entry must surface as a projection error rather than replaying another
  // Run's response into this delivery target.
  return "";
}

export function deliveryMessageText(
  content: string,
  blocks: ContentBlock[],
): string {
  if (content.trim() !== "") return content.trim();
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && (block.text ?? "").trim() !== "") {
      parts.push((block.text ?? "").trim());
    }
  }
  return parts.join("\n").trim();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
