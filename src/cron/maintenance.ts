//
// This module owns the projection helpers that keep Runtime-owned maintenance
// jobs out of user-facing cron surfaces. The scheduler-bound half of the Go file
// (`SetMaintenancePolicy`/`ensureMaintenanceJob`/`normalizeMaintenanceSchedule`)
// lands with the Scheduler and the durable Runtime lifecycle (backlog #26).

import { isMaintenanceCronJobID } from "../agentruntime/maintenance_cron.ts";
import type { CronJob } from "./cron.ts";

/**
 * Removes Runtime-owned maintenance jobs from a job list headed for a
 * user-facing surface (the cron tool and ACP management). Those
 * jobs are host storage housekeeping: they are scheduled, claimed, and completed
 * through the same lifecycle as any other job, but they are not automation tasks
 * the user authored, their prompt is not a prompt, and a front-end that rendered
 * them would offer edit/delete controls for something the user cannot
 * meaningfully evaluate. Filtering the projection keeps the scheduler's
 * authoritative store untouched.
 */
export function userVisibleJobs(jobs: CronJob[]): CronJob[] {
  return jobs.filter((job) => !isMaintenanceCronJobID(job.id ?? ""));
}

/**
 * Recognizes the package's own not-found wording. The stores report a missing
 * job as a formatted error rather than a sentinel, and maintenance must not
 * delete or recreate on an unrelated store failure.
 */
export function isMissingCronJobError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("not found");
}
