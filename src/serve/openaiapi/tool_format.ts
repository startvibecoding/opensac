// Ported from internal/serve/openaiapi/tool_format.go. `tools.FileDiff` maps
// to the existing `src/tools/io_helpers.ts` shape and Go's `%v` of an error
// maps to `(err as Error).message`.

import { basename } from "@std/path";
import type { FileDiff } from "../../tools/io_helpers.ts";
import { truncateWithSuffix } from "../../util/truncate.ts";

/**
 * Go filepath.Ext: the suffix from the final dot before a path separator,
 * including dotfiles (`.env` → `.env`, unlike Node/@std extname).
 */
function goExt(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const ch = path[i];
    if (ch === "/" || ch === "\\") return "";
    if (ch === ".") return path.slice(i);
  }
  return "";
}

/** toolCallInfo tracks a tool call through its lifecycle. */
export interface toolCallInfo {
  name: string;
  args: Record<string, unknown> | null;
  result: string;
  diff: FileDiff | null;
  error: Error | null;
  /** "running", "completed", "failed" */
  status: string;
}

/**
 * formatToolResult dispatches to collapsed or expanded based on detail level.
 * detail: "collapsed" (default) or "expanded"
 */
export function formatToolResult(tc: toolCallInfo, detail: string): string {
  if (detail === "expanded") return formatToolExpanded(tc);
  return formatToolCollapsed(tc);
}

/**
 * formatToolCollapsed renders a one-line summary.
 * Most tools: 🔧 `read` main.go ✅
 * edit/write with diff: always shows path + diff (never fully collapsed)
 * Errors: always shown
 */
export function formatToolCollapsed(tc: toolCallInfo): string {
  let sb = "";

  // Errors are always shown in full
  if (tc.error !== null) {
    sb += formatToolHeaderMD(tc.name, tc.args);
    sb += "\n\n";
    sb += `> ❌ Error: ${errorString(tc.error)}\n\n`;
    return sb;
  }

  // edit/write with diff — always show path + diff
  if (
    (tc.name === "edit" || tc.name === "write" || tc.name === "insert") &&
    tc.diff !== null && tc.diff.unified !== ""
  ) {
    sb += formatToolHeaderMD(tc.name, tc.args);
    sb += "\n\n";
    sb += `\`\`\`diff\n${tc.diff.unified}`;
    if (!tc.diff.unified.endsWith("\n")) sb += "\n";
    sb += "\`\`\`\n\n";
    return sb;
  }

  // Everything else: one-line summary
  let status = "✅";
  if (tc.status === "failed") status = "❌";
  sb += formatToolHeaderMD(tc.name, tc.args);
  sb += " ";
  sb += status;
  sb += "\n\n";
  return sb;
}

/** formatToolExpanded renders a tool call with full output in code fences. */
export function formatToolExpanded(tc: toolCallInfo): string {
  let sb = "";

  sb += formatToolHeaderMD(tc.name, tc.args);
  sb += "\n\n";

  // Error
  if (tc.error !== null) {
    sb += `> ❌ Error: ${errorString(tc.error)}\n\n`;
    return sb;
  }

  // Diff output (edit/write with diff)
  if (tc.diff !== null && tc.diff.unified !== "") {
    sb += `\`\`\`diff\n${tc.diff.unified}`;
    if (!tc.diff.unified.endsWith("\n")) sb += "\n";
    sb += "\`\`\`\n\n";
    return sb;
  }

  // Result output
  if (tc.result !== "") {
    const lang = inferCodeLang(tc.name, tc.args);
    sb += `\`\`\`${lang}\n${tc.result}`;
    if (!tc.result.endsWith("\n")) sb += "\n";
    sb += "\`\`\`\n\n";
  }

  return sb;
}

/**
 * formatToolHeaderMD builds the tool header line. Uses plain text with emoji
 * prefix — no markdown formatting to avoid rendering issues when streamed in
 * chunks.
 */
export function formatToolHeaderMD(
  name: string,
  args: Record<string, unknown> | null,
): string {
  const keyArg = toolKeyArg(name, args);
  if (keyArg === "") return `🔧 ${name}`;
  return `🔧 ${name}: ${keyArg}`;
}

