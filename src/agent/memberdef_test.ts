// (pure cases).

import { assertEquals } from "../compat/assert.ts";
import { createMemberDefRegistry, type MemberDef } from "./memberdef.ts";
import { test } from "#testing";

function def(id: string, displayName = ""): MemberDef {
  return {
    id,
    displayName,
    emoji: "",
    role: "",
    description: "",
    prompt: "",
    mode: "",
    tools: [],
    maxIterations: 0,
    workDir: "",
  };
}

test("createMemberDefRegistry order and lookup", () => {
  const defs = [
    def("lead", "交付总监"),
    null,
    def(""),
    def("engineer", "工程师"),
    def("lead", "duplicate-ignored"),
  ];
  const r = createMemberDefRegistry(defs);

  assertEquals(r.ids(), ["lead", "engineer"]);

  const lead = r.get("lead");
  assertEquals(lead?.displayName, "交付总监");
  assertEquals(r.get("ghost"), undefined);

  const ids = r.ids();
  ids[0] = "mutated";
  assertEquals(r.ids(), ["lead", "engineer"]);
});

test("createMemberDefRegistry empty", () => {
  const r = createMemberDefRegistry([]);
  assertEquals(r.ids().length, 0);
  assertEquals(r.get("any"), undefined);
});
