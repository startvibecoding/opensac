// Focused tests for the TUI command-spec layer: the spec table mirrors the
// Go commandSpecs (names, usage strings, i18n message IDs), and the input
// parser reproduces handleCommand's dispatch prologue (strings.Fields,
// /skill: prefix, slash commands, plain text).

import { assert, assertEquals } from "../compat/assert.ts";
import {
  commandSpecs,
  findCommandSpec,
  isKnownCommand,
  parseInputLine,
  splitFields,
} from "./command_specs.ts";
import { test } from "#testing";

test("commandSpecs keeps the Go spec table exactly", () => {
  // Names in Go declaration order (command_specs.go)
  const expectedNames = [
    "/auth",
    "/settings",
    "/tuilang",
    "/mode",
    "/esm",
    "/model",
    "/defaultModel",
    "/env",
    "/skillhub",
    "/skillmgr",
    "/skill",
    "/paste-image",
    "/clear",
    "/compact",
    "/sessions",
    "/expert",
    "/init_mcp",
    "/mcps",
    "/delegate",
    "/browser",
    "/stats",
    "/statusline",
    "/alloweditpath",
    "/allowautoedit",
    "/btw",
    "/systeminit",
    "/rule",
    "/reload",
    "/workflows",
    "/agent",
    "/cron",
    "/help",
    "/quit",
  ];
  assertEquals(commandSpecs.map((s) => s.name), expectedNames);
  // Usage strings are protocol text and must remain English/unchanged.
  assertEquals(findCommandSpec("/mode")?.usage, "/mode [plan|agent|yolo|os]");
  assertEquals(
    findCommandSpec("/sessions")?.usage,
    "/sessions [ls|set <id>|clear|del <id>]",
  );
  // i18n message IDs use the Go bundle's dotted keys.
  assertEquals(
    findCommandSpec("/auth")?.description,
    "commands.auth.description",
  );
  assertEquals(
    findCommandSpec("/defaultModel")?.description,
    "commands.default_model.description",
  );
});

test("splitFields collapses whitespace like strings.Fields", () => {
  assertEquals(splitFields(""), []);
  assertEquals(splitFields("   "), []);
  assertEquals(splitFields("  /model   deepseek-v4  "), [
    "/model",
    "deepseek-v4",
  ]);
  assertEquals(splitFields("a\tb\nc"), ["a", "b", "c"]);
});

test("parseInputLine dispatches commands, skills, and text", () => {
  assertEquals(parseInputLine(""), { kind: "text", command: "", args: [] });

  const cmd = parseInputLine("/mode yolo");
  assertEquals(cmd.kind, "command");
  assertEquals(cmd.command, "/mode");
  assertEquals(cmd.args, ["yolo"]);

  const skill = parseInputLine("/skill:refactor this  please");
  assertEquals(skill.kind, "skill");
  assertEquals(skill.command, "/skill:refactor");
  assertEquals(skill.args, ["this", "please"]);

  // Bare "/skill:" activates skill listing (empty name still a skill form)
  const emptySkill = parseInputLine("/skill:");
  assertEquals(emptySkill.kind, "skill");

  const text = parseInputLine("explain the build failure");
  assertEquals(text.kind, "text");
  assertEquals(text.command, "");
});

test("isKnownCommand recognizes specs and rejects unknowns", () => {
  assert(isKnownCommand("/help"));
  assert(isKnownCommand("/quit"));
  assertEquals(isKnownCommand("/bogus"), false);
  assertEquals(isKnownCommand(""), false);
});
