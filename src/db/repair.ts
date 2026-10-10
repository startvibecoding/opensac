/** Records a secondary index src/db rebuilt while opening a database. */
export interface IndexRepair {
  /** The canonical database path whose indexes were rebuilt. */
  path: string;
  /** The integrity-check line that triggered the repair. */
  cause: string;
  /** When the repair happened. */
  at: Date;
}

/** Returns the one-line operator-facing summary of a repair. */
export function describeIndexRepair(r: IndexRepair): string {
  return `rebuilt stale SQLite indexes in ${r.path} after an integrity check reported ${JSON.stringify(
    r.cause,
  )}`;
}

const indexRepairLog: IndexRepair[] = [];

/**
 * Stores a completed repair and logs it. The log line is the notice headless
 * entry points are guaranteed to reach, so a self-healed database is never
 * silent.
 */
export function recordIndexRepair(repair: IndexRepair): void {
  indexRepairLog.push(repair);
  console.error(`[db] ${describeIndexRepair(repair)}`);
}

/** Returns the repairs recorded since the last call and clears them. */
export function takeIndexRepairs(): IndexRepair[] {
  const entries = indexRepairLog.slice();
  indexRepairLog.length = 0;
  return entries;
}
