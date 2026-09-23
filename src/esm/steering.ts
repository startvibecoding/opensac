//
// Projects the latest active ESM objective into an already running Agent at its
// normal steering boundaries. It never starts a run: the adapter remains
// responsible for idle continuation scheduling.
//
// A source is intentionally scoped to one Agent run. It is safe for the agent
// loop to call next repeatedly and emits each persisted objective version at
// most once.

import type { Message } from "../provider/types.ts";
import { steeringMessage } from "./prompt.ts";
import { type Objective, statusActive } from "./state.ts";
import type { Store } from "./store.ts";

export class SteeringSource {
  private readonly store: Store | null;
  private readonly sessionID: string;
  private lastVersion = "";

  /**
   * Creates a run-scoped source for one session. A null store or empty session
   * ID is accepted so adapters can use the source uniformly in partially
   * initialized or compatibility paths; next then returns no message.
   */
  constructor(store: Store | null, sessionID: string) {
    this.store = store;
    this.sessionID = sessionID;
  }

  /**
   * Returns a single system-injected steering message when an active ESM
   * objective is first observed or has changed since the prior call. Paused,
   * blocked, limited, completed, and missing objectives deliberately produce no
   * steering instruction.
   */
  next(): Message[] {
    if (this.store === null || this.sessionID === "") return [];
    // Serialize the read together with the version update. Agent loops normally
    // call this serially, but this also prevents two concurrent callers from
    // observing objective versions in reverse order and re-emitting one.
    let obj: Objective | null = null;
    try {
      obj = this.store.get(this.sessionID);
    } catch {
      return [];
    }
    if (obj === null) return [];
    const version = steeringVersion(obj);
    if (version === this.lastVersion) return [];
    this.lastVersion = version;
    if (obj.status !== statusActive) return [];
    return [steeringMessage(obj)];
  }
}

function steeringVersion(obj: Objective | null): string {
  if (obj === null) return "";
  // updatedAt is the persisted optimistic-concurrency version, with the value
  // fields kept as a defensive fallback for tests or imported legacy rows.
  return `${obj.esmId}|${obj.updatedAt.toISOString()}|${obj.status}|${obj.phase}|${obj.objective}`;
}
