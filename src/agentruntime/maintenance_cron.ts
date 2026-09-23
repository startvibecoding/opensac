//
// Runtime-owned maintenance work: the resolved intent policy, the namespaced
// cron job identities, and the executor a shared cron scheduler dispatches to.
// The scheduler stays the sole owner of job lifecycle (claims, stale recovery,
// status, next run); this module owns what the job does.
//
// Deviations from Go: `context.Context` maps to an optional `AbortSignal`;
// `runMaintenanceCronJob` is async because the ported `reconcileArtifactStorage`
// is async; a `(handled, response, error)` triple whose error is not a normal
// control-flow signal maps to a `MaintenanceCronJobOutcome` value object plus a
// thrown `Error`.

import {
  attachmentStorageReclaimSchedule,
  isAttachmentStorageReclaimEnabled,
  type Settings,
} from "../config/settings.ts";
import { defaultAttachmentPolicy } from "./attachment.ts";
import { reconcileArtifactStorage } from "./storage_reconcile.ts";

/**
 * MaintenancePolicy is the resolved intent for Runtime-owned maintenance work.
 * It is produced once from configuration and then carried by whoever schedules
 * or executes the work, so no layer decides separately whether maintenance runs
 * or how often.
 */
export interface MaintenancePolicy {
  /** Gates the private attachment-store reconciliation. */
  reclaimAttachmentStorage: boolean;
  /** The cadence expression the scheduler should project for that reconciliation. */
  storageReconcileSchedule: string;
}

/** Namespaces Runtime-owned maintenance jobs inside the shared cron store. */
export const MAINTENANCE_CRON_JOB_PREFIX = "opensac-maintenance:";

/**
 * Reclaims unreferenced attachment storage once a day. Reclamation is already
 * age-bounded by the attachment retention window, so a daily pass is enough.
 */
export const MAINTENANCE_STORAGE_RECONCILE_SCHEDULE = "@daily";

/** Labels the projected job for logs and direct store inspection. */
export const MAINTENANCE_STORAGE_RECONCILE_JOB_NAME =
  "Reclaim unreferenced attachment storage";

/** defaultMaintenancePolicy is what applies when configuration says nothing. */
export function defaultMaintenancePolicy(): MaintenancePolicy {
  return {
    reclaimAttachmentStorage: true,
    storageReconcileSchedule: MAINTENANCE_STORAGE_RECONCILE_SCHEDULE,
  };
}

/**
 * Resolves maintenance configuration into one policy. A missing settings object is
 * not an error: it means every default.
 */
export function maintenancePolicyFromSettings(
  settings: Settings | undefined,
): MaintenancePolicy {
  const policy = defaultMaintenancePolicy();
  if (!settings) return policy;
  policy.reclaimAttachmentStorage = isAttachmentStorageReclaimEnabled(settings);
  const schedule = attachmentStorageReclaimSchedule(settings);
  if (schedule !== "") {
    policy.storageReconcileSchedule = schedule;
  }
  return policy;
}

/** The stable identity of the attachment storage reconciliation job. */
export function maintenanceStorageReconcileJobID(): string {
  return MAINTENANCE_CRON_JOB_PREFIX + "artifact-storage";
}

/**
 * Reports whether a persisted job belongs to the maintenance namespace and
 * therefore must be executed by `runMaintenanceCronJob`.
 */
export function isMaintenanceCronJobID(jobID: string): boolean {
  return jobID.trim().startsWith(MAINTENANCE_CRON_JOB_PREFIX);
}

/** The outcome of one maintenance dispatch. */
export interface MaintenanceCronJobOutcome {
  /** True when the job ID belongs to the maintenance namespace. */
  handled: boolean;
  /** A human-readable result for the cron job response. */
  response: string;
}

/**
 * Executes one namespaced maintenance job against a session directory and
 * reports the outcome as a cron job response.
 *
 * It always claims any ID inside the maintenance namespace, including ones it
 * does not recognize: an unknown maintenance job must fail with a status
 * instead of falling through to the ordinary agent path, where its prompt would
 * be run as a model turn. `handled` is false only for job IDs outside the
 * namespace.
 */
export async function runMaintenanceCronJob(
  sessionDir: string,
  jobID: string,
  policy: MaintenancePolicy,
  signal?: AbortSignal,
): Promise<MaintenanceCronJobOutcome> {
  const trimmed = jobID.trim();
  if (!isMaintenanceCronJobID(trimmed)) {
    return { handled: false, response: "" };
  }
  if (sessionDir.trim() === "") {
    throw new Error(
      `maintenance job ${trimmed} requires a session directory`,
    );
  }
  if (trimmed !== maintenanceStorageReconcileJobID()) {
    throw new Error(`unknown maintenance job "${trimmed}"`);
  }
  if (!policy.reclaimAttachmentStorage) {
    // The scheduler normally removes the job when maintenance is disabled, but a
    // row persisted by an older process must still not reclaim anything.
    return {
      handled: true,
      response: "attachment storage reclamation is disabled by configuration",
    };
  }

  const reconciliation = await reconcileArtifactStorage(
    sessionDir,
    defaultAttachmentPolicy(),
    new Date(),
    signal,
  );
  return {
    handled: true,
    response:
      `reclaimed ${reconciliation.removed} unreferenced attachment directories (${reconciliation.freed} bytes) older than ${reconciliation.ageFloor.toISOString()}; kept ${reconciliation.skippedYoung} too recent, ${reconciliation.skippedReferenced} referenced, ${reconciliation.skippedUnrecognized} unrecognized`,
  };
}
