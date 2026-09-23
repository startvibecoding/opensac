//
// The Scheduler checks for due cron jobs and executes them through the shared
// Runtime: Runtime-owned maintenance is dispatched to `runMaintenanceCronJob`,
// an optional adapter `JobHandler` may claim a job, and local jobs run a
// canonical durable `ExecutionRuntime` run keyed to the target session before
// spawning a sub-agent. Cron stays the sole owner of job lifecycle (claims,
// stale recovery, status, next run); the Runtime owns what the job does.
//
// Deviations from Go: `time.Time` maps to `Date` with `null` for the zero time;
// `context.Context` maps to an `AbortSignal`; goroutines map to tracked
// `Promise`s awaited by `stop()`; `channel`-based completion observation maps to
// callbacks; Go's `(value, error)` returns throw typed errors; and the
// scheduler's run context is detached from the stop lifecycle with
// `AbortSignal.timeout` instead of `context.WithoutCancel`.

import { type Event, EVENT_TEXT_DELTA } from "../agent/events.ts";
import { type AgentManager } from "../agent/manager.ts";
import { acquireExecutionAdmission } from "../agentruntime/execution_admission.ts";
import { ExecutionRuntime } from "../agentruntime/execution.ts";
import {
  defaultMaintenancePolicy,
  isMaintenanceCronJobID,
  MAINTENANCE_STORAGE_RECONCILE_JOB_NAME,
  MAINTENANCE_STORAGE_RECONCILE_SCHEDULE,
  type MaintenancePolicy,
  maintenanceStorageReconcileJobID,
  runMaintenanceCronJob,
} from "../agentruntime/maintenance_cron.ts";
import { SessionRunEventSink } from "../agentruntime/run_event.ts";
import {
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  type RunState,
} from "../agentruntime/run_state.ts";
import { type DurableRun, RunStore } from "../agentruntime/run_store.ts";
import {
  MODE_YOLO,
  resolvePolicy,
  resolvePolicyFromSession,
  SOURCE_CRON,
  type SourceResolutionInput,
} from "../agentruntime/source.ts";
import { generateID } from "../session/entry.ts";
import { type Manager, openByIDExact } from "../session/manager.ts";
import {
  asDueJobClaimer,
  type CronJob,
  type CronStore,
  runningLeaseTimeoutMs,
} from "./cron.ts";
import { isMissingCronJobError } from "./maintenance.ts";
import { normalizeJobSchedule, parseSchedule } from "./schedule.ts";

/**
 * JobHandler may claim execution for a persisted job before the Scheduler falls
 * back to its ordinary local-agent behavior. It lets Runtime-owned
 * maintenance work reuse cron's claim, recovery, status, and completion
 * lifecycle without creating an adapter-specific timer or scheduler.
 *
 * Returning `handled: false` delegates to the built-in Cron Agent execution. A
 * handled job receives the same final store update and observers as any normal
 * cron job.
 */
export interface JobHandlerOutcome {
  handled: boolean;
  response: string;
  error: Error | null;
}

export type JobHandler = (
  job: CronJob,
  signal?: AbortSignal,
) => JobHandlerOutcome | Promise<JobHandlerOutcome>;

const defaultIntervalMs = 30_000;

/**
 * JobAlreadyRunningError is thrown by `runNow` when the stored job still holds a
 * fresh running claim.
 */
export class JobAlreadyRunningError extends Error {
  constructor(id: string) {
    super(`cron job is already running: ${id}`);
    this.name = "JobAlreadyRunningError";
  }
}

/** Receives the completed local job's response and outcome. */
export type JobCompletionObserver = (
  job: CronJob,
  response: string,
  runErr: Error | null,
) => void;

/** Receives the completion of a session-scoped local cron run. */
export type CompletionObserver = (
  sessionId: string,
  response: string,
  runErr: Error | null,
) => void;

/**
 * Scheduler checks for due cron jobs and executes them via sub-agents.
 */
export class Scheduler {
  readonly store: CronStore;
  readonly manager: AgentManager | null;
  interval: number;
  sessionDir: string;
  running = false;

