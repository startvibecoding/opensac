// Offline-scan worker for the usage dashboard.
//
// The stats aggregates scan the unbounded `request_stats` table (124–258ms at
// 200k rows in the P3 baseline, §3.7-2), and the TUI serves the dashboard
// in-process, so a slow aggregate would stall streaming and lease heartbeats
// on the main event loop. This worker runs the same `stats.DB` queries over
// the same `StatsDAO` (stats_call.ts owns the dispatch) on a caller-owned
// read-only connection (`src/db.openReadOnlyStandalone`, the sanctioned second
// connection for offline checks), keeping the main loop responsive.
//
// It is a module worker started from `new URL("./stats_worker.ts",
// import.meta.url)` (query_offload.ts). Unlike the text-inlined
// `src/workflow/js_worker.js`, a module worker keeps its imports — including
// the DAO layer — and therefore needs `deno compile --include
// src/stats/stats_worker.ts` to ship inside the compiled binary.

import { openReadOnlyStandalone } from "../db/mod.ts";
import { StatsDAO, wrapStandaloneDatabase } from "../dao/mod.ts";
import { runStatsCall, type StatsCall } from "./stats_call.ts";
import { DB } from "./stats.ts";

/** One worker request, matching the host-side postMessage payload. */
interface StatsWorkerRequest {
  id: number;
  dbPath?: string;
  call: StatsCall;
}

type StatsWorkerScope = {
  onmessage: ((event: MessageEvent<StatsWorkerRequest>) => void) | null;
  postMessage(value: unknown): void;
};

// The worker global is not the DOM `Window`; narrow it to the protocol shape.
const scope = self as unknown as StatsWorkerScope;

let cachedPath = "";
let cachedDB: DB | null = null;

function dbFor(dbPath: string): DB {
  if (cachedDB !== null && cachedPath === dbPath) return cachedDB;
  if (cachedDB !== null) cachedDB.database.close();
  const raw = openReadOnlyStandalone(dbPath);
  const handle = wrapStandaloneDatabase(raw);
  if (handle === null) throw new Error("database is not open");
  cachedDB = new DB(handle, new StatsDAO(raw));
  cachedPath = dbPath;
  return cachedDB;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

scope.onmessage = (event) => {
  const { id, dbPath, call } = event.data;
  // Setup failures mean this worker cannot host the query at all; the host
  // falls back in-process. Query failures are data errors and surface as-is.
  let db: DB;
  try {
    if (typeof dbPath !== "string" || dbPath === "") {
      throw new Error("stats worker: database path is missing");
    }
    db = dbFor(dbPath);
  } catch (err) {
    scope.postMessage({ id, ok: false, phase: "setup", error: messageOf(err) });
    return;
  }
  try {
    scope.postMessage({ id, ok: true, result: runStatsCall(db, call) });
  } catch (err) {
    scope.postMessage({ id, ok: false, phase: "query", error: messageOf(err) });
  }
};
