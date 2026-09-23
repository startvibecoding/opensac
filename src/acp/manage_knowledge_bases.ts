// (the knowledge-base
// family of the `opensac/manage/*` Phase 3 management plane) together with the
// knowledge-base schedule projection from manage.go (`syncKnowledgeBaseSchedule`
// and the in-process cron runtime it lazily starts).
//
// The knowledge-base management RPCs project Runtime/session owned state. They
// deliberately do not expose graph tables or source files wholesale: query is
// a bounded preview endpoint, while normal Desktop prompts use the Runtime
// input contract.
//
// Deviations from Go: `json.RawMessage` params are already-decoded JSON;
// `context.Background()` maps to an `undefined` `AbortSignal`; Go's
// `sync.Mutex` guards drop because Deno is single-threaded; Go's `(value,
// error)` pairs throw typed `Error`s; and `os.Executable()` maps to the
// current-process path from `Deno.execPath()` with the Go `opensac` fallback.

import { acpStructuredRPCError } from "./projection.ts";
import type { ACPRPCRequest } from "./wire.ts";
import { RPCError } from "../mcp/rpc.ts";
import type { AcpServer } from "./server.ts";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  getKnowledgeSnapshot,
  type KnowledgeBase,
  KnowledgeBaseNotFoundError,
  type KnowledgeBaseSpec,
  KnowledgeBaseUnindexedError,
  type KnowledgeSnapshot,
  listKnowledgeBases,
  updateKnowledgeBase,
} from "../session/knowledge_bases.ts";
import {
  createKnowledgeBaseService,
  defaultKnowledgeBaseIndexPolicy,
  KnowledgeBaseService,
} from "../agentruntime/knowledgebase.ts";
import type { KnowledgeIndexProgress } from "../agentruntime/knowledge_index_job.ts";
import {
  knowledgeBaseCronJobID,
  knowledgeBaseIDFromCronJobID,
  runKnowledgeBaseCronJob,
} from "../agentruntime/knowledge_cron.ts";
import { SOURCE_ACP as SourceACPValue } from "../agentruntime/source.ts";
import { normalizeJobSchedule, parseSchedule } from "../cron/schedule.ts";
import type { CronJob, CronStore } from "../cron/cron.ts";
import { createSQLiteCronStore } from "../cron/sqlite_store.ts";
import {
  createScheduler,
  JobAlreadyRunningError,
  Scheduler,
} from "../cron/scheduler.ts";
import { userVisibleJobs } from "../cron/maintenance.ts";
import { createAgentManager } from "../agentruntime/agent_manager.ts";
import { maintenancePolicyFromSettings } from "../agentruntime/maintenance_cron.ts";
import { getSessionDir } from "../config/mod.ts";
import {
  defaultProviderConfig,
  getProviderConfig,
  normalizeMCPConfig,
  saveMCPConfig,
} from "../config/mod.ts";
import type { MCPServer } from "../config/mcp.ts";
import { globalMCPPath, loadMCPConfig, type MCPConfig } from "../config/mcp.ts";
import { resolvedModels } from "../provider/factory/mod.ts";
import {
  manageDecodeOptionalBool,
  manageDecodeOptionalString,
  manageDecodeWhitelist,
  manageSettings,
  manageWorkDir,
} from "./manage.ts";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── request/view shapes ─────────────────────────────────────────────────────

interface ManageKnowledgeBaseMutation {
  name?: string;
  rootDir?: string;
  preprocessProfile?: string;
  provider?: string;
  model?: string;
  mode?: string;
  thinkingLevel?: string;
  schedule?: string;
  enabled?: boolean;
}

interface ManageKnowledgeBaseCreateRequest {
  knowledgeBase?: ManageKnowledgeBaseMutation;
}

interface ManageKnowledgeBaseUpdateRequest {
  id?: string;
  knowledgeBase?: ManageKnowledgeBaseMutation;
}

interface ManageKnowledgeBaseQueryRequest {
  id?: string;
  query?: string;
  limit?: number;
}

interface ManageKnowledgeBaseMCPApplyRequest {
  id?: string;
  enabled?: boolean;
}

export interface ManageKnowledgeIndexView {
  running: boolean;
  phase?: string;
  filesTotal: number;
  filesDone: number;
  chunks: number;
  startedAt?: string;
  runId?: string;
  error?: string;
}

