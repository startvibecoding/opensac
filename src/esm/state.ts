// Ported from internal/esm/state.go
//
// The persisted lifecycle vocabulary and value bag for one supervised
// objective. TokensUsed and TimeUsedMS are observability counters only; ESM no
// longer enforces token or time limits.

/** Persisted lifecycle state for a supervised objective. */
export type Status = string;

export const statusActive: Status = "active";
export const statusPaused: Status = "paused";
export const statusBlocked: Status = "blocked";
export const statusUsageLimited: Status = "usage_limited";
export const statusCompleteCandidate: Status = "complete_candidate";
export const statusComplete: Status = "complete";

/**
 * Number of consecutive ESM runs reporting the same blocker before the
 * objective becomes blocked.
 */
export const blockedAuditLimit = 3;

/** Identifies the current role in the ESM completion pipeline. */
export type Phase = string;

export const phaseWorker: Phase = "worker";
export const phaseCritic: Phase = "critic";
export const phaseAudit: Phase = "audit";
export const phaseComplete: Phase = "complete";

/**
 * Per-session Enable Supervisor Mode objective. The Go `*Objective` receiver
 * methods map to the free functions below.
 */
export interface Objective {
  sessionId: string;
  esmId: string;
  objective: string;
  status: Status;
  tokensUsed: number;
  timeUsedMs: number;
  blockedCount: number;
  blockedReason: string;
  blockedRunId: string;
  completionReason: string;
  completionRunId: string;
  completionReview: string;
  phase: Phase;
  progressSummary: string;
  remainingWork: string[];
  rejectionCount: number;
  rejectionRunId: string;
  recoveryCount: number;
  recoveryReason: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Reports whether the row contains a real objective. */
export function hasObjective(obj: Objective | null | undefined): boolean {
  return obj != null && obj.sessionId !== "" && obj.esmId !== "";
}

/** Reports whether TUI idle continuation may start a new agent run. */
export function canAutoRun(obj: Objective | null | undefined): boolean {
  return obj != null &&
    (obj.status === statusActive || obj.status === statusCompleteCandidate);
}

/**
 * Reports whether a status still represents an open objective. "complete" is
 * terminal; clearing the objective deletes the row.
 */
export function isUnfinishedStatus(status: Status): boolean {
  return status !== "" && status !== statusComplete;
}

/** Reports whether normal ESM tools should remain visible. */
export function isRunnableStatus(status: Status): boolean {
  switch (status) {
    case statusActive:
    case statusPaused:
    case statusBlocked:
    case statusUsageLimited:
      return true;
    default:
      return false;
  }
}
