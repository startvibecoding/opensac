// Run-scoped context for the internal agent loop.
//
// Go threads `context.Context` through the agent loop and stores run-scoped
// values in it (agent id, event sink, parent run context, parent mode,
// iteration budget). Node has no `context.Context`, and Go's `context.WithValue`
// bag is an antipattern even there, so this module carries the caller's
// `AbortSignal` plus explicit typed fields. It is internal to `src/agent`.

import { type AgentID } from "../../sdk/agent/types.ts";
import { type Event } from "./events.ts";
import type { IterationBudget } from "./iteration_budget.ts";

/**
 * A run event sink: pushes an event and reports whether it was accepted. This
 * is the TS projection of Go's `chan<- Event`; the loop and tool-execution
 * paths push through it, and a sealed/finished sink returns false instead of
 * blocking.
 */
export type EventSink = (ev: Event) => boolean;

/** A run-scoped context carrying a cancellation signal and typed run values. */
export interface RunContext {
  /** Cancellation signal, mirroring Go's context cancellation. */
  signal?: AbortSignal;
  /** Identity of the owning agent. */
  agentID?: AgentID;
  /** The run's canonical event sink. */
  eventSink?: EventSink;
  /** The parent agent run context, carried through tool timeouts. */
  parentRunContext?: RunContext;
  /** The parent agent's execution mode for sub-agent inheritance. */
  parentMode?: string;
  /** The per-run iteration budget handle owned by the loop. */
  iterationBudget?: IterationBudget;
}

/** Creates an empty run context, optionally seeded with a signal. */
export function createRunContext(signal?: AbortSignal): RunContext {
  return { signal };
}

/** Returns a copy of ctx carrying an AbortSignal. */
export function contextWithSignal(
  ctx: RunContext | undefined,
  signal: AbortSignal,
): RunContext {
  return { ...(ctx ?? {}), signal };
}
