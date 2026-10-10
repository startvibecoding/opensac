// Activity Manager for tracking tool executions, thinking, and sub-agent tasks.
//
// Inspired by moark's activity tracking system but adapted for Ink TUI.
// Manages the activity timeline for each conversation turn.

import {
  TOOL_EXECUTION_FAILED,
  TOOL_EXECUTION_INTERRUPTED,
  type ToolExecutionState,
} from "../agentruntime/events.ts";
import { type ActivityItem, type ActivityStatus } from "./turn_card.tsx";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecution {
  id: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  status: ActivityStatus;
  result?: string;
  error?: string;
  intent?: string;
  parentId?: string;
  depth: number;
}

export interface ThinkingBlock {
  id: string;
  content: string;
  startTime: number;
  endTime?: number;
  isStreaming: boolean;
}

export interface SubAgentTask {
  id: string;
  parentToolCallId: string;
  status: ActivityStatus;
  startTime: number;
  endTime?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages the activity timeline for a conversation turn.
 * Tracks tool executions, thinking blocks, and sub-agent tasks.
 */
export class ActivityManager {
  #tools: Map<string, ToolExecution> = new Map();
  #thinking: Map<string, ThinkingBlock> = new Map();
  #subAgents: Map<string, SubAgentTask> = new Map();
  #activityOrder: string[] = [];

  // ── Tool Execution Tracking ────────────────────────────────────────────────

  /**
   * Starts tracking a tool execution.
   */
  startToolExecution(
    id: string,
    toolName: string,
    toolInput?: Record<string, unknown>,
    intent?: string,
    parentId?: string,
  ): void {
    if (this.#tools.has(id)) return;

    // Determine depth based on parent
    let depth = 0;
    if (parentId) {
      const parent = this.#tools.get(parentId);
      if (parent) {
        depth = parent.depth + 1;
      }
    }

    this.#tools.set(id, {
      id,
      toolName,
      toolInput,
      startTime: Date.now(),
      status: "running",
      intent,
      parentId,
      depth,
    });

    this.#activityOrder.push(id);
  }

  /**
   * Updates a tool execution with its result.
   */
  completeToolExecution(
    id: string,
    result?: string,
    error?: string,
    executionState?: ToolExecutionState,
  ): void {
    const tool = this.#tools.get(id);
    if (!tool) return;

    tool.endTime = Date.now();
    tool.result = result;
    tool.error = error;
    tool.status = executionState === TOOL_EXECUTION_INTERRUPTED
      ? "interrupted"
      : error || executionState === TOOL_EXECUTION_FAILED
      ? "error"
      : "completed";
  }

  /**
   * Marks a tool execution as interrupted.
   */
  interruptToolExecution(id: string): void {
    const tool = this.#tools.get(id);
    if (!tool) return;

    tool.endTime = Date.now();
    tool.status = "interrupted";
  }

  /**
   * Gets all active (running) tool executions.
   */
  getActiveTools(): ToolExecution[] {
    return Array.from(this.#tools.values()).filter((t) =>
      t.status === "running"
    );
  }

  // ── Thinking Block Tracking ────────────────────────────────────────────────

  /**
   * Starts a thinking block.
   */
  startThinking(id: string): void {
    if (this.#thinking.has(id)) return;

    this.#thinking.set(id, {
      id,
      content: "",
      startTime: Date.now(),
      isStreaming: true,
    });

