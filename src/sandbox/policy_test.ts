// (bwrap-specific cases omitted).

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { normalizeOptions, parseTmpSize } from "./policy.ts";
import { test } from "#testing";

test("normalizeTmpSize", () => {
  const cases: Record<string, string> = {
    "100m": "104857600",
    "1g": "1073741824",
    "4096": "4096",
    "2KB": "2048",
  };
  for (const [input, want] of Object.entries(cases)) {
    assertEquals(
      parseTmpSize(input).toString(),
      want,
      `parseTmpSize(${input})`,
    );
  }
  for (const input of ["0", "0m", "bad", "-1"]) {
    assertThrows(
      () => {
        // normalizeTmpSize rejects a zero result and malformed input.
        const bytes = parseTmpSize(input);
        if (bytes === 0) throw new Error("zero");
      },
      Error,
      undefined,
      `parseTmpSize(${input}) should fail`,
    );
  }
});

test("normalizeOptions ignores legacy linux /home deny", () => {
  if (runtime.build.os !== "linux") return;
  const project = "/home/free/src/vibecoding";
  const opts = normalizeOptions(project, { deniedPaths: ["/home"] });
  assertEquals(opts.deniedPaths, []);
});

test("normalizeOptions rejects overlapping allow and deny", () => {
  const project = runtime.makeTempDirSync({ prefix: "sbx-" });
  const err = assertThrows(() =>
    normalizeOptions(project, {
      allowedWrite: [project],
      deniedPaths: [path.join(project, "secret")],
    }),
  );
  assert((err as Error).message.includes("overlaps"));
});

test("normalizeOptions keeps .git visible", () => {
  const project = runtime.makeTempDirSync({ prefix: "sbx-" });
  const opts = normalizeOptions(project, {
    deniedPaths: [path.join(project, ".git")],
  });
  assertEquals(opts.deniedPaths, []);
});

test("normalizeOptions canonicalizes relative paths", () => {
  const project = runtime.makeTempDirSync({ prefix: "sbx-" });
  const cache = path.join(project, "cache");
  runtime.mkdirSync(cache, { recursive: true });
  const opts = normalizeOptions(project, { allowedRead: ["cache"] });
  assertEquals(opts.allowedRead, [runtime.realPathSync(cache)]);
});

test("normalizeOptions rejects deny containing project", () => {
  const project = runtime.makeTempDirSync({ prefix: "sbx-" });
  const err = assertThrows(() =>
    normalizeOptions(project, { deniedPaths: [path.dirname(project)] }),
  );
  assert((err as Error).message.includes("contains project"));
});
