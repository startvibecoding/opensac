//
// Routes public `sdk/agent` events from agents to consumers (UI, parent
// agents). Concurrency guards are dropped (Deno is single-threaded).

import type { AgentID, Event } from "../../sdk/agent/types.ts";

/** RouterEventHandler receives public agent events for routing purposes. */
export interface RouterEventHandler {
  handleRouterEvent(event: Event): void;
}

/** Adapts a function to RouterEventHandler. */
export class RouterEventHandlerFunc implements RouterEventHandler {
  private fn: (event: Event) => void;

  constructor(fn: (event: Event) => void) {
    this.fn = fn;
  }

  handleRouterEvent(event: Event): void {
    this.fn(event);
  }
}

/** Routes events from agents to consumers (UI, parent agents). */
export class EventRouter {
  private handlers = new Map<AgentID, RouterEventHandler[]>();
  private global: RouterEventHandler[] = [];

  /** Registers an event handler for a specific agent. */
  registerAgent(id: AgentID, handler: RouterEventHandler): void {
    const list = this.handlers.get(id) ?? [];
    list.push(handler);
    this.handlers.set(id, list);
  }

  /** Removes all handlers for a specific agent. */
  unregisterAgent(id: AgentID): void {
    this.handlers.delete(id);
  }

  /** Registers a handler that receives events from all agents. */
  registerGlobal(handler: RouterEventHandler): void {
    this.global.push(handler);
  }

  /**
   * Sends an event to the appropriate handlers. Agent-specific handlers run
   * first, then global handlers.
   */
  dispatch(event: Event): void {
    for (const h of this.handlers.get(event.agentId) ?? []) {
      h.handleRouterEvent(event);
    }
    for (const h of this.global) {
      h.handleRouterEvent(event);
    }
  }

  /** Returns the number of handlers for a given agent (for testing). */
  handlerCount(id: AgentID): number {
    return this.handlers.get(id)?.length ?? 0;
  }

  /** Returns the number of global handlers (for testing). */
  globalHandlerCount(): number {
    return this.global.length;
  }
}

/** Creates a new event router. */
export function createEventRouter(): EventRouter {
  return new EventRouter();
}
