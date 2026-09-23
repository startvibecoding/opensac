//
// The model-facing `cron` tool for managing the current session's scheduled
// tasks. The Go tool holds a `*Scheduler` it never uses (manual runs are
// projected by stamping the store and letting the scheduler claim them), so the
// `scheduler` field is retained for parity and will be wired when the scheduler
// lands with backlog #26.

import {
  createTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";
import { truncateWithSuffix } from "../util/truncate.ts";
import type { CronJob, CronStore } from "./cron.ts";
import { userVisibleJobs } from "./maintenance.ts";
import { parseSchedule } from "./schedule.ts";

/** A minimal scheduler contract the tool may reference. */
export interface CronScheduler {
  runNow(id: string): void | Promise<void>;
}

/** Provides cron job management for the agent. */
export class CronTool implements Tool {
  readonly store: CronStore;
  readonly scheduler: CronScheduler | null;

  constructor(store: CronStore, scheduler: CronScheduler | null = null) {
    this.store = store;
    this.scheduler = scheduler;
  }

  name(): string {
    return "cron";
  }

  description(): string {
    return "Manage scheduled tasks (cron jobs) for the current session. Create one-time or periodic background tasks, list them, and delete or update them by ID or unique name.";
  }

  promptSnippet(): string {
    return "Manage scheduled background tasks (one-time or periodic)";
  }

  promptGuidelines(): string[] {
    return [
      "The `cron` tool manages scheduled background tasks bound to the current session.",
      "Created tasks inherit the current session's working directory unless a work directory is set by the runtime.",
      'Use `cron(action="list")` to see this session\'s tasks.',
      'Use `cron(action="create", name="...", prompt="...", schedule="@daily")` for periodic tasks in this session.',
      'Use `cron(action="create", name="...", prompt="...", oneshot=true)` for one-time tasks in this session.',
      'Use `cron(action="delete", id="...")` or `cron(action="delete", name="...")` to delete a task.',
      "Schedule formats: `@daily`, `@weekly`, `@monthly`, `@hourly`, `@every 30m`, `@every 2h`, or empty for one-shot.",
      'Use `cron(action="run", id="...")` to trigger a task immediately.',
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Action: list, create, enable, disable, remove/delete, run",
          enum: [
            "list",
            "create",
            "enable",
            "disable",
            "remove",
            "delete",
            "run",
          ],
        },
        id: {
          type: "string",
          description:
            "Job ID for enable, disable, delete/remove, or run. If omitted, name must uniquely identify the task.",
        },
        name: {
          type: "string",
          description:
            "Short task name. Required for create; can identify an existing task for enable, disable, delete/remove, or run.",
        },
        prompt: {
          type: "string",
          description: "Task prompt for the sub-agent (required for create)",
        },
        schedule: {
          type: "string",
          description:
            "Schedule: @daily, @weekly, @monthly, @hourly, @every 30m, @every 2h, or empty/omit for one-shot",
        },
        oneshot: {
          type: "boolean",
          description:
            "If true, run once then auto-disable (default: false). Same as omitting schedule.",
        },
        mode: {
          type: "string",
          description: "Agent mode for the task: agent, yolo (default: yolo)",
          enum: ["agent", "yolo"],
        },
      },
      required: ["action"],
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const action = typeof params["action"] === "string" ? params["action"] : "";

    switch (action) {
      case "list":
        return this.executeList();
      case "create": {
        const name = stringParam(params, "name");
        const prompt = stringParam(params, "prompt");
        const schedule = stringParam(params, "schedule");
        const oneShot = boolParam(params, "oneshot");
        const mode = stringParam(params, "mode");
        return this.executeCreate(name, prompt, schedule, oneShot, mode);
      }
      case "enable":
        return this.executeSetEnabled(
          stringParam(params, "id"),
          stringParam(params, "name"),
          true,
        );
      case "disable":
        return this.executeSetEnabled(
          stringParam(params, "id"),
          stringParam(params, "name"),
          false,
        );
      case "remove":
      case "delete":
        return this.executeRemove(
          stringParam(params, "id"),
          stringParam(params, "name"),
        );
      case "run":
        return this.executeRun(
          stringParam(params, "id"),
          stringParam(params, "name"),
        );
      default:
        throw new Error(
          `unknown action: ${action} (use: list, create, enable, disable, remove/delete, run)`,
        );
    }
  }

  private executeList(): ToolResult {
    let jobs: CronJob[];
    try {
      jobs = this.store.list();
    } catch (err) {
      throw new Error(`list cron jobs: ${errorMessage(err)}`);
    }
    // Runtime-owned maintenance jobs are host housekeeping, not user automations.
    jobs = userVisibleJobs(jobs);
    if (jobs.length === 0) {
      return createTextToolResult("No cron jobs configured.");
    }

    let out = `Cron jobs (${jobs.length}):\n\n`;
    for (const j of jobs) {
      let status = "✅ enabled";
      if (!j.enabled) status = "⏸ disabled";
      if (j.lastStatus === "failed") status = "❌ failed";
      if (j.lastStatus === "running") status = "🔄 running";
      out +=
        `- [${j.id}] ${j.name}\n  Status: ${status} | Mode: ${j.mode} | Schedule: ${
          scheduleStr(j.schedule ?? "", j.oneShot ?? false)
        } | Runs: ${j.runCount ?? 0}\n  Prompt: ${
          truncateStr(j.prompt ?? "", 80)
        }\n`;
      if (j.lastRun) {
        out += `  Last run: ${j.lastRun.toISOString()}\n`;
      }
      if (j.lastError) {
        out += `  Error: ${j.lastError}\n`;
      }
      out += "\n";
    }
    return createTextToolResult(out);
  }

  private executeCreate(
    name: string,
    prompt: string,
    schedule: string,
    oneShot: boolean,
    mode: string,
  ): ToolResult {
    if (name === "") throw new Error("name is required for create");
    if (prompt === "") throw new Error("prompt is required for create");
    if (mode === "") mode = "yolo";

    // Determine if one-shot: explicit oneshot=true or empty schedule.
    let isOneShot = oneShot;
    if (!isOneShot && schedule === "") {
      isOneShot = true; // Default: no schedule = one-shot
    }

    // Compute NextRun for periodic tasks.
    let nextRun: Date | null = null;
    if (!isOneShot && schedule !== "") {
      try {
        nextRun = parseSchedule(schedule, new Date()).next;
      } catch (err) {
        throw new Error(`invalid schedule: ${errorMessage(err)}`);
      }
    }

    let job: CronJob;
    try {
      job = this.store.create({
        name,
        prompt,
        schedule,
        oneShot: isOneShot,
        enabled: true,
        mode,
        nextRun,
      });
    } catch (err) {
      throw new Error(`create cron job: ${errorMessage(err)}`);
    }

    const kind = isOneShot ? "one-shot" : "periodic";
    const nextInfo = nextRun ? `\n  Next run: ${nextRun.toISOString()}` : "";
    return createTextToolResult(
      `✅ Cron job created (${kind}):\n  ID: ${job.id}\n  Name: ${job.name}\n  Schedule: ${
        scheduleStr(job.schedule ?? "", isOneShot)
      }\n  Mode: ${job.mode}${nextInfo}\n  Prompt: ${
        truncateStr(job.prompt ?? "", 100)
      }`,
    );
  }

  private executeSetEnabled(
    id: string,
    name: string,
    enabled: boolean,
  ): ToolResult {
    const job = this.findJob(id, name);
    job.enabled = enabled;
    try {
      this.store.update(job);
    } catch (err) {
      throw new Error(`update cron job: ${errorMessage(err)}`);
    }
    const action = enabled ? "enabled" : "disabled";
    return createTextToolResult(`✅ Cron job ${job.id} ${action}: ${job.name}`);
  }

  private executeRemove(id: string, name: string): ToolResult {
    const job = this.findJob(id, name);
    const jobName = job.name;
    try {
      this.store.delete(job.id ?? "");
    } catch (err) {
      throw new Error(`delete cron job: ${errorMessage(err)}`);
    }
    return createTextToolResult(`🗑 Cron job removed: ${job.id} (${jobName})`);
  }

  private executeRun(id: string, name: string): ToolResult {
    const job = this.findJob(id, name);
    if (job.lastStatus === "running") {
      throw new Error(`cron job ${job.id} is already running`);
    }
    // Manual run is an explicit override: re-enable the job and clear the
    // scheduled time so both SQLite and in-memory schedulers claim it now.
    job.enabled = true;
    job.lastRun = null;
    job.nextRun = null;
    job.lastStatus = "";
    try {
      this.store.update(job);
    } catch (err) {
      throw new Error(`update cron job: ${errorMessage(err)}`);
    }
    return createTextToolResult(
      `▶ Cron job ${job.id} triggered: ${job.name} (will run on next scheduler tick)`,
    );
  }

  /** Resolves a job by explicit ID or by a unique, user-visible name. */
  findJob(id: string, name: string): CronJob {
    const trimmedId = id.trim();
    const trimmedName = name.trim();
    if (trimmedId !== "") {
      return this.store.get(trimmedId);
    }
    if (trimmedName === "") {
      throw new Error("id or name is required");
    }
    let jobs: CronJob[];
    try {
      jobs = this.store.list();
    } catch (err) {
      throw new Error(`list cron jobs: ${errorMessage(err)}`);
    }
    // A name lookup must never resolve a maintenance job, because its result
    // feeds the enable/disable/delete/run actions.
    const matches = userVisibleJobs(jobs).filter(
      (job) => (job.name ?? "").toLowerCase() === trimmedName.toLowerCase(),
    );
    if (matches.length === 0) {
      throw new Error(`cron job named "${trimmedName}" not found`);
    }
    if (matches.length > 1) {
      throw new Error(
        `cron job name "${trimmedName}" is ambiguous; use id`,
      );
    }
    return matches[0];
  }
}

/** Creates a cron management tool. */
export function createCronTool(
  store: CronStore,
  scheduler: CronScheduler | null = null,
): CronTool {
  return new CronTool(store, scheduler);
}

function scheduleStr(schedule: string, oneShot: boolean): string {
  if (oneShot) return "(one-shot)";
  if (schedule === "") return "(one-shot)";
  return schedule;
}

function truncateStr(s: string, maxLen: number): string {
  return truncateWithSuffix(s, maxLen, "...");
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v : "";
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
