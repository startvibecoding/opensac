// Presentation types for the per-turn activity timeline and diff stats.
//
// Rendering lives in tool_execution_display.tsx / thinking_display.tsx: the
// app renders one CompactToolRow (tools) or CompactThinkingRow (thinking)
// per ActivityManager item (moark-style turn cards, see app.tsx). This module
// keeps only the shared shape types the manager and the display components
// agree on; the earlier TurnCard/ActivityRow/ResponseSection components and
// the buildActivityTimeline/diff-stat builders were superseded by that path
// and removed (they had no remaining callers or tests).

export type ActivityStatus =
  "pending" | "running" | "completed" | "error" | "interrupted";
export type ActivityType =
  "tool" | "thinking" | "intermediate" | "status" | "plan";

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

/** Line/word counts shown after an edit/write tool row. */
export interface DiffStats {
  additions: number;
  deletions: number;
  files: number;
}