interface ManageKnowledgeBaseView {
  knowledgeBase: KnowledgeBase;
  snapshot: KnowledgeSnapshot | null;
  status: string;
  indexing?: ManageKnowledgeIndexView;
}

function mutationToSpec(
  m: ManageKnowledgeBaseMutation,
): KnowledgeBaseSpec {
  return {
    name: m.name ?? "",
    rootDir: m.rootDir ?? "",
    preprocessProfile: m.preprocessProfile ?? "",
    provider: m.provider ?? "",
    model: m.model ?? "",
    mode: m.mode ?? "",
    thinkingLevel: m.thinkingLevel ?? "",
    schedule: m.schedule ?? "",
    enabled: m.enabled ?? true,
  };
}

function manageKnowledgeIndexViewFrom(
  progress: KnowledgeIndexProgress,
): ManageKnowledgeIndexView {
  const view: ManageKnowledgeIndexView = {
    running: progress.running,
    filesTotal: progress.filesTotal,
    filesDone: progress.filesDone,
    chunks: progress.chunks,
  };
  if (progress.phase) view.phase = progress.phase;
  if (progress.startedAt) view.startedAt = progress.startedAt.toISOString();
  if (progress.runId) view.runId = progress.runId;
  if (progress.error) view.error = progress.error;
  return view;
}

// ─── cached Runtime service ──────────────────────────────────────────────────

/**
 * Returns the process-wide cached Runtime service. Caching matters: the
 * service owns the background index-job registry, so a fresh instance per RPC
 * would hide a running scan from progress polling and let duplicate scan
 * requests start parallel jobs.
 */
export function manageKnowledgeBaseService(
  s: AcpServer,
): KnowledgeBaseService {
  if (s === null || s.settings === null) {
    throw new Error("knowledge base runtime is unavailable");
  }
  if (s.knowledgeService !== null) return s.knowledgeService;
  const service = createKnowledgeBaseService(
    getSessionDir(s.settings),
    defaultKnowledgeBaseIndexPolicy(),
    s.settings,
  );
  s.knowledgeService = service;
  return service;
}

export function knowledgeBaseMCPServerName(id: string): string {
  return "knowledge-" + id.trim();
}

function knowledgeBaseMCPCommand(): string {
  try {
    const command = Deno.execPath().trim();
    if (command !== "") return command;
  } catch {
    // fall through to the default
  }
  return "opensac";
}

// ─── schedule projection ─────────────────────────────────────────────────────

export function knowledgeBaseIDFromCronJob(
  job: CronJob,
): string | undefined {
  return knowledgeBaseIDFromCronJobID(job.id ?? "");
}

/**
 * Projects the persisted knowledge-base cadence onto the shared Cron store. It
 * owns no scheduler state: Cron remains the sole lifecycle owner for claims,
 * recovery, terminal status and next-run calculation.
 */
export function syncKnowledgeBaseSchedule(
  s: AcpServer,
  base: KnowledgeBase,
): void {
  const { enabled } = normalizeKnowledgeBaseSchedule(
    base.schedule ?? "",
    base.enabled,
  );
  // A manual/disabled base has no persisted cron projection to create. Keep
  // offline management fixtures and one-shot scans usable when an ACP host
  // has not initialized its long-running scheduler yet.
  if (!enabled) {
    const store = s.cronStore;
    if (store === null) return;
    syncKnowledgeBaseScheduleWithStore(store, base);
    return;
  }
  const { store } = ensureManageCron(s);
  syncKnowledgeBaseScheduleWithStore(store, base);
}

export function syncKnowledgeBaseScheduleWithStore(
  store: CronStore | null,
  base: KnowledgeBase,
): void {
  if (store === null) {
    throw new Error("knowledge base cron store is unavailable");
  }
  const jobID = knowledgeBaseCronJobID(base.id);
  const { schedule, enabled } = normalizeKnowledgeBaseSchedule(
    base.schedule ?? "",
    base.enabled,
  );
  if (!enabled) {
    try {
      store.delete(jobID);
    } catch (err) {
      if (!errorMessage(err).includes("not found")) {
        throw new Error(
          `remove knowledge base schedule: ${errorMessage(err)}`,
        );
      }
    }
    return;
  }
  const job: CronJob = {
    id: jobID,
    name: "Knowledge base: " + base.name,
    prompt: "Reindex the Desktop knowledge base " + base.id + ".",
    schedule,
    mode: "yolo",
    workDir: base.rootDir,
    enabled: true,
  };
  let existing: CronJob | null = null;
  try {
    existing = store.get(jobID);
  } catch (err) {
    if (!errorMessage(err).includes("not found")) {
      throw new Error(`load knowledge base schedule: ${errorMessage(err)}`);
    }
  }
  let normalized: CronJob;
  if (existing !== null) {
    job.createdAt = existing.createdAt ?? null;
    job.lastRun = existing.lastRun ?? null;
    job.nextRun = existing.nextRun ?? null;
    job.runCount = existing.runCount ?? 0;
    job.lastStatus = existing.lastStatus ?? "";
    job.lastError = existing.lastError ?? "";
    try {
      normalized = normalizeJobSchedule(job);
    } catch (err) {
      throw new Error(
        `normalize knowledge base schedule: ${errorMessage(err)}`,
      );
    }
    store.update(normalized);
    return;
  }
  store.create(normalizeJobSchedule(job));
}