/** formatToolRunning returns a status line when a tool starts executing. */
export function formatToolRunning(
  name: string,
  args: Record<string, unknown> | null,
): string {
  const keyArg = toolKeyArg(name, args);
  if (keyArg === "") return `⏳ ${name} running...\n\n`;
  return `⏳ ${name}: ${keyArg}\n\n`;
}

/** formatToolHeader builds the header line (used by SSE content status). */
export function formatToolHeader(
  name: string,
  args: Record<string, unknown> | null,
): string {
  const keyArg = toolKeyArg(name, args);
  if (keyArg === "") return `🔧 [${name}]`;
  return `🔧 [${name}] ${keyArg}`;
}

function errorString(err: Error | null): string {
  if (err === null) return "";
  return err.message;
}

// --- Language inference ---

/** inferCodeLang guesses the code fence language from tool name and args. */
export function inferCodeLang(
  toolName: string,
  args: Record<string, unknown> | null,
): string {
  switch (toolName) {
    case "bash":
      return "bash";
    case "read":
    case "write": {
      if (args !== null && typeof args["path"] === "string") {
        return langFromPath(args["path"] as string);
      }
      break;
    }
    case "grep":
    case "find":
    case "ls":
      return ""; // plain text
  }
  return "";
}

/** langFromPath infers a code fence language from a file extension. */
export function langFromPath(path: string): string {
  const ext = goExt(path).toLowerCase();
  switch (ext) {
    case ".go":
      return "go";
    case ".py":
      return "python";
    case ".js":
      return "javascript";
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".rs":
      return "rust";
    case ".rb":
      return "ruby";
    case ".java":
      return "java";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".swift":
      return "swift";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".sh":
    case ".bash":
      return "bash";
    case ".zsh":
      return "zsh";
    case ".ps1":
      return "powershell";
    case ".sql":
      return "sql";
    case ".html":
    case ".htm":
      return "html";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".json":
      return "json";
    case ".jsonc":
      return "jsonc";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".xml":
      return "xml";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".dockerfile":
      return "dockerfile";
    case ".tf":
      return "hcl";
    case ".lua":
      return "lua";
    case ".r":
      return "r";
    case ".php":
      return "php";
    case ".pl":
    case ".pm":
      return "perl";
    case ".ex":
    case ".exs":
      return "elixir";
    case ".erl":
      return "erlang";
    case ".hs":
      return "haskell";
    case ".scala":
      return "scala";
    case ".clj":
      return "clojure";
    case ".vim":
      return "vim";
    case ".proto":
      return "protobuf";
    case ".graphql":
    case ".gql":
      return "graphql";
    case ".ini":
    case ".cfg":
    case ".conf":
      return "ini";
    case ".env":
      return "bash";
    case ".makefile":
      return "makefile";
    default: {
      const lowerBase = basename(path).toLowerCase();
      switch (lowerBase) {
        case "makefile":
        case "gnumakefile":
          return "makefile";
        case "dockerfile":
          return "dockerfile";
        case "vagrantfile":
        case "gemfile":
          return "ruby";
      }
      return "";
    }
  }
}

// --- Key arg extraction ---

/** toolKeyArg extracts the most relevant argument for display. */
export function toolKeyArg(
  name: string,
  args: Record<string, unknown> | null,
): string {
  if (args === null) return "";
  switch (name) {
    case "bash": {
      if (typeof args["command"] === "string") {
        return truncateWithSuffix(args["command"] as string, 120, "...");
      }
      break;
    }
    case "read":
    case "write":
    case "edit":
    case "insert":
    case "ls": {
      if (typeof args["path"] === "string") return args["path"] as string;
      break;
    }
    case "grep":
    case "find": {
      const parts: string[] = [];
      if (typeof args["pattern"] === "string") {
        parts.push(args["pattern"] as string);
      }
      if (typeof args["path"] === "string") parts.push(args["path"] as string);
      return parts.join(" ");
    }
    default: {
      for (const key of ["path", "command", "pattern", "query", "name"]) {
        const value = args[key];
        if (typeof value === "string" && value !== "") return value;
      }
    }
  }
  return "";
}
