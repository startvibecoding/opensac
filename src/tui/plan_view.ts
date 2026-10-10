// Task-plan projection shared by the transcript plan row and the Ctrl+T plan
// modal: a stable checklist rendering of the plan-tool payload. Pure string
// building; no Ink/React here (like tool_row_format.ts).

import type { Translator } from "./i18n.ts";
import { type TaskPlan } from "../tools/tool.ts";

/** Status glyph for one plan step. */
export function planStatusGlyph(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "▸";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}

/** Display title: the plan title or the localized untitled fallback. */
export function planTitle(plan: TaskPlan, tr: Translator): string {
  const title = plan.title.trim();
  return title !== "" ? title : tr.text("plan.untitled");
}

/** Completed/total step counts for compact rows. */
export function planProgress(plan: TaskPlan): { done: number; total: number } {
  return {
    done: plan.steps.filter((s) => s.status === "done").length,
    total: plan.steps.length,
  };
}

/** Checklist lines: title, one glyph row per step, and the optional note. */
export function renderTaskPlanLines(plan: TaskPlan, tr: Translator): string[] {
  const lines: string[] = [planTitle(plan, tr)];
  for (const step of plan.steps) {
    lines.push(`  ${planStatusGlyph(step.status)} ${step.title}`);
  }
  const note = plan.note.trim();
  if (note !== "") lines.push(`  ${tr.text("plan.note", note)}`);
  return lines;
}
