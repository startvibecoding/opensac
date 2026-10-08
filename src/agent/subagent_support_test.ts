// Focused tests for the stateless subagent/manager helpers ported from
// internal/agent (backlog #19).

import { assert, assertEquals, assertThrows } from "@opensac/assert";
import type { MemberDef } from "./memberdef.ts";
import {
  appendUniqueAgentID,
  buildSubAgentTask,
  defaultSubAgentPolicy,
  isTerminalManagedState,
  modeWithinCapability,
  removeAgentID,
  resolveMemberMode,
  restrictMemberTools,
  type SubAgentPolicy,
  subAgentToolNames,
  validateSubAgentPolicy,
} from "./subagent_support.ts";

// --- SubAgentPolicy tests (ported from subagent_test.go) ---

Deno.test("SubAgentPolicyDefault", () => {
  const p = defaultSubAgentPolicy();
  assertEquals(p.maxChildren, 5);
  assertEquals(p.allowedModes, ["plan", "agent", "yolo", "os"]);
  assertEquals(p.timeoutPerAgentMs, 30 * 60 * 1000);
});

Deno.test("SubAgentPolicyValidateTopLevel", () => {
  const p = defaultSubAgentPolicy();
  validateSubAgentPolicy(p, "", "yolo", 0);
});

Deno.test("SubAgentPolicyValidateAllowed", () => {
  const p = defaultSubAgentPolicy();
  validateSubAgentPolicy(p, "parent", "agent", 0);
});

Deno.test("SubAgentPolicyValidateMaxChildren", () => {
  const p = defaultSubAgentPolicy();
  assertThrows(() => validateSubAgentPolicy(p, "parent", "agent", 5));
});

Deno.test("SubAgentPolicyValidateDisallowedMode", () => {
  const p = defaultSubAgentPolicy();
  assertThrows(() => validateSubAgentPolicy(p, "parent", "admin", 0));
});

Deno.test("SubAgentPolicyValidateCustom", () => {
  const p: SubAgentPolicy = {
    maxChildren: 3,
    allowedModes: ["agent", "plan"],
    inheritSandbox: true,
    timeoutPerAgentMs: 0,
    totalTimeoutMs: 0,
  };
  validateSubAgentPolicy(p, "parent", "plan", 1);
  assertThrows(() => validateSubAgentPolicy(p, "parent", "yolo", 0));
  assertThrows(() => validateSubAgentPolicy(p, "parent", "agent", 3));
});

// --- SubAgentToolNames (adapted from subagent_tools_test.go) ---

Deno.test("SubAgentToolNamesAreCanonical", () => {
  const names = subAgentToolNames();
  assert(names.length > 0);
  const seen = new Set<string>();
  for (const name of names) {
    assert(name.startsWith("subagent_"), `${name} is not a subagent_* tool`);
    assert(!seen.has(name), `${name} is duplicated`);
    seen.add(name);
  }
});

Deno.test("SubAgentToolNamesReturnsAFreshArray", () => {
  const names = subAgentToolNames();
  names[0] = "mutated";
  assertEquals(subAgentToolNames()[0] === "mutated", false);
});

// --- mode capability / member resolution ---

Deno.test("ModeWithinCapabilityMonotonicReductions", () => {
  assert(modeWithinCapability("plan", "yolo"));
  assert(modeWithinCapability("agent", "yolo"));
  assert(modeWithinCapability("yolo", "yolo"));
  assertEquals(modeWithinCapability("yolo", "agent"), false);
  // OS is not a harmless restriction of agent/yolo.
  assertEquals(modeWithinCapability("os", "yolo"), false);
  assert(modeWithinCapability("plan", "os"));
  assert(modeWithinCapability("os", "os"));
  assertEquals(modeWithinCapability("plan", "unknown"), false);
});

Deno.test("ResolveMemberModeDefaultsAndCeilings", () => {
  // Empty parent mode defaults to yolo; a member may narrow to plan.
  const member: MemberDef = {
    id: "m",
    displayName: "M",
    emoji: "",
    role: "member",
    description: "",
    prompt: "",
    mode: "plan",
    tools: [],
    maxIterations: 0,
    workDir: "",
  };
  assertEquals(resolveMemberMode("", "", member), "plan");
  // A member declaring a broader mode than the parent is not honored.
  const broad = { ...member, mode: "yolo" };
  assertEquals(resolveMemberMode("plan", "", broad), "plan");
  // A requested mode within capability wins.
  assertEquals(resolveMemberMode("yolo", "agent"), "agent");
  // A requested mode exceeding capability throws.
  assertThrows(
    () => resolveMemberMode("plan", "yolo"),
    Error,
    "exceeds member/session capability",
  );
});

Deno.test("RestrictMemberToolsFiltersAndDedupes", () => {
  // Empty declaration retains the request.
  assertEquals(restrictMemberTools(["a", "b"], []), ["a", "b"]);
  // Empty request retains the declaration.
  assertEquals(restrictMemberTools([], ["a", "b"]), ["a", "b"]);
  // Unknown and duplicate names are dropped.
  assertEquals(
    restrictMemberTools(["a", "z", "a", "b"], ["a", "b"]),
    ["a", "b"],
  );
});

Deno.test("BuildSubAgentTaskWrapsInstruction", () => {
  const out = buildSubAgentTask("  do the thing  ");
  assert(out.startsWith("Delegated task:\ndo the thing\n"));
  assert(out.includes("Result: <the direct answer"));
});

// --- manager bookkeeping helpers ---

Deno.test("IsTerminalManagedState", () => {
  for (const state of ["done", "incomplete", "error", "canceled"]) {
    assert(isTerminalManagedState(state), state);
  }
  for (const state of ["running", "pending", ""]) {
    assertEquals(isTerminalManagedState(state), false);
  }
});

Deno.test("AppendUniqueAgentIDAvoidsDuplicates", () => {
  const ids: string[] = [];
  const first = appendUniqueAgentID(ids, "a");
  assertEquals(first, ["a"]);
  const second = appendUniqueAgentID(first, "b");
  assertEquals(second, ["a", "b"]);
  // Already present: the same slice is returned unchanged.
  assertEquals(appendUniqueAgentID(second, "a"), second);
});

Deno.test("RemoveAgentIDFilters", () => {
  assertEquals(removeAgentID([], "a"), []);
  assertEquals(removeAgentID(["a", "b", "a"], "a"), ["b"]);
  assertEquals(removeAgentID(["a"], "z"), ["a"]);
});
