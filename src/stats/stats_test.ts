//
// Raw INSERTs in the Go tests map to StatsDAO.insert over the shared
// connection; the test never constructs SQL itself.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { StatsDAO, type StatsRecord } from "../dao/mod.ts";
import { closeDatabases, openBunDatabase } from "../session/mod.ts";
import { dashboardHTML, opensacSmallICO } from "./assets.ts";
import { DB, type Query } from "./stats.ts";
import { test } from "#testing";

function insert(db: DB, record: Partial<StatsRecord>): void {
  const raw = db.database.db;
  if (raw === null) throw new Error("nil connection");
  const full: StatsRecord = {
    id: 0,
    timestamp: new Date().toISOString(),
    sessionId: null,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...record,
  };
  new StatsDAO(raw).insert(raw, full);
}

function createTestDB(): DB {
  const tmpDir = runtime.makeTempDirSync();
  const dbPath = path.join(tmpDir, "sessions.db");
  const f = runtime.openSync(dbPath, { create: true, write: true });
  f.close();
  return DB.open(dbPath);
}

test("DashboardUsesOpenSACSmallFavicon", () => {
  assert(dashboardHTML().includes('href="/opensac-small.ico"'));
  assert(opensacSmallICO().length > 0);
});

test("DashboardShareActivityUsesSevenDayFlameHeatmap", () => {
  const html = dashboardHTML();
  for (const expected of [
    "Last 7 days by 2-hour intensity",
    "groupBy: '1h'",
    "shareStartDate.setDate(shareStartDate.getDate() - 6)",
    "from: localDate(shareStartDate)",
    "const days = []",
    "const hourMap = {}",
    "const slotH = (chartH - slotGap * 11) / 12",
    "function flameColor(value)",
  ]) {
    assert(
      html.includes(expected),
      `dashboard share activity is missing ${expected}`,
    );
  }
});

test("Summary", () => {
  const db = createTestDB();
  insert(db, {
    timestamp: new Date().toISOString(),
    sessionId: "sess1",
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    durationMs: 2000,
  });

  const summary = db.summary({});
  assertEquals(summary.totalRequests, 1);
  assertEquals(summary.inputTokens, 1000);
  assertEquals(summary.outputTokens, 500);
  closeDatabases();
});

test("TimeSeries", () => {
  const db = createTestDB();
  for (let i = 0; i < 3; i++) {
    insert(db, {
      timestamp: isoUTC(2026, 6, 28 + i, 12),
      sessionId: "sess1",
      inputTokens: 100 * (i + 1),
      outputTokens: 50 * (i + 1),
      totalTokens: 150 * (i + 1),
      durationMs: 1000,
    });
  }
  const data = db.timeSeries({ groupBy: "day" });
  assertEquals(data.length, 3);
  closeDatabases();
});

test("TimeSeriesOneHour", () => {
  const db = createTestDB();
  const rows: Array<{ ts: string; totalTokens: number }> = [
    { ts: isoUTC(2026, 6, 28, 12, 40), totalTokens: 100 },
    { ts: isoUTC(2026, 6, 28, 14, 59, 59), totalTokens: 200 },
    { ts: isoUTC(2026, 6, 28, 15, 0, 0), totalTokens: 300 },
  ];
  for (const row of rows) {
    insert(db, {
      timestamp: row.ts,
      sessionId: "sess1",
      inputTokens: row.totalTokens,
      outputTokens: 0,
      totalTokens: row.totalTokens,
      durationMs: 1000,
    });
  }
  const data = db.timeSeries({ groupBy: "1h" });
  assertEquals(data.length, 3);
  assertEquals(data[0].label, "2026-06-28 12:00");
  assertEquals(data[0].totalTokens, 100);
  assertEquals(data[1].label, "2026-06-28 14:00");
  assertEquals(data[1].totalTokens, 200);
  assertEquals(data[2].label, "2026-06-28 15:00");
  assertEquals(data[2].totalTokens, 300);
  closeDatabases();
});

