// Ported helpers for the internal agent's `context.Context` value bag.
//
// Go threads `context.Context` through the agent loop and stores run-scoped
// values in it (agent id, event channel, event sink, parent run context, parent
// mode, iteration budget). Deno has no context.Context, so this module provides
// a small immutable value bag carrying the caller's AbortSignal plus typed
// values. It is internal to src/agent.

import type { AgentID } from "../../sdk/agent/types.ts";

/** A run-scoped context carrying a cancellation signal and typed values. */
export interface RunContext {
  /** Cancellation signal, mirroring Go's context cancellation. */
  signal?: AbortSignal;
  /** Typed values attached with contextWithValue. */
  values: Map<symbol, unknown>;
}

/** A typed key for the RunContext value bag. */
export type ContextKey<T> = symbol & { readonly __valueType?: T };

/** Creates a typed context key. */
export function contextKey<T>(name: string): ContextKey<T> {
  return Symbol(name) as ContextKey<T>;
}

/** Creates an empty run context, optionally seeded with a signal. */
export function newRunContext(signal?: AbortSignal): RunContext {
  return { signal, values: new Map() };
}

/** Returns a copy of ctx with value stored under key. */
export function contextWithValue<T>(
  ctx: RunContext | undefined,
  key: ContextKey<T>,
  value: T,
): RunContext {
  const base = ctx ?? newRunContext();
  const values = new Map(base.values);
  values.set(key, value);
  return { signal: base.signal, values };
}

/** Extracts the value stored under key, or undefined. */
export function contextValue<T>(
  ctx: RunContext | undefined,
  key: ContextKey<T>,
): T | undefined {
  return ctx?.values.get(key) as T | undefined;
}

/** Returns a copy of ctx carrying an AbortSignal. */
export function contextWithSignal(
  ctx: RunContext | undefined,
  signal: AbortSignal,
): RunContext {
  const base = ctx ?? newRunContext();
  return { signal, values: new Map(base.values) };
}

/** The agent-id context key. */
export const agentIDKey = contextKey<AgentID>("agentID");
