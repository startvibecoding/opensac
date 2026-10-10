import { runtime } from "../platform/runtime.ts";
import { assert, assertRejects } from "../compat/assert.ts";
import { defaultAttachmentPolicy } from "./attachment.ts";
import {
  defaultMaintenancePolicy,
  isMaintenanceCronJobID,
  MAINTENANCE_CRON_JOB_PREFIX,
  MAINTENANCE_STORAGE_RECONCILE_SCHEDULE,
  maintenancePolicyFromSettings,
  maintenanceStorageReconcileJobID,
  runMaintenanceCronJob,
} from "./maintenance_cron.ts";
import {
  artifactStorageDirectoryName,
  RECONCILE_GRACE_MS,
} from "./storage_reconcile.ts";
import { createManager } from "../session/manager.ts";
import { closeDatabases } from "../session/root_db.ts";
import { test } from "#testing";

function makeSessionRoot(): string {
  const root = runtime.makeTempDirSync({ prefix: "opensac-maint-" });
  const workDir = runtime.makeTempDirSync({ prefix: "opensac-maint-work-" });
  const manager = createManager(workDir, root);
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
  const dir = `${sessionDir}/${artifactStorageDirectoryName()}/${id}`;
  runtime.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/content`;
  runtime.writeTextFileSync(path, content, { mode: 0o600 });
  const stamp = new Date(Date.now() - ageMs);
  runtime.utimeSync(path, stamp, stamp);
  runtime.utimeSync(dir, stamp, stamp);
  return path;
}

test("RunMaintenanceCronJobClaimsTheWholeNamespace", async () => {
  const policy = defaultMaintenancePolicy();
  const outside = await runMaintenanceCronJob(
    makeSessionRoot(),
    "knowledge-base-index:abc",
    policy,
  );
  assert(!outside.handled, "the maintenance path claimed a foreign job");

  const unknown = (await assertRejects(() =>
    runMaintenanceCronJob(
      makeSessionRoot(),
      MAINTENANCE_CRON_JOB_PREFIX + "unknown-task",
      policy,
    ),
  )) as Error;
  assert(
    unknown.message.includes("unknown maintenance job"),
    `unknown maintenance job error = ${unknown.message}, want a refusal`,
  );

  await assertRejects(() =>
    runMaintenanceCronJob("", maintenanceStorageReconcileJobID(), policy),
  );
});

test("RunMaintenanceCronJobHonorsTheDisabledPolicy", async () => {
  const root = makeSessionRoot();
  const policy = defaultAttachmentPolicy();
  const aged = writeArtifactDirectory(
    root,
    "7123456789abcdef",
    policy.retention + RECONCILE_GRACE_MS + 3_600_000,
    "stale",
  );

  const outcome = await runMaintenanceCronJob(
    root,
    maintenanceStorageReconcileJobID(),
    { reclaimAttachmentStorage: false, storageReconcileSchedule: "" },
  );
  assert(outcome.handled);
  assert(
    outcome.response.includes("disabled"),
    `response = ${outcome.response}, want an explicit skip reason`,
  );
  assert(runtime.statSync(aged), "a disabled policy still reclaimed storage");
});

test("maintenancePolicyFromSettings", () => {
  const fromNil = maintenancePolicyFromSettings(undefined);
  assert(
    fromNil.reclaimAttachmentStorage === true &&
      fromNil.storageReconcileSchedule ===
        MAINTENANCE_STORAGE_RECONCILE_SCHEDULE,
    "nil settings policy should be the default",
  );

  const empty = maintenancePolicyFromSettings({});
  assert(
    empty.reclaimAttachmentStorage === true &&
      empty.storageReconcileSchedule === MAINTENANCE_STORAGE_RECONCILE_SCHEDULE,
    "empty settings policy should be enabled on the default cadence",
  );

  const off = maintenancePolicyFromSettings({
    maintenance: { reclaimAttachmentStorage: false },
  });
  assert(
    !off.reclaimAttachmentStorage,
    "explicit false should disable reclamation",
  );

  const override = maintenancePolicyFromSettings({
    maintenance: { storageReconcileSchedule: "  @every 6h  " },
  });
  assert(
    override.storageReconcileSchedule === "@every 6h" &&
      override.reclaimAttachmentStorage,
    "schedule override should trim the cadence and keep reclamation enabled",
  );
});

test("RunMaintenanceCronJobReclaimsAgedAttachmentStorage", async () => {
  const root = makeSessionRoot();
  const policy = defaultAttachmentPolicy();
  const aged = writeArtifactDirectory(
    root,
    "6123456789abcdef",
    policy.retention + RECONCILE_GRACE_MS + 3_600_000,
    "stale",
  );

  const outcome = await runMaintenanceCronJob(
    root,
    maintenanceStorageReconcileJobID(),
    defaultMaintenancePolicy(),
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
    runtime.statSync(aged);
  } catch {
    exists = false;
  }
  assert(!exists, "the scheduled pass did not remove the aged artifact");

  const dir = `${root}/${artifactStorageDirectoryName()}/6123456789abcdef`;
  let dirExists = true;
  try {
    runtime.statSync(dir);
  } catch {
    dirExists = false;
  }
  assert(!dirExists, "the artifact directory survived");
  closeDatabases();
});

test("IsMaintenanceCronJobIDMatchesPrefixOnly", () => {
  assert(isMaintenanceCronJobID(maintenanceStorageReconcileJobID()));
  assert(isMaintenanceCronJobID(MAINTENANCE_CRON_JOB_PREFIX + "anything"));
  assert(!isMaintenanceCronJobID("cron-user"));
});
