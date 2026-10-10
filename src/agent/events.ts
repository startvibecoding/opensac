//
// The internal agent event vocabulary. It intentionally differs in numeric
// ordering from the public `sdk/agent` event codes; `bridge.ts` maps between
// the two. Field names are camelCase to match the rest of the TS port.

import { type Attachment, type Usage } from "../provider/types.ts";
import { type ContextUsage } from "../context/mod.ts";
import { type FileDiff, type TaskPlan } from "../tools/mod.ts";
import {
  type HostedItem,
  type Message,
  type ToolCallBlock,
} from "../provider/types.ts";
import { type AgentID } from "../../sdk/agent/types.ts";

/** EventType identifies the type of agent event. */
export type EventType = number;

// Agent lifecycle events
export const EVENT_AGENT_START: EventType = 0;
export const EVENT_AGENT_END: EventType = 1;

// Turn lifecycle events (a turn = one assistant response + tool calls/results)
export const EVENT_TURN_START: EventType = 2;
export const EVENT_TURN_END: EventType = 3;

// Message lifecycle events
export const EVENT_MESSAGE_START: EventType = 4;
export const EVENT_MESSAGE_UPDATE: EventType = 5;
export const EVENT_MESSAGE_END: EventType = 6;

// Streaming events
export const EVENT_TEXT_DELTA: EventType = 7;
export const EVENT_THINK_DELTA: EventType = 8;
export const EVENT_HOSTED_ITEM: EventType = 9;

// Tool execution events
export const EVENT_TOOL_CALL: EventType = 10;
export const EVENT_TOOL_EXECUTION_START: EventType = 11;
export const EVENT_TOOL_EXECUTION_UPDATE: EventType = 12;
export const EVENT_TOOL_EXECUTION_END: EventType = 13;
export const EVENT_TOOL_RESULT: EventType = 14;
export const EVENT_TOOL_APPROVAL_REQUEST: EventType = 15;
export const EVENT_TOOL_APPROVAL_RESPONSE: EventType = 16;
export const EVENT_QUESTION_REQUEST: EventType = 17;
export const EVENT_QUESTION_RESPONSE: EventType = 18;
export const EVENT_PLAN_UPDATE: EventType = 19;

// Status events
export const EVENT_STATUS: EventType = 20;
export const EVENT_DONE: EventType = 21;
export const EVENT_ERROR: EventType = 22;
export const EVENT_USAGE: EventType = 23;
export const EVENT_RETRY: EventType = 24;

// Compaction events
export const EVENT_COMPACTION_START: EventType = 25;
export const EVENT_COMPACTION_END: EventType = 26;

// Pressure events
export const EVENT_CONTEXT_PRESSURE: EventType = 27;
export const EVENT_BUDGET_PRESSURE: EventType = 28;

// EVENT_RUN_FINISHED is the single canonical terminal event for a run. Exactly
// one is emitted per run before the legacy EVENT_DONE/EVENT_ERROR and the
// EVENT_AGENT_END lifecycle event.
export const EVENT_RUN_FINISHED: EventType = 29;

/** TaskStatus is the canonical terminal outcome of an agent run/task. */
export type TaskStatus = string;

export const TASK_SUCCESS: TaskStatus = "success";
export const TASK_INCOMPLETE: TaskStatus = "incomplete";
export const TASK_ERROR: TaskStatus = "error";
/** Retained as a source-compatible alias for TASK_ERROR. */
export const TASK_FAILED: TaskStatus = TASK_ERROR;
export const TASK_CANCELED: TaskStatus = "canceled";

/** Reports whether the TaskStatus represents a finished run outcome. */
export function taskStatusIsTerminal(s: TaskStatus): boolean {
  switch (s) {
    case TASK_SUCCESS:
    case TASK_INCOMPLETE:
    case TASK_FAILED:
    case TASK_CANCELED:
      return true;
  }
  return false;
}

/** Reports whether the outcome is a successful completion. */
export function taskStatusIsSuccessful(s: TaskStatus): boolean {
  return s === TASK_SUCCESS;
}

/** Canonical terminal state for a tool execution projection. */
export const TOOL_EXECUTION_COMPLETED = "completed" as const;
export const TOOL_EXECUTION_FAILED = "failed" as const;
export const TOOL_EXECUTION_INTERRUPTED = "interrupted" as const;
export const TOOL_EXECUTION_REUSED = "reused" as const;

export type ToolExecutionState =
  | typeof TOOL_EXECUTION_COMPLETED
  | typeof TOOL_EXECUTION_FAILED
  | typeof TOOL_EXECUTION_INTERRUPTED
  | typeof TOOL_EXECUTION_REUSED;

/** Event represents an event from the agent to the UI. */
export interface Event {
  type: EventType;
  agentId?: AgentID;

  // Expert-team metadata (additive; empty when no expert team is bound).
  memberId?: string;
  expertId?: string;
  memberDisplayName?: string;
  memberEmoji?: string;
  memberRole?: string;

  // Agent lifecycle
  messages?: Message[];

  // Turn lifecycle
  turnMessage?: Message;
  turnToolResults?: Message[];

  // Message lifecycle
  message?: Message;

  // Stream events
  textDelta?: string;
  thinkDelta?: string;
  hostedItem?: HostedItem;

  // Tool events
  toolCall?: ToolCallBlock;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolDiff?: FileDiff;
  toolError?: Error;
  toolExecutionState?: ToolExecutionState;
  toolImages?: ToolImage[];
  partialResult?: unknown;

  // Plan events
  plan?: TaskPlan;

  // Approval events
  approvalId?: string;
  approvalTool?: string;
  approvalArgs?: Record<string, unknown>;
  approvalResult?: boolean;

  // Question events
  questionId?: string;
  questionText?: string;
  questionOptions?: string[];
  questionContext?: string;
  questionAnswer?: string;

  // Status
  statusMessage?: string;
  responseStateFailureClass?: string;
  retryStatus?: boolean;

  // Retry information for automatic provider and turn recovery.
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryAfterMs?: number;
  retryMaxTokens?: number;
  retryReason?: string;
  retryContinue?: boolean;

  // Completion
  done?: boolean;
  stopReason?: string;
  error?: Error;
  assistantEntryId?: string;
  assistantMessage?: Message;
  status?: TaskStatus;

  // Usage
  usage?: Usage;

  // Attachments
  attachments?: Attachment[];

  // Context usage
  contextUsage?: ContextUsage;

  // Pressure info (for EVENT_CONTEXT_PRESSURE / EVENT_BUDGET_PRESSURE)
  pressureMessage?: string;
  pressureType?: string;
  pressurePercent?: number;
}

/** ToolImage is one image payload extracted from a rich tool result. */
export interface ToolImage {
  mimeType: string;
  data: string;
}
