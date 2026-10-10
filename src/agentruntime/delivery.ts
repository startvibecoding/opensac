//
// The deterministic, I/O-free delivery planner: it freezes the run-level
// transport target and the ordered outbox operations that the terminal
// transaction persists. Adapters may supply transport hooks but never build
// these rows directly.
//
// Deviations: `json.RawMessage` maps to decoded `unknown`, `time.Time` maps to
// `Date`, and Go's `(DeliveryPlan, string, error)` return maps to a
// `PlanDeliveryResult` value object that carries the fallback text alongside the
// plan (throwing for the error case).

import { createHash } from "node:crypto";
import {
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
  type AttachmentKind,
  type SessionAttachment,
} from "./attachment.ts";

/**
 * Describes a transport's actual media behavior. It is a Runtime policy input,
 * not a promise inferred from a platform's wire format.
 */
export interface DeliveryCapability {
  text: boolean;
  sendImage: boolean;
  sendFile: boolean;
  sendVideo: boolean;
}

/**
 * Freezes the run-level transport target and opaque reply context before the
 * terminal transaction creates the durable outbox.
 */
export interface DeliveryIntentPlan {
  id: string;
  sessionId: string;
  runId: string;
  platform: string;
  targetId: string;
  replyMessageId: string;
  transportContext: unknown;
  status: string;
  createdAt: Date;
}

/**
 * One deterministic outbox step. Provider state and lease fields are populated
 * only by the delivery coordinator after terminal commit.
 */
export interface OrderedDeliveryOperationPlan {
  id: string;
  operationKey: string;
  artifactId: string;
  operationKind: string;
  sequence: number;
  dependsOn: string;
  idempotencyKey: string;
  payloadDigest: string;
  status: string;
  createdAt: Date;
}

/**
 * Attached to the active DurableRun and persisted by its terminal transaction.
 * Adapters may supply transport hooks but never write these rows directly.
 */
export interface DeliveryPlan {
  intent: DeliveryIntentPlan;
  operations: OrderedDeliveryOperationPlan[];
}

/**
 * Contains the canonical result and the transport target needed to build
 * deterministic ordered operations before terminal commit.
 */
export interface DeliveryPlanRequest {
  sessionId: string;
  runId: string;
  platform: string;
  targetId: string;
  replyMessageId: string;
  transportContext: unknown;
  caption: string;
  attachments: SessionAttachment[];
  capability: DeliveryCapability;
  createdAt: Date;
}

/** Result of `planDelivery`: the plan plus any transport fallback text. */
export interface PlanDeliveryResult {
  plan: DeliveryPlan;
  fallbackText: string;
}

/**
 * Returns the frozen text payload for a durable text operation. Transport
 * adapters use this Runtime-owned projection for both immediate delivery and
 * recovery, so neither path reconstructs a caption or fallback from mutable
 * adapter state.
 */
export function deliveryOperationText(
  raw: unknown,
  operationKind: string,
): string {
  const payload = decodeObject(raw) as
    { caption?: string; fallback?: string } | undefined;
  if (payload === undefined) return "";
  if (operationKind === "send_fallback_text") {
    return (payload.fallback ?? "").trim();
  }
  return (payload.caption ?? "").trim();
}

/**
 * Builds a deterministic run-level caption/upload/send/fallback sequence. It
 * performs no persistence and no network I/O. Ordinary transport fallback is
 * returned as `fallbackText`; the plan is empty when nothing is deliverable.
 */
