//
// The canonical TUI ESM role-result application semantics. Both the TUI and
// ACP adapters apply results through these functions so completion,
// rejection, and blocker classification cannot diverge.

import {
  type AuditReport,
  auditVerdictPass,
  parseAuditReport,
  parseWorkerReport,
  type WorkerReport,
  workerStatusBlockedCandidate,
  workerStatusCompleteCandidate,
  workerStatusContinue,
} from "./report.ts";
import { type Objective, statusBlocked, statusComplete } from "./state.ts";
import type { Store } from "./store.ts";

/** UI/runtime-neutral result of one isolated ESM role run. */
export interface RoleResult {
  response: string;
  tokens: number;
  durationMs: number;
  toolCalls: number;
  toolNames: Map<string, number>;
  toolError: Map<string, boolean>;
}

/** Describes the state transition produced by applying one ESM role result. */
export interface Outcome {
  objective: Objective | null;
  subject: string;
  message: string;
  reason: string;
  rejected: boolean;
  completed: boolean;
}

/** The applied outcome plus whether it was actually accepted. */
export interface ApplyResult {
  outcome: Outcome;
  ok: boolean;
}

function emptyOutcome(): Outcome {
  return {
    objective: null,
    subject: "",
    message: "",
    reason: "",
    rejected: false,
    completed: false,
  };
}

/**
 * Applies the canonical TUI ESM worker semantics to durable state. Throws when
 * the store write fails.
 */
export function applyWorkerResult(
  store: Store | null,
  sessionID: string,
  runID: string,
  result: RoleResult,
): ApplyResult {
  if (store === null) throw new Error("esm store is required");
  let report: WorkerReport;
  try {
    report = parseWorkerReport(result.response);
  } catch (err) {
    const reason = "worker report was not structured: " +
      (err instanceof Error ? err.message : String(err));
    const next = store.rejectWorkerReport(sessionID, runID, reason, null);
    return {
      outcome: {
        ...emptyOutcome(),
        objective: next,
        subject: "worker report",
        reason,
        rejected: true,
      },
      ok: true,
    };
  }
  store.recordWorkerProgress(sessionID, report.summary, report.remainingWork);
  switch (report.status) {
    case workerStatusContinue: {
      const next = store.finishRun(sessionID, runID);
      return {
        outcome: {
          ...emptyOutcome(),
          objective: next,
          subject: "worker",
          message: workerContinueMessage(report),
        },
        ok: true,
      };
    }
    case workerStatusCompleteCandidate: {
      const reason = invalidWorkerCandidateReason(result, report);
      if (reason !== "") {
        const next = store.rejectWorkerReport(
          sessionID,
          runID,
          reason,
          workerOutstandingWork(report),
        );
        return {
          outcome: {
            ...emptyOutcome(),
            objective: next,
            subject: "worker completion candidate",
            reason,
            rejected: true,
          },
          ok: true,
        };
      }
      const completionReason = formatWorkerCompletion(report, result.response);
      const next = store.updateFromModelForRun(
        sessionID,
        statusComplete,
        completionReason,
        runID,
      );
      return {
        outcome: {
          ...emptyOutcome(),
          objective: next,
          subject: "worker completion candidate",
          reason: completionReason,
        },
        ok: true,
      };
    }
    case workerStatusBlockedCandidate: {
      if (report.blockers.length === 0) {
        const reason =
          "worker blocked_candidate report did not include a concrete blocker";
        const next = store.rejectWorkerReport(
          sessionID,
          runID,
          reason,
          report.remainingWork,
        );
        return {
          outcome: {
            ...emptyOutcome(),
            objective: next,
            subject: "worker blocker report",
            reason,
            rejected: true,
          },
          ok: true,
        };
      }
      const reason = formatWorkerBlocker(report);
      const next = store.updateFromModelForRun(
        sessionID,
        statusBlocked,
        reason,
        runID,
      );
      return {
        outcome: {
          ...emptyOutcome(),
          objective: next,
          subject: "worker blocker",
          reason,
        },
        ok: true,
      };
    }
  }
  throw new Error(`invalid worker status ${JSON.stringify(report.status)}`);
}

/**
 * Applies the canonical TUI ESM critic/audit semantics to durable state.
 */