  jobHandler: JobHandler | null;
  maintenance: MaintenancePolicy | null = null;

  completionObserver: CompletionObserver | null = null;
  jobObserver: JobCompletionObserver | null = null;

  /** In-memory single-scheduler claims for stores without atomic claims. */
  readonly claims = new Set<string>();

  quitController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly jobTasks = new Set<Promise<void>>();

  constructor(
    store: CronStore,
    manager: AgentManager | null,
    intervalMs: number,
    sessionDir = "",
    handler: JobHandler | null = null,
  ) {
    let resolvedInterval = intervalMs;
    if (!(resolvedInterval > 0)) resolvedInterval = defaultIntervalMs;
    this.store = store;
    this.manager = manager;
    this.interval = resolvedInterval;
    this.sessionDir = sessionDir;
    this.jobHandler = handler;
  }

  /** Installs a callback for completed local cron runs. */
  setCompletionObserver(observer: CompletionObserver | null): void {
    this.completionObserver = observer;
  }

  /** Installs a job-scoped completion callback. */
  setJobCompletionObserver(observer: JobCompletionObserver | null): void {
    this.jobObserver = observer;
  }

  /**
   * Installs the resolved Runtime maintenance policy this scheduler projects
   * and executes. Callers that never set one keep the defaults.
   */
  setMaintenancePolicy(policy: MaintenancePolicy): void {
    this.maintenance = policy;
  }

  /** Returns the installed policy or the Runtime default. */
  maintenancePolicy(): MaintenancePolicy {
    return this.maintenance ?? defaultMaintenancePolicy();
  }

  /** Begins the scheduler loop, projecting Runtime maintenance first. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.quitController = controller;
    this.ensureMaintenanceJob();
    this.loopPromise = this.loop(controller.signal);
  }

  /** Stops the scheduler and waits for the loop and any in-flight jobs. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const controller = this.quitController;
    this.quitController = null;
    controller?.abort();
    const loop = this.loopPromise;
    this.loopPromise = null;
    if (loop !== null) {
      try {
        await loop;
      } catch {
        // The loop only exits on abort; a stray rejection must not escape stop.
      }
    }
    while (this.jobTasks.size > 0) {
      await Promise.allSettled([...this.jobTasks]);
    }
  }

  /** Returns whether the scheduler is running. */
  isRunning(): boolean {
    return this.running;
  }

  private async loop(quit: AbortSignal): Promise<void> {
    this.checkAndRun(quit);
    while (!quit.aborted) {
      const aborted = await waitInterval(this.interval, quit);
      if (aborted) return;
      this.checkAndRun(quit);
    }
  }

  /** Checks all enabled jobs and runs any that are due. */
  checkAndRun(signal?: AbortSignal): void {
    let jobs: CronJob[];
    try {
      jobs = this.store.list();
    } catch (err) {
      logCron("failed to list jobs", err);
      return;
    }
    const now = new Date();
    for (const job of jobs) {
      if (!(job.enabled ?? false)) continue;
      if (
        (job.lastStatus ?? "") === "running" && !this.isStaleRunning(job, now)
      ) {
        continue;
      }
      if (this.isStaleRunning(job, now) || this.isDue(job, now)) {
        let claimed = false;
        let release: () => void = () => {};
        try {
          const result = this.claimJob(job.id ?? "", now);
          claimed = result.claimed;
          release = result.release;
        } catch (err) {
          logCron(`claim job ${job.id ?? ""}`, err);
          continue;
        }
        if (claimed) {
          this.trackJob(async () => {
            try {
              await this.executeJobContext(signal, job);
            } finally {
              release();
            }
          });
        }
      }
    }
  }

  /**
   * Claims a due job. Stores that support atomic claims coordinate across
   * processes; in-memory stores retain single-scheduler behavior.
   */
  claimJob(id: string, now: Date): { claimed: boolean; release: () => void } {
    const claimer = asDueJobClaimer(this.store);
    if (claimer !== null) {
      const claimed = claimer.claimDue(id, now);
      return { claimed, release: () => {} };
    }
    if (this.claims.has(id)) {
      return { claimed: false, release: () => {} };
    }
    this.claims.add(id);
    return {
      claimed: true,
      release: () => {
        this.claims.delete(id);
      },
    };
  }

