import type { BashTool } from "./bash.ts";
import {
  newTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Stops a running background job. */
export class KillTool implements Tool {
  // The registry argument is retained for parity with the Go struct.
  #bashTool: BashTool;

  constructor(_r: Registry, bashTool: BashTool) {
    this.#bashTool = bashTool;
  }

  name(): string {
    return "kill";
  }

  description(): string {
    return "Stop a running background job started with bash async=true.";
  }

  promptSnippet(): string {
    return "Stop a running background job";
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
          description: "The job ID to kill",
        },
      },
      required: ["jobId"],
    };
  }

  execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): ToolResult {
    const jobIdParam = params["jobId"];
    if (typeof jobIdParam !== "number") {
      throw new Error("jobId is required");
    }
    const id = Math.trunc(jobIdParam);

    const jm = this.#bashTool.getJobManager();
    const job = jm.getJob(id);
    if (!job) {
      throw new Error(`job ${id} not found`);
    }

    if (job.isDone()) {
      return newTextToolResult(`Job ${id} already finished.`);
    }

    try {
      jm.killJob(id);
    } catch (err) {
      throw new Error(`failed to kill job ${id}: ${messageOf(err)}`);
    }

    return newTextToolResult(
      `Sent kill signal to job ${id} (PID: ${job.pid}).`,
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
