//
// `RunReplay` is the adapter-neutral projection of persisted run events. It is
// intentionally read-only: adapters decide how to render or recover protocol
// state from the event data.

import type { SessionRunEvent } from "../session/session_events.ts";
import type { RunEvent } from "./run_event.ts";
import {
  isTerminalRunState,
  RUN_STATE_CANCELLED,
  RUN_STATE_CANCELLING,
  RUN_STATE_COMPLETED,
  RUN_STATE_CREATED,
  RUN_STATE_FAILED,
  RUN_STATE_INCOMPLETE,
  RUN_STATE_QUEUED,
  RUN_STATE_RUNNING,
  RUN_STATE_TIMED_OUT,
  RUN_STATE_WAITING_APPROVAL,
  RUN_STATE_WAITING_QUESTION,
  type RunState,
} from "./run_state.ts";

export interface RunReplay {
  sessionId: string;
  runId: string;
  events: RunEvent[];
  status: RunState;
  terminal: boolean;
}

/**
 * Reconstructs one run's latest lifecycle state from durable
 * `SessionRunEvent`s. Unknown event types remain in `events` for adapter
 * replay.
 */
export function replayRunEvents(
  events: SessionRunEvent[],
  runId: string,
): RunReplay {
  const replay: RunReplay = {
    sessionId: "",
    runId,
    events: [],
    status: "",
    terminal: false,
  };
  for (const event of events) {
    if (runId !== "" && event.runId !== runId) continue;
    if (replay.sessionId === "") replay.sessionId = event.sessionId;
    replay.events.push({
      id: event.id,
      sessionId: event.sessionId,
      runId: event.runId,
      eventType: event.eventType,
      source: event.source,
      status: event.status,
      model: event.model,
      mode: event.mode,
      timestamp: event.timestamp,
      data: event.data,
    });
    const state = runStateFromEvent(event);
    if (state !== null) {
      replay.status = state;
      replay.terminal = isTerminalRunState(state);
    }
  }
  return replay;
}

export function runStateFromEvent(event: SessionRunEvent): RunState | null {
  switch (event.eventType) {
    case "started":
    case "remote_started":
      return RUN_STATE_RUNNING;
    case "waiting_for_approval":
    case "approval_requested":
      return RUN_STATE_WAITING_APPROVAL;
    case "waiting_for_question":
    case "question_requested":
      return RUN_STATE_WAITING_QUESTION;
    case "cancelling":
    case "cancel_requested":
      return RUN_STATE_CANCELLING;
    case "finished":
    case "completed":
      return RUN_STATE_COMPLETED;
    case "failed":
      return RUN_STATE_FAILED;
    case "canceled":
    case "cancelled":
      return RUN_STATE_CANCELLED;
    case "timed_out":
    case "timeout":
      return RUN_STATE_TIMED_OUT;
    case "incomplete":
      return RUN_STATE_INCOMPLETE;
  }
  switch (event.status) {
    case "created":
      return RUN_STATE_CREATED;
    case "queued":
      return RUN_STATE_QUEUED;
    case "running":
      return RUN_STATE_RUNNING;
    case "waiting_for_approval":
      return RUN_STATE_WAITING_APPROVAL;
    case "waiting_for_question":
      return RUN_STATE_WAITING_QUESTION;
    case "cancelling":
    case "terminalizing":
      return RUN_STATE_CANCELLING;
    case "completed":
      return RUN_STATE_COMPLETED;
    case "failed":
      return RUN_STATE_FAILED;
    case "cancelled":
    case "canceled":
      return RUN_STATE_CANCELLED;
    case "timed_out":
      return RUN_STATE_TIMED_OUT;
    case "incomplete":
      return RUN_STATE_INCOMPLETE;
    default:
      return null;
  }
}

/**
 * Provides a stable JSON projection for adapters that need to pass durable
 * replay data across an API boundary.
 */
export function replayRunEventsJSON(
  events: SessionRunEvent[],
  runId: string,
): string {
  const replay = replayRunEvents(events, runId);
  replay.events.sort((a, b) => {
    const at = a.timestamp?.getTime() ?? 0;
    const bt = b.timestamp?.getTime() ?? 0;
    return at - bt;
  });
  return JSON.stringify(replay);
}