  /** Reports whether a job should run now. */
  isDue(job: CronJob, now: Date): boolean {
    const nextRun = job.nextRun ?? null;
    if (nextRun !== null) {
      return now.getTime() >= nextRun.getTime();
    }
    // Legacy one-shot jobs have no NextRun and are due until their first claim.
    return (job.lastRun ?? null) === null;
  }

  /** Reports whether a persisted running claim has outlived its lease. */
  isStaleRunning(job: CronJob, now: Date): boolean {
    return (job.lastStatus ?? "") === "running" &&
      (job.lastRun ?? null) !== null &&
      now.getTime() - job.lastRun!.getTime() >= runningLeaseTimeoutMs;
  }

  /** Runs a cron job by spawning a sub-agent. */
  executeJob(job: CronJob): Promise<void> {
    return this.executeJobContext(undefined, job);
  }

  async executeJobContext(
    signal: AbortSignal | undefined,
    job: CronJob,
  ): Promise<void> {
    let lastErr: Error | null = null;
    let response = "";
    let execution: ExecutionRuntime | null = null;
    let runId = "";
    let runSource = SOURCE_CRON;
    let effectiveMode = MODE_YOLO;
    let runData: unknown = undefined;
    let runCtxSignal: AbortSignal | undefined;
    let releaseRuntime: (() => void) | null = null;

    try {
      if (isMaintenanceCronJobID(job.id ?? "")) {
        // Maintenance is Runtime-owned work that reuses this scheduler's claim,
        // status, and next-run lifecycle. It is dispatched here rather than
        // through an adapter JobHandler because a handler may legitimately
        // decline a job, and a declined maintenance job would otherwise fall
        // through and run its prompt as a model turn.
        try {
          const outcome = await runMaintenanceCronJob(
            this.sessionDir,
            job.id ?? "",
            this.maintenancePolicy(),
            signal,
          );
          response += outcome.response;
        } catch (err) {
          lastErr = asError(err);
        }
        this.updateJob(job.id ?? "", (current) => {
          this.completeJob(current, lastErr);
        });
        return;
      }

      if (this.jobHandler !== null) {
        let outcome: JobHandlerOutcome;
        try {
          outcome = await this.jobHandler(job, signal);
        } catch (err) {
          lastErr = asError(err);
          this.updateJob(job.id ?? "", (current) => {
            this.completeJob(current, lastErr);
          });
          return;
        }
        if (outcome.handled) {
          response += outcome.response;
          lastErr = outcome.error;
          this.updateJob(job.id ?? "", (current) => {
            this.completeJob(current, lastErr);
          });
          return;
        }
      }

      // Local agent mode
      const multiAgentPrompt = false;
      let sess: Manager | null = null;
      let workDir = job.workDir ?? "";
      if ((job.sessionId ?? "") !== "" && this.sessionDir !== "") {
        let guard;
        try {
          guard = await acquireExecutionAdmission(
            signal,
            this.sessionDir,
            job.sessionId!,
            { wait: true },
          );
        } catch (err) {
          lastErr = new Error(
            `acquire cron execution admission: ${errorMessage(err)}`,
          );
          return;
        }
        releaseRuntime = () => guard.release();
        try {
          const opened = openByIDExact(this.sessionDir, job.sessionId!);
          sess = opened;
          if (workDir === "") {
            const header = opened.getHeader();
            if (header !== null && header.cwd !== "") workDir = header.cwd;
          }
        } catch {
          // Missing session is not fatal; the local job still runs.
        }
      }

      let policyErr: Error | null;
      let resolution;
      try {
        const result = resolvePolicy(
          { requested: SOURCE_CRON } satisfies SourceResolutionInput,
          "",
          job.mode ?? "",
          MODE_YOLO,
        );
        resolution = result.resolution;
        effectiveMode = result.mode;
        policyErr = result.error;
      } catch (err) {
        resolution = {
          source: SOURCE_CRON,
          conflicted: false,
          diagnostics: [],
        };
        policyErr = asError(err);
      }
      if (
        sess !== null && (job.sessionId ?? "") !== "" && this.sessionDir !== ""
      ) {
        const result = resolvePolicyFromSession(
          this.sessionDir,
          job.sessionId!,
          {
            sessionHeader: sess.getHeader(),
            requested: SOURCE_CRON,
          } satisfies SourceResolutionInput,
          "",
          job.mode ?? "",
          MODE_YOLO,
        );
        resolution = result.resolution;
        effectiveMode = result.mode;
        policyErr = result.error;
      }
      runSource = resolution.source !== "" ? resolution.source : SOURCE_CRON;
      if (policyErr !== null) {
        lastErr = new Error(
          `resolve cron execution policy: ${errorMessage(policyErr)}`,
        );
      }

      if (
        lastErr === null && sess !== null && (job.sessionId ?? "") !== "" &&
        this.sessionDir !== ""
      ) {
        runId = "cron_" + generateID();
        const startedAt = new Date();
        runData = { cronJobId: job.id ?? "", cronJobName: job.name ?? "" };
        execution = new ExecutionRuntime();
        execution.setRunStore(new RunStore(this.sessionDir));
        execution.setEventSink(new SessionRunEventSink(this.sessionDir));
        // A cron run must survive the scheduler being stopped: detach the
        // durable run from that lifecycle and bound it with the same generous
        // lease the job record uses.
        const runCtxParent = AbortSignal.timeout(runningLeaseTimeoutMs);
        try {
          runCtxSignal = execution.beginDurable(
            runCtxParent,
            cronDurableRun({
              id: runId,
              sessionId: job.sessionId!,
              workDir,
              source: runSource,
              mode: effectiveMode,
              status: "running",
              startedAt,
            }),
            {
              sessionId: job.sessionId!,
              runId,
              eventType: "started",
              source: runSource,
              status: "running",
              model: "",
              mode: effectiveMode,
              data: runData,
            },
          );
        } catch (err) {
          lastErr = new Error(`begin cron run: ${errorMessage(err)}`);
          execution = null;
        }
      }

      if (lastErr === null && this.manager === null) {
        lastErr = new Error("create agent: agent manager unavailable");
      }
      if (lastErr === null) {
        try {
          const a = this.manager!.create({
            isSubAgent: sess === null,
            mode: effectiveMode,
            workDir,
            session: sess ?? undefined,
            multiAgent: multiAgentPrompt,
            // A scheduled job is never the session's conversational lead: it
            // must not drain or wait on the session's expert-team members.
            auxiliaryRole: true,
          });
          if (execution !== null) {
            execution.setAgent(a);
          }
          try {
            for await (
              const event of a.inner.run(job.prompt ?? "", runCtxSignal)
            ) {
              if (event.type === EVENT_TEXT_DELTA) {
                response += event.textDelta ?? "";
              }
              if (event.error !== undefined) {
                lastErr = event.error;
              }
            }
          } finally {
            this.manager!.destroy(a.id());
          }
        } catch (err) {
          lastErr = new Error(`create agent: ${errorMessage(err)}`);
        }
      }

      if (execution !== null) {
        const status: RunState = lastErr !== null
          ? RUN_STATE_FAILED
          : RUN_STATE_COMPLETED;
        const message = lastErr !== null ? lastErr.message : "";
        const data = message === "" ? runData : {
          cronJobId: job.id ?? "",
          cronJobName: job.name ?? "",
          error: message,
        };
        try {
          execution.finishDurable(runId, status, message, {
            sessionId: job.sessionId!,
            runId,
            eventType: status === RUN_STATE_FAILED ? "failed" : "finished",
            source: runSource,
            status,
            model: "",
            mode: effectiveMode,
            data,
            timestamp: new Date(),
          });
        } catch (err) {
          logCron(`finish run ${runId}`, err);
        }
      }

      this.updateJob(job.id ?? "", (current) => {
        this.completeJob(current, lastErr);
      });
    } finally {
      if (releaseRuntime !== null) releaseRuntime();
      this.notifyCompletion(job.sessionId ?? "", response, lastErr);
      this.notifyJobCompletion(job, response, lastErr);
    }
  }

