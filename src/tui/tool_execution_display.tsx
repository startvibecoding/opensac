// Enhanced tool execution display component for Ink TUI.
//
// Provides rich display of tool execution details including:
// - Tool name and arguments
// - Execution status and timing
// - Result preview with truncation
// - Diff stats for file modifications
// - Error display
//
// Inspired by moark's tool display but adapted for terminal rendering.

import React from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { formatDuration, truncateDisplay } from "./formatters.ts";
import { normalizeCommand } from "./tool_row_format.ts";
import type { Translator } from "./i18n.ts";
import type { DiffStats } from "./turn_card.tsx";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecutionDisplayProps {
  toolName: string;
  toolCallId: string;
  status: "running" | "completed" | "error" | "interrupted";
  input?: Record<string, unknown>;
  result?: string;
  error?: string;
  intent?: string;
  elapsedMs?: number;
  diffStats?: DiffStats;
  translator: Translator;
  width: number;
  isExpanded?: boolean;
  showInput?: boolean;
  showResult?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style Constants
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  running: ">",
  completed: "o",
  error: "x",
  interrupted: "=",
  tool: "|",
  expand: "+",
  collapse: "-",
};

const COLORS = {
  running: "cyan",
  completed: "green",
  error: "red",
  interrupted: "yellow",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool Execution Display Component
// ─────────────────────────────────────────────────────────────────────────────

export function ToolExecutionDisplay({
  toolName,
  status,
  input,
  result,
  error,
  intent,
  elapsedMs,
  diffStats,
  translator,
  width,
  isExpanded = false,
  showInput = false,
  showResult = true,
}: ToolExecutionDisplayProps): ReactElement {
  const color = COLORS[status];
  const timeStr = elapsedMs ? formatDuration(elapsedMs) : "";

  // Get display name and intent
  const displayName = getToolDisplayName(toolName, input);
  const displayIntent = intent || generateIntent(toolName, input);

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Header */}
      <Box flexDirection="row">
        <Text color={color} bold>
          {ICONS[status]} {displayName}
        </Text>
        {displayIntent && <Text dimColor>— {displayIntent}</Text>}
        {timeStr && <Text dimColor>({timeStr})</Text>}
        {diffStats && (
          <Text color="green">{formatDiffStatsForDisplay(diffStats)}</Text>
        )}
      </Box>

      {/* Error */}
      {error && (
        <Box marginLeft={2}>
          <Text color="red">
            {translator.text("tool.error")}: {truncateText(error, width - 4)}
          </Text>
        </Box>
      )}

      {/* Expanded Input */}
      {isExpanded && showInput && input && (
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor bold>
            {translator.text("tool.input")}:
          </Text>
          <Box marginLeft={2}>
            <Text dimColor>
              {formatToolInput(input, width - 6)}
            </Text>
          </Box>
        </Box>
      )}

      {/* Result Preview */}
      {showResult && result && status === "completed" && (
        <Box marginLeft={2}>
          <Text dimColor>
            {truncateText(result, width - 4)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact Tool Row (for activity timeline)
// ─────────────────────────────────────────────────────────────────────────────

export interface CompactToolRowProps {
  toolName: string;
  /** Tool arguments; rendered as a single-line `tool: <call>` label. */
  toolInput?: Record<string, unknown>;
  status: "running" | "completed" | "error" | "interrupted";
  intent?: string;
  elapsedMs?: number;
  diffStats?: DiffStats;
  width: number;
}

export function CompactToolRow({
  toolName,
  toolInput,
  status,
  intent,
  elapsedMs,
  diffStats,
  width,
}: CompactToolRowProps): ReactElement {
  const icon = ICONS[status];
  const color = COLORS[status];
  const timeStr = elapsedMs ? ` (${formatDuration(elapsedMs)})` : "";
  const diffStr = diffStats ? ` ${formatDiffStatsForDisplay(diffStats)}` : "";

  const displayText = truncateDisplay(
    `${icon} ${toolCallLabel(toolName, toolInput)}`,
    width,
  );
  const intentText = intent ? ` — ${intent}` : "";

  return (
    <Text>
      <Text color={color}>{displayText}</Text>
      <Text dimColor>{intentText}{timeStr}</Text>
      {diffStr && <Text color="green">{diffStr}</Text>}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Arguments shown after the tool name on a live activity row, in order. */
const CALL_LABEL_ARGS: Record<string, string[]> = {
  bash: ["command"],
  read: ["path", "file_path"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  ls: ["path"],
  find: ["path", "pattern"],
  glob: ["pattern"],
  grep: ["path", "pattern"],
};

/**
 * Single-line `tool: <what it will run>` label for a tool call, e.g.
 * `bash: cd src & ls` or `read: src/main.ts`. Multi-line commands are
 * flattened onto one line. Falls back to the bare tool name when the call
 * carries no argument (or the tool has no known display argument).
 */
export function toolCallLabel(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const keys = CALL_LABEL_ARGS[toolName.toLowerCase()];
  if (keys === undefined) return toolName;
  const parts: string[] = [];
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value !== "string") continue;
    const text = normalizeCommand(value);
    if (text !== "") parts.push(text);
  }
  if (parts.length === 0) return toolName;
  return `${toolName}: ${parts.join(" ")}`;
}

function getToolDisplayName(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  // Special formatting for common tools
  if (name === "bash") {
    const cmd = input?.command as string | undefined;
    if (cmd) {
      const firstWord = cmd.split(" ")[0];
      return `${toolName}: ${firstWord}`;
    }
  }

  if (name === "read" || name === "write" || name === "edit") {
    const filePath = input?.file_path as string | undefined;
    if (filePath) {
      const fileName = filePath.split("/").pop() || filePath;
      return `${toolName} ${fileName}`;
    }
  }

  return toolName;
}

function generateIntent(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  switch (name) {
    case "bash": {
      const cmd = input?.command as string | undefined;
      if (cmd) {
        // Try to infer intent from command
        if (cmd.includes("test")) return "running tests";
        if (cmd.includes("build")) return "building";
        if (cmd.includes("install")) return "installing dependencies";
        if (cmd.includes("run")) return "running";
        return truncateText(cmd, 50);
      }
      break;
    }

    case "read":
      return "reading file";

    case "write":
      return "writing file";

    case "edit":
      return "editing file";

    case "glob":
    case "ls":
      return "listing files";

    case "grep":
    case "search":
      return "searching";
  }

  return "";
}

function formatToolInput(
  input: Record<string, unknown>,
  maxWidth: number,
): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    const valueStr = typeof value === "string" ? value : JSON.stringify(value);

    if (valueStr.length > maxWidth) {
      lines.push(`${key}: ${truncateText(valueStr, maxWidth)}`);
    } else {
      lines.push(`${key}: ${valueStr}`);
    }
  }

  return lines.join("\n");
}

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.substring(0, maxWidth - 3) + "...";
}

function formatDiffStatsForDisplay(stats: DiffStats): string {
  const parts: string[] = [];

  if (stats.additions > 0) {
    parts.push(`+${stats.additions}`);
  }
  if (stats.deletions > 0) {
    parts.push(`-${stats.deletions}`);
  }

  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Execution Summary
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecutionSummaryProps {
  tools: Array<{
    toolName: string;
    status: string;
    elapsedMs?: number;
  }>;
  translator: Translator;
}

export function ToolExecutionSummary({
  tools,
  translator,
}: ToolExecutionSummaryProps): ReactElement {
  const counts = {
    total: tools.length,
    running: tools.filter((t) => t.status === "running").length,
    completed: tools.filter((t) => t.status === "completed").length,
    error: tools.filter((t) => t.status === "error").length,
  };

  if (counts.total === 0) return <Text />;

  return (
    <Text dimColor>
      {translator.text("tool.summary", counts.total)}
      {counts.running > 0 &&
        ` (${counts.running} ${translator.text("tool.running")})`}
      {counts.error > 0 &&
        ` (${counts.error} ${translator.text("tool.errors")})`}
    </Text>
  );
}
