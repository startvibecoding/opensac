//
// Namespaced scheduled reindex jobs inside the shared cron store. The store is
// keyed only by sessionDir, so every scheduler process (ACP, CLI) can claim a
// namespaced job; each must route it through `runKnowledgeBaseCronJob` instead
// of executing the job prompt as an ordinary agent run inside the knowledge
// source directory.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; the Go
// `(handled, response, error)` triple maps to a `KnowledgeBaseCronOutcome`
// value object plus a thrown `Error`.

import {
  KnowledgeBaseServiceMissingError,
  KnowledgeIndexJob,
} from "./knowledge_index_job.ts";
import type { KnowledgeBaseService } from "./knowledgebase.ts";
import { SOURCE_CRON } from "./source.ts";

export const KNOWLEDGE_BASE_CRON_JOB_PREFIX = "knowledge-base-index:";

/** The result of attempting to route one cron job. */
export interface KnowledgeBaseCronOutcome {
  handled: boolean;
  response: string;
}

/** Derives the shared cron identity of one knowledge base's reindex schedule. */
export function knowledgeBaseCronJobID(knowledgeBaseID: string): string {
  return KNOWLEDGE_BASE_CRON_JOB_PREFIX + knowledgeBaseID.trim();
}

/** Extracts the knowledge base identity from a namespaced cron job ID. */
export function knowledgeBaseIDFromCronJobID(
  jobID: string,
): string | undefined {
  if (!jobID.startsWith(KNOWLEDGE_BASE_CRON_JOB_PREFIX)) return undefined;
  const id = jobID.slice(KNOWLEDGE_BASE_CRON_JOB_PREFIX.length).trim();
  return id === "" ? undefined : id;
}

/**
 * Wakes one namespaced reindex through the same background job machinery as
 * manual scans, so Cron only records the scheduling outcome while the canonical
 * durable Run stays Runtime-owned. It reports `handled=false` for job IDs
 * outside the knowledge namespace so a shared scheduler falls back to its own
 * execution path. Passing the process-wide cached service keeps scheduled scans
 * deduplicated against manual scans and visible to progress polling.
 */
export async function runKnowledgeBaseCronJob(
  ctx: AbortSignal | undefined,
  service: KnowledgeBaseService | null,
  jobID: string,
): Promise<KnowledgeBaseCronOutcome> {
  const id = knowledgeBaseIDFromCronJobID(jobID);
  if (id === undefined) return { handled: false, response: "" };
  if (service === null) {
    throw new KnowledgeBaseServiceMissingError();
  }
  const job: KnowledgeIndexJob = service.startIndex(ctx, id, SOURCE_CRON);
  const snapshot = await job.wait(ctx);
  return {
    handled: true,
    response:
      `indexed knowledge base ${id}: ${snapshot.fileCount} files, ` +
      `${snapshot.chunkCount} chunks`,
  };
}