  private trackJob(run: () => Promise<void>): void {
    const task = (async () => {
      try {
        await run();
      } catch (err) {
        logCron("cron job execution failed", err);
      }
    })();
    this.jobTasks.add(task);
    task.finally(() => {
      this.jobTasks.delete(task);
    });
  }

  /** Increments the run count and stamps the next run for a completed job. */
  completeJob(current: CronJob, runErr: Error | null): void {
    current.runCount = (current.runCount ?? 0) + 1;
    if (runErr !== null) {
      current.lastStatus = "failed";
      current.lastError = runErr.message;
    } else {
      current.lastStatus = "success";
      current.lastError = "";
    }

    // Compute next run from the latest stored schedule.
    let next: Date | null = null;
    let isOneShot = false;
    try {
      const parsed = parseSchedule(current.schedule ?? "", new Date());
      next = parsed.next;
      isOneShot = parsed.isOneShot;
    } catch {
      isOneShot = true;
    }
    if (isOneShot || (current.oneShot ?? false)) {
      current.enabled = false;
      current.nextRun = null;
    } else {
      current.nextRun = next;
    }
  }

  /** Reads the current persisted job, applies `update`, and saves it back. */
  updateJob(id: string, update: (job: CronJob) => void): void {
    let current: CronJob;
    try {
      current = this.store.get(id);
    } catch {
      return;
    }
    const next = { ...current };
    update(next);
    try {
      this.store.update(next);
    } catch {
      // A concurrent delete is not a scheduler error.
    }
  }

