import type { BashTool } from "./bash.ts";
import type { BackgroundJob } from "./jobmanager.ts";
import { formatGoDuration } from "./jobmanager.ts";
import {
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Lists and manages background jobs. */
export class JobsTool implements Tool {
  // The registry argument is retained for parity with the Go struct.
  #bashTool: BashTool;

  constructor(_r: Registry, bashTool: BashTool) {
    this.#bashTool = bashTool;
  }

  name(): string {
    return "jobs";
  }

  description(): string {
    return "List and check status of background jobs started with bash async=true. Shows running and finished jobs.";
  }

  promptSnippet(): string {
    return "List and manage background jobs";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        jobId: {
          type: "integer",
          description: "Optional: get detailed status of a specific job by ID",
        },
        cleanup: {
          type: "boolean",
          description: "Remove finished jobs from the list",
        },
      },
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const jm = this.#bashTool.getJobManager();

    if (params["cleanup"] === true) {
      for (const job of jm.listJobs()) {
        if (job.isDone()) jm.removeJob(job.id);
      }
      return createTextToolResult("Cleaned up finished jobs.");
    }

    const jobIdParam = params["jobId"];
    if (typeof jobIdParam === "number") {
      const id = Math.trunc(jobIdParam);
      const job = jm.getJob(id);
      if (!job) {
        throw new Error(`job ${id} not found`);
      }
      return createTextToolResult(formatJobDetail(job));
    }

    const jobs = jm.listJobs();
    if (jobs.length === 0) {
      return createTextToolResult("No background jobs.");
    }
    jobs.sort((a, b) => a.id - b.id);

    let result = "";
    for (const job of jobs) {
      result += job.status() + "\n";
    }
    return createTextToolResult(result);
  }
}

function formatJobDetail(job: BackgroundJob): string {
  let result = "";
  result += `Job ID:    ${job.id}\n`;
  result += `Command:   ${job.command}\n`;
  result += `PID:       ${job.pid}\n`;
  result += `Started:   ${formatDate(job.startTime)}\n`;
  result += `Elapsed:   ${formatGoDuration(Date.now() - job.startTime)}\n`;
  result += `Status:    `;

  if (job.done) {
    if (job.exitCode === 0) {
      result += "finished (success)\n";
    } else {
      result += `finished (exit code ${job.exitCode})\n`;
    }
    if (job.stdout.length > 0) {
      result += `STDOUT:\n${new TextDecoder().decode(job.stdout)}\n`;
    }
    if (job.stderr.length > 0) {
      result += `STDERR:\n${new TextDecoder().decode(job.stderr)}\n`;
    }
    if (job.err !== null) {
      result += `Error: ${job.err.message}\n`;
    }
  } else {
    result += "running\n";
  }

  return result;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
