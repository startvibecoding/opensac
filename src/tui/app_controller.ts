// the App's agent-event dispatch.
// The Go method lives on the Bubble Tea App; the TS projection splits it into
// this controller (storage + queues + decision routing) with two injection
// points: a `RunHandle` for the ExecutionRuntime/DecisionService bridge and
// callbacks for messages/spinner. The Ink layer subscribes and renders.

import type { Event } from "../agentruntime/events.ts";
import type { TaskPlan } from "../tools/tool.ts";
import type { AgentID } from "../../sdk/agent/types.ts";
import {
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_HOSTED_ITEM,
  EVENT_PLAN_UPDATE,
  EVENT_QUESTION_REQUEST,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_APPROVAL_REQUEST,
  EVENT_TOOL_CALL,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
  EVENT_TOOL_RESULT,
  EVENT_TURN_END,
  EVENT_TURN_START,
  TASK_CANCELED,
  TASK_FAILED,
  TASK_INCOMPLETE,
  TASK_SUCCESS,
  type TaskStatus,
} from "../agentruntime/events.ts";
import type { RunState } from "../agentruntime/run_state.ts";
import type { ContextUsage } from "../context/context.ts";
import {
  DECISION_APPROVAL,
  DECISION_QUESTION,
  type DecisionKind,
} from "../agentruntime/decision.ts";
import { AgentActivityStore } from "./activity.ts";
import { ActivityManager } from "./activity_manager.ts";
import { type MessageKind, TranscriptStore } from "./transcript_store.ts";
import type { TUICoreConnectionState } from "./service.ts";
import { Translator } from "./i18n.ts";

export type { MessageKind };

/** The execution-lifecycle bridge the controller needs (tuiRun in Go). */
export interface RunHandle {
  /** Registers a decision; returns an error message when it is a duplicate. */
  registerDecision(id: string, kind: DecisionKind): string | undefined;
  /** Binds the resolver invoked when the human answers. */
  bindDecision(id: string, resolve: (value: string) => void): void;
  /** Resolves a decision and persists its resolved DecisionRecord. */
  resolveDecision?(id: string, kind: DecisionKind, value: string): void;
  /** Terminalizes the run with the canonical RunState. */
  finish(state: RunState): void;
  /** Marks the durable run as waiting on an approval (optional). */
  waitForApproval?(): void;
  /** Marks the durable run as waiting on a question (optional). */
  waitForQuestion?(): void;
  /** Returns the durable run to active execution after an answer (optional). */
  resume?(): void;
}

export interface PendingApproval {
  agentID: AgentID | undefined;
  approvalID: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface PendingQuestion {
  questionID: string;
  question: string;
  options?: string[];
  context?: string;
}

/** Terminal hosted-item statuses that stay visible in the simple view. */
const TERMINAL_HOSTED_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "failed",
  "error",
  "canceled",
  "cancelled",
]);

/**
 * Whether a hosted-item row also renders in the simple event view (Go
 * shouldShowHostedItem): progress rows are full-view detail, terminal rows
 * and items without a status stay visible.
 */
function hostedItemVisibleInCompact(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "" || TERMINAL_HOSTED_STATUSES.has(normalized);
}

/**
 * Whether a lifecycle status row also renders in the simple event view (Go
 * isImportantEventStatus): warnings, failures, denials, cancellations and
 * permission problems are never routine noise.
 */
function isImportantEventStatus(message: string): boolean {
  const lower = message.trim().toLowerCase();
  for (
    const marker of [
      "warning",
      "error",
      "failed",
      "denied",
      "canceled",
      "cancelled",
      "permission",
    ]
  ) {
    if (lower.includes(marker)) return true;
  }
  return false;
}

export interface AppControllerCallbacks {
  onMessage(kind: MessageKind, text: string): void;
  /** Requests a render; the Ink layer throttles. */
  scheduleRender(): void;
  /** Spinner kick while thinking (Go tickSpinner). */
  tickSpinner?(): void;
  /** Delivers a resolved approval to the owning (lead or member) agent. */
  deliverApproval?(approvalID: string, approved: boolean): void;
  /** Delivers a resolved question answer to the owning agent. */
  deliverQuestion?(questionID: string, answer: string): void;
}

export class AppController {
  readonly store: TranscriptStore;
  readonly activities: AgentActivityStore;
  /** Live per-turn activity timeline (tools, thinking) for the lead agent. */
  readonly activityManager = new ActivityManager();

  /** Whether the current turn has an open thinking block in the manager. */
  #thinkBlockOpen = false;