export function applyReviewResult(
  store: Store | null,
  sessionID: string,
  runID: string,
  role: string,
  result: RoleResult,
): ApplyResult {
  if (store === null) throw new Error("esm store is required");
  let report: AuditReport;
  try {
    report = parseAuditReport(result.response);
  } catch (err) {
    const review = titleESMRole(role) +
      " report was not structured; completion candidate rejected: " +
      (err instanceof Error ? err.message : String(err));
    const next = store.rejectCompletionCandidateForRun(
      sessionID,
      runID,
      review,
      null,
    );
    return {
      outcome: {
        ...emptyOutcome(),
        objective: next,
        subject: role + " completion candidate",
        reason: review,
        rejected: true,
      },
      ok: true,
    };
  }
  const invalidReason = invalidSupervisorPassReason(role, result, report);
  if (invalidReason !== "") {
    const next = store.rejectCompletionCandidateForRun(
      sessionID,
      runID,
      invalidReason,
      report.missingWork,
    );
    return {
      outcome: {
        ...emptyOutcome(),
        objective: next,
        subject: role + " completion candidate",
        reason: invalidReason,
        rejected: true,
      },
      ok: true,
    };
  }
  const review = formatAuditReview(report, result.response);
  if (report.verdict !== auditVerdictPass) {
    const next = store.rejectCompletionCandidateForRun(
      sessionID,
      runID,
      review,
      report.missingWork,
    );
    return {
      outcome: {
        ...emptyOutcome(),
        objective: next,
        subject: role + " completion candidate",
        reason: review,
        rejected: true,
      },
      ok: true,
    };
  }
  if (role === "critic") {
    return {
      outcome: {
        ...emptyOutcome(),
        subject: "critic",
        message: "ESM critic found no hard blocker; verifier will audit",
      },
      ok: true,
    };
  }
  const next = store.markCompleteFromAudit(sessionID, review);
  return {
    outcome: {
      ...emptyOutcome(),
      objective: next,
      subject: "audit",
      reason: review,
      completed: true,
    },
    ok: true,
  };
}

export function invalidWorkerCandidateReason(
  result: RoleResult,
  report: WorkerReport,
): string {
  if (report.remainingWork.length > 0 || report.blockers.length > 0) {
    const contradictions: string[] = [];
    if (report.remainingWork.length > 0) {
      contradictions.push(
        formatItemDetail("remaining work", report.remainingWork),
      );
    }
    if (report.blockers.length > 0) {
      contradictions.push(formatItemDetail("blockers", report.blockers));
    }
    return "worker proposed completion while reporting " +
      contradictions.join("; ");
  }
  if (result.toolCalls === 0) {
    return "worker proposed completion without any tool-backed inspection or validation";
  }
  if (result.toolError.size >= result.toolCalls) {
    return "worker proposed completion but all inspection or validation tool calls failed";
  }
  if (report.summary.trim() === "") {
    return "worker proposed completion without a summary";
  }
  if (report.evidence.length === 0) {
    return "worker proposed completion without evidence";
  }
  return "";
}

export function invalidSupervisorPassReason(
  role: string,
  result: RoleResult,
  report: AuditReport,
): string {
  if (report.verdict !== auditVerdictPass) return "";
  const prefix = role + " pass rejected: ";
  if (report.missingWork.length > 0) {
    return prefix + formatItemDetail("missing_work", report.missingWork);
  }
  if (result.toolCalls === 0) {
    return prefix + "no independent tool-backed inspection was performed";
  }
  if (result.toolError.size >= result.toolCalls) {
    return prefix + "all independent inspection tool calls failed";
  }
  if (report.review.trim() === "") {
    return prefix + "review is empty";
  }
  if (report.requirementsChecked.length === 0) {
    return prefix + "requirements_checked is empty";
  }
  if (report.evidence.length === 0) {
    return prefix + "evidence is empty";
  }
  return "";
}

export function workerOutstandingWork(report: WorkerReport): string[] {
  const items = [...report.remainingWork];
  for (const blocker of report.blockers) {
    items.push("blocker: " + blocker);
  }
  return items;
}

export function workerContinueMessage(report: WorkerReport): string {
  const parts = ["ESM worker reported more work remains"];
  if (report.summary !== "") {
    parts.push("progress: " + report.summary);
  }
  if (report.remainingWork.length > 0) {
    parts.push(formatItemDetail("remaining work", report.remainingWork));
  }
  return parts.join("; ");
}

export function formatItemDetail(label: string, items: string[]): string {
  return `${label} (${items.length}): ${items.join("; ")}`;
}

export function formatWorkerCompletion(
  report: WorkerReport,
  raw: string,
): string {
  return formatReportParts(
    "summary",
    report.summary,
    "evidence",
    report.evidence,
    `remaining_work (${report.remainingWork.length})`,
    report.remainingWork,
    raw,
  );
}

export function formatWorkerBlocker(report: WorkerReport): string {
  return report.blockers.join("; ");
}

export function formatAuditReview(report: AuditReport, raw: string): string {
  return formatReportParts(
    "review",
    report.review,
    "requirements",
    report.requirementsChecked,
    `missing_work (${report.missingWork.length})`,
    report.missingWork,
    raw,
  );
}

export function formatReportParts(
  primaryLabel: string,
  primary: string,
  firstLabel: string,
  first: string[],
  secondLabel: string,
  second: string[],
  raw: string,
): string {
  const parts: string[] = [];
  if (primary.trim() !== "") {
    parts.push(primaryLabel + ": " + primary.trim());
  }
  if (first.length > 0) {
    parts.push(firstLabel + ": " + first.join("; "));
  }
  if (second.length > 0) {
    parts.push(secondLabel + ": " + second.join("; "));
  }
  if (parts.length === 0) {
    return raw.trim();
  }
  return parts.join("\n");
}

export function titleESMRole(role: string): string {
  if (role === "") return "ESM";
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}
