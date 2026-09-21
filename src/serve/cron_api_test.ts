// Translated from internal/serve/cron_maintenance_test.go

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cronMaintenancePolicy, ServeCronState } from "./cron_api.ts";
import {
  MaintenanceStorageReconcileSchedule,
} from "../agentruntime/maintenance_cron.ts";
import { saveGlobalSettingsPatch } from "../config/settings.ts";
import { defaultServeConfig, type ServeConfig } from "./config.ts";

// Closes the last seam of the maintenance switch: serve resolves the policy it
// hands the scheduler from the operator's settings.json, so the projection and
// the execution check agree with what the user configured rather than with a
// serve-side default.
Deno.test("cron maintenance policy reads global settings", async () => {
  const globalDir = join(await Deno.makeTempDir(), "global");
  Deno.env.set("OPENSAC_DIR", globalDir);
  try {
    const policy = cronMaintenancePolicy();
    assertEquals(
      JSON.stringify(policy),
      JSON.stringify({
        reclaimAttachmentStorage: true,
        storageReconcileSchedule: MaintenanceStorageReconcileSchedule,
      }),
      "default policy must enable reclamation on the Runtime cadence",
    );

    saveGlobalSettingsPatch({
      maintenance: {
        reclaimAttachmentStorage: false,
        storageReconcileSchedule: "@every 6h",
      },
    });
    const updated = cronMaintenancePolicy();
    assertEquals(updated.reclaimAttachmentStorage, false);
    assertEquals(updated.storageReconcileSchedule, "@every 6h");
  } finally {
    Deno.env.delete("OPENSAC_DIR");
  }
});

// Focused handler coverage for the ported cron.go surface (the Go handler
// tests sit behind the unported channelRuntime and land with the run.go slice,
// so these pin the request/response contract now).
Deno.test("cron api create list update delete round trip", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const cfg: ServeConfig = defaultServeConfig();
    cfg.features.cron = true;
    cfg.api.defaultWorkDir = await Deno.makeTempDir();
    const state = new ServeCronState({
      sessionDir,
      configSnapshot: () => cfg,
    });

    const create = await state.handleCron(
      new Request("http://s/api/cron?sessionId=sess-1", {
        method: "POST",
        body: JSON.stringify({ name: "nightly", prompt: "run it" }),
      }),
    );
    assertEquals(create.status, 201);
    const { job } = await create.json() as { job: Record<string, unknown> };
    assertEquals(job["name"], "nightly");
    assertEquals(job["mode"], "yolo");
    assertEquals(job["enabled"], true);
    const id = job["id"] as string;

    const status = await state.handleCron(
      new Request("http://s/api/cron?sessionId=sess-1", { method: "GET" }),
    );
    assertEquals(status.status, 200);
    const body = await status.json() as {
      enabled: boolean;
      running: boolean;
      path?: string;
      jobs: Record<string, unknown>[];
    };
    assertEquals(body.enabled, true);
    assertEquals(body.running, false);
    assertEquals(body.path, join(sessionDir, "sessions.db"));
    assertEquals(body.jobs.length, 1);

    const update = await state.handleCronByID(
      new Request(`http://s/api/cron/${id}?sessionId=sess-1`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", mode: "agent" }),
      }),
    );
    assertEquals(update.status, 200);
    assertEquals(
      ((await update.json()) as { job: Record<string, unknown> }).job["name"],
      "renamed",
    );

    // Cross-session update is a scoped 404.
    const scopedMiss = await state.handleCronByID(
      new Request(`http://s/api/cron/${id}?sessionId=sess-2`, {
        method: "PATCH",
        body: JSON.stringify({ name: "x" }),
      }),
    );
    assertEquals(scopedMiss.status, 404);

    const del = await state.handleCronByID(
      new Request(`http://s/api/cron/${id}?sessionId=sess-1`, {
        method: "DELETE",
      }),
    );
    assertEquals(del.status, 200);
    assertEquals(await del.json(), { id, deleted: true });
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cron api validates body, session, and disabled state", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const cfg: ServeConfig = defaultServeConfig();
    cfg.features.cron = true;
    const state = new ServeCronState({
      sessionDir,
      configSnapshot: () => cfg,
    });

    const badBody = await state.handleCron(
      new Request("http://s/api/cron", { method: "POST", body: "not json" }),
    );
    assertEquals(badBody.status, 400);

    const noSession = await state.handleCron(
      new Request("http://s/api/cron", {
        method: "POST",
        body: JSON.stringify({ name: "n", prompt: "p" }),
      }),
    );
    assertEquals(noSession.status, 400);

    const disabled = new ServeCronState({
      sessionDir,
      configSnapshot: () => null,
    });
    const forbidden = await disabled.handleCron(
      new Request("http://s/api/cron?sessionId=s", {
        method: "POST",
        body: "{}",
      }),
    );
    assertEquals(forbidden.status, 403);

    const method = await state.handleCronByID(
      new Request("http://s/api/cron/x?sessionId=s", { method: "GET" }),
    );
    assertEquals(method.status, 405);
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});
