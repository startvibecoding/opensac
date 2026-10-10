// Stateless helpers from internal/agent/subagent.go, subagent_tools.go, and
// manager.go, ported ahead of the not-yet-ported `Agent` core loop (backlog
// #19). The `Agent` struct, the sub-agent tools that call `AgentManager`, and
// the manager's agent lifecycle stay with the core-loop port; only the pure,
// front-end-neutral helpers live here so they can be tested and reused once the
// struct lands.
//
// Deliberate deviations from Go: `time.Duration` maps to a millisecond number;
// `*AgentManager` bookkeeping helpers operate on plain `AgentID[]` slices; and
// the `SubAgentPolicy.Validate` method maps to a free `validateSubAgentPolicy`
// function over the policy value.

import { type AgentID } from "../../sdk/agent/types.ts";
import { type MemberDef } from "./memberdef.ts";

/** Returns the canonical async sub-agent toolset, in registration order. */
export function subAgentToolNames(): string[] {
  return [
    "subagent_spawn",
    "subagent_status",
    "subagent_send",
    "subagent_answer",
    "subagent_destroy",
    "subagent_wait",
  ];
}

/**
 * Intersects a named member's requested mode with the parent mode and its
 * declared capability. The modes are deliberately not a simple numeric
 * hierarchy: OS mode exposes only bash but grants yolo-style execution, so it
 * must not be treated as a harmless restriction of agent or yolo.
 *
 * Throws when the requested mode would exceed the member/session capability.
 */
export function resolveMemberMode(
  parentMode: string,
  requestedMode: string,
  member?: MemberDef | null,
): string {
  parentMode = parentMode.trim();
  if (parentMode === "") parentMode = "yolo";
  let mode = parentMode;
  if (member != null && (member.mode ?? "").trim() !== "") {
    const declared = member.mode.trim();
    if (modeWithinCapability(declared, mode)) {
      mode = declared;
    }
  }
  requestedMode = requestedMode.trim();
  if (requestedMode === "") {
    return mode;
  }
  if (!modeWithinCapability(requestedMode, mode)) {
    throw new Error(
      `requested mode ${JSON.stringify(requestedMode)} exceeds ` +
        `member/session capability ${JSON.stringify(mode)}`,
    );
  }
  return requestedMode;
}

/**
 * Reports whether candidate can be run without granting more capability than
 * cap. Keeping OS separate is intentional: bash-only OS mode can still execute
 * arbitrary commands outside the sandbox.
 */
export function modeWithinCapability(candidate: string, cap: string): boolean {
  switch (cap) {
    case "plan":
      return candidate === "plan";
    case "agent":
      return candidate === "agent" || candidate === "plan";
    case "yolo":
      return (
        candidate === "yolo" || candidate === "agent" || candidate === "plan"
      );
    case "os":
      return candidate === "os" || candidate === "plan";
    default:
      return false;
  }
}

/**
 * Returns the requested subset of a member's declared tools. An empty request
 * retains the declaration; unknown or broader tool names are simply excluded so
 * an LLM cannot turn a restrictive persona into an all-tools child.
 */
export function restrictMemberTools(
  requested: string[],
  allowed: string[],
): string[] {
  if (allowed.length === 0) {
    return requested;
  }
  if (requested.length === 0) {
    return [...allowed];
  }
  const allowedSet = new Set(allowed);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (!allowedSet.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** Builds the standard delegated-task instruction wrapper for a sub-agent. */
export function buildSubAgentTask(task: string): string {
  task = task.trim();
  return `Delegated task:
${task}

Execute this task precisely. When done, structure your final response using this format:

Result: <the direct answer or completed change>
Evidence: <files inspected, commands run, test outputs — summarized>
Changes: <files modified with brief description, or "None">
Risks: <assumptions, uncertainty, follow-up needed, or "None">
`;
}

/** Defines security constraints for sub-agents. */
export interface SubAgentPolicy {
  /** Maximum number of sub-agents (default 5). */
  maxChildren: number;
  /** Allowed modes for sub-agents (default ["plan","agent","yolo","os"]). */
  allowedModes: string[];
  /** Inherit parent's sandbox (default true). */
  inheritSandbox: boolean;
  /** Per-agent timeout in milliseconds (default 30min). */
  timeoutPerAgentMs: number;
  /** Total timeout in milliseconds (default 30min). */
  totalTimeoutMs: number;
}

/** Returns the default policy. */
export function defaultSubAgentPolicy(): SubAgentPolicy {
  return {
    maxChildren: 5,
    allowedModes: ["plan", "agent", "yolo", "os"],
    inheritSandbox: true,
    timeoutPerAgentMs: 30 * 60 * 1000,
    totalTimeoutMs: 30 * 60 * 1000,
  };
}

/**
 * Checks whether a sub-agent creation request is allowed. Throws when the
 * request exceeds the policy.
 */
export function validateSubAgentPolicy(
  p: SubAgentPolicy,
  parentId: string,
  mode: string,
  currentChildCount: number,
): void {
  if (parentId === "") {
    return;
  }
  if (currentChildCount >= p.maxChildren) {
    throw new Error(`maximum ${p.maxChildren} sub-agents allowed`);
  }
  if (!p.allowedModes.includes(mode)) {
    throw new Error(
      `mode ${JSON.stringify(mode)} is not allowed for sub-agents; ` +
        `allowed: [${p.allowedModes.join(" ")}]`,
    );
  }
}

/** Reports whether a managed-agent state is terminal. */
export function isTerminalManagedState(state: string): boolean {
  return (
    state === "done" ||
    state === "incomplete" ||
    state === "error" ||
    state === "canceled"
  );
}

/**
 * Returns ids with id appended if absent. Mirrors the Go helper: the input slice
 * is returned unchanged when id is already present.
 */
export function appendUniqueAgentID(ids: AgentID[], id: AgentID): AgentID[] {
  for (const existing of ids) {
    if (existing === id) return ids;
  }
  return [...ids, id];
}

/** Returns ids with every occurrence of id removed (empty input yields []). */
export function removeAgentID(ids: AgentID[], id: AgentID): AgentID[] {
  if (ids.length === 0) {
    return [];
  }
  return ids.filter((existing) => existing !== id);
}