    this.#activityOrder.push(`thinking-${id}`);
  }

  /**
   * Appends content to a thinking block.
   */
  appendThinking(id: string, content: string): void {
    const block = this.#thinking.get(id);
    if (!block) return;

    block.content += content;
  }

  /**
   * Completes a thinking block.
   */
  completeThinking(id: string): void {
    const block = this.#thinking.get(id);
    if (!block) return;

    block.endTime = Date.now();
    block.isStreaming = false;
  }

  // ── Sub-Agent Task Tracking ────────────────────────────────────────────────

  /**
   * Starts tracking a sub-agent task.
   */
  startSubAgentTask(
    id: string,
    parentToolCallId: string,
  ): void {
    if (this.#subAgents.has(id)) return;

    this.#subAgents.set(id, {
      id,
      parentToolCallId,
      status: "running",
      startTime: Date.now(),
    });
  }

  /**
   * Completes a sub-agent task.
   */
  completeSubAgentTask(id: string, status: ActivityStatus = "completed"): void {
    const task = this.#subAgents.get(id);
    if (!task) return;

    task.endTime = Date.now();
    task.status = status;
  }

  // ─- Activity Timeline ───────────────────────────────────────────────────────

  /**
   * Builds the activity timeline for display.
   */
  buildTimeline(): ActivityItem[] {
    const items: ActivityItem[] = [];
    const now = Date.now();

    // Add thinking blocks (only streaming ones; completed blocks are in transcript)
    for (const [id, block] of this.#thinking) {
      if (!block.isStreaming) continue;
      items.push({
        id: `thinking-${id}`,
        type: "thinking",
        status: "running",
        content: block.content,
        timestamp: block.startTime,
        elapsedMs: now - block.startTime,
      });
    }

    // Add tool executions
    for (const [id, tool] of this.#tools) {
      items.push({
        id,
        type: "tool",
        status: tool.status,
        toolName: tool.toolName,
        toolUseId: id,
        toolInput: tool.toolInput,
        content: tool.result,
        intent: tool.intent,
        error: tool.error,
        timestamp: tool.startTime,
        elapsedMs: tool.endTime
          ? tool.endTime - tool.startTime
          : now - tool.startTime,
        depth: tool.depth,
        parentId: tool.parentId,
      });
    }

    // Sort by timestamp
    items.sort((a, b) => a.timestamp - b.timestamp);

    return items;
  }

  /**
   * Gets the count of activities by status.
   */
  getActivityCounts(): {
    total: number;
    running: number;
    completed: number;
    error: number;
    interrupted: number;
  } {
    let running = 0;
    let completed = 0;
    let error = 0;
    let interrupted = 0;

    for (const tool of this.#tools.values()) {
      switch (tool.status) {
        case "running":
          running++;
          break;
        case "completed":
          completed++;
          break;
        case "error":
          error++;
          break;
        case "interrupted":
          interrupted++;
          break;
      }
    }

    return {
      total: this.#tools.size,
      running,
      completed,
      error,
      interrupted,
    };
  }

  /**
   * Checks if there are any running activities.
   */
  hasRunningActivities(): boolean {
    return this.getActiveTools().length > 0;
  }

  /**
   * Clears all activity tracking.
   */
  clear(): void {
    this.#tools.clear();
    this.#thinking.clear();
    this.#subAgents.clear();
    this.#activityOrder = [];
  }

  // ─- Utility Methods ─────────────────────────────────────────────────────────

  /**
   * Gets a tool execution by ID.
   */
  getTool(id: string): ToolExecution | undefined {
    return this.#tools.get(id);
  }

  /**
   * Gets all tool executions.
   */
  getAllTools(): ToolExecution[] {
    return Array.from(this.#tools.values());
  }

  /**
   * Gets a thinking block by ID.
   */
  getThinking(id: string): ThinkingBlock | undefined {
    return this.#thinking.get(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global activity manager instance.
 * Reset this when starting a new turn.
 */
let globalManager: ActivityManager | undefined;

export function getActivityManager(): ActivityManager {
  if (!globalManager) {
    globalManager = new ActivityManager();
  }
  return globalManager;
}

export function resetActivityManager(): void {
  globalManager = new ActivityManager();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats elapsed time for display.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * Determines if a tool is a "parent" tool (spawns sub-agents).
 */
export function isParentTool(toolName: string): boolean {
  const parentTools = ["task", "agent", "spawn"];
  return parentTools.some((t) => toolName.toLowerCase().includes(t));
}

/**
 * Extracts the final path segment. Tool input paths arrive in the host's own
 * syntax, so a Windows backslash path must not render as one long "file name";
 * accept either separator regardless of the platform this process runs on.
 */
function pathBaseName(p: string): string {
  const separator = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return separator >= 0 ? (p.slice(separator + 1) || p) : p;
}
/**
 * Generates a display-friendly tool name.
 */
export function getToolDisplayName(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  // Special formatting for common tools
  switch (toolName.toLowerCase()) {
    case "bash": {
      const cmd = toolInput?.command as string | undefined;
      if (cmd) {
        // Truncate long commands
        return cmd.length > 30 ? cmd.substring(0, 30) + "..." : cmd;
      }
      return "Bash";
    }

    case "read": {
      const filePath = toolInput?.file_path as string | undefined;
      if (filePath) {
        return `Read ${pathBaseName(filePath)}`;
      }
      return "Read file";
    }

    case "write": {
      const writePath = toolInput?.file_path as string | undefined;
      if (writePath) {
        return `Write ${pathBaseName(writePath)}`;
      }
      return "Write file";
    }

    case "edit": {
      const editPath = toolInput?.file_path as string | undefined;
      if (editPath) {
        return `Edit ${pathBaseName(editPath)}`;
      }
      return "Edit file";
    }

    default:
      return toolName;
  }
}
