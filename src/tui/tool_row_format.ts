// Tool-call row formatting, ported 1:1 from the Go TUI's formatters.go
// (formatToolHeader / formatBashCommandLine / formatToolExecutionStart /
// formatEditedToolResult) and render.go (renderToolResult).
//
// Every tool row has the shape  [tool] <path?> ..., e.g.:
//   | [bash] npm run build (running)
//   | [read] src/main.ts  42 lines
//   | [edit] src/x.ts (+3 -1)
// These are pure string builders; no Ink/React here.
//

import {
  TOOL_EXECUTION_FAILED,
  type ToolExecutionState,
} from "../agentruntime/events.ts";
import { type FileDiff } from "../tools/io_helpers.ts";
import { compactBashOutput } from "./formatters.ts";
import type { Translator } from "./i18n.ts";
import { formatDetailedActivityTool } from "./activity.ts";
import { planProgress, planTitle, renderTaskPlanLines } from "./plan_view.ts";
import { type TaskPlan } from "../tools/tool.ts";

export type ToolRowStatus = "running" | "completed" | "interrupted";

export interface ToolRowInput {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  status: ToolRowStatus;
  summary: string;
  fullContent: string;
  diff?: FileDiff;
  plan?: TaskPlan;
  /** Spinner frame prefixed to the running label on live rows. */
  spinner?: string;
  toolError: string;
  executionState: ToolExecutionState | "";
}

// ── argument helpers ────────────────────────────────────────────────────────

/** The `path` argument (Go toolPath). */
export function toolPath(args: Record<string, unknown> | undefined): string {
  const p = args?.["path"];
  return typeof p === "string" ? p : "";
}

/**
 * The bash command text. Prefer the `command` argument; fall back to the
 * [command] section emitted in the result (Go bashCommand).
 */
export function bashCommand(input: ToolRowInput): string {
  const c = input.toolArgs?.["command"];
  if (typeof c === "string" && c.trim() !== "") return c;
  return (
    toolSectionValue(input.fullContent, "[command]") ||
    toolSectionValue(input.summary, "[command]")
  );
}

/** The [exit_code] section of the result, if present (Go bashExitCode). */
function bashExitCode(input: ToolRowInput): number | undefined {
  for (const content of [input.fullContent, input.summary]) {
    const v = toolSectionValue(content, "[exit_code]");
    if (v === "") continue;
    const code = Number.parseInt(v.trim(), 10);
    if (!Number.isNaN(code)) return code;
  }
  return undefined;
}

/** Value on the line immediately following a `[section]` marker. */
export function toolSectionValue(content: string, section: string): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === section) return lines[i + 1].trim();
  }
  return "";
}

/** A `[section]` marker line (`[stdout]`, `[exit_code]`, …). */
const SECTION_MARKER_RE = /^\[[a-z_]+\]$/;

/**
 * Whole body of a `[section]` block (every line up to the next marker), or
 * `null` when the section is absent. Unlike `toolSectionValue` this keeps the
 * full multi-line body rather than only the first line.
 */
function toolSectionBody(content: string, section: string): string | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== section) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (SECTION_MARKER_RE.test(lines[j].trim())) break;
      body.push(lines[j]);
    }
    return body.join("\n").trim();
  }
  return null;
}

/** Single-line header: `[tool] path?` (Go formatToolHeader). */
export function toolHeader(input: ToolRowInput): string {
  const p = toolPath(input.toolArgs);
  return p !== "" ? `[${input.toolName}] ${p}` : `[${input.toolName}]`;
}

// ── bash ────────────────────────────────────────────────────────────────────

export function normalizeCommand(command: string): string {
  return command.replace(/\r\n/g, "; ").replace(/\n/g, "; ").trim();
}

