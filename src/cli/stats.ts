// the `stats` subcommand. Runs the
// dashboard HTTP server (src/stats, already migrated) or prints the summary
// tables directly in the terminal. The browser opener is best-effort and
// never fatal, matching the Go command.

import * as path from "@std/path";
import {
  type Aggregate,
  DB,
  type RecentPage,
  type Summary,
} from "../stats/stats.ts";
import { Server } from "../stats/server.ts";
import { getSessionDir, loadSettings } from "../config/mod.ts";

export interface StatsCommandOptions {
  addr: string;
  dbPath: string;
  cli: boolean;
  noBrowserOpen: boolean;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
  /** Injectable opener (tests avoid spawning a browser). */
  openURL?: (url: string) => Promise<void> | void;
  /** Injectable server factory for tests. */
  serve?: (server: Server) => Promise<void>;
}

export function defaultStatsOptions(): StatsCommandOptions {
  return {
    addr: "127.0.0.1:7878",
    dbPath: "",
    cli: false,
    noBrowserOpen: false,
  };
}

function resolveStatsDBPath(dbPath: string): string {
  if (dbPath !== "") return dbPath;
  const settings = loadSettings();
  return path.join(getSessionDir(settings), "sessions.db");
}

/** Opens the stats database, surfacing the same wrapped errors as Go. */
export function openStatsDB(options: StatsCommandOptions): DB {
  const dbPath = resolveStatsDBPath(options.dbPath);
  try {
    return DB.open(dbPath);
  } catch (err) {
    throw new Error(`open stats database: ${(err as Error).message}`);
  }
}

/** Executes the stats command (web dashboard or terminal tables). */
export async function executeStatsCommand(
  options: StatsCommandOptions,
): Promise<void> {
  const db = openStatsDB(options);
  try {
    if (options.cli) {
      runStatsCLI(options.write ?? ((line) => console.log(line)), db);
      return;
    }
    await runStatsServer(db, options);
  } finally {
    db.close();
  }
}

function runStatsCLI(write: (line: string) => void, db: DB): void {
  const query = {};
  const summary = db.summary(query);
  const byProvider = db.byProvider(query);
  const byModel = db.byModel(query);
  const recent = db.recent(1, 10);
  printStatsCLI(write, summary, byProvider, byModel, recent);
}

async function runStatsServer(
  db: DB,
  options: StatsCommandOptions,
): Promise<void> {
  const server = new Server(db, options.addr);
  const url = `http://${options.addr}`;
  if (!options.noBrowserOpen) {
    const openURL = options.openURL ?? openInDefaultBrowser;
    try {
      await openURL(url);
    } catch (err) {
      const writeError = options.writeError ??
        ((line) => console.error(line));
      writeError(
        `stats dashboard: could not open browser: ${(err as Error).message}`,
      );
      writeError(`stats dashboard: open ${url} manually`);
    }
  }
  if (options.serve !== undefined) {
    await options.serve(server);
    return;
  }
  server.start();
  await server.finished();
}

// ─── terminal projection ────────────────────────────────────────────────────