export function normalizeKnowledgeBaseSchedule(
  valueInput: string,
  baseEnabled: boolean,
): { schedule: string; enabled: boolean } {
  const value = valueInput.trim().toLowerCase();
  if (
    !baseEnabled || value === "" || value === "manual" || value === "off" ||
    value === "disabled"
  ) {
    return { schedule: "", enabled: false };
  }
  switch (value) {
    case "hourly":
      return { schedule: "@hourly", enabled: true };
    case "daily":
      return { schedule: "@daily", enabled: true };
    case "weekly":
      return { schedule: "@weekly", enabled: true };
    case "monthly":
      return { schedule: "@monthly", enabled: true };
  }
  try {
    parseSchedule(value, new Date());
  } catch (err) {
    throw new Error(
      `invalid knowledge base schedule: ${errorMessage(err)}`,
    );
  }
  return { schedule: value, enabled: true };
}

export function removeKnowledgeBaseSchedule(s: AcpServer, id: string): void {
  const store = s.cronStore;
  if (store === null) return;
  try {
    store.delete(knowledgeBaseCronJobID(id));
  } catch (err) {
    if (!errorMessage(err).includes("not found")) {
      throw new Error(`remove knowledge base schedule: ${errorMessage(err)}`);
    }
  }
}

/**
 * Called by the shared Scheduler only for its namespaced jobs. It delegates to
 * the Runtime-owned handler through the cached service, so scheduled scans
 * share one background-job registry with manual scans; Cron then records the
 * scheduling outcome and moves the next-run cursor.
 */
async function handleKnowledgeBaseCronJob(
  s: AcpServer,
  job: CronJob,
  _signal?: AbortSignal,
): Promise<{ handled: boolean; response: string; error: Error | null }> {
  if (knowledgeBaseIDFromCronJobID(job.id ?? "") === undefined) {
    return { handled: false, response: "", error: null };
  }
  let service: KnowledgeBaseService;
  try {
    service = manageKnowledgeBaseService(s);
  } catch (err) {
    return { handled: true, response: "", error: toError(err) };
  }
  try {
    const outcome = await runKnowledgeBaseCronJob(
      _signal,
      service,
      job.id ?? "",
    );
    return {
      handled: outcome.handled,
      response: outcome.response,
      error: null,
    };
  } catch (err) {
    return { handled: true, response: "", error: toError(err) };
  }
}

export function syncAllKnowledgeBaseSchedulesWithStore(
  s: AcpServer,
  store: CronStore,
): void {
  const bases = listKnowledgeBases(getSessionDir(s.settings!));
  const wanted = new Set<string>();
  for (const base of bases) {
    wanted.add(knowledgeBaseCronJobID(base.id));
    syncKnowledgeBaseScheduleWithStore(store, base);
  }
  for (const job of store.list()) {
    if (knowledgeBaseIDFromCronJob(job) === undefined) continue;
    if (!wanted.has(job.id ?? "")) {
      try {
        store.delete(job.id ?? "");
      } catch (err) {
        if (!errorMessage(err).includes("not found")) throw err;
      }
    }
  }
}

// ─── in-process cron runtime (manage.go §ensureManageCron) ───────────────────

const defaultManageCronIntervalMs = 30_000;

/** Resolves the ACP in-process scheduler tick (OPENSAC_ACP_CRON_INTERVAL). */
export function manageCronInterval(): number {
  const value = (Deno.env.get("OPENSAC_ACP_CRON_INTERVAL") ?? "").trim();
  if (value !== "") {
    const parsed = parseGoDurationMs(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return defaultManageCronIntervalMs;
}

/** Parses the subset of Go duration strings the env contract uses. */
function parseGoDurationMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "ns":
      return amount / 1e6;
    case "us":
    case "µs":
      return amount / 1e3;
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
  }
  return null;
}

