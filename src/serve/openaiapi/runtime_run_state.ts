// Ported from internal/serve/openaiapi/runtime_run_state.go (the WebUI
// status → canonical RunState mapping).
import type { RunState } from "../../agentruntime/run_state.ts";
import {
  RunStateCancelled,
  RunStateCancelling,
  RunStateCompleted,
  RunStateCreated,
  RunStateFailed,
  RunStateIncomplete,
  RunStateRunning,
  RunStateTimedOut,
  RunStateWaitingApproval,
  RunStateWaitingQuestion,
} from "../../agentruntime/run_state.ts";

export function webUIActiveRunState(status: string): RunState {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "created":
    case "queued":
      return RunStateCreated;
    case "waiting_for_approval":
      return RunStateWaitingApproval;
    case "waiting_for_question":
      return RunStateWaitingQuestion;
    case "cancelling":
      return RunStateCancelling;
    default:
      return RunStateRunning;
  }
}

export function webUIRunState(status: string, message: string): RunState {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return RunStateCompleted;
    case "incomplete":
      return RunStateIncomplete;
    case "canceled":
    case "cancelled": {
      const lowered = message.toLowerCase();
      if (
        lowered.includes("deadline") || lowered.includes("timed out") ||
        lowered.includes("timeout")
      ) {
        return RunStateTimedOut;
      }
      return RunStateCancelled;
    }
    default:
      return RunStateFailed;
  }
}
