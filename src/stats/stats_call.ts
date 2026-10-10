// Shared stats query dispatch, executed by both the in-process path and the
// offline-scan worker (stats_worker.ts). Keeping the call shape and the
// `stats.DB` method mapping in one place means the two execution placements
// cannot drift: both run the same queries over the same DAO.

import { DB, type Query } from "./stats.ts";

/** One dashboard query request, transported across the worker boundary. */
export type StatsCall =
  | { method: "summary"; query: Query }
  | { method: "timeSeries"; query: Query }
  | { method: "byProvider"; query: Query }
  | { method: "byModel"; query: Query }
  | {
      method: "recentFiltered";
      query: Query;
      page: number;
      pageSize: number;
    };

/** Runs one call against a query surface. */
export function runStatsCall(db: DB, call: StatsCall): unknown {
  switch (call.method) {
    case "summary":
      return db.summary(call.query);
    case "timeSeries":
      return db.timeSeries(call.query);
    case "byProvider":
      return db.byProvider(call.query);
    case "byModel":
      return db.byModel(call.query);
    case "recentFiltered":
      return db.recentFiltered(call.query, call.page, call.pageSize);
  }
}
