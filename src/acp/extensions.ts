// (the pure, server-independent
// extension projections).
//
// These helpers build the additive `opensac/*` extension payloads that the ACP
// server emits: the per-project result projection and the
// `listedSession._meta.lastRun` durable-run projection. They carry no server
// state, so they are ported ahead of the ACP server, which lands in a later
// slice.

import {
  getActiveDurableRun,
  listLatestDurableRunsBySessions,
} from "../agentruntime/run_queries.ts";
import { type Project } from "../session/projects.ts";
import { acpRunStatus } from "./projection.ts";

/** The additive ACP project projection. */
export interface ACPProjectResult {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  sessionCount?: number;
}

/** Projects one persisted project onto the ACP project result. */
export function acpProjectResult(
  project: Project,
  sessionCount?: number,
): ACPProjectResult {
  const result: ACPProjectResult = { id: project.id, name: project.name };
  if (sessionCount !== undefined) result.sessionCount = sessionCount;
  if (!isZeroTime(project.createdAt)) {
    result.createdAt = formatRFC3339(project.createdAt);
  }
  if (!isZeroTime(project.updatedAt)) {
    result.updatedAt = formatRFC3339(project.updatedAt);
  }
  return result;
}

/**
 * Assembles the additive `listedSession._meta.lastRun` projection for one page
 * of sessions: the most recent durable Run per session plus the cross-process
 * active marker. Sessions without any Run receive no entry; lookup failures
 * degrade to an empty projection instead of failing `session/list`.
 */
export function sessionListLastRun(
  sessionDir: string,
  sessionIds: string[],
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  if (sessionIds.length === 0) return result;
  let latestRuns: Map<
    string,
    { id: string; status: string; startedAt: Date; finishedAt: Date | null }
  >;
  try {
    latestRuns = listLatestDurableRunsBySessions(sessionDir, sessionIds);
  } catch {
    return result;
  }
  for (const sessionId of sessionIds) {
    const run = latestRuns.get(sessionId);
    if (run === undefined || run.id === "") continue;
    let active = false;
    try {
      if (getActiveDurableRun(sessionDir, sessionId) !== null) active = true;
    } catch {
      active = false;
    }
    result[sessionId] = {
      runId: run.id,
      status: acpRunStatus(run.status),
      startedAt: formatRFC3339(run.startedAt),
      active,
      finishedAt:
        run.finishedAt !== null ? formatRFC3339(run.finishedAt) : null,
    };
  }
  return result;
}

/** Formats a `Date` as Go's `time.RFC3339` (UTC, no fractional seconds). */
export function formatRFC3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The ported representation of Go's zero `time.Time` is an invalid `Date`. */
export function isZeroTime(date: Date): boolean {
  return Number.isNaN(date.getTime());
}
