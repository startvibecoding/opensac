import type { DB } from "../db/mod.ts";
import {
  execChanges,
  type Param,
  queryAll,
  queryOptional,
} from "./database.ts";

/**
 * Optional predicates shared by all stats queries. Timestamps are stored as
 * RFC3339 strings in SQLite, so lexical comparison preserves ordering.
 */
export interface StatsFilter {
  from?: string;
  to?: string;
  provider?: string;
  protocol?: string;
  model?: string;
}

/** Aggregate result returned by {@link StatsDAO.summary}. */
export interface StatsSummaryRecord {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Aggregate result returned by grouped queries. */
export interface StatsAggregateRecord {
  label: string;
  vendor: string;
  protocol: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

/** Persisted request_stats row. */
export interface StatsRecord {
  id: number;
  timestamp: string;
  sessionId: string | null;
  provider: string;
  protocol: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}

/** SQL-backed access to request_stats. */
export class StatsDAO {
    private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  /**
   * Records one provider request in the supplied transaction so usage and
   * lease validation remain atomic.
   */
  insert(tx: DB, record: StatsRecord | null): void {
    if (record === null) return;
    execChanges(
      tx,
      `INSERT INTO request_stats
        (timestamp, session_id, provider, protocol, model, input_tokens, output_tokens, total_tokens, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.timestamp,
        record.sessionId,
        record.provider,
        record.protocol,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.durationMs,
      ],
    );
  }

  summary(filter: StatsFilter): StatsSummaryRecord {
    const { where, params } = statsWhere(filter);
    return queryOptional<StatsSummaryRecord>(
      this.requireDb(),
      `SELECT COUNT(*) AS totalRequests,
              CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) AS inputTokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS outputTokens,
              CAST(COALESCE(SUM(total_tokens), 0) AS INTEGER) AS totalTokens
       FROM request_stats${where}`,
      params,
    ) ?? { totalRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  timeSeries(filter: StatsFilter, groupBy: string): StatsAggregateRecord[] {
    const { where, params } = statsWhere(filter);
    const bucket = statsBucketExpr(groupBy);
    return queryAll<StatsAggregateRecord>(
      this.requireDb(),
      `SELECT ${bucket} AS label,
              CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) AS inputTokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS outputTokens,
              CAST(COALESCE(SUM(total_tokens), 0) AS INTEGER) AS totalTokens,
              COUNT(*) AS requests
       FROM request_stats${where}
       GROUP BY label ORDER BY label`,
      params,
    );
  }

  byProvider(filter: StatsFilter): StatsAggregateRecord[] {
    const { where, params } = statsWhere(filter);
    return queryAll<StatsAggregateRecord>(
      this.requireDb(),
      `SELECT provider AS vendor, protocol,
              CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) AS inputTokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS outputTokens,
              CAST(COALESCE(SUM(total_tokens), 0) AS INTEGER) AS totalTokens,
              COUNT(*) AS requests
       FROM request_stats${where}
       GROUP BY provider, protocol ORDER BY totalTokens DESC`,
      params,
    );
  }

  byModel(filter: StatsFilter): StatsAggregateRecord[] {
    const { where, params } = statsWhere(filter);
    return queryAll<StatsAggregateRecord>(
      this.requireDb(),
      `SELECT model, provider AS vendor, protocol,
              CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) AS inputTokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS outputTokens,
              CAST(COALESCE(SUM(total_tokens), 0) AS INTEGER) AS totalTokens,
              COUNT(*) AS requests
       FROM request_stats${where}
       GROUP BY model, provider, protocol ORDER BY totalTokens DESC`,
      params,
    );
  }

  /** Returns rows and the total number of matching rows. */
  recent(
    filter: StatsFilter,
    page: number,
    pageSize: number,
  ): { records: StatsRecord[]; total: number } {
    const db = this.requireDb();
    const { where, params } = statsWhere(filter);
    const total = queryOptional<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM request_stats${where}`,
      params,
    )?.n ?? 0;
    const records = queryAll<StatsRecord>(
      db,
      `SELECT id, timestamp, session_id AS sessionId, provider, protocol, model,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              total_tokens AS totalTokens, duration_ms AS durationMs
       FROM request_stats${where}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return { records, total };
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("stats database is not open");
    return this.db;
  }
}

function statsWhere(filter: StatsFilter): { where: string; params: Param[] } {
  const clauses: string[] = [];
  const params: Param[] = [];
  if (filter.from) {
    clauses.push("timestamp >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("timestamp < ?");
    params.push(filter.to);
  }
  if (filter.provider) {
    clauses.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.protocol) {
    clauses.push("protocol = ?");
    params.push(filter.protocol);
  }
  if (filter.model) {
    clauses.push("model = ?");
    params.push(filter.model);
  }
  return {
    where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function statsBucketExpr(groupBy: string): string {
  switch (groupBy) {
    case "1h":
      return "substr(timestamp, 1, 10) || ' ' || substr(timestamp, 12, 2) || ':00'";
    case "week":
      return "substr(timestamp, 1, 4) || '-W' || substr(timestamp, 6, 2) || '-' || substr(timestamp, 9, 2)";
    case "month":
      return "substr(timestamp, 1, 7)";
    default:
      return "substr(timestamp, 1, 10)";
  }
}
