// TurnCard-inspired component for Ink TUI.
//
// This component renders a conversation turn with:
// - Activity timeline showing tool executions and thinking
// - Collapsible tool results
// - Response text with markdown rendering
// - Status indicators and timing
//
// Inspired by moark's TurnCard.tsx but adapted for terminal rendering.

import React from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { displayWidth, formatDuration } from "./formatters.ts";
import type { Translator } from "./i18n.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ActivityStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "interrupted";
export type ActivityType =
  | "tool"
  | "thinking"
  | "intermediate"
  | "status"
  | "plan";

export interface ActivityItem {
  id: string;
  type: ActivityType;
  status: ActivityStatus;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  content?: string;
  intent?: string;
  timestamp: number;
  error?: string;
  elapsedMs?: number;
  /** Nesting level for sub-agent tasks */
  depth?: number;
  /** Parent activity ID for nested tasks */
  parentId?: string;
}

export interface ResponseContent {
  text: string;
  isStreaming: boolean;
  streamStartTime?: number;
  timestamp?: number;
}

export interface TurnCardProps {
  /** Turn identifier */
  turnId: string;
  /** Activity timeline items */
  activities: ActivityItem[];
  /** Response content */
  response?: ResponseContent;
  /** Intent/description of the turn */
  intent?: string;
  /** Whether this turn is currently streaming */
  isStreaming?: boolean;
  /** Whether the turn is complete */
  isComplete?: boolean;
  /** Whether the card is expanded */
  isExpanded?: boolean;
  /** Translator for i18n */
  translator: Translator;
  /** Terminal width */
  width: number;
  /** Callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style Constants
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  tool: "⏺",
  thinking: "💭",
  pending: "○",
  running: "◐",
  completed: "●",
  error: "✗",
  interrupted: "⏸",
  expand: "▶",
  collapse: "▼",
  chevron: "›",
};

// ─────────────────────────────────────────────────────────────────────────────
// TurnCard Component
// ─────────────────────────────────────────────────────────────────────────────

export function TurnCard({
  activities,
  response,
  isStreaming = false,
  isComplete = false,
  isExpanded = true,
  translator,
  width,
}: TurnCardProps): ReactElement {
  const contentWidth = width - 4; // Reserve space for indentation and margins

  // Render collapsed view when not expanded
  if (!isExpanded) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>
          {ICONS.expand} {translator.text("turn.collapsed")}{" "}
          ({activities.length} {translator.text("turn.activities")})
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Activity Timeline */}
      {activities.length > 0 && (
        <Box flexDirection="column" marginLeft={1}>
          {activities.map((activity, index) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              index={index}
              translator={translator}
              width={contentWidth}
            />
          ))}
        </Box>
      )}

      {/* Response Section */}
      {response && response.text && (
        <Box flexDirection="column" marginTop={activities.length > 0 ? 1 : 0}>
          <ResponseSection
            response={response}
            translator={translator}
            width={contentWidth}
          />
        </Box>
      )}

      {/* Streaming indicator */}
      {isStreaming && !isComplete && (
        <Box marginTop={1}>
          <Text dimColor>
            {ICONS.running} {translator.text("turn.streaming")}...
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Row Component
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityRowProps {
  activity: ActivityItem;
  index: number;
  translator: Translator;
  width: number;
}

function ActivityRow({ activity, width }: ActivityRowProps): ReactElement {
  const icon = getActivityIcon(activity);
  const statusColor = getStatusColor(activity.status);
  const indent = activity.depth ? "  ".repeat(activity.depth) : "";

  // Truncate intent/content for display
  const displayText = activity.intent || activity.content || "";
  const truncatedText = truncateText(displayText, width - 10 - indent.length);

  // Format elapsed time
  const timeStr = activity.elapsedMs ? formatDuration(activity.elapsedMs) : "";

  return (
    <Box key={activity.id} flexDirection="row">
      <Text>
        {indent}
        {icon}{" "}
        <Text color={statusColor}>
          {activity.toolName || activity.type}
        </Text>
        {truncatedText && <Text dimColor>— {truncatedText}</Text>}
        {timeStr && <Text dimColor>({timeStr})</Text>}
      </Text>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Response Section Component
// ─────────────────────────────────────────────────────────────────────────────

interface ResponseSectionProps {
  response: ResponseContent;
  translator: Translator;
  width: number;
}

function ResponseSection({ response }: ResponseSectionProps): ReactElement {
  // Show streaming indicator if still streaming
  if (response.isStreaming) {
    return (
      <Box flexDirection="column">
        <Text>
          {ICONS.chevron} {response.text}
          <Text dimColor>▊</Text>
        </Text>
      </Box>
    );
  }

  // Show completed response
  return (
    <Box flexDirection="column">
      <Text>
        {response.text.split("\n").map((line, i) => (
          <Text key={i}>
            {i === 0 ? ICONS.chevron + " " : "  "}
            {line}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function getActivityIcon(activity: ActivityItem): string {
  switch (activity.type) {
    case "tool":
      return ICONS.tool;
    case "thinking":
      return ICONS.thinking;
    case "plan":
      return "📋";
    case "status":
      return "ℹ";
    default:
      return "•";
  }
}

function getStatusColor(status: ActivityStatus): string {
  switch (status) {
    case "pending":
      return "gray";
    case "running":
      return "cyan";
    case "completed":
      return "green";
    case "error":
      return "red";
    case "interrupted":
      return "yellow";
    default:
      return "white";
  }
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const width = displayWidth(text);
  if (width <= maxWidth) return text;

  const suffix = "...";
  const target = maxWidth - displayWidth(suffix);
  if (target <= 0) return suffix;

  let w = 0;
  let out = "";
  const chars = Array.from(text);

  for (const ch of chars) {
    const rw = displayWidth(ch);
    if (w + rw > target) break;
    out += ch;
    w += rw;
  }

  return out + suffix;
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Timeline Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds an activity timeline from tool results and events.
 * Groups activities by parent-child relationships.
 */
export function buildActivityTimeline(
  toolResults: Array<{
    toolCallID: string;
    toolName: string;
    status: string;
    summary?: string;
    toolError?: string;
    elapsedMs?: number;
  }>,
  thinkingBlocks?: Array<{
    id: string;
    content: string;
    startTime?: number;
    endTime?: number;
  }>,
): ActivityItem[] {
  const activities: ActivityItem[] = [];
  const now = Date.now();

  // Add thinking blocks first
  if (thinkingBlocks) {
    for (const block of thinkingBlocks) {
      activities.push({
        id: block.id,
        type: "thinking",
        status: "completed",
        content: block.content,
        timestamp: block.startTime || now,
        elapsedMs: block.startTime && block.endTime
          ? block.endTime - block.startTime
          : undefined,
      });
    }
  }

  // Add tool results
  for (const result of toolResults) {
    activities.push({
      id: result.toolCallID,
      type: "tool",
      status: result.status as ActivityStatus,
      toolName: result.toolName,
      toolUseId: result.toolCallID,
      content: result.summary,
      error: result.toolError,
      timestamp: now,
      elapsedMs: result.elapsedMs,
    });
  }

  return activities;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff Stats Display
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffStats {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * Formats diff stats for display in the activity timeline.
 */
export function formatDiffStats(stats: DiffStats): string {
  const parts: string[] = [];

  if (stats.additions > 0) {
    parts.push(`+${stats.additions}`);
  }
  if (stats.deletions > 0) {
    parts.push(`-${stats.deletions}`);
  }
  if (stats.files > 1) {
    parts.push(`${stats.files} files`);
  }

  return parts.join(" ");
}

/**
 * Computes diff stats from file diffs.
 */
export function computeDiffStats(
  diffs: Array<{ added: number; deleted: number }>,
): DiffStats {
  let additions = 0;
  let deletions = 0;

  for (const diff of diffs) {
    additions += diff.added;
    deletions += diff.deleted;
  }

  return {
    additions,
    deletions,
    files: diffs.length,
  };
}
