// Ported from the `PlanDelivery` cases of
// internal/agentruntime/delivery_coordinator_test.go, plus focused coverage for
// `deliveryOperationText`.

import { assert, assertEquals } from "@std/assert";
import {
  AttachmentAudio,
  AttachmentImage,
  type SessionAttachment,
} from "./attachment.ts";
import {
  deliveryOperationText,
  type DeliveryPlanRequest,
  planDelivery,
} from "./delivery.ts";

function attachment(
  overrides: Partial<SessionAttachment>,
): SessionAttachment {
  return {
    id: "",
    sessionId: "session",
    runId: "run",
    origin: "",
    kind: AttachmentImage,
    filename: "",
    mediaType: "",
    bytes: 0,
    sha256: "",
    storageKey: "",
    status: "",
    createdAt: new Date(),
    expiresAt: new Date(),
    ...overrides,
  };
}

Deno.test("PlanDeliveryFallbackStaysAfterCaptionWhenMediaAlsoExists", () => {
  const now = new Date();
  const request: DeliveryPlanRequest = {
    sessionId: "session",
    runId: "run",
    platform: "feishu",
    targetId: "chat",
    replyMessageId: "",
    transportContext: undefined,
    caption: "summary",
    createdAt: now,
    capability: {
      text: true,
      sendImage: true,
      sendFile: false,
      sendVideo: false,
    },
    attachments: [
      attachment({
        id: "native-image",
        kind: AttachmentImage,
        filename: "screen.png",
        sha256: "image-hash",
      }),
      attachment({
        id: "unsupported-audio",
        kind: AttachmentAudio,
        filename: "voice.amr",
        sha256: "audio-hash",
      }),
    ],
  };
  const { plan, fallbackText } = planDelivery(request);
  assert(fallbackText !== "");
  assertEquals(plan.operations.length, 4);
  const captionId = plan.operations[0].id;
  assertEquals(plan.operations[0].operationKind, "send_text");
  assertEquals(plan.operations[3].operationKind, "send_fallback_text");
  assertEquals(plan.operations[3].dependsOn, captionId);
});

Deno.test("PlanDeliveryRejectsForeignAttachment", () => {
  const request: DeliveryPlanRequest = {
    sessionId: "session",
    runId: "run",
    platform: "wechat",
    targetId: "chat",
    replyMessageId: "",
    transportContext: undefined,
    caption: "",
    createdAt: new Date(),
    capability: {
      text: true,
      sendImage: false,
      sendFile: false,
      sendVideo: false,
    },
    attachments: [
      attachment({ id: "a", sessionId: "other", runId: "run" }),
    ],
  };
  let threw = false;
  try {
    planDelivery(request);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("PlanDeliveryIsDeterministic", () => {
  const make = (): DeliveryPlanRequest => ({
    sessionId: "session",
    runId: "run",
    platform: "feishu",
    targetId: "chat",
    replyMessageId: "reply-1",
    transportContext: { opaque: true },
    caption: "hello",
    createdAt: new Date(1000),
    capability: {
      text: true,
      sendImage: false,
      sendFile: false,
      sendVideo: false,
    },
    attachments: [],
  });
  const first = planDelivery(make());
  const second = planDelivery(make());
  assertEquals(first.plan.intent.id, second.plan.intent.id);
  assertEquals(first.plan.operations.length, 1);
  assertEquals(
    first.plan.operations[0].id,
    second.plan.operations[0].id,
  );
  assertEquals(first.plan.intent.status, "pending");
});

Deno.test("DeliveryOperationTextSelectsCaptionOrFallback", () => {
  const payload = { caption: " the caption ", fallback: " the fallback " };
  assertEquals(deliveryOperationText(payload, "send_text"), "the caption");
  assertEquals(
    deliveryOperationText(payload, "send_fallback_text"),
    "the fallback",
  );
  assertEquals(deliveryOperationText(undefined, "send_text"), "");
});
