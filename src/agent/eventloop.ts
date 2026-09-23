//
// Go's `<-chan Event` maps to an `AsyncIterable<Event>`; `context.Context`
// maps to an optional `AbortSignal`.

import type { Event } from "./events.ts";

/** Receives agent events from a running request. */
export interface EventHandler {
  handleAgentEvent(event: Event): Promise<void> | void;
}

/**
 * Adapts a function to an EventHandler.
 */
export function eventHandlerFunc(
  fn: (event: Event) => Promise<void> | void,
): EventHandler {
  return { handleAgentEvent: fn };
}

/**
 * Forwards every event from the stream to the handler until the stream closes,
 * the signal aborts, or the handler throws.
 *
 * Cancellation boundary: the Agent loop's terminal events
 * (EVENT_RUN_FINISHED/EVENT_DONE/EVENT_ERROR/EVENT_AGENT_END) are sent
 * unconditionally, so a consumer that returns here on abort can leave a
 * cancelled run parked on one of those sends. In-process adapters that must let
 * the run finish its terminal bookkeeping keep draining the stream (the TUI
 * retires the stream but keeps consuming it); an adapter whose process ends with
 * the command, such as CLI print mode, relies on process teardown instead.
 */
export async function consumeEvents(
  events: AsyncIterable<Event>,
  handler: EventHandler,
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of events) {
    if (signal?.aborted) {
      throw new DOMException("context canceled", "AbortError");
    }
    await handler.handleAgentEvent(event);
  }
}
