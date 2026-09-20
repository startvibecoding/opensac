// Translated from internal/agentruntime/maintenance_cron_test.go.

import { assert, assertRejects } from "@std/assert";
import { defaultAttachmentPolicy } from "./attachment.ts";
import {
  DefaultMaintenancePolicy,
  IsMaintenanceCronJobID,
  MaintenanceCronJobPrefix,
  MaintenancePolicyFromSettings,
  MaintenanceStorageReconcileJobID,
  MaintenanceStorageReconcileSchedule,
  RunMaintenanceCronJob,
} from "./maintenance_cron.ts";
import {
  ArtifactStorageDirectoryName,
  ReconcileGraceMs,
} from "./storage_reconcile.ts";
import { newManager } from "../session/manager.ts";
import { closeDatabases } from "../session/root_db.ts";

function makeSessionRoot(): string {
  const root = Deno.makeTempDirSync({ prefix: "mothx-maint-" });
  const workDir = Deno.makeTempDirSync({ prefix: "mothx-maint-work-" });
  const manager = newManager(workDir, root);
  manager.init();
  return root;
}

/** Plants attachment-looking storage aged by `ageMs`, using the intake layout. */
function writeArtifactDirectory(
  sessionDir: string,
  id: string,
  ageMs: number,
  content: string,
): string {
  const dir = `${sessionDir}/${ArtifactStorageDirectoryName()}/${id}`;
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/content`;
  Deno.writeTextFileSync(path, content, { mode: 0o600 });
  const stamp = new Date(Date.now() - ageMs);
  Deno.utimeSync(path, stamp, stamp);
  Deno.utimeSync(dir, stamp, stamp);
  return path;
}

Deno.test("RunMaintenanceCronJobClaimsTheWholeNamespace", async () => {
  const policy = DefaultMaintenancePolicy();
  const outside = await RunMaintenanceCronJob(
    makeSessionRoot(),
    "knowledge-base-index:abc",
    policy,
  );
  assert(!outside.handled, "the maintenance path claimed a foreign job");

  const unknown = (await assertRejects(() =>
    RunMaintenanceCronJob(
      makeSessionRoot(),
      MaintenanceCronJobPrefix + "unknown-task",
      policy,
    )
  )) as Error;
  assert(
    unknown.message.includes("unknown maintenance job"),
    `unknown maintenance job error = ${unknown.message}, want a refusal`,
  );

  await assertRejects(() =>
    RunMaintenanceCronJob(
      "",
      MaintenanceStorageReconcileJobID(),
      policy,
    )
  );
});

Deno.test("RunMaintenanceCronJobHonorsTheDisabledPolicy", async () => {
  const root = makeSessionRoot();
  const policy = defaultAttachmentPolicy();
  const aged = writeArtifactDirectory(
    root,
    "7123456789abcdef",
    policy.retention + ReconcileGraceMs + 3_600_000,
    "stale",
  );

  const outcome = await RunMaintenanceCronJob(
    root,
    MaintenanceStorageReconcileJobID(),
    { reclaimAttachmentStorage: false, storageReconcileSchedule: "" },
  );
  assert(outcome.handled);
  assert(
    outcome.response.includes("disabled"),
    `response = ${outcome.response}, want an explicit skip reason`,
  );
  assert(Deno.statSync(aged), "a disabled policy still reclaimed storage");
});

Deno.test("MaintenancePolicyFromSettings", () => {
  const fromNil = MaintenancePolicyFromSettings(undefined);
  assert(
    fromNil.reclaimAttachmentStorage === true &&
      fromNil.storageReconcileSchedule === MaintenanceStorageReconcileSchedule,
    "nil settings policy should be the default",
  );

  const empty = MaintenancePolicyFromSettings({});
  assert(
    empty.reclaimAttachmentStorage === true &&
      empty.storageReconcileSchedule === MaintenanceStorageReconcileSchedule,
    "empty settings policy should be enabled on the default cadence",
  );

  const off = MaintenancePolicyFromSettings({
    maintenance: { reclaimAttachmentStorage: false },
  });
  assert(
    !off.reclaimAttachmentStorage,
    "explicit false should disable reclamation",
  );

  const override = MaintenancePolicyFromSettings({
    maintenance: { storageReconcileSchedule: "  @every 6h  " },
  });
  assert(
    override.storageReconcileSchedule === "@every 6h" &&
      override.reclaimAttachmentStorage,
    "schedule override should trim the cadence and keep reclamation enabled",
  );
});

Deno.test("RunMaintenanceCronJobReclaimsAgedAttachmentStorage", async () => {
  const root = makeSessionRoot();
  const policy = defaultAttachmentPolicy();
  const aged = writeArtifactDirectory(
    root,
    "6123456789abcdef",
    policy.retention + ReconcileGraceMs + 3_600_000,
    "stale",
  );

  const outcome = await RunMaintenanceCronJob(
    root,
    MaintenanceStorageReconcileJobID(),
    DefaultMaintenancePolicy(),
  );
  assert(outcome.handled);
  assert(
    outcome.response.includes(
      "reclaimed 1 unreferenced attachment directories",
    ),
    `response = ${outcome.response}, want the reclaimed count`,
  );
  let exists = true;
  try {
    Deno.statSync(aged);
  } catch {
    exists = false;
  }
  assert(!exists, "the scheduled pass did not remove the aged artifact");

  const dir = `${root}/${ArtifactStorageDirectoryName()}/6123456789abcdef`;
  let dirExists = true;
  try {
    Deno.statSync(dir);
  } catch {
    dirExists = false;
  }
  assert(!dirExists, "the artifact directory survived");
  closeDatabases();
});

Deno.test("IsMaintenanceCronJobIDMatchesPrefixOnly", () => {
  assert(IsMaintenanceCronJobID(MaintenanceStorageReconcileJobID()));
  assert(IsMaintenanceCronJobID(MaintenanceCronJobPrefix + "anything"));
  assert(!IsMaintenanceCronJobID("cron-user"));
});
