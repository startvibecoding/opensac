import {
  newPlanToolResult,
  type PlanStep,
  type Registry,
  type TaskPlan,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Publishes a structured task plan for UI and audit surfaces. */
export class PlanTool implements Tool {
  // The registry argument is retained for parity with the Go constructor.
  constructor(_r: Registry) {}

  name(): string {
    return "plan";
  }

  description(): string {
    return "Publish or update a structured task plan with step statuses.";
  }

  promptSnippet(): string {
    return "Publish a visible task plan with pending, running, done, or failed steps";
  }

  promptGuidelines(): string[] {
    return [
      "Use plan before making code changes for multi-step tasks.",
      "Update plan step statuses as work progresses.",
      "Keep plan steps concise and actionable.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the current task plan",
        },
        steps: {
          type: "array",
          description: "Ordered task steps with statuses",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Concise step description",
              },
              status: {
                type: "string",
                enum: ["pending", "running", "done", "failed"],
                description: "Current step status",
              },
            },
            required: ["title", "status"],
          },
        },
        note: {
          type: "string",
          description:
            "Optional short note about risks, blockers, or next action",
        },
      },
      required: ["steps"],
    };
  }

  execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): ToolResult {
    const title = typeof params["title"] === "string"
      ? params["title"] as string
      : "";
    const note = typeof params["note"] === "string"
      ? params["note"] as string
      : "";
    const stepsRaw = params["steps"];
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      throw new Error("steps array is required and must not be empty");
    }

    const plan: TaskPlan = {
      title: title.trim(),
      note: note.trim(),
      steps: [],
    };
    for (let i = 0; i < stepsRaw.length; i++) {
      const raw = stepsRaw[i];
      if (typeof raw !== "object" || raw === null) {
        throw new Error(`step ${i}: invalid step format`);
      }
      const m = raw as Record<string, unknown>;
      const stepTitle = typeof m["title"] === "string"
        ? (m["title"] as string).trim()
        : "";
      if (stepTitle === "") {
        throw new Error(`step ${i}: title is required`);
      }
      const statusRaw = typeof m["status"] === "string"
        ? m["status"] as string
        : "";
      const status = normalizePlanStatus(statusRaw);
      if (status === "") {
        throw new Error(
          `step ${i}: status must be pending, running, done, or failed`,
        );
      }
      const step: PlanStep = { title: stepTitle, status };
      plan.steps.push(step);
    }

    return newPlanToolResult(formatTaskPlan(plan), plan);
  }
}

function normalizePlanStatus(status: string): string {
  const s = status.trim().toLowerCase();
  switch (s) {
    case "pending":
    case "running":
    case "done":
    case "failed":
      return s;
    default:
      return "";
  }
}

function formatTaskPlan(plan: TaskPlan | null): string {
  if (!plan) return "Plan updated.";
  let sb = "";
  if (plan.title !== "") {
    sb += `Plan: ${plan.title}\n`;
  } else {
    sb += "Plan updated:\n";
  }
  for (const step of plan.steps) {
    sb += `- [${step.status}] ${step.title}\n`;
  }
  if (plan.note !== "") {
    sb += `Note: ${plan.note}`;
  }
  return sb.replace(/\n+$/, "");
}
