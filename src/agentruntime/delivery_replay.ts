//
// Protocol-neutral projection of durable delivery handoffs. The actual message
// remains in the session transcript. `json.RawMessage` maps to decoded
// `unknown`.

import type { SessionRunEvent } from "../session/session_events.ts";
import type { RunEvent } from "./run_event.ts";

/** The protocol-neutral projection of a durable delivery handoff. */
export interface DeliveryRecord {
  runId: string;
  sessionId: string;
  pending: boolean;
  assistantEntry: string;
  status: string;
  source: string;
}

/**
 * Reconstructs pending channel/background deliveries from durable run events.
 * Unknown events and protocol payloads remain untouched.
 */
export function replayDeliveries(
  events: SessionRunEvent[],
): Map<string, DeliveryRecord> {
  const pending = new Map<string, DeliveryRecord>();
  for (const event of events) {
    let payloadPending = false;
    let assistantEntry = "";
    const data = asObject(event.data);
    if (data !== undefined) {
      if (typeof data.channelDeliveryPending === "boolean") {
        payloadPending = data.channelDeliveryPending;
      }
      if (typeof data.assistantEntryId === "string") {
        assistantEntry = data.assistantEntryId;
      }
    }
    switch (event.eventType) {
      case "finished":
        if (payloadPending && assistantEntry !== "") {
          pending.set(event.runId, {
            runId: event.runId,
            sessionId: event.sessionId,
            pending: true,
            assistantEntry,
            status: event.status,
            source: event.source,
          });
        }
        break;
      case "channel_delivery_reconciled":
        pending.delete(event.runId);
        break;
    }
  }
  return pending;
}

export function replayDeliveriesFromRunEvents(
  events: RunEvent[],
): Map<string, DeliveryRecord> {
  const persisted: SessionRunEvent[] = events.map((event) => ({
    id: event.id ?? "",
    sessionId: event.sessionId,
    runId: event.runId,
    eventType: event.eventType,
    source: event.source,
    status: event.status,
    model: event.model,
    mode: event.mode,
    timestamp: event.timestamp ?? new Date(),
    data: event.data,
  }));
  return replayDeliveries(persisted);
}

export function newDeliveryReconciledEvent(
  sessionId: string,
  runId: string,
  source: string,
  data: unknown,
): RunEvent {
  return {
    sessionId,
    runId,
    eventType: "channel_delivery_reconciled",
    source,
    status: "delivered",
    model: "",
    mode: "",
    data,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
