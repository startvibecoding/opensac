// Tests for the pure ACP extension projections
// (internal/acp/extensions.go).

import { runtime } from "../platform/runtime.ts";
import { assertEquals } from "../compat/assert.ts";
import { type Project } from "../session/projects.ts";
import {
  acpProjectResult,
  formatRFC3339,
  isZeroTime,
  sessionListLastRun,
} from "./extensions.ts";
import { test } from "#testing";

test("acpProjectResult formats dates and honors the optional count", () => {
  const project: Project = {
    id: "p1",
    name: "Docs",
    createdAt: new Date("2026-09-20T05:00:00.250Z"),
    updatedAt: new Date("2026-09-20T06:00:00.000Z"),
  };
  assertEquals(acpProjectResult(project), {
    id: "p1",
    name: "Docs",
    createdAt: "2026-09-20T05:00:00Z",
    updatedAt: "2026-09-20T06:00:00Z",
  });
  assertEquals(acpProjectResult(project, 3).sessionCount, 3);

  const zero: Project = {
    id: "p2",
    name: "New",
    createdAt: new Date(NaN),
    updatedAt: new Date(NaN),
  };
  assertEquals(acpProjectResult(zero), { id: "p2", name: "New" });
  assertEquals(isZeroTime(new Date(NaN)), true);
  assertEquals(isZeroTime(new Date()), false);
});

test("sessionListLastRun degrades to an empty projection", () => {
  const sessionDir = runtime.makeTempDirSync();
  assertEquals(sessionListLastRun(sessionDir, []), {});
  assertEquals(sessionListLastRun(sessionDir, ["missing-1"]), {});
});

test("formatRFC3339 drops fractional seconds", () => {
  assertEquals(
    formatRFC3339(new Date("2026-09-20T05:00:00.999Z")),
    "2026-09-20T05:00:00Z",
  );
});
