import { type RunContext } from "./run_context.ts";
import type { ToolContext } from "../tools/tool.ts";

/**
 * ITERATION_BUDGET_TOOL_NAME is the model-facing renewal tool for the main loop's
 * iteration budget.
 */
export const ITERATION_BUDGET_TOOL_NAME = "extend_budget";

const defaultIterationBudgetSoft = 200;
const defaultRenewFactor = 0.5;
const defaultMaxRenewals = 2;
/** Default total wall-clock cap for one run, in milliseconds (16 hours). */
export const DEFAULT_ITERATION_BUDGET_WALL_CLOCK = 16 * 60 * 60 * 1000;

/**
 * IterationBudgetPolicy bounds the main loop's iteration count and governs
 * model-requested renewals. A zero value disables renewal.
 */
export interface IterationBudgetPolicy {
  soft: number;
  hard: number;
  renewFactor: number;
  maxRenewals: number;
  minInterval: number;
  maxWallClock: number;
}

/** Returns a policy with the product defaults applied. */
export function emptyIterationBudgetPolicy(): IterationBudgetPolicy {
  return {
    soft: 0,
    hard: 0,
    renewFactor: 0,
    maxRenewals: 0,
    minInterval: 0,
    maxWallClock: 0,
  };
}

/**
 * Applies defaults relative to the supplied soft limit (used when the policy
 * leaves soft unset). A normalized policy is always enabled.
 */
export function normalizeIterationBudgetPolicy(
  p: IterationBudgetPolicy,
  soft: number,
): IterationBudgetPolicy {
  if (soft <= 0) soft = defaultIterationBudgetSoft;
  const out = { ...p };
  if (out.soft <= 0) out.soft = soft;
  if (out.hard < out.soft) out.hard = out.soft * 2;
  if (out.renewFactor <= 0) out.renewFactor = defaultRenewFactor;
  if (out.renewFactor > 1) out.renewFactor = 1;
  if (out.maxRenewals <= 0) out.maxRenewals = defaultMaxRenewals;
  if (out.minInterval < 0) out.minInterval = 0;
  if (out.minInterval === 0) {
    out.minInterval = Math.floor(out.soft / 10);
    if (out.minInterval < 1) out.minInterval = 1;
  }
  if (out.maxWallClock <= 0) {
    out.maxWallClock = DEFAULT_ITERATION_BUDGET_WALL_CLOCK;
  }
  return out;
}

/** Reports whether renewal is configured (a hard ceiling above soft). */
export function iterationBudgetPolicyEnabled(
  p: IterationBudgetPolicy,
): boolean {
  return p.soft > 0 && p.hard > p.soft;
}

/**
 * iterationBudget is the per-run, Runtime-owned budget handle shared between the
 * agent loop and the extend_budget tool. The loop owns the turn counter and the
 * limit; the tool may only request a clamped increase.
 */
export class IterationBudget {
  private soft: number;
  private hard: number;
  private limit: number;
  private renewFactor: number;
  private maxRenewals: number;
  private minInterval: number;

  private turn = 0;
  private renewals = 0;
  private lastRenewal = -1;

  constructor(policy: IterationBudgetPolicy, soft: number) {
    const p = normalizeIterationBudgetPolicy(policy, soft);
    this.soft = p.soft;
    this.hard = p.hard;
    this.limit = p.soft;
    this.renewFactor = p.renewFactor;
    this.maxRenewals = p.maxRenewals;
    this.minInterval = p.minInterval;
  }

  /** Returns the current effective iteration limit. */
  limitValue(): number {
    return this.limit;
  }

  /** Returns the initial (pre-renewal) iteration limit. */
  softValue(): number {
    return this.soft;
  }

  /** Returns the ceiling renewal may never pass. */
  hardValue(): number {
    return this.hard;
  }

  /** Returns the number of granted renewals. */
  renewalsCount(): number {
    return this.renewals;
  }

  /**
   * Reports whether another renewal could currently be granted: there is both
   * renewal budget left and headroom below the hard ceiling.
   */
  canRenew(): boolean {
    return this.renewals < this.maxRenewals && this.limit < this.hard;
  }

  /** Records the current iteration index for the minimum-interval check. */
  setTurn(i: number): void {
    this.turn = i;
  }

  /** Returns the number of turns granted by one renewal by default. */
  defaultGrant(): number {
    let grant = Math.round(this.soft * this.renewFactor);
    if (grant < 1) grant = 1;
    return grant;
  }

  /**
   * Clamps and applies a renewal. Throws when the request is invalid; a
   * zero-grant success means the ceiling is already reached.
   */
  request(
    additional: number,
    reason: string,
  ): { granted: number; remaining: number; renewals: number } {
    if (reason.trim() === "") {
      throw new Error("reason is required to request more turns");
    }
    if (this.renewals >= this.maxRenewals) {
      throw new Error(
        `iteration budget renewal limit reached (${this.renewals}/${this.maxRenewals})`,
      );
    }
    if (
      this.lastRenewal >= 0 &&
      this.turn - this.lastRenewal < this.minInterval
    ) {
      throw new Error(
        `iteration budget was renewed too recently (wait ${
          this.minInterval - (this.turn - this.lastRenewal)
        } more turns)`,
      );
    }
    if (this.limit >= this.hard) {
      throw new Error(
        `iteration budget is already at its hard ceiling (${this.hard})`,
      );
    }

    let want = additional;
    if (want <= 0) want = this.defaultGrant();
    let next = this.limit + want;
    if (next > this.hard) next = this.hard;
    const granted = next - this.limit;
    if (granted <= 0) {
      return {
        granted: 0,
        remaining: this.limit - this.turn,
        renewals: this.renewals,
      };
    }
    this.limit = next;
    this.renewals++;
    this.lastRenewal = this.turn;
    return {
      granted,
      remaining: this.limit - this.turn,
      renewals: this.renewals,
    };
  }
}

/** Creates a per-run iteration budget handle from a policy. */
export function newIterationBudget(
  policy: IterationBudgetPolicy,
  soft: number,
): IterationBudget {
  return new IterationBudget(policy, soft);
}

/** Attaches the per-run budget handle to the run context. */
export function contextWithIterationBudget(
  ctx: RunContext | undefined,
  b: IterationBudget,
): RunContext | undefined {
  if (ctx == null || b == null) return ctx;
  return { ...ctx, iterationBudget: b };
}

/** Extracts the per-run budget handle. */
export function iterationBudgetFromContext(
  ctx: RunContext | undefined,
): IterationBudget | undefined {
  return ctx?.iterationBudget;
}

/**
 * Attaches the per-run budget handle to a tool context so a registered
 * `extend_budget` tool can reach the same budget the loop owns. This is the TS
 * analog of Go passing the run `context.Context` straight into `Tool.Execute`.
 */
export function toolContextWithIterationBudget(
  ctx: ToolContext,
  b: IterationBudget,
): ToolContext {
  return { ...ctx, iterationBudget: b };
}

/** Extracts the per-run budget handle from a tool context. */
export function iterationBudgetFromToolContext(
  ctx: ToolContext | undefined,
): IterationBudget | undefined {
  return ctx?.iterationBudget;
}
