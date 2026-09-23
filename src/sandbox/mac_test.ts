//
// The Go tests are darwin-only, but the profile builder and temp-profile
// lifecycle are platform-neutral, so they run everywhere.

import { assert, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { createMacSandbox, Level } from "./mod.ts";

Deno.test("mac sandbox profile uses options", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
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

Deno.test("mac sandbox cleans up command profile", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = createMacSandbox(project, Level.Standard);
  const spec = sb.wrapCommand(undefined, "/bin/sh", "true", {
    workDir: project,
  });
  const profilePath = spec.args[1];
  assert(profilePath !== undefined && profilePath !== "");
  Deno.statSync(profilePath);
  assert(spec.cleanup !== undefined);

  spec.cleanup?.();
  assertThrows(() => Deno.statSync(profilePath));
});