test("ByProvider", () => {
  const db = createTestDB();
  const now = new Date().toISOString();
  insert(db, {
    timestamp: now,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    sessionId: null,
  });
  insert(db, {
    timestamp: now,
    provider: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-3",
    inputTokens: 2000,
    outputTokens: 800,
    totalTokens: 2800,
    sessionId: null,
  });
  insert(db, {
    timestamp: now,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 1200,
    outputTokens: 600,
    totalTokens: 1800,
    sessionId: null,
  });

  const data = db.byProvider({});
  assertEquals(data.length, 2);
  assertEquals(data[0].vendor, "openai");
  assertEquals(data[0].protocol, "openai-chat");
  assertEquals(data[0].totalTokens, 3300);
  closeDatabases();
});

test("ByModel", () => {
  const db = createTestDB();
  const now = new Date().toISOString();
  insert(db, {
    timestamp: now,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 600,
    outputTokens: 300,
    totalTokens: 900,
    sessionId: null,
  });
  insert(db, {
    timestamp: now,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-3.5",
    inputTokens: 800,
    outputTokens: 200,
    totalTokens: 1000,
    sessionId: null,
  });
  insert(db, {
    timestamp: now,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 900,
    outputTokens: 300,
    totalTokens: 1200,
    sessionId: null,
  });

  const data = db.byModel({});
  assertEquals(data.length, 2);
  assertEquals(data[0].model, "gpt-4");
  assertEquals(data[0].totalTokens, 2100);
  closeDatabases();
});

test("Recent", () => {
  const db = createTestDB();
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    insert(db, {
      timestamp: now,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      sessionId: null,
    });
  }
  const page = db.recent(1, 3);
  assertEquals(page.items.length, 3);
  assertEquals(page.total, 5);
  assertEquals(page.page, 1);
  assertEquals(page.pageSize, 3);
  closeDatabases();
});

test("RecentFiltered", () => {
  const db = createTestDB();
  insert(db, {
    timestamp: "2026-07-02T10:00:00Z",
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    sessionId: null,
  });
  insert(db, {
    timestamp: "2026-07-03T10:00:00Z",
    provider: "moark",
    protocol: "openai-chat",
    model: "qwen3.6-plus",
    inputTokens: 200,
    outputTokens: 100,
    totalTokens: 300,
    sessionId: null,
  });

  const q: Query = {
    from: new Date(Date.UTC(2026, 6, 3, 0, 0, 0)),
    to: new Date(Date.UTC(2026, 6, 4, 0, 0, 0)),
    vendor: "moark",
  };
  const page = db.recentFiltered(q, 1, 20);
  assertEquals(page.total, 1);
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].vendor, "moark");
  assertEquals(page.items[0].model, "qwen3.6-plus");
  closeDatabases();
});

test("CurrentSchemaInitializationIsIdempotent", () => {
  const tmpDir = runtime.makeTempDirSync();
  const dbPath = path.join(tmpDir, "sessions.db");
  const f = runtime.openSync(dbPath, { create: true, write: true });
  f.close();

  const db1 = DB.open(dbPath);
  let count = countTable(db1, "request_stats");
  assertEquals(count, 1);
  db1.close();

  const db2 = DB.open(dbPath);
  count = countTable(db2, "schema_migrations");
  assertEquals(count, 1);
  db2.close();
  closeDatabases();
});

test("OpenUsesSharedSessionConnection", () => {
  const dbPath = path.join(runtime.makeTempDirSync(), "sessions.db");
  const shared = openBunDatabase(dbPath);

  const statsDB = DB.open(dbPath);
  statsDB.close();
  assert(
    statsDB.database === shared,
    "stats database must use the shared connection",
  );
  closeDatabases();
});

function countTable(db: DB, name: string): number {
  const raw = db.database.db;
  if (raw === null) throw new Error("nil connection");
  const rows = raw.query<Record<string, unknown>>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    name,
  );
  return Number(rows[0].n);
}

function isoUTC(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): string {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second),
  ).toISOString();
}