  /**
   * Triggers one immediate manual execution of a stored job without waiting for
   * the next scheduler tick. It reuses the claim path so last_run/running
   * stamping and cross-process coordination stay identical to scheduled runs,
   * and executes asynchronously; completion surfaces through the installed
   * completion observers.
   */
  runNow(id: string): void {
    if (this.store === null || this.store === undefined) {
      throw new Error("cron store unavailable");
    }
    const trimmed = (id ?? "").trim();
    if (trimmed === "") {
      throw new Error("cron job id is required");
    }
    const job = this.store.get(trimmed);
    const now = new Date();
    if (
      (job.lastStatus ?? "") === "running" && !this.isStaleRunning(job, now)
    ) {
      throw new JobAlreadyRunningError(trimmed);
    }
    // Manual run is an explicit override (same semantics as the cron tool run
    // action): re-enable the job and clear its schedule state so the claim path
    // stamps last_run/running atomically.
    job.enabled = true;
    job.lastRun = null;
    job.nextRun = null;
    job.lastStatus = "";
    job.lastError = "";
    this.store.update(job);

    const { claimed, release } = this.claimJob(job.id ?? "", now);
    if (!claimed) {
      release();
      throw new Error(
        `cron job ${trimmed} could not be claimed for a manual run`,
      );
    }
    const signal = this.quitController?.signal;
    this.trackJob(async () => {
      try {
        await this.executeJobContext(signal, job);
      } finally {
        release();
      }
    });
  }

  /** Fans out a session-scoped completion notification when bound. */
  notifyCompletion(
    sessionId: string,
    response: string,
    runErr: Error | null,
  ): void {
    if (sessionId === "") return;
    this.completionObserver?.(sessionId, response, runErr);
  }

  /** Fans out a job-scoped completion notification. */
  notifyJobCompletion(
    job: CronJob,
    response: string,
    runErr: Error | null,
  ): void {
    this.jobObserver?.(job, response, runErr);
  }

