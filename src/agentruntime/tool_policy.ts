// Ported from internal/agentruntime/tool_policy.go.
//
// The non-overridable source policy evaluated before approval: a forced mode
// controls agent behavior only, it never disables this guard. High-risk bash
// detection tokenizes shell control operators and executable paths so quoting,
// compound commands, and common flag variants cannot bypass it.
//
// Deviation: Go's `(p ExecutionPolicy) EvaluateToolCall` method maps to the
// standalone `evaluateToolCall(policy, toolName, args)` free function so this
// module stays free of a source.ts import cycle.

import type {
  BeforeToolCallContext,
  ToolCallBlockResult,
} from "../agent/agent.ts";
import type { ExecutionPolicy } from "./source.ts";

/** CommandRisk is the unattended-execution risk assigned to a bash command. */
export type CommandRisk = "low" | "medium" | "high";

export const CommandRiskLow: CommandRisk = "low";
export const CommandRiskMedium: CommandRisk = "medium";
export const CommandRiskHigh: CommandRisk = "high";

/** ToolCallPolicyDecision is the source policy result for one tool call. */
export interface ToolCallPolicyDecision {
  block: boolean;
  reason: string;
}

/** The empty (allow) decision returned when no source policy applies. */
const ALLOW: ToolCallPolicyDecision = { block: false, reason: "" };

/**
 * Applies non-overridable source policy before approval. A forced mode controls
 * agent behavior only; it never disables this guard.
 */
export function evaluateToolCall(
  policy: ExecutionPolicy,
  toolName: string,
  args: Record<string, unknown> | undefined,
): ToolCallPolicyDecision {
  if (!policy.hasForcedMode() || toolName !== "bash") {
    return ALLOW;
  }
  const command = typeof args?.["command"] === "string"
    ? args["command"] as string
    : "";
  if (classifyBashCommand(command) !== CommandRiskHigh) {
    return ALLOW;
  }
  return {
    block: true,
    reason: "channel execution policy blocked high risk bash command",
  };
}

/**
 * Classifies command risk for unattended execution. High risk detection
 * tokenizes shell control operators and executable paths so quoting, compound
 * commands, and common flag variants cannot bypass it.
 */
export function classifyBashCommand(command: string): CommandRisk {
  command = command.trim();
  if (containsHighRiskBash(command)) {
    return CommandRiskHigh;
  }

  const mediumRiskPrefixes = [
    "mv ",
    "cp -r",
    "git push",
    "git reset --hard",
    "git clean",
    "npm publish",
    "go install",
    "apt ",
    "yum ",
    "brew ",
    "pip install",
    "docker ",
    "kubectl ",
    "curl ",
    "wget ",
    "ssh ",
    "scp ",
  ];
  for (const prefix of mediumRiskPrefixes) {
    if (command.startsWith(prefix)) {
      return CommandRiskMedium;
    }
  }

  const lowRiskPrefixes = [
    "go ",
    "make ",
    "npm ",
    "yarn ",
    "node ",
    "python ",
    "pip ",
    "git status",
    "git log",
    "git diff",
    "git branch",
    "ls",
    "cat ",
    "head ",
    "tail ",
    "wc ",
    "echo ",
    "printf ",
    "grep ",
    "find ",
    "which ",
    "type ",
    "cd ",
    "pwd",
    "env",
    "printenv",
  ];
  for (const prefix of lowRiskPrefixes) {
    if (command.startsWith(prefix)) {
      return CommandRiskLow;
    }
  }

  return CommandRiskMedium;
}

function containsHighRiskBash(command: string): boolean {
  const tokens = bashRiskTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const base = executableBase(token);
    switch (true) {
      case base === "rm":
        if (
          segmentHasFlag(tokens, i + 1, "r", "--recursive") ||
          segmentHasFlag(tokens, i + 1, "R", "--recursive")
        ) {
          return true;
        }
        break;
      case base === "dd" || base === "shred" || base.startsWith("mkfs"):
        return true;
      case base === "chmod":
        if (
          segmentContains(tokens, i + 1, "777") ||
          segmentHasFlag(tokens, i + 1, "R", "--recursive")
        ) {
          return true;
        }
        break;
      case base === "chown":
        if (segmentHasFlag(tokens, i + 1, "R", "--recursive")) {
          return true;
        }
        break;
      case base === "sudo" || base === "su" || base === "shutdown" ||
        base === "reboot" || base === "halt":
        return true;
      case base === "killall":
        return true;
      case base === "kill":
        if (
          segmentContains(tokens, i + 1, "-9", "--signal=KILL", "--signal=9")
        ) {
          return true;
        }
        break;
      case base === "eval" || base === "exec":
        return true;
      case isShellExecutable(base):
        if (segmentHasFlag(tokens, i + 1, "c", "--command")) {
          return true;
        }
        break;
      case isInlineInterpreter(base):
        if (
          segmentHasFlag(tokens, i + 1, "c", "--command") ||
          segmentHasFlag(tokens, i + 1, "e", "--eval")
        ) {
          return true;
        }
        break;
      case base === "git":
        if (
          segmentContainsSequence(tokens, i + 1, "reset", "--hard") ||
          segmentContainsForcedGitClean(tokens, i + 1)
        ) {
          return true;
        }
        break;
      case base === "find":
        if (segmentContains(tokens, i + 1, "-delete")) {
          return true;
        }
        break;
    }

    if (
      token === ">" && i + 1 < tokens.length &&
      tokens[i + 1].startsWith("/dev/")
    ) {
      return true;
    }
    if (
      token === "|" && i + 1 < tokens.length &&
      isShellExecutable(executableBase(tokens[i + 1]))
    ) {
      return true;
    }
  }
  return false;
}

