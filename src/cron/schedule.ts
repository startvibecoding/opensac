//
// Parses a human-readable schedule string into a next-run time and stamps a
// job's mode/schedule normalization. Deviations from Go: `time.Time` maps to
// `Date` with `null` for Go's zero time and an explicit result object replacing
// Go's multiple return values.

import { type CronJob } from "./cron.ts";

/** The parsed result of a schedule expression. */
export interface ScheduleResult {
  /** The next run time, or `null` for a one-shot schedule. */
  next: Date | null;
  /** True when the schedule runs only once. */
  isOneShot: boolean;
}

/**
 * Parses a schedule into a next-run time. Supported formats:
 *
 *   ""           → one-shot (no next run)
 *   "@once"      → one-shot (same as empty)
 *   "@every 30m" → every 30 minutes
 *   "@every 2h"  → every 2 hours
 *   "@every 1d"  → every 1 day
 *   "@hourly"    → every 1 hour
 *   "@daily"     → every 24 hours (midnight)
 *   "@weekly"    → every 7 days
 *   "@monthly"   → 1st of next month
 */
export function parseSchedule(schedule: string, from: Date): ScheduleResult {
  const trimmed = schedule.trim();

  // Empty or @once → one-shot
  if (trimmed === "" || trimmed === "@once") {
    return { next: null, isOneShot: true };
  }

  // @every Xm / Xh / Xd
  if (trimmed.startsWith("@every ")) {
    const duration = parseDuration(trimmed.slice("@every ".length));
    if (duration <= 0) {
      throw new Error("@every duration must be positive");
    }
    return { next: new Date(from.getTime() + duration), isOneShot: false };
  }

  // Named schedules
  switch (trimmed.toLowerCase()) {
    case "@hourly":
      return {
        next: new Date(from.getTime() + 60 * 60 * 1000),
        isOneShot: false,
      };
    case "@daily": {
      const next = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate() + 1,
        0,
        0,
        0,
        0,
      );
      return { next, isOneShot: false };
    }
    case "@weekly": {
      let daysUntilMon = (8 - from.getDay()) % 7;
      if (daysUntilMon === 0) daysUntilMon = 7;
      const next = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate() + daysUntilMon,
        0,
        0,
        0,
        0,
      );
      return { next, isOneShot: false };
    }
    case "@monthly": {
      const next = new Date(
        from.getFullYear(),
        from.getMonth() + 1,
        1,
        0,
        0,
        0,
        0,
      );
      return { next, isOneShot: false };
    }
  }

  // Try standard 5-field cron: min hour day month weekday
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return parseCronExpr(parts, from);
  }

  throw new Error(
    `unsupported schedule format: "${schedule}" (use @every Xm, @hourly, @daily, @weekly, @monthly, or 5-field cron)`,
  );
}

/**
 * Parses "30m", "2h", "1d" into milliseconds. Mirrors Go's `time.ParseDuration`
 * plus the `d` (day) extension.
 */
function parseDuration(s: string): number {
  if (s.endsWith("d")) {
    const n = Number(s.slice(0, -1));
    if (!Number.isInteger(n)) throw new Error(`invalid duration ${s}`);
    return n * 24 * 60 * 60 * 1000;
  }
  return parseGoDuration(s);
}

const DURATION_UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "\u00b5s": 1e-3,
  "\u03bcs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parses a Go-style duration string (for example "1h30m") into milliseconds. */
function parseGoDuration(s: string): number {
  const re = /([0-9]*\.?[0-9]+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/g;
  let total = 0;
  let matched = "";
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * DURATION_UNITS[m[2]];
    matched += m[0];
  }
  if (matched === "" || matched !== s) {
    throw new Error(`invalid duration ${s}`);
  }
  return total;
}

/**
 * Handles standard five-field cron expressions. Fields support exact values,
 * `* /N` steps, comma-separated values, and inclusive ranges.
 */