  /**
   * Projects the Runtime-owned maintenance policy onto this scheduler's own
   * store: enabled means the job exists on the configured cadence, disabled
   * means it is gone. An existing job keeps its run history, counters, and
   * enabled flag; only its schedule follows configuration.
   */
  ensureMaintenanceJob(): void {
    if (this.store === null || this.store === undefined) return;
    const policy = this.maintenancePolicy();
    const id = maintenanceStorageReconcileJobID();
    let existing: CronJob | null = null;
    let existingErr: Error | null = null;
    try {
      existing = this.store.get(id);
    } catch (err) {
      existingErr = asError(err);
    }
    if (!policy.reclaimAttachmentStorage) {
      if (existing !== null) {
        try {
          this.store.delete(id);
        } catch (err) {
          if (!isMissingCronJobError(err)) {
            logCron("remove disabled maintenance job", err);
          }
        }
      } else if (!isMissingCronJobError(existingErr)) {
        logCron("inspect maintenance job", existingErr);
      }
      return;
    }
    if (this.sessionDir === "") {
      // Without a session directory there is no private store to reconcile.
      return;
    }
    let schedule = (policy.storageReconcileSchedule ?? "").trim();
    if (schedule === "") schedule = MAINTENANCE_STORAGE_RECONCILE_SCHEDULE;
    if (existing !== null) {
      if ((existing.schedule ?? "") === schedule) return;
      const updated = normalizeMaintenanceSchedule(
        { ...existing },
        schedule,
      );
      if (updated === null) return;
      try {
        this.store.update(updated);
      } catch (err) {
        logCron("update maintenance schedule", err);
      }
      return;
    }
    if (!isMissingCronJobError(existingErr)) {
      logCron("inspect maintenance job", existingErr);
      return;
    }
    const job: CronJob = {
      id,
      name: MAINTENANCE_STORAGE_RECONCILE_JOB_NAME,
      prompt: "Runtime-owned maintenance; never executed as an agent prompt.",
      schedule,
      mode: "yolo",
      enabled: true,
    };
    const normalized = normalizeMaintenanceSchedule(job, schedule);
    if (normalized === null) return;
    try {
      this.store.create(normalized);
    } catch (err) {
      // Several processes sharing one store can race to create it; the loser
      // sees the job already scheduled.
      logCron("project maintenance job", err);
    }
  }
}

/** Constructs a new cron scheduler with an optional Runtime job handler. */
export function newScheduler(
  store: CronStore,
  manager: AgentManager | null,
  intervalMs: number,
): Scheduler {
  return new Scheduler(store, manager, intervalMs);
}

/** Constructs a scheduler that can attach scheduled runs to existing sessions. */
export function newSchedulerWithSessionDir(
  store: CronStore,
  manager: AgentManager | null,
  intervalMs: number,
  sessionDir: string,
  handler: JobHandler | null = null,
): Scheduler {
  return new Scheduler(store, manager, intervalMs, sessionDir, handler);
}

/**
 * Stamps the next run for the requested maintenance cadence, falling back to the
 * Runtime default when the configured value cannot be parsed. Returns `null`
 * when even the default cannot be normalized.
 */
export function normalizeMaintenanceSchedule(
  job: CronJob,
  schedule: string,
): CronJob | null {
  try {
    return normalizeJobSchedule({ ...job, schedule });
  } catch {
    if (schedule !== MAINTENANCE_STORAGE_RECONCILE_SCHEDULE) {
      logCron(
        "invalid maintenance schedule",
        `${
          JSON.stringify(schedule)
        } (using ${MAINTENANCE_STORAGE_RECONCILE_SCHEDULE})`,
      );
      try {
        return normalizeJobSchedule({
          ...job,
          schedule: MAINTENANCE_STORAGE_RECONCILE_SCHEDULE,
        });
      } catch {
        return null;
      }
    }
    return null;
  }
}

function cronDurableRun(
  fields: Partial<DurableRun> & { id: string; sessionId: string },
): DurableRun {
  const base: DurableRun = {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(0),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
  };
  return Object.assign(base, fields);
}

function waitInterval(ms: number, quit: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (quit.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      quit.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(true);
    }
    quit.addEventListener("abort", onAbort, { once: true });
  });
}

function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logCron(message: string, err: unknown): void {
  if (err === null || err === undefined) {
    console.error(`[cron] ${message}`);
    return;
  }
  console.error(`[cron] ${message}: ${errorMessage(err)}`);
}

// Re-exported for tests that drive the internal event vocabulary.
export type { Event };
