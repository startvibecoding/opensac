// Ported from internal/serve/cron.go
//
// The cron management HTTP surface. The Go `*channelRuntime` receiver maps to
// the `ServeCronState` component: it owns the cron half of the runtime struct
// (cronMu/cronStore/cronStorePath/cronScheduler) plus the config snapshot
// callback, and the run.go slice composes it instead of reimplementing these
// handlers. Deviations: `context.Context` maps to the Request (handlers do no
// long-running I/O); `writeJSON` maps to the shared `writeJson` helper;
// `time.Time{}` maps to `null`; the sync Go `Scheduler.Stop` maps to a
// fire-and-forget async `stop()`; JSON decode uses `Request.json`.

import { join } from "@std/path";
import {
  type CronJob,
  type CronStore,
  newSessionScopedStore,
  parseSchedule,
  userVisibleJobs,
} from "../cron/mod.ts";
import type { Scheduler } from "../cron/mod.ts";
import { newSQLiteCronStore } from "../cron/mod.ts";
import {
  DefaultMaintenancePolicy,
  type MaintenancePolicy,
  MaintenancePolicyFromSettings,
  MaintenanceStorageReconcileSchedule,
} from "../agentruntime/maintenance_cron.ts";
import { loadSettings } from "../config/settings.ts";
import { getWorkDir, validateWorkDir } from "../serve/openaiapi/config.ts";
import type { ServeConfig } from "./config.ts";
import { openByIDExact } from "../session/manager.ts";
import { isWithinPath } from "../util/path.ts";
import { writeJson } from "./http.ts";

/**
 * cronMaintenancePolicy resolves the Runtime maintenance policy from the
 * current global settings so serve projects the operator's cadence and on/off
 * choice. An unreadable settings file keeps the Runtime default, which is
 * safe: the reconciliation is bounded by the attachment retention window and
 * fails closed when the durable reference set cannot be read.
 */
