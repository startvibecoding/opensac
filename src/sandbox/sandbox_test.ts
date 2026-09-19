// Ported from internal/sandbox/sandbox_test.go (bwrap cases live in bwrap_test.ts).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  formatSandboxInfo,
  Level,
  levelString,
  Manager,
  newManager,
  newNoneSandbox,
  parseLevel,
} from "./mod.ts";

Deno.test("levelString", () => {
  assertEquals(levelString(Level.Strict), "strict");
  assertEquals(levelString(Level.Standard), "standard");
  assertEquals(levelString(Level.None), "none");
  assertEquals(levelString(99 as Level), "unknown");
});

Deno.test("parseLevel", () => {
  assertEquals(parseLevel("strict"), Level.Strict);
  assertEquals(parseLevel("standard"), Level.Standard);
  assertEquals(parseLevel("none"), Level.None);
  assertThrows(() => parseLevel("invalid"));
});

Deno.test("newNoneSandbox", () => {
  const sb = newNoneSandbox();
  assertEquals(sb.name(), "none");
  assertEquals(sb.level(), Level.None);
  assert(sb.isAvailable());
});

Deno.test("noneSandbox wrapCommand uses platform shell args", () => {
  const sb = newNoneSandbox();

  const bash = sb.wrapCommand(undefined, "/bin/bash", "echo hello", {
    workDir: "/tmp",
  });
  assertEquals(bash.program, "/bin/bash");
  assertEquals(bash.args, ["-c", "echo hello"]);
  assertEquals(bash.cwd, "/tmp");

  const cmd = sb.wrapCommand(undefined, "cmd.exe", "echo hello", {});
  assertEquals(cmd.args, ["/c", "echo hello"]);

  const ps = sb.wrapCommand(undefined, "PowerShell.exe", "echo hello", {});
  assertEquals(ps.args, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "echo hello",
  ]);
});

Deno.test("newManager and default active level", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = newManager(project);
  // Default active sandbox is direct execution.
  assertEquals(m.getActive().level(), Level.None);
  m.setLevel(Level.None);
  assertEquals(m.getActive().level(), Level.None);
});

Deno.test("manager getForLevel", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = newManager(project);
  assertEquals(m.getForLevel(Level.None).level(), Level.None);
  assertThrows(() => m.getForLevel(99 as Level));
});

Deno.test("manager standard falls back on invalid policy", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  // A denied path that contains the project makes the policy invalid.
  const m = new Manager(project, { deniedPaths: [project] });
  m.setLevel(Level.Standard);
  assertEquals(m.getActive().level(), Level.None);
  assert(m.fallbackError() !== undefined);
});

Deno.test("manager strict does not fall back on invalid policy", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = new Manager(project, { deniedPaths: [project] });
  assertThrows(() => m.setLevel(Level.Strict));
});

Deno.test("manager with invalid policy still allows none", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = new Manager(project, { deniedPaths: [project] });
  m.setLevel(Level.None);
  assertEquals(m.getActive().level(), Level.None);
  assertThrows(() => m.getForLevel(Level.Strict));
});

Deno.test("formatSandboxInfo", () => {
  assert(formatSandboxInfo(newNoneSandbox()).includes("No sandbox"));
  assert(formatSandboxInfo(undefined).includes("No sandbox"));
});
