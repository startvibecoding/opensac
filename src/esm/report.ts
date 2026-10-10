//
// The structured role reports an isolated ESM worker/critic/audit/recovery
// sub-agent returns as its final assistant response, plus their tolerant JSON
// extraction.

export const workerStatusContinue = "continue";
export const workerStatusCompleteCandidate = "complete_candidate";
export const workerStatusBlockedCandidate = "blocked_candidate";

export const auditVerdictPass = "pass";
export const auditVerdictFail = "fail";

export const recoveryDecisionResume = "resume";
export const recoveryDecisionBlocked = "blocked";

/** Structured final response from an isolated ESM worker. */
export interface WorkerReport {
  status: string;
  summary: string;
  evidence: string[];
  remainingWork: string[];
  blockers: string[];
}

/** Structured final response from an isolated ESM auditor. */
export interface AuditReport {
  verdict: string;
  review: string;
  requirementsChecked: string[];
  missingWork: string[];
  evidence: string[];
}

/**
 * Structured result of an observer inspecting work left behind by an
 * interrupted ESM role.
 */
export interface RecoveryReport {
  decision: string;
  summary: string;
  evidence: string[];
  remainingWork: string[];
  blockers: string[];
}

export function parseWorkerReport(text: string): WorkerReport {
  const payload = decodeReport<Record<string, unknown>>(text);
  const report: WorkerReport = {
    status: asString(payload.status),
    summary: asString(payload.summary),
    evidence: asStringArray(payload.evidence),
    remainingWork: asStringArray(payload.remaining_work),
    blockers: asStringArray(payload.blockers),
  };
  const missingWork = asStringArray(payload.missing_work);
  report.status = report.status.trim();
  switch (report.status) {
    case workerStatusContinue:
    case workerStatusCompleteCandidate:
    case workerStatusBlockedCandidate:
      break;
    default:
      throw new Error(`invalid worker status ${JSON.stringify(report.status)}`);
  }
  report.summary = report.summary.trim();
  report.evidence = trimStringSlice(report.evidence);
  report.remainingWork = mergeTrimmedStringSlices(
    report.remainingWork,
    missingWork,
  );
  report.blockers = trimStringSlice(report.blockers);
  return report;
}

function mergeTrimmedStringSlices(...slices: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const values of slices) {
    for (let value of values) {
      value = value.trim();
      if (value === "") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

export function parseAuditReport(text: string): AuditReport {
  const payload = decodeReport<Record<string, unknown>>(text);
  const report: AuditReport = {
    verdict: asString(payload.verdict),
    review: asString(payload.review),
    requirementsChecked: asStringArray(payload.requirements_checked),
    missingWork: asStringArray(payload.missing_work),
    evidence: asStringArray(payload.evidence),
  };
  report.verdict = report.verdict.trim();
  switch (report.verdict) {
    case auditVerdictPass:
    case auditVerdictFail:
      break;
    default:
      throw new Error(
        `invalid audit verdict ${JSON.stringify(report.verdict)}`,
      );
  }
  report.review = report.review.trim();
  report.requirementsChecked = trimStringSlice(report.requirementsChecked);
  report.missingWork = trimStringSlice(report.missingWork);
  report.evidence = trimStringSlice(report.evidence);
  return report;
}

export function parseRecoveryReport(text: string): RecoveryReport {
  const payload = decodeReport<Record<string, unknown>>(text);
  const report: RecoveryReport = {
    decision: asString(payload.decision),
    summary: asString(payload.summary),
    evidence: asStringArray(payload.evidence),
    remainingWork: asStringArray(payload.remaining_work),
    blockers: asStringArray(payload.blockers),
  };
  report.decision = report.decision.trim();
  switch (report.decision) {
    case recoveryDecisionResume:
    case recoveryDecisionBlocked:
      break;
    default:
      throw new Error(
        `invalid recovery decision ${JSON.stringify(report.decision)}`,
      );
  }
  report.summary = report.summary.trim();
  report.evidence = trimStringSlice(report.evidence);
  report.remainingWork = trimStringSlice(report.remainingWork);
  report.blockers = trimStringSlice(report.blockers);
  if (report.summary === "") {
    throw new Error("recovery summary is empty");
  }
  if (
    report.decision === recoveryDecisionBlocked &&
    report.blockers.length === 0
  ) {
    throw new Error("blocked recovery report has no concrete blocker");
  }
  return report;
}

function decodeReport<T>(text: string): T {
  const payload = extractJSONObject(text);
  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    throw new Error(
      `parse report json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Extracts the first balanced JSON object from arbitrary model text. */
export function extractJSONObject(text: string): string {
  text = text.trim();
  if (text === "") throw new Error("empty report");
  const start = text.indexOf("{");
  if (start < 0) throw new Error("report does not contain a json object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      switch (ch) {
        case "\\":
          escaped = true;
          break;
        case '"':
          inString = false;
          break;
      }
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
        depth++;
        break;
      case "}":
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
        break;
    }
  }
  throw new Error("unterminated json object");
}

/** Trims each entry and drops empty values, matching the Go helper. */
export function trimStringSlice(values: string[]): string[] {
  if (values.length === 0) return [];
  const out: string[] = [];
  for (let value of values) {
    value = value.trim();
    if (value !== "") out.push(value);
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    else if (item != null) out.push(String(item));
  }
  return out;
}
