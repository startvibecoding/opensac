// (the RunState vocabulary and
// terminal classifier). The `ExecutionRuntime` lifecycle that consumes these
// states lands in a later #26 slice.

/** The adapter-neutral lifecycle state of an active execution. */
export type RunState = string;

export const RUN_STATE_CREATED: RunState = "created";
export const RUN_STATE_QUEUED: RunState = "queued";
export const RUN_STATE_RUNNING: RunState = "running";
export const RUN_STATE_WAITING_APPROVAL: RunState = "waiting_for_approval";
export const RUN_STATE_WAITING_QUESTION: RunState = "waiting_for_question";
export const RUN_STATE_CANCELLING: RunState = "cancelling";
export const RUN_STATE_TERMINALIZING: RunState = "terminalizing";
export const RUN_STATE_COMPLETED: RunState = "completed";
export const RUN_STATE_INCOMPLETE: RunState = "incomplete";
export const RUN_STATE_FAILED: RunState = "failed";
export const RUN_STATE_CANCELLED: RunState = "cancelled";
export const RUN_STATE_TIMED_OUT: RunState = "timed_out";

/** Reports whether a run state is terminal. */
export function isTerminalRunState(state: RunState): boolean {
  switch (state) {
    case RUN_STATE_COMPLETED:
    case RUN_STATE_INCOMPLETE:
    case RUN_STATE_FAILED:
    case RUN_STATE_CANCELLED:
    case RUN_STATE_TIMED_OUT:
      return true;
    default:
      return false;
  }
}