export function cronMaintenancePolicy(): MaintenancePolicy {
  try {
    return MaintenancePolicyFromSettings(loadSettings());
  } catch (err) {
    console.error(
      `[serve] load settings for the cron maintenance policy: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return DefaultMaintenancePolicy();
  }
}

export interface CronAPIResponse {
  enabled: boolean;
  running: boolean;
  path?: string;
  jobs: CronJob[];
}

export interface CronJobRequest {
  sessionId?: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  oneShot?: boolean;
  mode?: string;
  workDir?: string;
  a2aTarget?: string;
  a2aToken?: string;
  enabled?: boolean;
}

/**
 * Owns the cron half of the Go `channelRuntime` struct. `configSnapshot` is
 * the runtime's live serve-config accessor; `dispatcher` is the optional
 * channel dispatcher the scheduler is published to.
 */
export class ServeCronState {
  sessionDir: string;
  configSnapshot: () => ServeConfig | null;
  dispatcher: {
    setCronScheduler(s: Scheduler | null): void;
  } | null;
  cronStore: CronStore | null = null;
  cronStorePath = "";
  cronScheduler: Scheduler | null = null;

  constructor(opts: {
    sessionDir: string;
    configSnapshot: () => ServeConfig | null;
    dispatcher?: { setCronScheduler(s: Scheduler | null): void } | null;
  }) {
    this.sessionDir = opts.sessionDir;
    this.configSnapshot = opts.configSnapshot;
    this.dispatcher = opts.dispatcher ?? null;
  }

  handleCron(request: Request): Promise<Response> {
    switch (request.method) {
      case "GET":
        return this.writeCronStatus(request);
      case "POST":
        return this.handleCronCreate(request);
      default:
        return Promise.resolve(new Response(null, { status: 405 }));
    }
  }

  handleCronByID(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const id = path.startsWith("/api/cron/")
      ? path.slice("/api/cron/".length).replace(/^\/+|\/+$/g, "")
      : path;
    if (id === "") {
      return Promise.resolve(
        writeJson(() => {}, 400, { error: "cron job ID required" }),
      );
    }
    switch (request.method) {
      case "PATCH":
      case "PUT":
        return this.handleCronUpdate(request, id);
      case "DELETE":
        return this.handleCronDelete(request, id);
      default:
        return Promise.resolve(new Response(null, { status: 405 }));
    }
  }

  async writeCronStatus(request: Request): Promise<Response> {
    let jobs: CronJob[];
    try {
      jobs = await this.listCronJobs(cronSessionIDFromRequest(request, {}));
    } catch (err) {
      return writeJson(() => {}, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const publicJobs = jobs.map((job) => publicCronJob(job));
    return writeJson(
      () => {},
      200,
      {
        enabled: this.cronEnabled(),
        running: this.cronRunning(),
        path: this.cronPath() || undefined,
        jobs: publicJobs,
      } satisfies CronAPIResponse,
    );
  }

  async handleCronCreate(request: Request): Promise<Response> {
    const store = this.ensureCronStore();
    if (store === null) {
      return writeJson(() => {}, 403, { error: "cron is disabled" });
    }
    let req: CronJobRequest;
    try {
      req = await request.json() as CronJobRequest;
    } catch {
      return writeJson(() => {}, 400, { error: "invalid JSON body" });
    }
    if (req.name === undefined || req.name.trim() === "") {
      return writeJson(() => {}, 400, { error: "name is required" });
    }
    if (req.prompt === undefined || req.prompt.trim() === "") {
      return writeJson(() => {}, 400, { error: "prompt is required" });
    }
    const sessionId = cronSessionIDFromRequest(request, req);
    if (sessionId === "") {
      return writeJson(() => {}, 400, { error: "sessionId is required" });
    }
    const job: CronJob = {
      sessionId,
      name: req.name.trim(),
      prompt: req.prompt,
      enabled: true,
      mode: "yolo",
      workDir: this.cronWorkDirForSession(sessionId),
      schedule: "",
    };
    if (req.enabled !== undefined) job.enabled = req.enabled;
    if (req.mode !== undefined && req.mode.trim() !== "") {
      job.mode = req.mode.trim();
    }
    if (req.workDir !== undefined && req.workDir.trim() !== "") {
      job.workDir = req.workDir.trim();
    }
    try {
      await this.validateCronWorkDir(job.workDir ?? "");
    } catch (err) {
      return writeJson(() => {}, 403, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (req.schedule !== undefined) job.schedule = req.schedule.trim();
    if (req.oneShot !== undefined) job.oneShot = req.oneShot;
    if (req.a2aTarget !== undefined) job.a2aTarget = req.a2aTarget.trim();
    if (req.a2aToken !== undefined) job.a2aToken = req.a2aToken.trim();
    try {
      normalizeCronJobSchedule(job);
    } catch (err) {
      return writeJson(() => {}, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let created: CronJob;
    try {
      created = store.create(job);
    } catch (err) {
      return writeJson(() => {}, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return writeJson(() => {}, 201, { job: publicCronJob(created) });
  }

  async handleCronUpdate(request: Request, id: string): Promise<Response> {
    const baseStore = this.ensureCronStore();
    if (baseStore === null) {
      return writeJson(() => {}, 403, { error: "cron is disabled" });
    }
    let req: CronJobRequest;
    try {
      req = await request.json() as CronJobRequest;
    } catch {
      return writeJson(() => {}, 400, { error: "invalid JSON body" });
    }
    const sessionId = cronSessionIDFromRequest(request, req);
    if (sessionId === "") {
      return writeJson(() => {}, 400, { error: "sessionId is required" });
    }
    const store = newSessionScopedStore(baseStore, sessionId);
    let job: CronJob;
    try {
      job = store.get(id);
    } catch (err) {
      return writeJson(() => {}, 404, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (req.name !== undefined) job.name = req.name.trim();
    if (req.prompt !== undefined) job.prompt = req.prompt;
    if (req.schedule !== undefined) job.schedule = req.schedule.trim();
    if (req.oneShot !== undefined) job.oneShot = req.oneShot;
    if (req.mode !== undefined) job.mode = req.mode.trim();
    if (req.workDir !== undefined) job.workDir = req.workDir.trim();
    try {
      await this.validateCronWorkDir(job.workDir ?? "");
    } catch (err) {
      return writeJson(() => {}, 403, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (req.a2aTarget !== undefined) job.a2aTarget = req.a2aTarget.trim();
    if (req.a2aToken !== undefined) job.a2aToken = req.a2aToken.trim();
    if (req.enabled !== undefined) job.enabled = req.enabled;
    if (
      req.sessionId !== undefined && req.sessionId.trim() !== "" &&
      req.sessionId.trim() !== sessionId
    ) {
      return writeJson(() => {}, 404, {
        error: "cron job not found in this session",
      });
    }
    if ((job.name ?? "").trim() === "") {
      return writeJson(() => {}, 400, { error: "name is required" });
    }
    if ((job.prompt ?? "").trim() === "") {
      return writeJson(() => {}, 400, { error: "prompt is required" });
    }
    try {
      normalizeCronJobSchedule(job);
    } catch (err) {
      return writeJson(() => {}, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      store.update(job);
    } catch (err) {
      return writeJson(() => {}, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return writeJson(() => {}, 200, { job: publicCronJob(job) });
  }

  handleCronDelete(request: Request, id: string): Promise<Response> {
    const baseStore = this.ensureCronStore();
    if (baseStore === null) {
      return Promise.resolve(
        writeJson(() => {}, 403, { error: "cron is disabled" }),
      );
    }
    const sessionId = cronSessionIDFromRequest(request, {});
    if (sessionId === "") {
      return Promise.resolve(
        writeJson(() => {}, 400, { error: "sessionId is required" }),
      );
    }
    const store = newSessionScopedStore(baseStore, sessionId);
    try {
      store.delete(id);
    } catch (err) {
      return Promise.resolve(writeJson(() => {}, 404, {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return Promise.resolve(writeJson(() => {}, 200, { id, deleted: true }));
  }

  listCronJobs(sessionId: string): Promise<CronJob[]> {
    const store = this.ensureCronStore();
    if (store === null) return Promise.resolve([]);
    const scoped = sessionId !== ""
      ? newSessionScopedStore(store, sessionId)
      : store;
    // Runtime-owned maintenance jobs are scheduled housekeeping, not user
    // automations, so the Web UI cron view never renders them.
    const jobs = userVisibleJobs(scoped.list());
    return Promise.resolve(jobs.sort((a, b) => {
      const at = goTimeMs(a.createdAt);
      const bt = goTimeMs(b.createdAt);
      if (at === bt) return (a.id ?? "") < (b.id ?? "") ? -1 : 1;
      return bt - at;
    }));
  }

  ensureCronStore(): CronStore | null {
    if (!this.cronEnabled()) return null;
    const nextPath = join(this.sessionDir, "sessions.db");
    if (this.cronStore === null || this.cronStorePath !== nextPath) {
      this.stopCronSchedulerLocked();
      this.cronStorePath = nextPath;
      this.cronStore = newSQLiteCronStore(this.sessionDir);
    }
    return this.cronStore;
  }

  cronEnabled(): boolean {
    const cfg = this.configSnapshot();
    return cfg !== null && cfg.features.cron;
  }

  cronPath(): string {
    if (this.cronStorePath !== "") return this.cronStorePath;
    if (this.configSnapshot() === null) return "";
    return join(this.sessionDir, "sessions.db");
  }

  cronRunning(): boolean {
    return this.cronScheduler !== null && this.cronScheduler.isRunning();
  }

  cronWorkDirForSession(sessionId: string): string {
    if (sessionId !== "" && this.sessionDir !== "") {
      try {
        const mgr = openByIDExact(this.sessionDir, sessionId);
        const header = mgr.getHeader();
        if (header !== null && header.cwd !== "") return header.cwd;
      } catch {
        // Fall through to the configured default.
      }
    }
    const cfg = this.configSnapshot();
    if (cfg !== null) return apiWorkDir(cfg);
    return "";
  }

  validateCronWorkDir(workDir: string): Promise<void> {
    if (workDir.trim() === "") return Promise.resolve();
    const cfg = this.configSnapshot();
    if (cfg === null) return Promise.resolve();
    if (cfg.api.allowedWorkDirs !== undefined) {
      // APIConfig.ValidateWorkDir only reads AllowedWorkDirs; the dedicated
      // openaiapi helper keeps the exact Go error strings.
      return validateWorkDir(
        { allowedWorkDirs: cfg.api.allowedWorkDirs },
        workDir,
      );
    }
    if (cfg.security.allowedWorkDirs.length === 0) return Promise.resolve();
    return (async () => {
      for (const allowed of cfg.security.allowedWorkDirs) {
        if (await isWithinPath(allowed, workDir)) return;
      }
      throw new Error(
        `working directory ${workDir} not in allowed_work_dirs`,
      );
    })();
  }

  /** Mirrors run.go's stopCronSchedulerLocked for store rotations. */
  stopCronSchedulerLocked(): void {
    if (this.cronScheduler !== null) {
      const scheduler = this.cronScheduler;
      this.cronScheduler = null;
      void scheduler.stop().catch(() => {});
    }
    if (this.dispatcher !== null) {
      this.dispatcher.setCronScheduler(null);
    }
  }
}

/** Go's time.Time zero value in epoch milliseconds (year 1). */
function goTimeMs(t: Date | null | undefined): number {
  if (t === null || t === undefined || Number.isNaN(t.getTime())) {
    return -62135596800000;
  }
  return t.getTime();
}

/** The effective API working directory (Go cfg.API.GetWorkDir). */
function apiWorkDir(cfg: ServeConfig): string {
  return getWorkDir({
    defaultWorkDir: cfg.api.defaultWorkDir,
    workingDir: cfg.api.workingDir,
  });
}

export function cronSessionIDFromRequest(
  request: Request | null,
  req: CronJobRequest,
): string {
  if (req.sessionId !== undefined) return req.sessionId.trim();
  if (request === null) return "";
  return (new URL(request.url).searchParams.get("sessionId") ?? "").trim();
}

/** Normalizes mode and resolves the next run for the persisted schedule. */
export function normalizeCronJobSchedule(job: CronJob): void {
  if (job === undefined || job === null) {
    throw new Error("cron job required");
  }
  if ((job.mode ?? "") === "") job.mode = "yolo";
  if (job.mode !== "agent" && job.mode !== "yolo") {
    throw new Error("mode must be agent or yolo");
  }
  const { next, isOneShot } = parseSchedule(job.schedule ?? "", new Date());
  if (job.oneShot || isOneShot) {
    job.oneShot = true;
    job.nextRun = null;
    return;
  }
  job.nextRun = next;
}

/** Strips the A2A bearer token from the operator-facing projection. */
export function publicCronJob(job: CronJob): CronJob {
  return { ...job, a2aToken: undefined };
}

// Re-exported for the scheduler-wiring slice and tests.
export { MaintenanceStorageReconcileSchedule };
