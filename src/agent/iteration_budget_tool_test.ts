// (the pure
// ExtendBudgetTool + tool-context cases; the loop-driven cases move with the
// core loop).

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { ToolContext } from "../tools/tool.ts";
import {
  createIterationBudget,
  ITERATION_BUDGET_TOOL_NAME,
  iterationBudgetFromToolContext,
  type IterationBudgetPolicy,
  toolContextWithIterationBudget,
} from "./iteration_budget.ts";
import { createExtendBudgetTool } from "./iteration_budget_tool.ts";

function policy(
  partial: Partial<IterationBudgetPolicy>,
): IterationBudgetPolicy {
  return {
    soft: 0,
    hard: 0,
    renewFactor: 0,
    maxRenewals: 0,
    minInterval: 0,
    maxWallClock: 0,
    ...partial,
  };
}

Deno.test("extend_budget tool metadata and rejection without a budget", () => {
  const tool = createExtendBudgetTool();
  assertEquals(tool.name(), ITERATION_BUDGET_TOOL_NAME);
  const ctx: ToolContext = {};
  assertThrows(
    () => tool.execute(ctx, { reason: "x" }),
    Error,
    "iteration budget renewal is not available",
  );
});

Deno.test("extend_budget tool grants and rejects missing reason", () => {
  const tool = createExtendBudgetTool();
  const b = createIterationBudget(
    policy({
      soft: 4,
      hard: 12,
      renewFactor: 0.5,
      maxRenewals: 2,
      minInterval: 1,
    }),
    4,
  );
  const ctx = toolContextWithIterationBudget({}, b);
  assertEquals(iterationBudgetFromToolContext(ctx), b);

  assertThrows(() => tool.execute(ctx, {}), Error, "reason is required");

  const res = tool.execute(ctx, { reason: "still working" });
  assert(res.text.includes("Granted 2 additional turns"));
  assertEquals(b.limitValue(), 6);
});
