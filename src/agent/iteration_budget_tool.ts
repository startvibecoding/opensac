// Ported from internal/agent/iteration_budget_tool.go.

import {
  newTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";
import {
  iterationBudgetFromToolContext,
  IterationBudgetToolName,
} from "./iteration_budget.ts";

/**
 * ExtendBudgetTool lets the model request more iterations when a run is close to
 * its iteration limit but the task is genuinely unfinished. It is stateless: the
 * per-run budget handle is carried on the tool context, and the Runtime clamps
 * every request (hard ceiling, renewal count, minimum interval). It is registered
 * only for the session's conversational lead.
 */
export class ExtendBudgetTool implements Tool {
  name(): string {
    return IterationBudgetToolName;
  }

  description(): string {
    return "Request more agent iterations when the run is close to its iteration limit but the task is genuinely unfinished. The Runtime decides how many turns (if any) to grant.";
  }

  promptSnippet(): string {
    return "Request more iterations when near the iteration limit and the task is unfinished";
  }

  promptGuidelines(): string[] {
    return [
      "Call extend_budget only when a [Budget Pressure] notice reports few turns remaining and the task is genuinely unfinished — not to avoid wrapping up",
      "Always give a concrete reason describing the remaining work; the Runtime may refuse the request",
      "Prefer finishing or summarizing the task over extending the budget",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Concrete description of the work that still remains and why more turns are needed. Required.",
        },
        additional_turns: {
          type: "integer",
          minimum: 1,
          description:
            "Optional number of additional turns to request. Omit to let the Runtime pick a default grant.",
        },
      },
      required: ["reason"],
    };
  }

  execute(ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const budget = iterationBudgetFromToolContext(ctx);
    if (budget === undefined) {
      throw new Error("iteration budget renewal is not available for this run");
    }
    const reason = typeof params["reason"] === "string"
      ? params["reason"] as string
      : "";
    if (reason.length === 0) {
      throw new Error("reason is required to request more turns");
    }
    let additional = 0;
    const v = params["additional_turns"];
    if (typeof v === "number" && v > 0) {
      additional = Math.trunc(v);
    }
    const { granted, remaining, renewals } = budget.request(additional, reason);
    if (granted <= 0) {
      return newTextToolResult(
        `Iteration budget is already at its hard ceiling (${budget.hardValue()}). ${remaining} turns remain; finish the task or summarize progress.`,
      );
    }
    return newTextToolResult(
      `Granted ${granted} additional turns. Effective limit is now ${budget.limitValue()} (${budget.hardValue()} hard), ${remaining} turns remaining, ${renewals} renewal(s) used.`,
    );
  }
}

/** Creates the extend_budget tool. */
export function newExtendBudgetTool(): ExtendBudgetTool {
  return new ExtendBudgetTool();
}