/**
 * Idempotently starts the ACP in-process cron runtime: the shared SQLite store
 * plus the existing cron Scheduler driven by an AgentManager built through
 * the canonical agentruntime construction path.
 */
export function ensureManageCron(s: AcpServer): {
  scheduler: Scheduler;
  store: CronStore;
} {
  if (s.cronScheduler !== null && s.cronStore !== null) {
    return { scheduler: s.cronScheduler, store: s.cronStore };
  }
  if (
    s.settings === null || s.runtime === null || s.p === null || s.m === null
  ) {
    throw new Error("ACP cron runtime prerequisites are unavailable");
  }
  const settings = s.settings;
  const sessionDir = getSessionDir(settings);
  const store = createSQLiteCronStore(sessionDir);
  let manager = s.cronAgentMgr;
  if (manager === null) {
    manager = createAgentManager({
      runtime: s.runtime,
      provider: s.p,
      model: s.m,
      settings,
      providerName: s.providerName,
      allow: s.allow,
      multiAgentEnabled: true,
    });
    s.cronAgentMgr = manager;
  }
  const scheduler = createScheduler(
    store,
    manager,
    manageCronInterval(),
    sessionDir,
    (job, signal) => handleKnowledgeBaseCronJob(s, job, signal),
  );
  scheduler.setMaintenancePolicy(maintenancePolicyFromSettings(settings));
  // Reconcile schedules persisted by older Desktop processes before the
  // first tick.
  syncAllKnowledgeBaseSchedulesWithStore(s, store);
  scheduler.setJobCompletionObserver((job, _response, runErr) => {
    observeManageCronJob(s, job, runErr);
  });
  scheduler.start();
  s.cronScheduler = scheduler;
  s.cronStore = store;
  return { scheduler, store };
}

/** Stops the in-process scheduler at server shutdown. Idempotent. */
export function stopManageCron(s: AcpServer): void {
  const scheduler = s.cronScheduler;
  s.cronScheduler = null;
  if (scheduler !== null) void scheduler.stop();
}

/** Projects the additive cron_completed session event. */
function observeManageCronJob(
  s: AcpServer,
  job: CronJob,
  runErr: Error | null,
): void {
  const params: Record<string, unknown> = {
    event: "cron_completed",
    jobId: job.id ?? "",
    status: runErr === null ? "success" : "failed",
  };
  if (job.sessionId) params.sessionId = job.sessionId;
  s.notifyExtension("_opensac/session_event", params);
}

// ─── cron management handlers (manage.go §6.1) ───────────────────────────────

interface ManageCronJobView {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  oneshot: boolean;
  mode: string;
  enabled: boolean;
  runCount: number;
  lastStatus: string;
  sessionId?: string;
  workDir?: string;
  createdAt?: string;
  lastRun?: string;
  nextRun?: string;
  lastError?: string;
}

function manageCronJobView(job: CronJob): ManageCronJobView {
  const view: ManageCronJobView = {
    id: job.id ?? "",
    name: job.name ?? "",
    prompt: job.prompt ?? "",
    schedule: job.schedule ?? "",
    oneshot: job.oneShot ?? false,
    mode: job.mode ?? "",
    enabled: job.enabled ?? false,
    runCount: job.runCount ?? 0,
    lastStatus: job.lastStatus ?? "",
  };
  if (job.sessionId) view.sessionId = job.sessionId;
  if (job.workDir) view.workDir = job.workDir;
  if (job.createdAt) view.createdAt = job.createdAt.toISOString();
  if (job.lastRun) view.lastRun = job.lastRun.toISOString();
  if (job.nextRun) view.nextRun = job.nextRun.toISOString();
  if (job.lastError) view.lastError = job.lastError;
  return view;
}

const manageCronJobFields: Record<string, boolean> = {
  name: true,
  schedule: true,
  prompt: true,
  mode: true,
  enabled: true,
};

function manageCronIDFields(): Record<string, boolean> {
  return { ...manageCronJobFields, id: true };
}

