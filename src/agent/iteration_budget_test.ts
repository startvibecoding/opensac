// Translated from internal/agent/iteration_budget_test.go (pure cases).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  contextWithIterationBudget,
  DefaultIterationBudgetWallClock,
  iterationBudgetFromContext,
  type IterationBudgetPolicy,
  iterationBudgetPolicyEnabled,
  newIterationBudget,
  normalizeIterationBudgetPolicy,
} from "./iteration_budget.ts";
import { newRunContext } from "./run_context.ts";

const defaultRenewFactor = 0.5;
const defaultMaxRenewals = 2;

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

Deno.test("iteration budget policy normalize", () => {
  const p = normalizeIterationBudgetPolicy(policy({}), 90);
  assertEquals([p.soft, p.hard], [90, 180]);
  assertEquals(p.renewFactor, defaultRenewFactor);
  assertEquals(p.maxRenewals, defaultMaxRenewals);
  assertEquals(p.minInterval, 9);
  assertEquals(p.maxWallClock, DefaultIterationBudgetWallClock);
  assert(iterationBudgetPolicyEnabled(p));
  assert(!iterationBudgetPolicyEnabled(policy({})));
});

Deno.test("iteration budget request clamp", () => {
  const b = newIterationBudget(
    policy({
      soft: 10,
      hard: 20,
      renewFactor: 0.5,
      maxRenewals: 2,
      minInterval: 3,
      maxWallClock: 3600000,
    }),
    10,
  );

  assertThrows(() => b.request(0, "   "));

  b.setTurn(0);
  const first = b.request(0, "unfinished");
  assertEquals(first.granted, 5);
  assertEquals(first.renewals, 1);
  assertEquals(b.limitValue(), 15);
  assertEquals(first.remaining, 15);

  b.setTurn(1);
  assertThrows(() => b.request(0, "again"));

  b.setTurn(4);
  b.request(100, "more");
  assertEquals(b.limitValue(), 20);

  b.setTurn(9);
  assertThrows(() => b.request(0, "one more"));
});

Deno.test("iteration budget can renew", () => {
  const b = newIterationBudget(
    policy({
      soft: 10,
      hard: 20,
      renewFactor: 0.5,
      maxRenewals: 2,
      minInterval: 3,
      maxWallClock: 3600000,
    }),
    10,
  );
  assert(b.canRenew());

  b.setTurn(0);
  b.request(0, "first");
  b.setTurn(4);
  b.request(0, "second");
  assert(!b.canRenew());

  const capped = newIterationBudget(
    policy({
      soft: 10,
      hard: 15,
      renewFactor: 0.5,
      maxRenewals: 5,
      minInterval: 1,
      maxWallClock: 3600000,
    }),
    10,
  );
  capped.setTurn(0);
  capped.request(100, "to the ceiling");
  assertEquals(capped.limitValue(), 15);
  assert(!capped.canRenew());
});

Deno.test("iteration budget context round trip", () => {
  assertEquals(iterationBudgetFromContext(newRunContext()), undefined);
  const b = newIterationBudget(policy({ soft: 4, hard: 8 }), 4);
  const ctx = contextWithIterationBudget(newRunContext(), b);
  assertEquals(iterationBudgetFromContext(ctx), b);
});
