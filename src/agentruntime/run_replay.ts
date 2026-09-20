// Ported from internal/agentruntime/run_replay.go.
//
// `RunReplay` is the adapter-neutral projection of persisted run events. It is
// intentionally read-only: adapters decide how to render or recover protocol
// state from the event data.

import type { SessionRunEvent } from "../session/session_events.ts";
import type { RunEvent } from "./run_event.ts";
import {
  isTerminalRunState,
  type RunState,
  RunStateCancelled,
  RunStateCancelling,
  RunStateCompleted,
  RunStateCreated,
  RunStateFailed,
  RunStateIncomplete,
  RunStateQueued,
  RunStateRunning,
  RunStateTimedOut,
  RunStateWaitingApproval,
  RunStateWaitingQuestion,
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
      return RunStateRunning;
    case "waiting_for_approval":
    case "approval_requested":
      return RunStateWaitingApproval;
    case "waiting_for_question":
    case "question_requested":
      return RunStateWaitingQuestion;
    case "cancelling":
    case "cancel_requested":
      return RunStateCancelling;
    case "finished":
    case "completed":
      return RunStateCompleted;
    case "failed":
      return RunStateFailed;
    case "canceled":
    case "cancelled":
      return RunStateCancelled;
    case "timed_out":
    case "timeout":
      return RunStateTimedOut;
    case "incomplete":
      return RunStateIncomplete;
  }
  switch (event.status) {
    case "created":
      return RunStateCreated;
    case "queued":
      return RunStateQueued;
    case "running":
      return RunStateRunning;
    case "waiting_for_approval":
      return RunStateWaitingApproval;
    case "waiting_for_question":
      return RunStateWaitingQuestion;
    case "cancelling":
    case "terminalizing":
      return RunStateCancelling;
    case "completed":
      return RunStateCompleted;
    case "failed":
      return RunStateFailed;
    case "cancelled":
    case "canceled":
      return RunStateCancelled;
    case "timed_out":
      return RunStateTimedOut;
    case "incomplete":
      return RunStateIncomplete;
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