/** Assembles and normalizes a job from whitelisted patch fields. */
function manageCronJobFromFields(
  base: CronJob,
  fields: Record<string, unknown>,
): CronJob {
  const job: CronJob = { ...base };
  if (Object.hasOwn(fields, "name")) {
    const { value } = manageDecodeOptionalString(fields.name);
    job.name = value.trim();
  }
  if (Object.hasOwn(fields, "prompt")) {
    const { value } = manageDecodeOptionalString(fields.prompt);
    job.prompt = value;
  }
  if (Object.hasOwn(fields, "schedule")) {
    const { value } = manageDecodeOptionalString(fields.schedule);
    job.schedule = value.trim();
  }
  if (Object.hasOwn(fields, "mode")) {
    const { value } = manageDecodeOptionalString(fields.mode);
    job.mode = value.trim();
  }
  if (Object.hasOwn(fields, "enabled")) {
    const { value } = manageDecodeOptionalBool(fields.enabled);
    job.enabled = value;
  }
  if ((job.name ?? "").trim() === "") {
    throw acpStructuredRPCError(
      -32602,
      "cron_field_invalid",
      "name is required",
      { field: "name" },
    );
  }
  if ((job.prompt ?? "").trim() === "") {
    throw acpStructuredRPCError(
      -32602,
      "cron_field_invalid",
      "prompt is required",
      { field: "prompt" },
    );
  }
  if (job.mode !== "" && job.mode !== "agent" && job.mode !== "yolo") {
    throw acpStructuredRPCError(
      -32602,
      "cron_mode_invalid",
      `mode ${JSON.stringify(job.mode)} must be agent or yolo`,
      { field: "mode" },
    );
  }
  try {
    return normalizeJobSchedule(job);
  } catch (err) {
    throw acpStructuredRPCError(
      -32602,
      "cron_schedule_invalid",
      `schedule: ${errorMessage(err)}`,
      { field: "schedule" },
    );
  }
}

export function handleManageCronList(s: AcpServer, req: ACPRPCRequest): void {
  let scheduler: Scheduler;
  let store: CronStore;
  try {
    ({ scheduler, store } = ensureManageCron(s));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  // Maintenance jobs stay out of the Desktop automation view.
  const jobs = userVisibleJobs(store.list()).sort((a, b) => {
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    if (at === bt) return (a.id ?? "") < (b.id ?? "") ? -1 : 1;
    return bt - at;
  });
  s.writeResponse(
    req.idRaw,
    {
      enabled: true,
      running: scheduler.isRunning(),
      jobs: jobs.map(manageCronJobView),
    },
    null,
  );
}

export function handleManageCronCreate(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  let fields: Record<string, unknown>;
  try {
    fields = manageDecodeWhitelist(
      req.params,
      manageCronJobFields,
      "cron_field_not_allowed",
    );
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return;
  }
  let store: CronStore;
  try {
    ({ store } = ensureManageCron(s));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  let job: CronJob;
  try {
    job = manageCronJobFromFields(
      { enabled: true, workDir: manageWorkDir(s) },
      fields,
    );
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return;
  }
  try {
    const created = store.create(job);
    s.writeResponse(req.idRaw, { job: manageCronJobView(created) }, null);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        `create cron job: ${errorMessage(err)}`,
        null,
      ),
    );
  }
}

export function handleManageCronUpdate(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  let fields: Record<string, unknown>;
  try {
    fields = manageDecodeWhitelist(
      req.params,
      manageCronIDFields(),
      "cron_field_not_allowed",
    );
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return;
  }
  const id = (manageDecodeOptionalString(fields.id).value ?? "").trim();
  if (id === "") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "id is required",
        null,
      ),
    );
    return;
  }
  let store: CronStore;
  try {
    ({ store } = ensureManageCron(s));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  let existing: CronJob;
  try {
    existing = store.get(id);
  } catch {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_job_not_found",
        `cron job ${JSON.stringify(id)} not found`,
        null,
      ),
    );
    return;
  }
  let job: CronJob;
  try {
    job = manageCronJobFromFields(existing, fields);
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return;
  }
  try {
    store.update(job);
    s.writeResponse(req.idRaw, { job: manageCronJobView(job) }, null);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        `update cron job: ${errorMessage(err)}`,
        null,
      ),
    );
  }
}

function handleManageCronIDOnly(
  s: AcpServer,
  req: ACPRPCRequest,
): string | undefined {
  let fields: Record<string, unknown>;
  try {
    fields = manageDecodeWhitelist(
      req.params,
      { id: true },
      "cron_field_not_allowed",
    );
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return undefined;
  }
  const id = (manageDecodeOptionalString(fields.id).value ?? "").trim();
  if (id === "") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(-32602, "invalid_params", "id is required", null),
    );
    return undefined;
  }
  return id;
}

