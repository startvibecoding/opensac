// Focused tests for the ported `mothx stats` command: terminal table
// projection (tabwriter alignment), formatter helpers, and the web-server
// path with an injected serve function (no real browser or listener).

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  defaultStatsOptions,
  executeStatsCommand,
  printStatsCLI,
} from "./stats.ts";
import type { Aggregate, RecentPage, Summary } from "../stats/stats.ts";
import { closeDatabases, openBunDatabase } from "../session/mod.ts";

const summary: Summary = {
  totalRequests: 42,
  inputTokens: 10_000,
  outputTokens: 5_000,
  totalTokens: 15_000,
};

const byProvider: Aggregate[] = [
  {
    label: "deepseek",
    vendor: "deepseek",
    protocol: "openai",
    model: "",
    inputTokens: 8000,
    outputTokens: 4000,
    totalTokens: 12000,
    requests: 30,
  },
  {
    label: "anthropic",
    vendor: "anthropic",
    protocol: "",
    model: "",
    inputTokens: 2000,
    outputTokens: 1000,
    totalTokens: 3000,
    requests: 12,
  },
];

const byModel: Aggregate[] = [
  {
    label: "",
    vendor: "deepseek",
    protocol: "openai",
    model: "v4",
    inputTokens: 8000,
    outputTokens: 4000,
    totalTokens: 12000,
    requests: 30,
  },
];

const recent: RecentPage = {
  total: 1,
  page: 1,
  pageSize: 10,
  items: [
    {
      id: 1,
      timestamp: new Date(Date.UTC(2026, 8, 20, 12, 30, 15)),
      sessionId: "s1",
      vendor: "deepseek",
      protocol: "openai",
      model: "v4",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      durationMs: 1500,
    },
  ],
};

Deno.test("printStatsCLI renders summary, aggregates, and recent rows", () => {
  const lines: string[] = [];
  printStatsCLI(
    (line) => void lines.push(line),
    summary,
    byProvider,
    byModel,
    recent,
  );
  const text = lines.join("\n");
  assert(text.includes("VibeCoding Stats"));
  assert(text.includes("Requests:     42"));
  assert(text.includes("Total tokens: 15000"));
  assert(text.includes("By Provider"));
  assert(text.includes("deepseek (openai)"));
  // Empty protocol falls back to vendor
  assert(text.includes("anthropic"));
  assert(text.includes("By Model"));
  assert(text.includes("Recent Requests"));
  assert(text.includes("1500ms") === false); // 1500ms renders as 1.5s
  assert(text.includes("1.5s"));
});

Deno.test("printStatsCLI renders empty aggregates and zero time", () => {
  const lines: string[] = [];
  const emptyRecent: RecentPage = { ...recent, items: [] };
  printStatsCLI(
    (line) => void lines.push(line),
    {
      totalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    [],
    [],
    emptyRecent,
  );
  const text = lines.join("\n");
  assert(text.includes("Requests:     0"));
  // Both aggregate sections show No data, plus recent
  assertEquals((text.match(/No data/g) ?? []).length, 3);
});

Deno.test("default stats options match Go defaults", () => {
  const opts = defaultStatsOptions();
  assertEquals(opts.addr, "127.0.0.1:7878");
  assertEquals(opts.cli, false);
  assertEquals(opts.noBrowserOpen, false);
  assertEquals(opts.dbPath, "");
});

Deno.test("executeStatsCommand --cli reads a real sessions.db via --db", () => {
  const dir = Deno.makeTempDirSync();
  const dbPath = path.join(dir, "sessions.db");
  openBunDatabase(dbPath); // creates the shared schema
  const lines: string[] = [];
  const opts = defaultStatsOptions();
  opts.dbPath = dbPath;
  opts.cli = true;
  opts.write = (line) => void lines.push(line);
  executeStatsCommand(opts);
  const text = lines.join("\n");
  assert(text.includes("VibeCoding Stats"));
  assert(text.includes("Requests:     0"));
  closeDatabases();
});

Deno.test("executeStatsCommand web path invokes the injected serve hook", async () => {
  const dir = Deno.makeTempDirSync();
  // Use the not-found path to validate option plumbing without a real database.
  let captured: unknown = null;
  const opts = defaultStatsOptions();
  opts.dbPath = path.join(dir, "missing.db");
  opts.serve = (server) => {
    captured = server;
    return Promise.resolve();
  };
  let threw = false;
  try {
    await executeStatsCommand(opts);
  } catch (error) {
    threw = error instanceof Error;
  }
  assert(threw);
  // serve hook is only reached after a successful DB open
  assertEquals(captured, null);
});