/** Status suffix for a bash row (Go bashCommandStatus). */
function bashStatus(tr: Translator, input: ToolRowInput): string {
  if (input.status === "running") {
    return `${spinnerMark(input)}${tr.text("tool.command.running")}`;
  }
  if (input.status === "interrupted") {
    return tr.text("tool.modal.state.canceled");
  }
  if (
    input.toolError !== "" ||
    input.executionState.toLowerCase() === "interrupted" ||
    input.executionState.toLowerCase() === "failed"
  ) {
    return tr.text("tool.command.failed");
  }
  const exitCode = bashExitCode(input);
  if (exitCode !== undefined) {
    if (exitCode === 0) return tr.text("tool.command.succeeded");
    return tr.text("tool.command.failed_exit", exitCode);
  }
  if (input.fullContent.includes("Use 'jobs' tool to check status")) {
    return tr.text("tool.command.started");
  }
  return tr.text("tool.command.succeeded");
}

/** Full bash command line: `[bash] <command> (status)` (Go formatBashCommandLine). */
function bashCommandLine(tr: Translator, input: ToolRowInput): string {
  let command = normalizeCommand(bashCommand(input));
  if (command === "") command = tr.text("tool.command.unavailable");
  if (Array.from(command).length > 160) {
    command = Array.from(command).slice(0, 160).join("");
  }
  return `[bash] ${command} (${bashStatus(tr, input)})`;
}

/** First meaningful line of a captured stream (blank/`(no output)` skipped). */
function outputLine(body: string | null): string | null {
  if (body === null) return null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "(no output)") continue;
    return trimmed;
  }
  return null;
}

/**
 * Single-line output excerpt for the simple view: the first meaningful
 * stdout line, falling back to stderr when stdout is empty. The structured
 * `[runtime]`/`[command]`/… markers belong to the full view only — the row
 * header already carries the command and its status, so repeating a marker
 * here would read as the result's whole content.
 */
function bashExcerpt(input: ToolRowInput): string {
  for (const content of [input.fullContent, input.summary]) {
    if (content === "") continue;
    const line =
      outputLine(toolSectionBody(content, "[stdout]")) ??
      outputLine(toolSectionBody(content, "[stderr]"));
    if (line !== null) return truncateRaw(line, 160);
  }
  return "";
}

// ── running rows ────────────────────────────────────────────────────────────

/** Spinner prefix for a live running label (empty without a supplied frame). */
function spinnerMark(input: ToolRowInput): string {
  return input.spinner !== undefined && input.spinner !== ""
    ? `${input.spinner} `
    : "";
}

/** Running line for any tool (Go formatToolExecutionStartWithTranslator). */
function runningLine(tr: Translator, input: ToolRowInput): string {
  if (input.toolName === "bash") return bashCommandLine(tr, input);
  const header = toolHeader(input);
  switch (input.toolName) {
    case "grep":
    case "find": {
      const pattern = input.toolArgs?.["pattern"];
      if (typeof pattern === "string") {
        return `${header} ${spinnerMark(input)}running ${truncateRaw(
          pattern,
          120,
        )}`;
      }
      break;
    }
    case "ls": {
      const p = toolPath(input.toolArgs);
      if (p !== "") {
        return `${header} ${spinnerMark(input)}running ${truncateRaw(p, 120)}`;
      }
      break;
    }
  }
  return `${header} ${spinnerMark(input)}${tr.text("tool.command.running")}`;
}

// ── edit / write diff display ───────────────────────────────────────────────

/** Edit/write result with path, diff stat and a unified-diff excerpt. */
function editedLine(tr: Translator, input: ToolRowInput): string {
  const header = editHeader(tr, input);
  const unified = input.diff?.unified?.trim() ?? "";
  if (unified === "") return header;
  const excerpt = unifiedDiffExcerpt(unified);
  return excerpt === "" ? header : `${header}\n${excerpt}`;
}

/** Renders a canonical failed result even when the failure has no Error. */
function failedLine(
  tr: Translator,
  input: ToolRowInput,
  compact: boolean,
): string {
  const header = `${toolHeader(input)} ${tr.text("tool.modal.state.error")}`;
  if (compact) return header;

  const parts: string[] = [];
  if (input.fullContent !== "") parts.push("---", input.fullContent);
  if (input.diff?.unified !== undefined && input.diff.unified.trim() !== "") {
    parts.push(tr.text("tool.modal.diff"), input.diff.unified);
  }
  return parts.length === 0 ? header : `${header}\n${parts.join("\n")}`;
}