export function handleManageCronRemove(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  const id = handleManageCronIDOnly(s, req);
  if (id === undefined) return;
  let store: CronStore;
  try {
    ({ store } = ensureManageCron(s));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  try {
    store.delete(id);
  } catch (err) {
    const code = errorMessage(err).includes("not found")
      ? "cron_job_not_found"
      : "cron_unavailable";
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        code,
        `delete cron job: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, { id, deleted: true }, null);
}

export function handleManageCronRun(s: AcpServer, req: ACPRPCRequest): void {
  const id = handleManageCronIDOnly(s, req);
  if (id === undefined) return;
  let scheduler: Scheduler;
  try {
    ({ scheduler } = ensureManageCron(s));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "cron_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  try {
    scheduler.runNow(id);
  } catch (err) {
    let code = "cron_run_failed";
    if (err instanceof JobAlreadyRunningError) code = "cron_job_running";
    else if (errorMessage(err).includes("not found")) {
      code = "cron_job_not_found";
    }
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        code,
        `run cron job: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  s.writeResponse(
    req.idRaw,
    { ok: true, jobId: id, triggered: true },
    null,
  );
}

// ─── views / validation / errors ─────────────────────────────────────────────

function manageKnowledgeBaseView(
  s: AcpServer,
  base: KnowledgeBase,
): ManageKnowledgeBaseView {
  const view: ManageKnowledgeBaseView = {
    knowledgeBase: base,
    snapshot: null,
    status: "unindexed",
  };
  if ((base.activeSnapshotId ?? "").trim() !== "") {
    const snapshot = getKnowledgeSnapshot(
      getSessionDir(s.settings!),
      base.activeSnapshotId,
    );
    view.snapshot = snapshot;
    view.status = snapshot.status;
  }
  // Progress must project even without an active snapshot: the first scan of
  // a new base is exactly when hosts need the running-job view to poll.
  attachKnowledgeIndexProgress(s, view, base.id);
  return view;
}

function attachKnowledgeIndexProgress(
  s: AcpServer,
  view: ManageKnowledgeBaseView,
  baseID: string,
): void {
  let service: KnowledgeBaseService;
  try {
    service = manageKnowledgeBaseService(s);
  } catch {
    return;
  }
  const { progress, running } = service.indexProgress(baseID);
  if (!running) return;
  view.indexing = manageKnowledgeIndexViewFrom(progress);
}

function validateKnowledgeBaseProvider(
  spec: KnowledgeBaseSpec,
): RPCError | null {
  const providerID = spec.provider.trim();
  const modelID = spec.model.trim();
  if (providerID === "" && modelID === "") return null;
  if (providerID === "" || modelID === "") {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_model_invalid",
      "provider and model must be configured together",
      null,
    );
  }
  const settings = manageSettings();
  if (
    getProviderConfig(settings, providerID) === undefined &&
    defaultProviderConfig(providerID) === undefined
  ) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_provider_not_found",
      `provider ${JSON.stringify(providerID)} is not configured`,
      { provider: providerID },
    );
  }
  for (const model of resolvedModels(settings, providerID)) {
    if (model !== null && model.id === modelID) return null;
  }
  return acpStructuredRPCError(
    -32602,
    "knowledge_base_model_invalid",
    `model ${JSON.stringify(modelID)} is not configured for provider ${
      JSON.stringify(providerID)
    }`,
    { provider: providerID, model: modelID },
  );
}

function validateKnowledgeBaseSchedule(
  spec: KnowledgeBaseSpec,
): RPCError | null {
  try {
    normalizeKnowledgeBaseSchedule(spec.schedule ?? "", spec.enabled);
  } catch (err) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_schedule_invalid",
      errorMessage(err),
      { schedule: spec.schedule ?? "" },
    );
  }
  return null;
}

