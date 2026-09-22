// Ported from internal/tui/agent_events.go: the App's agent-event dispatch.
// The Go method lives on the Bubble Tea App; the TS projection splits it into
// this controller (storage + queues + decision routing) with two injection
// points: a `RunHandle` for the ExecutionRuntime/DecisionService bridge and
// callbacks for messages/spinner. The Ink layer subscribes and renders.

import type { Event } from "../agent/events.ts";
import type { AgentID } from "../../sdk/agent/types.ts";
import {
  EventDone,
  EventError,
  EventHostedItem,
  EventQuestionRequest,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolApprovalRequest,
  EventToolCall,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  EventToolResult,
  EventTurnEnd,
  EventTurnStart,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  type TaskStatus,
  TaskSuccess,
} from "../agent/events.ts";
import type { RunState } from "../agentruntime/run_state.ts";
import type { ContextUsage } from "../context/context.ts";
import {
  DecisionApproval,
  type DecisionKind,
  DecisionQuestion,
} from "../agentruntime/decision.ts";
import { AgentActivityStore } from "./activity.ts";
import { ActivityManager } from "./activity_manager.ts";
import { TranscriptStore } from "./transcript_store.ts";
import { Translator } from "./i18n.ts";

/** The execution-lifecycle bridge the controller needs (tuiRun in Go). */
export interface RunHandle {
  /** Registers a decision; returns an error message when it is a duplicate. */
  registerDecision(id: string, kind: DecisionKind): string | undefined;
  /** Binds the resolver invoked when the human answers. */
  bindDecision(id: string, resolve: (value: string) => void): void;
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

export type MessageKind = "status" | "error" | "warning" | "plain";

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
  readonly activities = new AgentActivityStore();
  /** Live per-turn activity timeline (tools, thinking) for the lead agent. */
  readonly activityManager = new ActivityManager();

  /** Whether the current turn has an open thinking block in the manager. */
  #thinkBlockOpen = false;

  waitingForApproval = false;
  waitingForQuestion = false;
  isThinking = false;
  runTerminalHandled = false;
  /** Latest provider-reported context usage (mothx a.contextUsage). */
  contextUsage: ContextUsage | undefined;

  readonly approvalQueue: PendingApproval[] = [];
  readonly questionQueue: PendingQuestion[] = [];
  /** Currently displayed approval, if any. */
  shownApproval: PendingApproval | undefined;
  shownQuestion: PendingQuestion | undefined;

  #run: RunHandle | undefined;
  #leadAgentId: string | undefined;
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
  }

  setLeadAgentId(id: string | undefined): void {
    this.#leadAgentId = id;
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

  /** Adds a message row (Go addMessage): a plain transcript row plus the
   * typed notification channel for the Ink layer. */
  addMessage(text: string, kind: MessageKind = "plain"): void {
    this.store.messages.push(text);
    this.#cb.onMessage(kind, text);
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
      case EventTextDelta:
        this.store.appendAssistantDelta(event.textDelta ?? "");
        this.#cb.scheduleRender();
        return;

      case EventThinkDelta: {
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

      case EventHostedItem:
        if (event.hostedItem) {
          let line = "hosted item";
          if (event.hostedItem.type) line += ` [${event.hostedItem.type}]`;
          if (event.hostedItem.status) line += `: ${event.hostedItem.status}`;
          this.addMessage(line, "status");
        }
        this.#cb.scheduleRender();
        return;

      case EventTurnStart:
        // A new turn owns a fresh activity timeline (Go turn lifecycle).
        this.activityManager.clear();
        this.#thinkBlockOpen = false;
        this.store.beginAssistantSlot();
        return;

      case EventToolCall:
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
        return;

      case EventToolExecutionStart:
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
        return;

      case EventToolExecutionEnd:
      case EventToolResult:
        this.store.appendToolResult({
          toolCallID: event.toolCallId ?? "",
          toolName: event.toolName,
          toolArgs: event.toolArgs,
          toolResult: event.toolResult,
          toolDiff: event.toolDiff,
          toolError: event.toolError,
          toolExecutionState: event.toolExecutionState,
        });
        this.activityManager.completeToolExecution(
          event.toolCallId ?? "",
          event.toolResult ?? "",
          event.toolError?.message,
        );
        this.#cb.scheduleRender();
        return;

      case EventTurnEnd:
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

      case EventStatus:
        if (!event.retryStatus && event.statusMessage) {
          this.addMessage(event.statusMessage, "status");
          this.#cb.scheduleRender();
        }
        return;

      case EventToolApprovalRequest:
        this.#handleApprovalRequest(event);
        return;

      case EventQuestionRequest:
        this.#handleQuestionRequest(event);
        return;

      case EventRunFinished:
        this.#handleRunFinished(event);
        return;

      case EventDone:
      case EventError:
        // Legacy terminal events: EventRunFinished is the single canonical
        // terminal; EventDone/EventError after it are ignored, and EventError
        // before it terminalizes the run as failed.
        if (this.runTerminalHandled) return;
        this.#handleRunFinished(
          event.type === EventError
            ? { ...event, type: EventRunFinished, status: TaskFailed }
            : { ...event, type: EventRunFinished, status: TaskSuccess },
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
      const err = this.#run.registerDecision(next.approvalID, DecisionApproval);
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
        DecisionQuestion,
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
        case TaskFailed:
          state = "failed";
          break;
        case TaskCanceled:
          state = "cancelled";
          break;
        case TaskIncomplete:
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
      case TaskFailed:
        this.addMessage(
          `Error: ${event.error?.message ?? "run failed"}`,
          "error",
        );
        break;
      case TaskIncomplete:
        this.addMessage("Session ended: incomplete", "warning");
        break;
      case TaskCanceled:
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
