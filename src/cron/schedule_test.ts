//
// The Go tests pin UTC instants; this port uses local-time `Date` construction
// so the assertions are timezone-independent while still exercising the same
// local-time calendar arithmetic production uses (`cron` schedules from
// `time.Now()`).

import { assert, assertEquals, assertThrows } from "@opensac/assert";
import { parseSchedule } from "./schedule.ts";

Deno.test("ParseScheduleEmpty", () => {
  const { next, isOneShot } = parseSchedule("", new Date());
  assert(isOneShot, "expected one-shot for empty schedule");
  assertEquals(next, null);
});

Deno.test("ParseScheduleOnce", () => {
  const { next, isOneShot } = parseSchedule("@once", new Date());
  assert(isOneShot, "expected one-shot for @once");
  assertEquals(next, null);
});

Deno.test("ParseScheduleEveryDuration", () => {
  const now = new Date();
  const cases: [string, number][] = [
    ["@every 30m", 30 * 60 * 1000],
    ["@every 2h", 2 * 60 * 60 * 1000],
    ["@every 1d", 24 * 60 * 60 * 1000],
  ];
  for (const [schedule, wantDur] of cases) {
    const { next, isOneShot } = parseSchedule(schedule, now);
    assert(!isOneShot, `ParseSchedule(${schedule}): unexpected one-shot`);
    assertEquals(next!.getTime() - now.getTime(), wantDur, schedule);
  }
});

Deno.test("ParseScheduleNamed", () => {
  const now = new Date(2026, 4, 29, 15, 30, 0, 0);
  const cases: [string, Date][] = [
    ["@hourly", new Date(2026, 4, 29, 16, 30, 0, 0)],
    ["@daily", new Date(2026, 4, 30, 0, 0, 0, 0)],
    ["@monthly", new Date(2026, 5, 1, 0, 0, 0, 0)],
  ];
  for (const [schedule, wantNext] of cases) {
    const { next, isOneShot } = parseSchedule(schedule, now);
    assert(!isOneShot, `ParseSchedule(${schedule}): unexpected one-shot`);
    assertEquals(next!.getTime(), wantNext.getTime(), schedule);
  }
});

Deno.test("ParseScheduleWeekly", () => {
  // 2026-05-29 is a Friday; the next Monday is 2026-06-01.
  const from = new Date(2026, 4, 29, 15, 30, 0, 0);
  const { next, isOneShot } = parseSchedule("@weekly", from);
  assert(!isOneShot);
  assertEquals(next!.getTime(), new Date(2026, 5, 1, 0, 0, 0, 0).getTime());
});

Deno.test("ParseScheduleInvalid", () => {
  assertThrows(() => parseSchedule("invalid", new Date()));
  assertThrows(() => parseSchedule("@every xyz", new Date()));
  assertThrows(() => parseSchedule("@every 0s", new Date()));
});

Deno.test("ParseScheduleFiveFields", () => {
  const from = new Date(2026, 4, 29, 10, 30, 0, 0);
  const cases: [string, Date][] = [
    ["5 * * * *", new Date(2026, 4, 29, 11, 5, 0, 0)],
    ["*/5 9 * * *", new Date(2026, 4, 30, 9, 0, 0, 0)],
    ["0 9 * * 1", new Date(2026, 5, 1, 9, 0, 0, 0)],
    ["0 9 * * 0", new Date(2026, 4, 31, 9, 0, 0, 0)],
  ];
  for (const [expr, want] of cases) {
    const { next, isOneShot } = parseSchedule(expr, from);
    assert(!isOneShot, expr);
    assertEquals(next!.getTime(), want.getTime(), expr);
  }
});

Deno.test("ParseScheduleRejectsInvalidCronFields", () => {
  for (
    const expr of ["0 99 * * *", "0 9 32 * *", "0 9 * 13 *", "0 9 * * 8"]
  ) {
    assertThrows(
      () => parseSchedule(expr, new Date()),
      Error,
      undefined,
      `ParseSchedule(${expr}) accepted invalid field`,
    );
  }
});