  waitingForApproval = false;
  waitingForQuestion = false;
  isThinking = false;
  runTerminalHandled = false;
  /**
   * The shared Core connection as the front end sees it. A restart is a
   * transient condition, so it lives in the live view and is never committed
   * to the transcript: history records what the user asked, not the transport
   * underneath it.
   */
  coreConnection: TUICoreConnectionState = "connected";
  /**
   * The line shown while the connection settles. A reconnect is confirmed
   * briefly and then cleared, so the live view returns to normal without
   * leaving a row behind.
   */
  coreConnectionNotice = "";
  /** Latest provider-reported context usage (mothx a.contextUsage). */
  contextUsage: ContextUsage | undefined;

  readonly approvalQueue: PendingApproval[] = [];
  readonly questionQueue: PendingQuestion[] = [];
  /** Currently displayed approval, if any. */
  shownApproval: PendingApproval | undefined;
  shownQuestion: PendingQuestion | undefined;

  #run: RunHandle | undefined;
  #leadAgentId: string | undefined;
  /** Latest published task plan (Ctrl+T). */
  #currentPlan: TaskPlan | undefined;
  /** Per-call plans pending their tool-result row (cleared every turn). */
  readonly #planByToolCall = new Map<string, TaskPlan>();
  readonly #cb: AppControllerCallbacks;
  readonly #translator: Translator;

  constructor(
    translator: Translator,
    cb: AppControllerCallbacks,
    options: { leadAgentId?: string } = {},
  ) {
    this.#translator = translator;
    this.#cb = cb;
    this.#leadAgentId = options.leadAgentId;
    this.store = new TranscriptStore({ translator });
    this.activities = new AgentActivityStore(translator);
  }

  setLeadAgentId(id: string | undefined): void {
    this.#leadAgentId = id;
  }

  /** The lead (interactive) agent ID; background events must not match it. */
  get leadAgentId(): string | undefined {
    return this.#leadAgentId;
  }

  /** The translator used for localized labels (Go App.translator). */
  get translator(): Translator {
    return this.#translator;
  }

  /** Clears the context/cache footer state (Go resetAgent + /clear). */
  resetContextUsage(): void {
    this.contextUsage = undefined;
  }

  attachRun(run: RunHandle | undefined): void {
    this.#run = run;
    this.runTerminalHandled = false;
  }

  /** The handle of the currently attached run, if any. */
  currentRunHandle(): RunHandle | undefined {
    return this.#run;
  }

  get runAttached(): boolean {
    return this.#run !== undefined;
  }

  /** The most recently published task plan, if the plan tool has run. */
  get currentPlan(): TaskPlan | undefined {
    return this.#currentPlan;
  }

  /** Adds a message row (Go addMessage): a plain transcript row plus the
   * typed notification channel for the Ink layer. */
  addMessage(text: string, kind: MessageKind = "plain"): void {
    this.store.addMessageRow(text, kind);
    this.#cb.onMessage(kind, text);
    this.#cb.scheduleRender();
  }

  /**
   * Adds a routine lifecycle row (Go addEventMessage). A row that is not
   * visible in the simple view stays in the transcript but renders only in the
   * full event view, so switching Ctrl+G back to full replays it.
   */
  addEventMessage(text: string, visibleInCompact: boolean): void {
    this.store.addMessageRow(text, "status", !visibleInCompact);
    this.#cb.onMessage("status", text);
    this.#cb.scheduleRender();
  }

  /**
   * Projects one shared Core connection transition into the live view. This
   * deliberately does not touch the transcript: the condition is about the
   * transport, and it clears itself once the connection settles.
   */
  setCoreConnection(
    state: TUICoreConnectionState,
    notice: string,
  ): void {
    this.coreConnection = state;
    this.coreConnectionNotice = notice;
    this.#cb.scheduleRender();
  }

  /** Clears a settled connection notice from the live view. */
  clearCoreConnectionNotice(): void {
    if (this.coreConnectionNotice === "") return;
    this.coreConnectionNotice = "";
    this.#cb.scheduleRender();
  }