/** Edit/write header only: `Edited path (+3 -1)` (Go formatExpandedEditHeader). */
function editHeader(tr: Translator, input: ToolRowInput): string {
  let p = toolPath(input.toolArgs);
  if (input.diff?.path !== undefined && input.diff.path !== "") {
    p = input.diff.path;
  }
  if (p === "") p = "(unknown)";

  let header = tr.text("tool.edited", p);
  if (input.diff !== undefined) {
    header += ` (+${input.diff.added} -${input.diff.deleted})`;
  }
  return header;
}

/**
 * Expanded Ctrl+O rendering for one tool row, mirroring the Go
 * renderExpandedToolResult + formatToolModalContent: a header line, the tool
 * arguments, `---` plus the full output, and the unified diff when present.
 */
export function expandedToolRow(tr: Translator, input: ToolRowInput): string {
  if (input.status === "running") return runningLine(tr, input);
  if (
    input.toolName !== "bash" &&
    input.executionState === TOOL_EXECUTION_FAILED
  ) {
    return failedLine(tr, input, false);
  }
  if (input.toolName === "plan") return planRow(tr, input, false);

  let header: string;
  if (input.toolName === "bash") {
    header = bashCommandLine(tr, input);
  } else if (input.status === "interrupted") {
    header = `${toolHeader(input)} ${tr.text("tool.modal.state.canceled")}`;
  } else if (input.toolName === "edit" || input.toolName === "write") {
    header = editHeader(tr, input);
  } else {
    header = toolHeader(input);
  }

  const parts: string[] = [];
  const args = formatDetailedActivityTool(input.toolName, input.toolArgs);
  if (args.trim() !== "" && args !== input.toolName) parts.push(args);
  if (input.fullContent !== "") parts.push("---", input.fullContent);
  const unified = input.diff?.unified?.trim() ?? "";
  if (unified !== "" && input.diff !== undefined) {
    parts.push(tr.text("tool.modal.diff"), input.diff.unified);
  }
  return parts.length === 0 ? header : `${header}\n${parts.join("\n")}`;
}

const HUNK_RE = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/;

/** Renders a compact unified-diff excerpt with line numbers (Go formatUnifiedDiffExcerpt). */
function unifiedDiffExcerpt(unified: string): string {
  const lines: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of unified.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line === "") {
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk !== null) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      continue;
    }
    if (oldLine === 0 && newLine === 0) continue;

    const kind = line[0];
    const text = line.length > 1 ? line.slice(1) : "";
    switch (kind) {
      case " ":
        lines.push(`    ${newLine.toString().padEnd(4)} ${text}`);
        oldLine++;
        newLine++;
        break;
      case "-":
        lines.push(`    ${oldLine.toString().padEnd(4)}-${text}`);
        oldLine++;
        break;
      case "+":
        lines.push(`    ${newLine.toString().padEnd(4)}+${text}`);
        newLine++;
        break;
    }
  }
  return lines.join("\n");
}

// ── plan rows ───────────────────────────────────────────────────────────────

/** Plan row: `[plan] title` plus the checklist (compact shows progress). */
function planRow(
  tr: Translator,
  input: ToolRowInput,
  compact: boolean,
): string {
  const plan = input.plan;
  const header = toolHeader(input);
  if (plan === undefined) return `${header} ...`;
  if (compact) {
    const { done, total } = planProgress(plan);
    return `${header} ${planTitle(plan, tr)} (${done}/${total})`;
  }
  const lines = renderTaskPlanLines(plan, tr);
  lines[0] = `${header} ${lines[0]}`;
  return lines.join("\n");
}

// ── generic completed rows ─────────────────────────────────────────────────