export function manageKnowledgeBaseRPCError(err: unknown): RPCError {
  const error = toError(err);
  if (error instanceof KnowledgeBaseNotFoundError) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_not_found",
      "knowledge base was not found",
      null,
    );
  }
  if (error instanceof KnowledgeBaseUnindexedError) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_unindexed",
      "knowledge base has no completed index",
      null,
    );
  }
  const message = error.message.trim();
  if (message.includes("is disabled")) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_disabled",
      message,
      null,
    );
  }
  if (
    message.includes("knowledge base root") ||
    message.includes("path escaped root")
  ) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_root_unavailable",
      message,
      null,
    );
  }
  return acpStructuredRPCError(
    -32000,
    "knowledge_base_operation_failed",
    message,
    null,
  );
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function manageKnowledgeBaseID(
  req: ACPRPCRequest,
): { id: string; err: RPCError | null } {
  const params = (req.params ?? {}) as { id?: unknown };
  if (typeof params.id !== "string" || params.id.trim() === "") {
    return {
      id: "",
      err: acpStructuredRPCError(
        -32602,
        "invalid_params",
        "knowledge base id is required",
        null,
      ),
    };
  }
  return { id: params.id.trim(), err: null };
}

function requireSettings(s: AcpServer, req: ACPRPCRequest): boolean {
  if (s === null || s.settings === null) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_unavailable",
        "knowledge base runtime is unavailable",
        null,
      ),
    );
    return false;
  }
  return true;
}

// ─── handlers ────────────────────────────────────────────────────────────────

export function handleManageKnowledgeBasesList(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const bases = listKnowledgeBases(getSessionDir(s.settings!));
  const views: ManageKnowledgeBaseView[] = [];
  for (const base of bases) {
    try {
      views.push(manageKnowledgeBaseView(s, base));
    } catch (err) {
      s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
      return;
    }
  }
  s.writeResponse(req.idRaw, { knowledgeBases: views }, null);
}

export function handleManageKnowledgeBasesGet(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const { id, err } = manageKnowledgeBaseID(req);
  if (err !== null) {
    s.writeResponse(req.idRaw, null, err);
    return;
  }
  try {
    const base = getKnowledgeBase(getSessionDir(s.settings!), id);
    const view = manageKnowledgeBaseView(s, base);
    s.writeResponse(req.idRaw, view, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
  }
}

export function handleManageKnowledgeBasesCreate(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const input = req.params as ManageKnowledgeBaseCreateRequest | null;
  if (input === null || typeof input !== "object" || !input.knowledgeBase) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "knowledgeBase is required",
        null,
      ),
    );
    return;
  }
  const spec = mutationToSpec(input.knowledgeBase);
  const providerErr = validateKnowledgeBaseProvider(spec);
  if (providerErr !== null) {
    s.writeResponse(req.idRaw, null, providerErr);
    return;
  }
  const scheduleErr = validateKnowledgeBaseSchedule(spec);
  if (scheduleErr !== null) {
    s.writeResponse(req.idRaw, null, scheduleErr);
    return;
  }
  let base: KnowledgeBase;
  try {
    base = createKnowledgeBase(getSessionDir(s.settings!), spec);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
    return;
  }
  try {
    syncKnowledgeBaseSchedule(s, base);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_schedule_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  s.writeResponse(
    req.idRaw,
    { knowledgeBase: base, snapshot: null, status: "unindexed" },
    null,
  );
}

export function handleManageKnowledgeBasesUpdate(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const input = req.params as ManageKnowledgeBaseUpdateRequest | null;
  if (
    input === null || typeof input !== "object" || !input.knowledgeBase ||
    typeof input.id !== "string" || input.id.trim() === ""
  ) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "id and knowledgeBase are required",
        null,
      ),
    );
    return;
  }
  const spec = mutationToSpec(input.knowledgeBase);
  const providerErr = validateKnowledgeBaseProvider(spec);
  if (providerErr !== null) {
    s.writeResponse(req.idRaw, null, providerErr);
    return;
  }
  const scheduleErr = validateKnowledgeBaseSchedule(spec);
  if (scheduleErr !== null) {
    s.writeResponse(req.idRaw, null, scheduleErr);
    return;
  }
  let base: KnowledgeBase;
  try {
    base = updateKnowledgeBase(
      getSessionDir(s.settings!),
      input.id.trim(),
      spec,
    );
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
    return;
  }
  try {
    syncKnowledgeBaseSchedule(s, base);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_schedule_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  s.writeResponse(
    req.idRaw,
    { knowledgeBase: base, snapshot: null, status: "unindexed" },
    null,
  );
}

export function handleManageKnowledgeBasesDelete(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const { id, err } = manageKnowledgeBaseID(req);
  if (err !== null) {
    s.writeResponse(req.idRaw, null, err);
    return;
  }
  try {
    deleteKnowledgeBase(getSessionDir(s.settings!), id);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
    return;
  }
  try {
    removeKnowledgeBaseSchedule(s, id);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_schedule_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, { deleted: true, id }, null);
}