/** Renders the same tab-separated tables as the Go CLI (aligned with 2 cols). */
export function printStatsCLI(
  write: (line: string) => void,
  summary: Summary,
  byProvider: Aggregate[],
  byModel: Aggregate[],
  recent: RecentPage,
): void {
  const rows: string[] = [];
  rows.push("VibeCoding Stats");
  rows.push("");
  rows.push(`Requests:     ${formatStatsInt(summary.totalRequests)}`);
  rows.push(`Input tokens: ${formatStatsInt(summary.inputTokens)}`);
  rows.push(`Output tokens: ${formatStatsInt(summary.outputTokens)}`);
  rows.push(`Total tokens: ${formatStatsInt(summary.totalTokens)}`);

  appendAggregates(
    rows,
    "By Provider",
    "Provider",
    byProvider,
    5,
    (a) => a.protocol === "" ? a.vendor : `${a.vendor} (${a.protocol})`,
  );
  appendAggregates(
    rows,
    "By Model",
    "Model",
    byModel,
    5,
    (a) => a.model !== "" ? a.model : a.label,
  );

  rows.push("");
  rows.push("Recent Requests");
  if (recent.items.length === 0) {
    rows.push("  No data");
  } else {
    rows.push(
      [
        "Time",
        "Provider",
        "Protocol",
        "Model",
        "Input",
        "Output",
        "Duration",
      ].join("\t"),
    );
    for (const item of recent.items) {
      rows.push([
        formatStatsTime(item.timestamp),
        emptyDash(item.vendor),
        emptyDash(item.protocol),
        emptyDash(item.model),
        formatStatsInt(item.inputTokens),
        formatStatsInt(item.outputTokens),
        formatStatsDuration(item.durationMs),
      ].join("\t"));
    }
  }

  for (const line of alignColumns(rows)) write(line);
}

function appendAggregates(
  rows: string[],
  title: string,
  labelHeader: string,
  aggregates: Aggregate[],
  limit: number,
  labelFn: (a: Aggregate) => string,
): void {
  rows.push("");
  rows.push(title);
  if (aggregates.length === 0) {
    rows.push("  No data");
    return;
  }
  rows.push(
    [labelHeader, "Requests", "Input", "Output", "Total"].join("\t"),
  );
  for (let i = 0; i < Math.min(limit, aggregates.length); i++) {
    const row = aggregates[i];
    rows.push([
      emptyDash(labelFn(row)),
      formatStatsInt(row.requests),
      formatStatsInt(row.inputTokens),
      formatStatsInt(row.outputTokens),
      formatStatsInt(row.totalTokens),
    ].join("\t"));
  }
}

/** Pads tab-separated columns to a minimum 2-space gap (text/tabwriter shape). */
function alignColumns(lines: string[]): string[] {
  const split = lines.map((line) => line.split("\t"));
  const columnCount = Math.max(...split.map((cells) => cells.length));
  const widths = new Array<number>(columnCount).fill(0);
  for (const cells of split) {
    if (cells.length < 2) continue;
    cells.forEach((cell, i) => {
      if (i < cells.length - 1) widths[i] = Math.max(widths[i], cell.length);
    });
  }
  return split.map((cells) => {
    if (cells.length < 2) return cells.join("");
    return cells.map((cell, i) => {
      if (i === cells.length - 1) return cell;
      return cell.padEnd(widths[i] + 2, " ");
    }).join("");
  });
}

function formatStatsInt(n: number): string {
  return String(n);
}

function formatStatsTime(t: Date): string {
  if (t.getTime() === 0) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = new Date(t);
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${
    pad(local.getDate())
  } ${pad(local.getHours())}:${pad(local.getMinutes())}:${
    pad(local.getSeconds())
  }`;
}

function formatStatsDuration(ms: number): string {
  if (ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function emptyDash(s: string): string {
  return s.trim() === "" ? "-" : s;
}

/** Best-effort cross-platform URL opener; rejects when no candidate exists. */
export async function openInDefaultBrowser(url: string): Promise<void> {
  const candidates = browserCommands();
  for (const [command, ...args] of candidates) {
    const found = await commandExists(command);
    if (!found) continue;
    const child = new Deno.Command(command, { args: [...args, url] }).spawn();
    await child.status;
    return;
  }
  throw new Error("no browser opener found");
}

function browserCommands(): string[][] {
  switch (Deno.build.os) {
    case "darwin":
      return [["open"]];
    case "windows":
      return [["rundll32", "url.dll,FileProtocolHandler"]];
    default:
      return [["xdg-open"], ["gio", "open"], ["sensible-browser"]];
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const args = Deno.build.os === "windows"
      ? ["where", command]
      : ["which", command];
    const result = await new Deno.Command(args[0], {
      args: args.slice(1),
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}
