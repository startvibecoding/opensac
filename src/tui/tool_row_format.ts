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

import type { FileDiff } from "../tools/io_helpers.ts";
import { compactBashOutput } from "./formatters.ts";
import type { Translator } from "./i18n.ts";

export type ToolRowStatus = "running" | "completed" | "interrupted";

export interface ToolRowInput {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  status: ToolRowStatus;
  summary: string;
  fullContent: string;
  diff?: FileDiff;
  toolError: string;
  executionState: string;
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
  return toolSectionValue(input.fullContent, "[command]") ||
    toolSectionValue(input.summary, "[command]");
}

/** The [exit_code] section of the result, if present (Go bashExitCode). */
function bashExitCode(input: ToolRowInput): [number, boolean] {
  for (const content of [input.fullContent, input.summary]) {
    const v = toolSectionValue(content, "[exit_code]");
    if (v === "") continue;
    const code = Number.parseInt(v.trim(), 10);
    if (!Number.isNaN(code)) return [code, true];
  }
  return [0, false];
}

/** Value on the line immediately following a `[section]` marker. */
export function toolSectionValue(content: string, section: string): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === section) return lines[i + 1].trim();
  }
  return "";
}

/** Single-line header: `[tool] path?` (Go formatToolHeader). */
export function toolHeader(input: ToolRowInput): string {
  const p = toolPath(input.toolArgs);
  return p !== "" ? `[${input.toolName}] ${p}` : `[${input.toolName}]`;
}

// ── bash ────────────────────────────────────────────────────────────────────

function normalizeCommand(command: string): string {
  return command.replace(/\r\n/g, "; ").replace(/\n/g, "; ").trim();
}

/** Status suffix for a bash row (Go bashCommandStatus). */
function bashStatus(tr: Translator, input: ToolRowInput): string {
  if (input.status === "running") return tr.text("tool.command.running");
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
  const [exitCode, ok] = bashExitCode(input);
  if (ok) {
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

// ── running rows ────────────────────────────────────────────────────────────

/** Running line for any tool (Go formatToolExecutionStartWithTranslator). */
function runningLine(tr: Translator, input: ToolRowInput): string {
  if (input.toolName === "bash") return bashCommandLine(tr, input);
  const header = toolHeader(input);
  switch (input.toolName) {
    case "grep":
    case "find": {
      const pattern = input.toolArgs?.["pattern"];
      if (typeof pattern === "string") {
        return `${header} running ${truncateRaw(pattern, 120)}`;
      }
      break;
    }
    case "ls": {
      const p = toolPath(input.toolArgs);
      if (p !== "") return `${header} running ${truncateRaw(p, 120)}`;
      break;
    }
  }
  return `${header} ${tr.text("tool.command.running")}`;
}

// ── edit / write diff display ───────────────────────────────────────────────

/** Edit/write result with path, diff stat and a unified-diff excerpt. */
function editedLine(tr: Translator, input: ToolRowInput): string {
  let p = toolPath(input.toolArgs);
  if (input.diff?.path !== undefined && input.diff.path !== "") {
    p = input.diff.path;
  }
  if (p === "") p = "(unknown)";

  let header = tr.text("tool.edited", p);
  if (input.diff !== undefined) {
    header += ` (+${input.diff.added} -${input.diff.deleted})`;
  }

  const unified = input.diff?.unified?.trim() ?? "";
  if (unified === "") return header;
  const excerpt = unifiedDiffExcerpt(unified);
  return excerpt === "" ? header : `${header}\n${excerpt}`;
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

  if (input.toolName === "bash") {
    const header = bashCommandLine(tr, input);
    let summary = input.summary;
    if (summary === "" && input.status === "interrupted") return header;
    if (summary === "") summary = "...";
    if (compact) {
      const nl = summary.indexOf("\n");
      if (nl >= 0) summary = summary.slice(0, nl);
    }
    return summary.includes("\n")
      ? `${header}\n${summary}`
      : `${header} ${summary}`;
  }

  if (input.status === "interrupted") {
    // No result was produced; the header carries the terminal state.
    return `${toolHeader(input)} ${tr.text("tool.modal.state.canceled")}`;
  }

  if (compact) return completedLine(tr, input, true);

  if (input.toolName === "edit" || input.toolName === "write") {
    if (
      input.summary === "" && input.fullContent === "" &&
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
  const first = result.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return truncateRaw(first, 50);
}

function truncateRaw(s: string, max: number): string {
  const runes = Array.from(s);
  return runes.length <= max ? s : runes.slice(0, max - 3).join("") + "...";
}