function parseCronExpr(fields: string[], from: Date): ScheduleResult {
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const sets: boolean[][] = [];
  for (let i = 0; i < fields.length; i++) {
    const values = parseCronField(fields[i], ranges[i][0], ranges[i][1]);
    if (i === 4) {
      // Cron accepts both 0 and 7 for Sunday.
      values[0] = values[0] || values[7];
      values[7] = values[0];
    }
    sets.push(values);
  }

  // Cron schedules operate on minute boundaries. Search a bounded horizon so
  // impossible dates (for example 31 February) return a validation error.
  let next = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const maxMinutes = 5 * 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    const month = next.getMonth() + 1;
    let weekday = next.getDay();
    if (weekday === 0) weekday = 7;
    const dayMatches = sets[2][next.getDate()] && sets[3][month];
    const weekdayMatches = sets[4][weekday];
    // When both day-of-month and weekday are restricted, cron uses OR; if
    // either is wildcard, both conditions reduce to the normal AND.
    const dayWildcard = cronFieldIsWildcard(fields[2]);
    const weekdayWildcard = cronFieldIsWildcard(fields[4]);
    let dayOK = dayMatches && weekdayMatches;
    if (!dayWildcard && !weekdayWildcard) {
      dayOK = (sets[2][next.getDate()] && sets[3][month]) || weekdayMatches;
    } else if (dayWildcard) {
      dayOK = weekdayMatches && sets[3][month];
    } else if (weekdayWildcard) {
      dayOK = dayMatches;
    }
    if (sets[0][next.getMinutes()] && sets[1][next.getHours()] && dayOK) {
      return { next, isOneShot: false };
    }
    next = new Date(next.getTime() + 60_000);
  }
  throw new Error("cron expression has no occurrence within five years");
}

function parseIntStrict(raw: string): number {
  if (!/^[+-]?\d+$/.test(raw)) throw new Error("invalid value");
  return Number.parseInt(raw, 10);
}

function parseCronField(field: string, min: number, max: number): boolean[] {
  const values = new Array<boolean>(max + 1).fill(false);
  for (const item of field.trim().split(",")) {
    if (item === "") throw new Error("empty value");
    let base = item;
    let step = 1;
    if (item.includes("/")) {
      const parts = item.split("/");
      if (parts.length !== 2 || parts[1] === "") {
        throw new Error("invalid step");
      }
      step = Number.parseInt(parts[1], 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error("step must be positive");
      }
      base = parts[0];
    }
    let lo = min;
    let hi = max;
    if (base === "*") {
      // wildcard: keep the full range
    } else if (base.includes("-")) {
      const parts = base.split("-");
      if (parts.length !== 2) throw new Error("invalid range");
      lo = parseIntStrict(parts[0]);
      hi = parseIntStrict(parts[1]);
    } else {
      lo = parseIntStrict(base);
      hi = lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`value out of range ${min}-${max}`);
    }
    for (let value = lo; value <= hi; value += step) {
      values[value] = true;
    }
  }
  return values;
}

function cronFieldIsWildcard(field: string): boolean {
  return field.trim() === "*";
}

/**
 * Validates a job's mode and schedule and computes its NextRun. It is the
 * canonical normalization for management surfaces that create or update jobs:
 * an empty mode defaults to yolo, only agent/yolo are accepted, and an empty
 * (or @once) schedule marks the job one-shot with no next run.
 *
 * Returns a new normalized job rather than mutating the input (Go mutates the
 * pointer).
 */
export function normalizeJobSchedule(job: CronJob): CronJob {
  if (!job) throw new Error("cron job required");
  const mode = job.mode || "yolo";
  if (mode !== "agent" && mode !== "yolo") {
    throw new Error("mode must be agent or yolo");
  }

  const { next, isOneShot } = parseSchedule(job.schedule ?? "", new Date());
  if (job.oneShot || isOneShot) {
    return { ...job, mode, oneShot: true, nextRun: null };
  }
  return { ...job, mode, oneShot: false, nextRun: next };
}
