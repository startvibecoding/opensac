// (pure cases).

import { assertEquals } from "@std/assert";
import { type MemberDef, newMemberDefRegistry } from "./memberdef.ts";

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

Deno.test("newMemberDefRegistry order and lookup", () => {
  const defs = [
    def("lead", "交付总监"),
    null,
    def(""),
    def("engineer", "工程师"),
    def("lead", "duplicate-ignored"),
  ];
  const r = newMemberDefRegistry(defs);

  assertEquals(r.ids(), ["lead", "engineer"]);

  const lead = r.get("lead");
  assertEquals(lead?.displayName, "交付总监");
  assertEquals(r.get("ghost"), undefined);

  const ids = r.ids();
  ids[0] = "mutated";
  assertEquals(r.ids(), ["lead", "engineer"]);
});

Deno.test("newMemberDefRegistry empty", () => {
  const r = newMemberDefRegistry([]);
  assertEquals(r.ids().length, 0);
  assertEquals(r.get("any"), undefined);
});
