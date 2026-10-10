// (bwrap cases live in bwrap_test.ts).

import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import {
  createManager,
  createNoneSandbox,
  formatSandboxInfo,
  Level,
  levelString,
  Manager,
  parseLevel,
} from "./mod.ts";
import { test } from "#testing";

test("levelString", () => {
  assertEquals(levelString(Level.Strict), "strict");
  assertEquals(levelString(Level.Standard), "standard");
  assertEquals(levelString(Level.None), "none");
  assertEquals(levelString(99 as Level), "unknown");
});

test("parseLevel", () => {
  assertEquals(parseLevel("strict"), Level.Strict);
  assertEquals(parseLevel("standard"), Level.Standard);
  assertEquals(parseLevel("none"), Level.None);
  assertThrows(() => parseLevel("invalid"));
});

test("createNoneSandbox", () => {
  const sb = createNoneSandbox();
  assertEquals(sb.name(), "none");
  assertEquals(sb.level(), Level.None);
  assert(sb.isAvailable());
});

test("noneSandbox wrapCommand uses platform shell args", () => {
  const sb = createNoneSandbox();

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

test("createManager and default active level", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = createManager(project);
  // Default active sandbox is direct execution.
  assertEquals(m.getActive().level(), Level.None);
  m.setLevel(Level.None);
  assertEquals(m.getActive().level(), Level.None);
});

test("manager getForLevel", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = createManager(project);
  assertEquals(m.getForLevel(Level.None).level(), Level.None);
  assertThrows(() => m.getForLevel(99 as Level));
});

test("manager standard falls back on invalid policy", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  // A denied path that contains the project makes the policy invalid.
  const m = new Manager(project, { deniedPaths: [project] });
  m.setLevel(Level.Standard);
  assertEquals(m.getActive().level(), Level.None);
  assert(m.fallbackError() !== undefined);
});

test("manager strict does not fall back on invalid policy", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = new Manager(project, { deniedPaths: [project] });
  assertThrows(() => m.setLevel(Level.Strict));
});

test("manager with invalid policy still allows none", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const m = new Manager(project, { deniedPaths: [project] });
  m.setLevel(Level.None);
  assertEquals(m.getActive().level(), Level.None);
  assertThrows(() => m.getForLevel(Level.Strict));
});

test("formatSandboxInfo", () => {
  assert(formatSandboxInfo(createNoneSandbox()).includes("No sandbox"));
  assert(formatSandboxInfo(undefined).includes("No sandbox"));
});
