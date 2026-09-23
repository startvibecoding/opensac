// (run status sets).
//
// nonTerminalSessionRunStatusList is the single source of truth for durable Run
// statuses that keep a Session busy. Every other form of this set (SQL literals,
// membership checks, partial unique indexes) derives from it.

/** The canonical durable statuses that keep a Session busy. */
export const nonTerminalSessionRunStatusList: readonly string[] = [
  "created",
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_question",
  "cancelling",
  "terminalizing",
];

/**
 * The canonical terminal Run status set. "expired" is included for parity with
 * fork/reopen/recovery handling even though the terminalizer does not currently
 * write it.
 */
export const terminalSessionRunStatusList: readonly string[] = [
  "completed",
  "incomplete",
  "expired",
  "failed",
  "cancelled",
  "canceled",
  "timed_out",
];

/** Returns the canonical durable statuses that keep a Session busy. */
export function nonTerminalSessionRunStatuses(): string[] {
  return [...nonTerminalSessionRunStatusList];
}

/** Reports whether a durable Run still requires execution/cancel/terminal work. */
export function isNonTerminalSessionRunStatus(status: string): boolean {
  return nonTerminalSessionRunStatusList.includes(status);
}

/** Returns the canonical terminal Run statuses. */
export function terminalSessionRunStatuses(): string[] {
  return [...terminalSessionRunStatusList];
}

/** Reports whether a durable Run status is terminal. */
export function isTerminalSessionRunStatus(status: string): boolean {
  return terminalSessionRunStatusList.includes(status);
}

/**
 * Renders the canonical non-terminal status set as a SQL IN(...) literal so DDL
 * partial unique indexes stay derived from the same source instead of drifting.
 */
export function nonTerminalSessionRunStatusSQL(): string {
  return nonTerminalSessionRunStatusList.map((s) => `'${s}'`).join(", ");
}
