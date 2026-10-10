// Compact tool row for the live activity timeline: a colored status icon plus
// a single-line `tool: <call>` label, dim intent/timing, and green diff stats.
//
// The fuller ToolExecutionDisplay card/summary variants were superseded by
// the transcript's committed tool rows (app.tsx renders formatToolRow output
// from tool_row_format.ts) and removed — nothing else called them.

import React from "react";
import type { ReactElement } from "react";
import { Text } from "ink";
import { formatDuration, truncateDisplay } from "./formatters.ts";
import { normalizeCommand } from "./tool_row_format.ts";
import { type DiffStats } from "./turn_card.tsx";

const ICONS = {
  running: ">",
  completed: "o",
  error: "x",
  interrupted: "=",
};

const COLORS = {
  running: "cyan",
  completed: "green",
  error: "red",
  interrupted: "yellow",
};

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