function bashRiskTokens(command: string): string[] {
  command = replaceShellOperators(command);
  command = command.replace(/['"\\]/g, "");
  return command.split(/\s+/).filter((token) => token !== "");
}

/**
 * Mirrors `strings.NewReplacer`'s left-to-right, longest-match-at-each-position
 * semantics for the shell operators; a naive ordered replace would re-split the
 * spaces it inserts around a two-character operator.
 */
function replaceShellOperators(command: string): string {
  const keys: Array<[string, string]> = [
    ["&&", " && "],
    ["||", " || "],
    [">>", " >> "],
    ["<<", " << "],
    [";", " ; "],
    ["|", " | "],
    ["&", " & "],
    [">", " > "],
    ["<", " < "],
    ["(", " ( "],
    [")", " ) "],
    ["{", " { "],
    ["}", " } "],
    ["`", " ` "],
    ["\n", " ; "],
    ["\r", " ; "],
  ];
  let out = "";
  for (let i = 0; i < command.length;) {
    let matched: [string, string] | null = null;
    for (const entry of keys) {
      if (command.startsWith(entry[0], i)) {
        if (matched === null || entry[0].length > matched[0].length) {
          matched = entry;
        }
      }
    }
    if (matched !== null) {
      out += matched[1];
      i += matched[0].length;
    } else {
      out += command[i];
      i++;
    }
  }
  return out;
}

function executableBase(token: string): string {
  return pathBase(token.trim());
}

/** Mirrors Go's `path.Base` (always forward-slash separated). */
function pathBase(value: string): string {
  if (value === "") return ".";
  let v = value;
  while (v.length > 1 && v.endsWith("/")) v = v.slice(0, -1);
  if (v === "/") return "/";
  const idx = v.lastIndexOf("/");
  return idx >= 0 ? v.slice(idx + 1) : v;
}

function isShellExecutable(base: string): boolean {
  switch (base) {
    case "sh":
    case "bash":
    case "dash":
    case "zsh":
    case "ksh":
    case "fish":
      return true;
    default:
      return false;
  }
}

function isInlineInterpreter(base: string): boolean {
  switch (base) {
    case "python":
    case "python2":
    case "python3":
    case "node":
    case "perl":
    case "ruby":
    case "php":
    case "pwsh":
    case "powershell":
      return true;
    default:
      return false;
  }
}

function isShellBoundary(token: string): boolean {
  switch (token) {
    case ";":
    case "&&":
    case "||":
    case "|":
    case "&":
    case "(":
    case ")":
    case "{":
    case "}":
    case "`":
    case ">":
    case ">>":
    case "<":
    case "<<":
      return true;
    default:
      return false;
  }
}

function segmentEnd(tokens: string[], start: number): number {
  let end = start;
  while (end < tokens.length && !isShellBoundary(tokens[end])) {
    end++;
  }
  return end;
}

function segmentContains(
  tokens: string[],
  start: number,
  ...values: string[]
): boolean {
  const end = segmentEnd(tokens, start);
  for (const token of tokens.slice(start, end)) {
    for (const value of values) {
      if (token === value) return true;
    }
  }
  return false;
}

function segmentHasFlag(
  tokens: string[],
  start: number,
  shortFlag: string,
  longFlag: string,
): boolean {
  const end = segmentEnd(tokens, start);
  for (const token of tokens.slice(start, end)) {
    if (token === longFlag || token.startsWith(`${longFlag}=`)) {
      return true;
    }
    if (
      token.startsWith("-") && !token.startsWith("--") &&
      token.slice(1).includes(shortFlag)
    ) {
      return true;
    }
  }
  return false;
}

function segmentContainsSequence(
  tokens: string[],
  start: number,
  first: string,
  second: string,
): boolean {
  const end = segmentEnd(tokens, start);
  let firstSeen = false;
  for (const token of tokens.slice(start, end)) {
    if (token === first) {
      firstSeen = true;
      continue;
    }
    if (firstSeen && token === second) {
      return true;
    }
  }
  return false;
}

function segmentContainsForcedGitClean(
  tokens: string[],
  start: number,
): boolean {
  const end = segmentEnd(tokens, start);
  let cleanSeen = false;
  for (const token of tokens.slice(start, end)) {
    if (token === "clean") {
      cleanSeen = true;
      continue;
    }
    if (cleanSeen && token.startsWith("-") && token.includes("f")) {
      return true;
    }
  }
  return false;
}

/**
 * Composes the non-overridable source policy with an adapter hook. The source
 * policy always runs first, so a forced high-risk bash command cannot be
 * overridden by an adapter's approval callback.
 */
export function beforeToolCallForPolicy(
  policy: ExecutionPolicy,
  adapterHook?:
    | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
    | null,
): ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined) | null {
  if (
    !policy.hasForcedMode() &&
    (adapterHook === undefined || adapterHook === null)
  ) {
    return null;
  }
  return (ctx: BeforeToolCallContext): ToolCallBlockResult | undefined => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const decision = evaluateToolCall(policy, ctx.toolCall.name, args);
    if (decision.block) {
      return { block: true, reason: decision.reason };
    }
    if (adapterHook !== undefined && adapterHook !== null) {
      return adapterHook(ctx);
    }
    return undefined;
  };
}