/** Completed non-specialized tool row: header + summary (compact mode aware). */
function completedLine(
  _tr: Translator,
  input: ToolRowInput,
  compact: boolean,
): string {
  let summary = input.summary;
  if (summary === "") summary = "...";
  if (compact) {
    const nl = summary.indexOf("\n");
    if (nl >= 0) summary = summary.slice(0, nl);
  }
  const header = toolHeader(input);
  if (compact) return `${header} ${summary}`;
  const sep = summary.includes("\n") ? "\n" : " ";
  return `${header}${sep}${summary}`;
}

// ── public entry ────────────────────────────────────────────────────────────

/**
 * Formats one tool-call row exactly as the Go TUI's renderToolResult.
 * @param compact whether compact mode is on (single-line summaries)
 */
export function formatToolRow(
  tr: Translator,
  input: ToolRowInput,
  compact: boolean,
): string {
  if (input.status === "running") return runningLine(tr, input);

  if (
    input.toolName !== "bash" &&
    input.executionState === TOOL_EXECUTION_FAILED
  ) {
    return failedLine(tr, input, compact);
  }
  if (input.toolName === "bash") {
    const header = bashCommandLine(tr, input);
    if (input.summary === "" && input.status === "interrupted") return header;
    if (compact) {
      const excerpt = bashExcerpt(input);
      return excerpt === "" ? header : `${header} ${excerpt}`;
    }
    let summary = input.summary;
    if (summary === "") summary = "...";
    return summary.includes("\n")
      ? `${header}\n${summary}`
      : `${header} ${summary}`;
  }

  if (input.status === "interrupted") {
    // No result was produced; the header carries the terminal state.
    return `${toolHeader(input)} ${tr.text("tool.modal.state.canceled")}`;
  }

  if (input.toolName === "plan") return planRow(tr, input, compact);

  if (compact) return completedLine(tr, input, true);

  if (input.toolName === "edit" || input.toolName === "write") {
    if (
      input.summary === "" &&
      input.fullContent === "" &&
      input.diff === undefined
    ) {
      return `${toolHeader(input)} ...`;
    }
    return editedLine(tr, input);
  }

  return completedLine(tr, input, false);
}

/** Builds the default per-tool summary (used by the transcript store). */
export function defaultToolSummary(
  tr: Translator,
  toolName: string,
  result: string,
  diff?: FileDiff,
): string {
  switch (toolName) {
    case "bash":
    case "ls":
      return compactBashOutput(result);
    case "read":
      return tr.text("tool.result.lines", result.split("\n").length);
    case "write":
    case "edit":
      if (diff !== undefined) {
        return `(+${diff.added} -${diff.deleted})`;
      }
      break;
  }
  const first =
    result
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return truncateRaw(first, 50);
}

function truncateRaw(s: string, max: number): string {
  const runes = Array.from(s);
  return runes.length <= max ? s : runes.slice(0, max - 3).join("") + "...";
}

/**
 * Parallel calls at which a batch collapses into one tree block instead of
 * rendering one independent row per call (Go `minToolGroupSize`).
 */
export const MIN_TOOL_GROUP_SIZE = 2;

/**
 * Renders a parallel tool-call batch as a tree (Go `renderToolGroupBlock`):
 * a title carrying the live count, then one indented branch per call. The
 * caller supplies the already-formatted per-call rows in message order, so a
 * batch keeps its shape for its whole lifetime — the title switches from the
 * running form to the completed form once every call reached a terminal state.
 * Empty member rows are dropped; `title` keeps the full group count.
 */
export function formatToolGroup(title: string, members: string[]): string {
  const bodies = members
    .map((m) => m.trimRight())
    .filter((m) => m.trim() !== "");
  const lines = [title];
  for (let i = 0; i < bodies.length; i++) {
    const branch = i === bodies.length - 1 ? "└─ " : "├─ ";
    lines.push(treeIndentBlock(branch, bodies[i]));
  }
  return lines.join("\n");
}

/** Prefixes the first line of `body` with the branch and indents the rest. */
function treeIndentBlock(branch: string, body: string): string {
  const lines = body.split("\n");
  if (lines.length === 1) return branch + lines[0];
  return (
    branch +
    lines[0] +
    lines
      .slice(1)
      .map((line) => `\n   ${line}`)
      .join("")
  );
}
