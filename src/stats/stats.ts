//
// Package stats provides usage-statistics queries over the request_stats table
// and an HTTP dashboard that renders them.

import * as path from "@std/path";
import type { DB as RawDB } from "../db/mod.ts";
import {
  type Database,
  StatsDAO,
  type StatsFilter,
  type StatsRecord,
} from "../dao/mod.ts";
import { sessionDir } from "../platform/platform.ts";
import { openBunDatabase } from "../session/mod.ts";

/** Represents a single recorded LLM request. */
export interface StatsEntry {
  id: number;
  timestamp: Date;
  sessionId: string;
  vendor: string;
  protocol: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}

/** Represents aggregated stats for a dimension. */
export interface Aggregate {
  label: string;
  vendor: string;
  protocol: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

/** Represents overall statistics summary. */
export interface Summary {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Represents a stats query with filters. */
export interface Query {
  from?: Date;
  to?: Date;
  vendor?: string;
  protocol?: string;
  model?: string;
  /** "day", "1h", "week", "month", "provider", "model". */
  groupBy?: string;
}

/** A paginated result of recent stats entries. */
export interface RecentPage {
  items: StatsEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Wraps a shared SQLite connection for stats queries. */
export class DB {
  // Retained for backwards-compatible test and integration access to the shared
  // connection. Queries in this package use statsDAO.
  #db: Database;
  #statsDAO: StatsDAO;

  constructor(db: Database, statsDAO: StatsDAO) {
    this.#db = db;
    this.#statsDAO = statsDAO;
  }

  /** The DAO-facing handle to the shared connection. */
  get database(): Database {
    return this.#db;
  }

  /** The stats DAO bound to the shared connection. */
  get statsDAO(): StatsDAO {
    return this.#statsDAO;
  }

  /** Opens the stats database at the given sessions.db path. */
  static open(dbPath: string): DB {
    let exists = true;
    try {
      Deno.statSync(dbPath);
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new Error(`database not found: ${dbPath}`);
    }
    let db: Database;
    try {
      db = openBunDatabase(dbPath);
    } catch (err) {
      throw new Error(`open database: ${(err as Error).message}`);
    }
    const raw = db.db;
    if (raw === null) throw new Error("database is not open");
    return new DB(db, new StatsDAO(raw));
  }

  /** Opens the default sessions.db in the user's config directory. */
  static openDefault(): DB {
    const dbPath = path.join(sessionDir(), "sessions.db");
    return DB.open(dbPath);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * Releases the stats wrapper. The shared session connection is closed by
   * session.CloseDatabases during process shutdown.
   */
  close(): void {
    // no-op
  }

  /** Returns overall summary statistics for the given query. */
  summary(q: Query): Summary {
    const record = this.#statsDAO.summary(statsFilter(q));
    return {
      totalRequests: record.totalRequests,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
    };
  }

  /** Returns time-bucketed stats for charting. */
  timeSeries(q: Query): Aggregate[] {
    const records = this.#statsDAO.timeSeries(statsFilter(q), q.groupBy ?? "");
    return records.map((record) => ({
      label: record.label,
      vendor: "",
      protocol: "",
      model: "",
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      requests: record.requests,
    }));
  }

  /** Returns stats grouped by vendor and protocol. */
  byProvider(q: Query): Aggregate[] {
    const records = this.#statsDAO.byProvider(statsFilter(q));
    return records.map((record) => ({
      label: record.vendor,
      vendor: record.vendor,
      protocol: record.protocol,
      model: "",
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      requests: record.requests,
    }));
  }

  /** Returns stats grouped by model. */
  byModel(q: Query): Aggregate[] {
    const records = this.#statsDAO.byModel(statsFilter(q));
    return records.map((record) => ({
      label: record.model,
      model: record.model,
      vendor: record.vendor,
      protocol: record.protocol,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      requests: record.requests,
    }));
  }

  /** Returns a paginated list of stats entries, most recent first. */
  recent(page: number, pageSize: number): RecentPage {
    return this.recentFiltered({}, page, pageSize);
  }

  /**
   * Returns a paginated list of stats entries matching the query, most recent
   * first.
   */
  recentFiltered(q: Query, page: number, pageSize: number): RecentPage {
    if (pageSize <= 0) pageSize = 20;
    if (page <= 0) page = 1;

    const { records, total } = this.#statsDAO.recent(
      statsFilter(q),
      page,
      pageSize,
    );
    const results: StatsEntry[] = records.map((record) => ({
      id: record.id,
      timestamp: parseTimestamp(record.timestamp),
      sessionId: record.sessionId ?? "",
      vendor: record.provider,
      protocol: record.protocol,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      durationMs: record.durationMs,
    }));
    return { items: results, total, page, pageSize };
  }
}

function parseTimestamp(value: string): Date {
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Formats a Date as RFC3339Nano-style UTC. */
function formatRFC3339Nano(d: Date): string {
  // JavaScript dates carry millisecond precision; trim trailing zero millis to
  // match Go's RFC3339Nano output shape.
  const iso = d.toISOString();
  if (iso.endsWith(".000Z")) {
    return iso.slice(0, -5) + "Z";
  }
  return iso;
}

function statsFilter(q: Query): StatsFilter {
  const filter: StatsFilter = {
    provider: q.vendor,
    protocol: q.protocol,
    model: q.model,
  };
  if (q.from && !isNaN(q.from.getTime())) {
    filter.from = formatRFC3339Nano(q.from);
  }
  if (q.to && !isNaN(q.to.getTime())) {
    filter.to = formatRFC3339Nano(q.to);
  }
  return filter;
}

/** A raw connection type kept for the DAO insert helper used by tests. */
export type { RawDB, StatsRecord };