  /** Handles one agent event (Go handleAgentEvent). */
  handleAgentEvent(event: Event): void {
    if (AgentActivityStore.isBackgroundAgentEvent(event, this.#leadAgentId)) {
      this.activities.record(event);
      this.#cb.scheduleRender();
      return;
    }

    switch (event.type) {
      case EVENT_TEXT_DELTA:
        this.store.appendAssistantDelta(event.textDelta ?? "");
        this.#cb.scheduleRender();
        return;

      case EVENT_THINK_DELTA: {
        const delta = event.thinkDelta ?? "";
        this.store.appendThinkDelta(delta);
        if (!this.#thinkBlockOpen) {
          this.activityManager.startThinking("turn");
          this.#thinkBlockOpen = true;
        }
        this.activityManager.appendThinking("turn", delta);
        this.#cb.scheduleRender();
        return;
      }

      case EVENT_HOSTED_ITEM:
        if (event.hostedItem) {
          let line = this.#translator.text("activity.hosted_item");
          if (event.hostedItem.type) line += ` [${event.hostedItem.type}]`;
          if (event.hostedItem.status) line += `: ${event.hostedItem.status}`;
          this.addEventMessage(
            line,
            hostedItemVisibleInCompact(event.hostedItem.status ?? ""),
          );
        }
        this.#cb.scheduleRender();
        return;

      case EVENT_TURN_START:
        // A new turn owns a fresh activity timeline (Go turn lifecycle).
        this.activityManager.clear();
        this.#thinkBlockOpen = false;
        this.#planByToolCall.clear();
        this.store.beginAssistantSlot();
        this.#cb.scheduleRender();
        return;

      case EVENT_TOOL_CALL:
        if (event.toolCall) {
          this.store.appendToolExecutionStart(
            event.toolCall.id,
            event.toolCall.name,
            event.toolArgs,
          );
          this.activityManager.startToolExecution(
            event.toolCall.id,
            event.toolCall.name,
            event.toolArgs,
          );
        }
        this.#cb.scheduleRender();
        return;

      case EVENT_TOOL_EXECUTION_START:
        this.store.appendToolExecutionStart(
          event.toolCallId ?? "",
          event.toolName ?? "",
          event.toolArgs,
        );
        this.activityManager.startToolExecution(
          event.toolCallId ?? "",
          event.toolName ?? "",
          event.toolArgs,
        );
        this.#cb.scheduleRender();
        return;

      case EVENT_TOOL_EXECUTION_END:
      case EVENT_TOOL_RESULT:
        this.store.appendToolResult({
          toolCallID: event.toolCallId ?? "",
          toolName: event.toolName,
          toolArgs: event.toolArgs,
          toolResult: event.toolResult,
          toolDiff: event.toolDiff,
          plan: this.#planByToolCall.get(event.toolCallId ?? ""),
          toolError: event.toolError,
          toolExecutionState: event.toolExecutionState,
        });
        this.activityManager.completeToolExecution(
          event.toolCallId ?? "",
          event.toolResult ?? "",
          event.toolError?.message,
          event.toolExecutionState,
        );
        this.#cb.scheduleRender();
        return;

      case EVENT_TURN_END:
        this.store.commitActiveStream();
        if (event.contextUsage !== undefined) {
          this.contextUsage = event.contextUsage;
        }
        if (this.#thinkBlockOpen) {
          this.activityManager.completeThinking("turn");
          this.#thinkBlockOpen = false;
        }
        this.#cb.scheduleRender();
        return;

      case EVENT_PLAN_UPDATE:
        if (event.plan !== undefined) {
          this.#currentPlan = event.plan;
          this.#planByToolCall.set(event.toolCallId ?? "", event.plan);
        }
        this.#cb.scheduleRender();
        return;

      case EVENT_STATUS:
        if (!event.retryStatus && event.statusMessage) {
          this.addEventMessage(
            event.statusMessage,
            isImportantEventStatus(event.statusMessage),
          );
          this.#cb.scheduleRender();
        }
        return;

      case EVENT_TOOL_APPROVAL_REQUEST:
        this.#handleApprovalRequest(event);
        return;

      case EVENT_QUESTION_REQUEST:
        this.#handleQuestionRequest(event);
        return;

      case EVENT_RUN_FINISHED:
        this.#handleRunFinished(event);
        return;

      case EVENT_DONE:
      case EVENT_ERROR:
        // Legacy terminal events: EVENT_RUN_FINISHED is the single canonical
        // terminal; EVENT_DONE/EVENT_ERROR after it are ignored, and EVENT_ERROR
        // before it terminalizes the run as failed.
        if (this.runTerminalHandled) return;
        this.#handleRunFinished(
          event.type === EVENT_ERROR
            ? { ...event, type: EVENT_RUN_FINISHED, status: TASK_FAILED }
            : { ...event, type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
        );
        return;

      default:
        return;
    }
  }

  #handleApprovalRequest(event: Event): void {
    const next: PendingApproval = {
      agentID: event.agentId,
      approvalID: event.approvalId ?? "",
      toolName: event.approvalTool ?? "",
      args: event.approvalArgs,
    };
    if (this.shownApproval?.approvalID === next.approvalID) {
      this.#cb.scheduleRender();
      return;
    }
    if (this.#run) {
      const err = this.#run.registerDecision(
        next.approvalID,
        DECISION_APPROVAL,
      );
      if (err !== undefined) {
        this.addMessage(`duplicate approval request: ${err}`, "error");
        return;
      }
      this.#run.bindDecision(next.approvalID, (value) => {
        const approved = value !== "false";
        this.#cb.deliverApproval?.(next.approvalID, approved);
        this.resolveApproval(next.approvalID, approved);
        this.#run?.resume?.();
      });
      this.#run.waitForApproval?.();
    }
    this.approvalQueue.push(next);
    if (!this.waitingForApproval) this.showNextApproval();
    this.#cb.scheduleRender();
    if (this.isThinking) this.#cb.tickSpinner?.();
  }

  /** Answers the shown approval and surfaces the next queued one. */
  resolveApproval(approvalID: string, approved: boolean): void {
    if (this.shownApproval?.approvalID === approvalID) {
      this.shownApproval = undefined;
      this.waitingForApproval = false;
      this.showNextApproval();
    }
    this.#cb.scheduleRender();
    void approved;
  }

  /** Advances the question panel after the shown question is resolved. */
  resolveQuestion(questionID: string): void {
    if (this.shownQuestion?.questionID === questionID) {
      this.shownQuestion = undefined;
      this.waitingForQuestion = false;
      this.showNextQuestion();
    }
    this.#cb.scheduleRender();
  }

  #handleQuestionRequest(event: Event): void {
    if (event.agentId) {
      // A member's question is addressed to the lead, not the human: the
      // Runtime queues it in the session mailbox and the lead answers it with
      // subagent_answer. Registering it as a human decision here would
      // misroute the answer (Go comment preserved).
      const member = event.memberDisplayName || event.agentId;
      this.addMessage(
        `[member question] ${member}: ${event.questionText ?? ""}`,
        "status",
      );
      this.#cb.scheduleRender();
      return;
    }
    this.store.commitActiveStream();
    if (this.#run) {
      const err = this.#run.registerDecision(
        event.questionId ?? "",
        DECISION_QUESTION,
      );
      if (err !== undefined) {
        this.addMessage(`duplicate question request: ${err}`, "error");
        return;
      }
      this.#run.bindDecision(event.questionId ?? "", (value) => {
        this.#cb.deliverQuestion?.(event.questionId ?? "", value);
        this.resolveQuestion(event.questionId ?? "");
        this.#run?.resume?.();
      });
      this.#run.waitForQuestion?.();
    }
    this.questionQueue.push({
      questionID: event.questionId ?? "",
      question: event.questionText ?? "",
      options: event.questionOptions,
      context: event.questionContext,
    });
    if (!this.waitingForQuestion) this.showNextQuestion();
    this.#cb.scheduleRender();
  }

  showNextApproval(): void {
    const next = this.approvalQueue.shift();
    if (!next) {
      this.shownApproval = undefined;
      this.waitingForApproval = false;
      return;
    }
    this.shownApproval = next;
    this.waitingForApproval = true;
    this.#cb.scheduleRender();
  }

  showNextQuestion(): void {
    const next = this.questionQueue.shift();
    if (!next) {
      this.shownQuestion = undefined;
      this.waitingForQuestion = false;
      return;
    }
    this.shownQuestion = next;
    this.waitingForQuestion = true;
    this.#cb.scheduleRender();
  }

  #handleRunFinished(event: Event): void {
    this.runTerminalHandled = true;
    // Terminal run: close any open thinking block and interrupt tools that
    // never delivered a result, mirroring finalizeInterruptedTools.
    if (this.#thinkBlockOpen) {
      this.activityManager.completeThinking("turn");
      this.#thinkBlockOpen = false;
    }
    for (const tool of this.activityManager.getActiveTools()) {
      this.activityManager.interruptToolExecution(tool.id);
    }
    if (this.#run) {
      let state: RunState = "completed";
      switch (event.status) {
        case TASK_FAILED:
          state = "failed";
          break;
        case TASK_CANCELED:
          state = "cancelled";
          break;
        case TASK_INCOMPLETE:
          state = "incomplete";
          break;
      }
      this.#run.finish(state);
      this.#run = undefined;
    }
    // No tool can still be executing once the run is terminal.
    this.store.finalizeInterruptedTools();
    this.isThinking = false;
    this.store.commitActiveStream();
    switch (event.status) {
      case TASK_FAILED:
        this.addMessage(
          `Error: ${event.error?.message ?? "run failed"}`,
          "error",
        );
        break;
      case TASK_INCOMPLETE:
        this.addMessage("Session ended: incomplete", "warning");
        break;
      case TASK_CANCELED:
        this.addMessage("Run canceled", "warning");
        break;
      default:
        break;
    }
    this.#cb.scheduleRender();
  }

  /** The canonical task status of the current run's terminal event. */
  static statusOf(event: Event): TaskStatus | undefined {
    return event.status;
  }
}
