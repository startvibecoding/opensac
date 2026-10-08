// delivery-event coverage from delivery_events.go.

import { assertEquals } from "@opensac/assert";
import {
  createDeliveryPendingEvent,
  deliveryPendingData,
} from "./delivery_events.ts";
import {
  createDeliveryReconciledEvent,
  replayDeliveries,
  replayDeliveriesFromRunEvents,
} from "./delivery_replay.ts";
import type { SessionRunEvent } from "../session/session_events.ts";

function event(overrides: Partial<SessionRunEvent>): SessionRunEvent {
  return {
    id: "",
    sessionId: "",
    runId: "",
    eventType: "",
    source: "",
    status: "",
    model: "",
    mode: "",
    timestamp: new Date(),
    ...overrides,
  };
}

Deno.test("ReplayDeliveries pending and reconciled", () => {
  const events = [
    event({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "finished",
      status: "completed",
      data: { channelDeliveryPending: true, assistantEntryId: "entry-1" },
    }),
    event({
      sessionId: "session-1",
      runId: "run-2",
      eventType: "finished",
      status: "completed",
      data: { channelDeliveryPending: true, assistantEntryId: "entry-2" },
    }),
    event({
      sessionId: "session-1",
      runId: "run-2",
      eventType: "channel_delivery_reconciled",
      status: "delivered",
    }),
  ];
  const pending = replayDeliveries(events);
  assertEquals(pending.size, 1);
  assertEquals(pending.get("run-1")?.assistantEntry, "entry-1");
});

Deno.test("delivery pending data and events round trip", () => {
  const data = deliveryPendingData("run-1", "resp-1", "pending", "entry-1", {
    extraKey: "extra-value",
  });
  assertEquals(data.channelDeliveryPending, true);
  assertEquals(data.extraKey, "extra-value");

  const finished = createDeliveryPendingEvent(
    "s",
    "run-1",
    "tui",
    "completed",
    "m",
    "yolo",
    data,
  );
  const reconciled = createDeliveryReconciledEvent("s", "run-1", "tui", {});
  const pending = replayDeliveriesFromRunEvents([finished, reconciled]);
  assertEquals(pending.size, 0);
});