export function handleManageKnowledgeBasesScan(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const { id, err } = manageKnowledgeBaseID(req);
  if (err !== null) {
    s.writeResponse(req.idRaw, null, err);
    return;
  }
  let service: KnowledgeBaseService;
  try {
    service = manageKnowledgeBaseService(s);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  // Scans always run in the background: the RPC returns as soon as the job is
  // admitted so a long index can never stall the ACP request loop.
  let alreadyRunning = false;
  const existing = service.indexJob(id);
  if (existing !== null && !existing.finished) alreadyRunning = true;
  let job;
  try {
    job = service.startIndex(undefined, id, SourceACPValue);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
    return;
  }
  const progress = job.viewProgress();
  s.writeResponse(
    req.idRaw,
    {
      started: true,
      alreadyRunning,
      id,
      status: "indexing",
      indexing: manageKnowledgeIndexViewFrom(progress),
    },
    null,
  );
}

export function handleManageKnowledgeBasesStatus(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  handleManageKnowledgeBasesGet(s, req);
}

export function handleManageKnowledgeBasesQuery(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  if (!requireSettings(s, req)) return;
  const input = req.params as ManageKnowledgeBaseQueryRequest | null;
  if (
    input === null || typeof input !== "object" ||
    typeof input.id !== "string" || input.id.trim() === "" ||
    typeof input.query !== "string" || input.query.trim() === ""
  ) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "id and query are required",
        null,
      ),
    );
    return;
  }
  let limit = input.limit ?? 0;
  if (limit <= 0) limit = 8;
  if (limit > 20) limit = 20;
  let service: KnowledgeBaseService;
  try {
    service = manageKnowledgeBaseService(s);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  try {
    const result = service.query(
      undefined,
      input.id.trim(),
      input.query.trim(),
      limit,
    );
    s.writeResponse(req.idRaw, { query: result }, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageKnowledgeBaseRPCError(err));
  }
}

// ─── MCP apply ───────────────────────────────────────────────────────────────

export function handleManageKnowledgeBaseMCPApply(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  const input = req.params as ManageKnowledgeBaseMCPApplyRequest | null;
  if (input === null || typeof input !== "object") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "knowledge_base_invalid_request",
        "invalid knowledge MCP request",
        null,
      ),
    );
    return;
  }
  const id = (input.id ?? "").trim();
  if (id === "") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "knowledge_base_invalid_request",
        "knowledge base id is required",
        null,
      ),
    );
    return;
  }
  if (s === null || s.settings === null) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "knowledge_base_unavailable",
        "knowledge base runtime is unavailable",
        null,
      ),
    );
    return;
  }
  try {
    getKnowledgeBase(getSessionDir(s.settings), id);
  } catch (err) {
    const code = toError(err) instanceof KnowledgeBaseNotFoundError
      ? "knowledge_base_not_found"
      : "knowledge_base_unavailable";
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        code,
        `load knowledge base: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  let cfg: MCPConfig;
  try {
    cfg = manageMCPConfigAtGlobalPath();
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "mcp_unavailable",
        `load MCP config: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  const enabled = input.enabled ?? true;
  const entry: MCPServer = {
    name: knowledgeBaseMCPServerName(id),
    type: "stdio",
    command: knowledgeBaseMCPCommand(),
    args: ["knowledge-mcp", "serve", "--knowledge-base", id],
    enabled,
  };
  const servers = cfg.mcpServers ?? [];
  let updated = false;
  for (let index = 0; index < servers.length; index++) {
    if (servers[index].name === entry.name) {
      servers[index] = entry;
      updated = true;
      break;
    }
  }
  if (!updated) servers.push(entry);
  cfg.mcpServers = servers;
  normalizeMCPConfig(cfg);
  try {
    saveMCPConfig(globalMCPPath(), cfg);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "mcp_unavailable",
        `save MCP config: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  s.writeResponse(
    req.idRaw,
    { id, name: entry.name, enabled },
    null,
  );
}

function manageMCPConfigAtGlobalPath(): MCPConfig {
  let cfg: MCPConfig;
  try {
    cfg = loadMCPConfig(globalMCPPath());
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
  if (cfg === null || cfg === undefined) cfg = {};
  normalizeMCPConfig(cfg);
  return cfg;
}
