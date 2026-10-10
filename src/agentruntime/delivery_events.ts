//
// Delivery compatibility payloads and events stay at the Runtime boundary so
// channel recovery never hand-assembles them. `json.RawMessage` maps to
// decoded `unknown`; `time.Time` maps to `Date`.

import { type RunEvent } from "./run_event.ts";

/**
 * Returns the compatibility payload used by existing channel recovery while
 * keeping delivery semantics at the Runtime boundary.
 */
export function deliveryPendingData(
  responseRunId: string,
  responseId: string,
  state: string,
  assistantEntryId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    responseRunId,
    responseId,
    state,
    channelDeliveryPending: true,
    assistantEntryId,
  };
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) data[key] = value;
  }
  return data;
}

export function createDeliveryPendingEvent(
  sessionId: string,
  runId: string,
  source: string,
  status: string,
  model: string,
  mode: string,
  data: unknown,
): RunEvent {
  return {
    sessionId,
    runId,
    eventType: "finished",
    source,
    status,
    model,
    mode,
    timestamp: new Date(),
    data,
  };
}
