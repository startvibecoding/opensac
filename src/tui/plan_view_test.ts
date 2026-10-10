// Focused tests for plan_view.ts: the checklist projection shared by the
// transcript plan row and the Ctrl+T plan modal.

import { assertEquals } from "../compat/assert.ts";
import { Translator } from "./i18n.ts";
import {
  planProgress,
  planStatusGlyph,
  renderTaskPlanLines,
} from "./plan_view.ts";
import { type TaskPlan } from "../tools/tool.ts";
import { test } from "#testing";

const tr = new Translator("en");

const plan: TaskPlan = {
  title: "Ship the fix",
  note: "  watch the tests  ",
  steps: [
    { title: "read", status: "done" },
    { title: "edit", status: "running" },
    { title: "test", status: "pending" },
    { title: "lint", status: "failed" },
  ],
};

test("plan lines render a titled checklist with status glyphs", () => {
  assertEquals(renderTaskPlanLines(plan, tr), [
    "Ship the fix",
    "  ✓ read",
    "  ▸ edit",
    "  · test",
    "  ✗ lint",
    "  Note: watch the tests",
  ]);
});

test("untitled plans fall back and progress counts done steps", () => {
  const untitled: TaskPlan = { title: "  ", note: "", steps: plan.steps };
  assertEquals(renderTaskPlanLines(untitled, tr)[0], "Task plan");
  assertEquals(planProgress(plan), { done: 1, total: 4 });
  assertEquals(planStatusGlyph("unknown"), "·");
});
