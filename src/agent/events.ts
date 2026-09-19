// Ported from internal/agent/events.go.
//
// The internal agent event vocabulary. It intentionally differs in numeric
// ordering from the public `sdk/agent` event codes; `bridge.ts` maps between
// the two. Field names are camelCase to match the rest of the TS port.

import type { Attachment, Usage } from "../provider/types.ts";
import type { ContextUsage } from "../context/mod.ts";
import type { FileDiff, TaskPlan } from "../tools/mod.ts";
import type { HostedItem, Message, ToolCallBlock } from "../provider/types.ts";
import type { AgentID } from "../../sdk/agent/types.ts";

/** EventType identifies the type of agent event. */
export type EventType = number;

// Agent lifecycle events
export const EventAgentStart: EventType = 0;
export const EventAgentEnd: EventType = 1;

// Turn lifecycle events (a turn = one assistant response + tool calls/results)
export const EventTurnStart: EventType = 2;
export const EventTurnEnd: EventType = 3;

// Message lifecycle events
export const EventMessageStart: EventType = 4;
export const EventMessageUpdate: EventType = 5;
export const EventMessageEnd: EventType = 6;

// Streaming events
export const EventTextDelta: EventType = 7;
export const EventThinkDelta: EventType = 8;
export const EventHostedItem: EventType = 9;

// Tool execution events
export const EventToolCall: EventType = 10;
export const EventToolExecutionStart: EventType = 11;
export const EventToolExecutionUpdate: EventType = 12;
export const EventToolExecutionEnd: EventType = 13;
export const EventToolResult: EventType = 14;
export const EventToolApprovalRequest: EventType = 15;
export const EventToolApprovalResponse: EventType = 16;
export const EventQuestionRequest: EventType = 17;
export const EventQuestionResponse: EventType = 18;
export const EventPlanUpdate: EventType = 19;

// Status events
export const EventStatus: EventType = 20;
export const EventDone: EventType = 21;
export const EventError: EventType = 22;
export const EventUsage: EventType = 23;
export const EventRetry: EventType = 24;

// Compaction events
export const EventCompactionStart: EventType = 25;
export const EventCompactionEnd: EventType = 26;

// Pressure events
export const EventContextPressure: EventType = 27;
export const EventBudgetPressure: EventType = 28;

// EventRunFinished is the single canonical terminal event for a run. Exactly
// one is emitted per run before the legacy EventDone/EventError and the
// EventAgentEnd lifecycle event.
export const EventRunFinished: EventType = 29;

/** TaskStatus is the canonical terminal outcome of an agent run/task. */
export type TaskStatus = string;

export const TaskSuccess: TaskStatus = "success";
export const TaskIncomplete: TaskStatus = "incomplete";
export const TaskError: TaskStatus = "error";
/** Retained as a source-compatible alias for TaskError. */
export const TaskFailed: TaskStatus = TaskError;
export const TaskCanceled: TaskStatus = "canceled";

/** Reports whether the TaskStatus represents a finished run outcome. */
export function taskStatusIsTerminal(s: TaskStatus): boolean {
  switch (s) {
    case TaskSuccess:
    case TaskIncomplete:
    case TaskFailed:
    case TaskCanceled:
      return true;
  }
  return false;
}

/** Reports whether the outcome is a successful completion. */
export function taskStatusIsSuccessful(s: TaskStatus): boolean {
  return s === TaskSuccess;
}

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
  toolExecutionState?: string;
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

  // Pressure info (for EventContextPressure / EventBudgetPressure)
  pressureMessage?: string;
  pressureType?: string;
  pressurePercent?: number;
}

/** ToolImage is one image payload extracted from a rich tool result. */
export interface ToolImage {
  mimeType: string;
  data: string;
}
