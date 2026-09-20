// Ported from internal/agentruntime/execution.go (the RunState vocabulary and
// terminal classifier). The `ExecutionRuntime` lifecycle that consumes these
// states lands in a later #26 slice.

/** The adapter-neutral lifecycle state of an active execution. */
export type RunState = string;

export const RunStateCreated: RunState = "created";
export const RunStateQueued: RunState = "queued";
export const RunStateRunning: RunState = "running";
export const RunStateWaitingApproval: RunState = "waiting_for_approval";
export const RunStateWaitingQuestion: RunState = "waiting_for_question";
export const RunStateCancelling: RunState = "cancelling";
export const RunStateTerminalizing: RunState = "terminalizing";
export const RunStateCompleted: RunState = "completed";
export const RunStateIncomplete: RunState = "incomplete";
export const RunStateFailed: RunState = "failed";
export const RunStateCancelled: RunState = "cancelled";
export const RunStateTimedOut: RunState = "timed_out";

/** Reports whether a run state is terminal. */
export function isTerminalRunState(state: RunState): boolean {
  switch (state) {
    case RunStateCompleted:
    case RunStateIncomplete:
    case RunStateFailed:
    case RunStateCancelled:
    case RunStateTimedOut:
      return true;
    default:
      return false;
  }
}
