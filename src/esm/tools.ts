//
// The model-facing get_esm / update_esm tools plus the compact plain-text
// objective renderer shared by TUI and tools.

import type { Tool, ToolContext, ToolResult } from "../tools/mod.ts";
import { newTextToolResult } from "../tools/mod.ts";
import {
  blockedAuditLimit,
  type Objective,
  type Status,
  statusBlocked,
  statusComplete,
  statusCompleteCandidate,
} from "./state.ts";
import { type Store } from "./store.ts";
import { EsmObjectiveNotFoundError } from "./store.ts";

export type SessionIDFunc = () => string;
export type RunIDFunc = () => string;

/** Returns the model-facing ESM state query tool. */
export function newGetTool(
  store: Store | null,
  sessionID: SessionIDFunc,
): Tool {
  return new GetTool(store, sessionID);
}

/** Returns the model-facing ESM status update tool. */
export function newUpdateTool(
  store: Store | null,
  sessionID: SessionIDFunc,
  runID?: RunIDFunc,
): Tool {
  return new UpdateTool(store, sessionID, runID ?? null);
}

class GetTool implements Tool {
  constructor(
    private readonly store: Store | null,
    private readonly sessionID: SessionIDFunc,
  ) {}

  name(): string {
    return "get_esm";
  }

  description(): string {
    return "Inspect the current Enable Supervisor Mode objective, status, and progress.";
  }

  promptSnippet(): string {
    return "Inspect the current Enable Supervisor Mode objective, status, and progress.";
  }

  promptGuidelines(): string[] {
    return [
      "When an ESM objective is active, use get_esm if you need current status and update_esm only to propose complete with evidence or report a real blocker.",
    ];
  }

  parameters(): unknown {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  execute(_ctx: ToolContext, _params: Record<string, unknown>): ToolResult {
    if (this.store === null || this.sessionID() === "") {
      return newTextToolResult(
        "No ESM objective is available for this session.",
      );
    }
    let obj: Objective;
    try {
      obj = this.store.get(this.sessionID());
    } catch (err) {
      if (err instanceof EsmObjectiveNotFoundError) {
        return newTextToolResult(
          "No ESM objective is available for this session.",
        );
      }
      throw err;
    }
    return newTextToolResult(formatObjective(obj));
  }
}

class UpdateTool implements Tool {
  constructor(
    private readonly store: Store | null,
    private readonly sessionID: SessionIDFunc,
    private readonly runID: RunIDFunc | null,
  ) {}

  name(): string {
    return "update_esm";
  }

  description(): string {
    return "Propose the current Enable Supervisor Mode objective as complete with requirement-by-requirement evidence, or report a concrete repeated blocker.";
  }

  promptSnippet(): string {
    return "Propose the current ESM objective complete with verification evidence, or report a blocker for the supervisor audit.";
  }

  promptGuidelines(): string[] {
    return [
      "Use update_esm status=complete only to submit a complete_candidate when current evidence appears to prove every objective requirement is satisfied and no required work remains; include that evidence in reason.",
      "status=complete is not terminal: ESM will run an independent audit before the objective can actually stop.",
      "Do not mark complete for a demo, partial implementation, narrow passing check, plausible final answer, or because this run is ending.",
      "Use update_esm status=blocked only after the same concrete blocker repeats across at least three consecutive ESM agent runs; include the blocker in reason.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete", "blocked"] },
        reason: {
          type: "string",
          description:
            "Required. For complete, provide concise verification evidence covering the full objective. For blocked, provide the repeated concrete blocker.",
        },
      },
      required: ["status", "reason"],
      additionalProperties: false,
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    if (this.store === null || this.sessionID() === "") {
      throw new Error("no ESM session is available");
    }
    const status: Status = stringParam(params, "status").trim();
    const reason = stringParam(params, "reason").trim();
    const runID = this.runID !== null ? this.runID() : "";
    const obj = this.store.updateFromModelForRun(
      this.sessionID(),
      status,
      reason,
      runID,
    );
    switch (obj.status) {
      case statusCompleteCandidate:
        return newTextToolResult(
          "ESM completion candidate recorded. An independent audit must pass before the objective is marked complete.",
        );
      case statusComplete:
        return newTextToolResult(
          "ESM objective marked complete. Report the verification evidence and final state to the user.",
        );
      case statusBlocked:
        return newTextToolResult(
          `ESM objective marked blocked after ${blockedAuditLimit} matching blocker reports.`,
        );
      default:
        if (status === statusBlocked) {
          return newTextToolResult(
            `Blocked audit recorded (${obj.blockedCount}/${blockedAuditLimit}). ESM remains active until the same blocker repeats in ${blockedAuditLimit} consecutive agent runs.`,
          );
        }
        return newTextToolResult(formatObjective(obj));
    }
  }
}

function stringParam(
  params: Record<string, unknown> | null,
  key: string,
): string {
  if (params === null || params === undefined) return "";
  const v = params[key];
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/** Returns a compact plain-text representation safe for TUI and tools. */
export function formatObjective(obj: Objective | null): string {
  if (obj === null) {
    return "No ESM objective is available for this session.";
  }
  const b: string[] = [];
  b.push("Enable Supervisor Mode\n");
  b.push(`Status: ${obj.status}\n`);
  if (obj.phase !== "") {
    b.push(`Phase: ${obj.phase}\n`);
  }
  b.push(`Objective: ${obj.objective}\n`);
  b.push(`Tokens: ${obj.tokensUsed}\n`);
  if (obj.timeUsedMs > 0) {
    b.push(`Time: ${formatDurationMS(obj.timeUsedMs)}\n`);
  }
  if (obj.blockedCount > 0 && obj.blockedReason !== "") {
    b.push(
      `Blocked audit: ${obj.blockedCount}/${blockedAuditLimit} (${obj.blockedReason})\n`,
    );
  }
  if (obj.progressSummary !== "") {
    b.push(`Latest progress: ${obj.progressSummary}\n`);
  }
  if (obj.remainingWork.length > 0) {
    b.push(
      `Remaining work (${obj.remainingWork.length}): ${
        obj.remainingWork.join("; ")
      }\n`,
    );
  }
  if (obj.rejectionCount > 0) {
    b.push(`Completion rejections: ${obj.rejectionCount}\n`);
  }
  if (obj.completionReason !== "") {
    b.push(`Completion candidate: ${obj.completionReason}\n`);
  }
  if (obj.completionReview !== "") {
    b.push(`Completion audit: ${obj.completionReview}\n`);
  }
  return b.join("").replace(/\n+$/, "");
}

function formatDurationMS(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}
