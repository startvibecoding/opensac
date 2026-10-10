//
// The Go tests are darwin-only, but the profile builder and temp-profile
// lifecycle are platform-neutral, so they run everywhere.

import { runtime } from "../platform/runtime.ts";
import { assert, assertThrows } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { createMacSandbox, Level } from "./mod.ts";
import { test } from "#testing";

test("mac sandbox profile uses options", () => {
  const project = runtime.makeTempDirSync({ prefix: "sbx-" });
  const denied = path.join(project, "secret");
  const sb = createMacSandbox(project, Level.Standard, {
    allowNetwork: true,
    allowedRead: ["/opt/tool"],
    allowedWrite: ["/tmp/work"],
    deniedPaths: [denied],
  });
  const profile = sb.buildProfile({ workDir: project });
  for (const want of ["/opt/tool", "/tmp/work", denied]) {
    assert(profile.includes(want), `profile missing ${want}`);
  }
  assert(!profile.includes("(deny network*)"));
});

test("mac sandbox cleans up command profile", () => {
  const project = runtime.makeTempDirSync({ prefix: "sbx-" });
  const sb = createMacSandbox(project, Level.Standard);
  const spec = sb.wrapCommand(undefined, "/bin/sh", "true", {
    workDir: project,
  });
  const profilePath = spec.args[1];
  assert(profilePath !== undefined && profilePath !== "");
  runtime.statSync(profilePath);
  assert(spec.cleanup !== undefined);

  spec.cleanup?.();
  assertThrows(() => runtime.statSync(profilePath));
});
