// Projects canonical Core run events onto the Agent event vocabulary consumed
// by the TUI controller. The Core event stream is the only source of prompt
// lifecycle events; this module translates wire payloads back into the exact
// canonical event semantics (never synthesizing a second success/failure
// stream) so the controller renders service runs exactly like in-process runs.

import type { CoreRuntimeEvent } from "../core/runtime.ts";
import { deserializeAgentEvent } from "../agentruntime/session_executor.ts";
import {
  type Event,
  EVENT_QUESTION_REQUEST,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_APPROVAL_REQUEST,
  TASK_CANCELED,
  TASK_FAILED,
  TASK_INCOMPLETE,
  TASK_SUCCESS,
  type TaskStatus,
} from "../agentruntime/events.ts";

/**
 * Converts one canonical Core event into an Agent event for the controller.
 * Returns `undefined` for events with no controller projection (for example
 * `run_started`, which the submission path already renders).
 */
export function coreEventToAgentEvent(
  event: CoreRuntimeEvent,
): Event | undefined {
  const payload = event.payload ?? {};
  const embedded = payload.agentEvent;
  if (isRecord(embedded) && typeof embedded.type === "number") {
    return deserializeAgentEvent(embedded);
  }
  switch (event.eventType) {
    case "run_started":
      return undefined;
    case "text_delta":
      return {
        type: EVENT_TEXT_DELTA,
        textDelta: stringOr(payload.text, ""),
      };
    case "thinking_delta":
    case "reasoning_delta":
      return {
        type: EVENT_THINK_DELTA,
        thinkDelta: stringOr(payload.thinking ?? payload.text, ""),
      };
    case "run_finished":
      return {
        type: EVENT_RUN_FINISHED,
        status: taskStatusFor(payload.status),
        ...(typeof payload.error === "string" && payload.error !== ""
          ? { error: new Error(payload.error) }
          : {}),
      };
    default:
      break;
  }
  if (typeof payload.approvalId === "string") {
    return {
      type: EVENT_TOOL_APPROVAL_REQUEST,
      approvalId: payload.approvalId,
      approvalTool: stringOr(payload.approvalTool, ""),
      ...(isRecord(payload.approvalArgs)
        ? { approvalArgs: payload.approvalArgs }
        : {}),
    };
  }
  if (typeof payload.questionId === "string") {
    return {
      type: EVENT_QUESTION_REQUEST,
      questionId: payload.questionId,
      questionText: stringOr(payload.questionText, ""),
      ...(Array.isArray(payload.questionOptions)
        ? {
          questionOptions: payload.questionOptions.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
        : {}),
      ...(typeof payload.questionContext === "string"
        ? { questionContext: payload.questionContext }
        : {}),
    };
  }
  return {
    type: EVENT_STATUS,
    statusMessage: stringOr(payload.status ?? payload.text, event.eventType),
    ...(payload.retryStatus === true ? { retryStatus: true } : {}),
  };
}

/** Maps a canonical run status onto the terminal TaskStatus vocabulary. */
export function taskStatusFor(status: unknown): TaskStatus {
  switch (status) {
    case "cancelled":
    case "canceled":
      return TASK_CANCELED;
    case "failed":
    case "error":
      return TASK_FAILED;
    case "timed_out":
      return TASK_INCOMPLETE;
    default:
      return TASK_SUCCESS;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