export function planDelivery(request: DeliveryPlanRequest): PlanDeliveryResult {
  const sessionId = request.sessionId.trim();
  const runId = request.runId.trim();
  const platform = request.platform.trim();
  const targetId = request.targetId.trim();
  if (sessionId === "" || runId === "" || platform === "") {
    throw new Error("delivery session, Run, and platform are required");
  }
  const createdAt = isZeroDate(request.createdAt)
    ? new Date()
    : request.createdAt;
  const intentId = stableDeliveryId(
    "intent",
    sessionId,
    runId,
    platform,
    targetId,
  );
  const plan: DeliveryPlan = {
    intent: {
      id: intentId,
      sessionId,
      runId,
      platform,
      targetId,
      replyMessageId: request.replyMessageId.trim(),
      transportContext: request.transportContext,
      status: "pending",
      createdAt,
    },
    operations: [],
  };
  let sequence = 0;
  let previousId = "";
  const appendOperationWithDependency = (
    key: string,
    artifactId: string,
    kind: string,
    payload: string,
    dependsOn: string,
    status?: string,
  ): string => {
    sequence++;
    const operationId = stableDeliveryId("operation", intentId, key);
    const operationStatus = status && status !== "" ? status : "pending";
    plan.operations.push({
      id: operationId,
      operationKey: key,
      artifactId,
      operationKind: kind,
      sequence,
      dependsOn,
      idempotencyKey: operationId,
      payloadDigest: stableDeliveryDigest(payload),
      status: operationStatus,
      createdAt,
    });
    previousId = operationId;
    return operationId;
  };
  const appendOperation = (
    key: string,
    artifactId: string,
    kind: string,
    payload: string,
    status?: string,
  ): string =>
    appendOperationWithDependency(
      key,
      artifactId,
      kind,
      payload,
      previousId,
      status,
    );

  const caption = request.caption.trim();
  let captionId = "";
  if (caption !== "" && request.capability.text) {
    captionId = appendOperation("caption", "", "send_text", caption);
  }
  const fallback: string[] = [];
  request.attachments.forEach((attachment, index) => {
    if (
      attachment.sessionId !== sessionId ||
      attachment.runId !== runId ||
      attachment.id === ""
    ) {
      throw new Error("delivery attachment does not belong to Run");
    }
    const kind: AttachmentKind = attachment.kind;
    const native =
      (kind === ATTACHMENT_IMAGE && request.capability.sendImage) ||
      (kind === ATTACHMENT_FILE && request.capability.sendFile) ||
      (kind === ATTACHMENT_VIDEO && request.capability.sendVideo);
    if (!native) {
      let name = (attachment.filename ?? "").trim();
      if (name === "") name = kind;
      fallback.push(
        `Generated ${kind} ${JSON.stringify(
          name,
        )} is available in the OpenSAC session; this transport cannot send media attachments.`,
      );
      return;
    }
    const keyPrefix = `artifact-${String(index + 1).padStart(
      3,
      "0",
    )}-${attachment.id}`;
    const uploadId = appendOperation(
      keyPrefix + "-upload",
      attachment.id,
      "upload_artifact",
      attachment.sha256,
    );
    sequence++;
    const sendId = stableDeliveryId("operation", intentId, keyPrefix + "-send");
    plan.operations.push({
      id: sendId,
      operationKey: keyPrefix + "-send",
      artifactId: attachment.id,
      operationKind: "send_artifact",
      sequence,
      dependsOn: uploadId,
      idempotencyKey: sendId,
      payloadDigest: stableDeliveryDigest(attachment.sha256 + "\x00" + kind),
      status: "pending",
      createdAt,
    });
    previousId = sendId;
  });
  const fallbackText = fallback.join("\n");
  if (fallbackText !== "" && request.capability.text) {
    // A channel's immediate projection may combine the caption and fallback
    // into one text message. Keep fallback ordered after that caption while
    // avoiding a dependency on native media that the same message already
    // precedes; recovery can therefore replay fallback without waiting on a
    // failed optional artifact send.
    appendOperationWithDependency(
      "fallback",
      "",
      "send_fallback_text",
      fallbackText,
      captionId,
    );
  }
  if (plan.operations.length === 0) {
    return { plan: { intent: plan.intent, operations: [] }, fallbackText };
  }
  return { plan, fallbackText };
}

function stableDeliveryId(kind: string, ...values: string[]): string {
  const digest = createHash("sha256");
  digest.update(kind);
  for (const value of values) {
    digest.update("\x00");
    digest.update(value);
  }
  return "delivery_" + kind + "_" + digest.digest("hex").slice(0, 32);
}

function stableDeliveryDigest(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

function isZeroDate(value: Date): boolean {
  return value === undefined || value === null || value.getTime() === 0;
}

function decodeObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
