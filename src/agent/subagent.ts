//
// The sub-agent tools create, monitor, message, answer, and destroy managed
// children through AgentManager. Go's goroutine-per-spawn maps to a
// fire-and-forget async task; `<-chan agentpkg.Event` maps to `for await` over
// the public `Agent.run` stream; and `context.WithTimeout` maps to a derived
// AbortSignal carrying a timeout. The pure helpers (resolveMemberMode,
// restrictMemberTools, buildSubAgentTask, SubAgentPolicy) already live in
// subagent_support.ts and are reused here.

import { type AgentID } from "../../sdk/agent/types.ts";
import {
  type Event as PublicEvent,
  eventDone,
  eventError,
  eventQuestionRequest,
  eventRunFinished,
  eventToolApprovalRequest,
  eventToolCall,
  roleAssistant,
  taskCanceled,
  taskFailed,
  taskIncomplete,
  type TaskStatus,
} from "../../sdk/agent/mod.ts";
import { Registry, type Tool, type ToolContext, type ToolResult } from "../tools/tool.ts";
import { createTextToolResult } from "../tools/tool.ts";
import type { AgentAdapter } from "./bridge.ts";
import {
  type Event,
  EVENT_DONE,
  EVENT_ERROR,
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
  type EventType,
  type TaskStatus as InternalTaskStatus,
} from "./events.ts";
import {
  agentIDFromToolContext,
  eventSinkFromToolContext,
  parentModeFromToolContext,
  parentRunContextFromToolContext,
} from "./agent.ts";
import { goDurationString } from "./agent_support.ts";
import type { AgentManager } from "./manager.ts";
import {
  createMemberCompletion,
  MEMBER_ITEM_QUESTION,
  MEMBER_STATUS_CANCELED,
  MEMBER_STATUS_DONE,
  MEMBER_STATUS_ERROR,
  MEMBER_STATUS_INCOMPLETE,
  MEMBER_STATUS_QUESTION,
  type MemberCompletion,
  type MemberMailbox,
} from "./mailbox.ts";
import { type MemberDef } from "./memberdef.ts";
import { type RunContext } from "./run_context.ts";
import { SubAgentWaitTool } from "./subagent_wait.ts";
import {
  buildSubAgentTask,
  defaultSubAgentPolicy,
  isTerminalManagedState,
  resolveMemberMode,
  restrictMemberTools,
} from "./subagent_support.ts";

export { subAgentToolNames } from "./subagent_support.ts";
export { MEMBER_ITEM_QUESTION, MEMBER_STATUS_QUESTION, type MemberCompletion };
export { SubAgentWaitTool };

type EventSink = (ev: Event) => boolean;

/**
 * Registers the built-in sub-agent tools when multi-agent mode is enabled. Safe
 * to call more than once; Registry.register replaces existing tools.
 */
export function registerSubAgentTools(
  registry: Registry,
  manager: AgentManager,
): void {
  registry.register(new SubAgentSpawnTool(manager));
  registry.register(new SubAgentStatusTool(manager));
  registry.register(new SubAgentSendTool(manager));
  registry.register(new SubAgentAnswerTool(manager));
  registry.register(new SubAgentDestroyTool(manager));
  registry.register(new SubAgentWaitTool(manager));
}

/**
 * Registers the blocking single sub-agent delegation tool. Independent from the
 * async multi-agent toolset.
 */
export function registerDelegateSubAgentTool(
  registry: Registry,
  manager: AgentManager,
): void {
  registry.register(new DelegateSubAgentTool(manager));
}

/** Carries expert-team metadata for forwarded child events. */
export interface ChildEventMeta {
  memberId: string;
  expertId: string;
  memberDisplayName: string;
  memberEmoji: string;
  memberRole: string;
}

/** Pushes an internal event to the parent sink; returns false when absent. */
export function sendParentEvent(
  sink: EventSink | undefined,
  ev: Event,
): boolean {
  if (sink === undefined) return false;
  return sink(ev);
}

/**
 * Forwards child-agent activity to the parent event stream so frontends can
 * render background progress. The optional meta attaches expert-team identity.
 */
export function forwardChildAgentEvent(
  sink: EventSink | undefined,
  childId: AgentID,
  e: PublicEvent,
  meta?: ChildEventMeta,
): boolean {
  if (sink === undefined) return false;
  const ev: Event = {
    type: e.type as EventType,
    agentId: childId,
    textDelta: e.textDelta,
    thinkDelta: e.thinkDelta,
    toolCallId: e.toolCallId,
    toolName: e.toolName,
    toolArgs: e.toolArgs,
    toolResult: e.toolResult,
    toolError: e.toolError,
    statusMessage: e.statusMessage,
    done: e.done,
    stopReason: e.stopReason,
    error: e.error,
    status: e.status as InternalTaskStatus | undefined,
  };
  if (meta !== undefined) {
    ev.memberId = meta.memberId;
    ev.expertId = meta.expertId;
    ev.memberDisplayName = meta.memberDisplayName;
    ev.memberEmoji = meta.memberEmoji;
    ev.memberRole = meta.memberRole;
  }
  if (e.toolImages !== undefined) {
    ev.toolImages = e.toolImages.map((image) => ({
      mimeType: image.mimeType,
      data: image.data,
    }));
  }
  if ((ev.toolName ?? "") === "" && e.toolCall !== undefined) {
    ev.toolName = e.toolCall.name;
  }
  switch (ev.type) {
    case EVENT_TEXT_DELTA:
    case EVENT_THINK_DELTA:
    case EVENT_TOOL_CALL:
    case EVENT_TOOL_EXECUTION_START:
    case EVENT_TOOL_EXECUTION_END:
    case EVENT_TOOL_RESULT:
    case EVENT_STATUS:
    case EVENT_DONE:
    case EVENT_ERROR:
    case EVENT_RUN_FINISHED:
      return sendParentEvent(sink, ev);
    default:
      return false;
  }
}

/**
 * Routes a member's question to the lead instead of the human: it projects the
 * request on the parent stream and queues it in the session mailbox.
 */
export function forwardMemberQuestion(
  manager: AgentManager,
  sink: EventSink | undefined,
  childId: AgentID,
  e: PublicEvent,
  meta: ChildEventMeta | undefined,
): void {
  if (sink !== undefined) {
    const ev: Event = {
      type: EVENT_QUESTION_REQUEST,
      agentId: childId,
      questionId: e.questionId,
      questionText: e.questionText,
      questionOptions: e.questionOptions ? [...e.questionOptions] : undefined,
      questionContext: e.questionContext,
    };
    if (meta !== undefined) {
      ev.memberId = meta.memberId;
      ev.expertId = meta.expertId;
      ev.memberDisplayName = meta.memberDisplayName;
      ev.memberEmoji = meta.memberEmoji;
      ev.memberRole = meta.memberRole;
    }
    sendParentEvent(sink, ev);
  }
  manager.notifyMemberQuestion(
    childId,
    meta?.memberDisplayName ?? "",
    e.questionId ?? "",
    e.questionText ?? "",
    e.questionOptions ?? [],
  );
}

/** Returns the last assistant response text from an agent's message history. */
export function lastAssistantResponse(a: AgentAdapter): string {
  const messages = a.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== roleAssistant) continue;
    if ((m.content ?? "") !== "") return m.content ?? "";
    let sb = "";
    for (const block of m.contents ?? []) {
      if (block.type === "text" && (block.text ?? "") !== "") {
        sb += block.text ?? "";
      }
    }
    return sb;
  }
  return "";
}

/** Normalizes a child run error against the run deadline/cancellation flags. */
export function normalizeSubAgentRunError(
  id: AgentID,
  timedOut: boolean,
  canceled: boolean,
  err: Error | undefined,
): Error | undefined {
  if (err === undefined) return undefined;
  if (timedOut) {
    return new Error(
      `sub-agent ${id} timed out after 30 minutes; the parent agent will continue. Check subagent_status for partial results`,
    );
  }
  if (canceled) {
    return new Error(
      `sub-agent ${id} stopped before completion; the parent agent will continue`,
    );
  }
  return err;
}

/** A derived child run signal carrying a deadline. */
interface ChildRunSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  canceled: () => boolean;
  cancel: () => void;
}

/** Derives a child run signal from the parent run context plus a timeout. */
function childRunSignal(
  parent: RunContext | undefined,
  timeoutMs: number,
): ChildRunSignal {
  const controller = new AbortController();
  let timedOut = false;
  let canceled = false;
  const parentSignal = parent?.signal;
  const onAbort = () => {
    canceled = true;
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      canceled = true;
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("sub-agent timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    canceled: () => canceled,
    cancel: () => {
      clearTimeout(timer);
      if (parentSignal !== undefined) {
        parentSignal.removeEventListener("abort", onAbort);
      }
      if (!controller.signal.aborted) {
        canceled = true;
        controller.abort(new DOMException("canceled", "AbortError"));
      }
    },
  };
}

/** Reads the parent run context from a tool context, when present. */
function parentContextFor(ctx: ToolContext): RunContext | undefined {
  const parentRunCtx = parentRunContextFromToolContext(ctx);
  return parentRunCtx;
}

/** Reads the requested string parameter, or "". */
function stringParam(
  params: Record<string, unknown>,
  key: string,
): string {
  const v = params[key];
  return typeof v === "string" ? v : "";
}

/** Reads the requested string-array parameter. */
function stringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const out: string[] = [];
  const v = params[key];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "string") out.push(item);
    }
  }
  return out;
}

// --- SubAgentSpawnTool -----------------------------------------------------

/** Creates and starts a sub-agent (async multi-agent toolset). */
export class SubAgentSpawnTool implements Tool {
  private manager: AgentManager;

  constructor(manager: AgentManager) {
    this.manager = manager;
  }

  name(): string {
    return "subagent_spawn";
  }

  description(): string {
    return "Create and start a bounded sub-agent task. Returns a handle for status/result polling.";
  }

  promptSnippet(): string {
    return "Create a bounded sub-agent task for independent work";
  }

  promptGuidelines(): string[] {
    return [
      "Use subagent_spawn only for independent subtasks with clear scope, expected output, and stop conditions",
      "Spawn multiple sub-agents in parallel for independent investigation or review work, then reconcile their results in the main agent",
      "Use subagent_status to poll results and verify important claims before acting on them",
      "Use subagent_destroy to clean up finished sub-agents",
      "When an expert team roster is present in the system prompt, dispatch members by their id via the member parameter instead of restating personas in the task",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Focused task for the sub-agent, including scope, relevant paths/context, expected artifact, and stop conditions",
        },
        member: {
          type: "string",
          description:
            "Member definition id from the bound expert team roster (see system prompt roster). Resolves the member persona and capability overrides.",
        },
        mode: {
          type: "string",
          enum: ["plan", "agent", "yolo", "os"],
          description:
            "Sub-agent execution mode. Defaults to the parent agent's mode; if unavailable, falls back to 'yolo'.",
        },
        work_dir: {
          type: "string",
          description:
            "Working directory for the sub-agent (defaults to current)",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Allowed tools (empty = all)",
        },
        max_iterations: {
          type: "integer",
          default: 50,
          description: "Maximum iterations",
        },
        system_prompt_extra: {
          type: "string",
          description: "Extra context for the sub-agent",
        },
      },
      required: ["task"],
    };
  }

  execute(ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const task = stringParam(params, "task");
    if (task === "") throw new Error("task is required");

    const memberID = stringParam(params, "member").trim();
    let memberDef: MemberDef | undefined;
    if (memberID !== "") {
      if (this.manager.members === undefined) {
        throw new Error("no expert team is bound to this session");
      }
      const def = this.manager.members.get(memberID);
      if (def === undefined) {
        throw new Error(
          `unknown member ${JSON.stringify(memberID)}; known members: [${
            this.manager.members.ids().join(" ")
          }]`,
        );
      }
      memberDef = def;
    }

    const parentMode = parentModeFromToolContext(ctx);
    const requestedMode = stringParam(params, "mode");
    let mode = requestedMode;
    if (memberDef !== undefined) {
      mode = resolveMemberMode(parentMode ?? "", requestedMode, memberDef);
    } else if (mode === "") {
      mode = parentMode ?? "";
    }

    let workDir = stringParam(params, "work_dir");
    if (memberDef !== undefined && memberDef.workDir !== "") {
      if (workDir !== "" && workDir !== memberDef.workDir) {
        throw new Error(
          `member ${JSON.stringify(memberID)} work_dir is fixed to ${
            JSON.stringify(memberDef.workDir)
          }`,
        );
      }
      workDir = memberDef.workDir;
    }

    let maxIter = 0;
    let maxIterSet = false;
    const v = params["max_iterations"];
    if (typeof v === "number" && v > 0) {
      maxIter = Math.trunc(v);
      maxIterSet = true;
    }
    if (memberDef !== undefined && memberDef.maxIterations > 0) {
      if (!maxIterSet || maxIter > memberDef.maxIterations) {
        maxIter = memberDef.maxIterations;
      }
      maxIterSet = true;
    }
    if (!maxIterSet) maxIter = 50;

    let extra = stringParam(params, "system_prompt_extra");
    if (memberDef !== undefined && memberDef.prompt !== "") {
      extra = extra !== ""
        ? memberDef.prompt + "\n\n" + extra
        : memberDef.prompt;
    }

    let toolFilter = stringArrayParam(params, "tools");
    if (memberDef !== undefined && memberDef.tools.length > 0) {
      toolFilter = restrictMemberTools(toolFilter, memberDef.tools);
    }

    let memberDisplayName = "";
    let memberEmoji = "";
    let memberRole = "";
    if (memberDef !== undefined) {
      memberDisplayName = memberDef.displayName;
      memberEmoji = memberDef.emoji;
      memberRole = memberDef.role;
    }

    const parentId = agentIDFromToolContext(ctx);
    const sink = eventSinkFromToolContext(ctx);

    const policy = defaultSubAgentPolicy();
    const run = childRunSignal(parentContextFor(ctx), policy.timeoutPerAgentMs);

    let a: AgentAdapter;
    try {
      a = this.manager.create({
        parentId: parentId ?? "",
        memberId: memberID,
        expertId: this.manager.expertID,
        memberDisplayName,
        memberEmoji,
        memberRole,
        mode,
        workDir,
        tools: toolFilter,
        systemPromptExtra: extra,
        maxIterations: maxIter,
      });
    } catch (err) {
      run.cancel();
      throw new Error(`create sub-agent: ${(err as Error).message}`);
    }
    this.manager.markRunning(a.id());
    this.manager.setCancel(a.id(), run.cancel);

    void (async () => {
      try {
        const notifier = new memberNotifier(
          this.manager.mailbox,
          memberID,
          memberDisplayName,
        );
        const eventMeta: ChildEventMeta = {
          memberId: memberID,
          expertId: this.manager.expertID,
          memberDisplayName,
          memberEmoji,
          memberRole,
        };
        for await (const e of a.run(buildSubAgentTask(task), run.signal)) {
          if (e.type === eventToolApprovalRequest && sink !== undefined) {
            sendParentEvent(sink, {
              type: EVENT_TOOL_APPROVAL_REQUEST,
              agentId: a.id(),
              approvalId: e.approvalId,
              approvalTool: e.approvalTool,
              approvalArgs: e.approvalArgs,
              memberId: memberID,
              expertId: this.manager.expertID,
              memberDisplayName,
              memberEmoji,
              memberRole,
            });
          }
          forwardChildAgentEvent(sink, a.id(), e, eventMeta);
          if (e.type === eventQuestionRequest) {
            forwardMemberQuestion(this.manager, sink, a.id(), e, eventMeta);
          }
          switch (e.type) {
            case eventRunFinished: {
              const runErr = terminalRunError(a, run, e.status);
              this.applyTerminal(a, e.status, runErr);
              notifier.notify(
                terminalMemberStatus(e.status),
                memberTerminalPayload(runErr, a),
              );
              break;
            }
            case eventDone: {
              const response = lastAssistantResponse(a);
              this.manager.markDone(a.id(), response);
              notifier.notify(MEMBER_STATUS_DONE, response);
              break;
            }
            case eventError: {
              const runErr = normalizeSubAgentRunError(
                a.id(),
                run.timedOut(),
                run.canceled(),
                e.error ?? new Error("sub-agent run failed"),
              );
              this.manager.markError(a.id(), runErr);
              notifier.notify(
                MEMBER_STATUS_ERROR,
                memberTerminalPayload(runErr, a),
              );
              break;
            }
          }
        }
        if (run.signal.aborted) {
          const st = this.manager.status(a.id());
          if (st === undefined || !isTerminalManagedState(st.state)) {
            const runErr = normalizeSubAgentRunError(
              a.id(),
              run.timedOut(),
              run.canceled(),
              new Error(run.canceled() ? "canceled" : "timed out"),
            );
            this.manager.markError(a.id(), runErr);
            notifier.notify(
              MEMBER_STATUS_ERROR,
              memberTerminalPayload(runErr, a),
            );
          }
        }
      } finally {
        run.cancel();
        this.manager.setCancel(a.id(), undefined);
      }
    })();

    return createTextToolResult(JSON.stringify({
      handle: a.id(),
      status: "running",
      timeout: goDurationString(policy.timeoutPerAgentMs),
    }));
  }

  private applyTerminal(
    a: AgentAdapter,
    status: TaskStatus | undefined,
    runErr: Error | undefined,
  ): void {
    switch (status) {
      case taskFailed:
        this.manager.markError(a.id(), runErr);
        break;
      case taskIncomplete:
        this.manager.markIncomplete(a.id(), runErr);
        break;
      case taskCanceled:
        this.manager.markCanceled(a.id(), runErr);
        break;
      default:
        this.manager.markDone(a.id(), lastAssistantResponse(a));
    }
  }
}

/** Maps a terminal TaskStatus to the member mailbox status. */
function terminalMemberStatus(status: TaskStatus | undefined): string {
  switch (status) {
    case taskFailed:
      return MEMBER_STATUS_ERROR;
    case taskIncomplete:
      return MEMBER_STATUS_INCOMPLETE;
    case taskCanceled:
      return MEMBER_STATUS_CANCELED;
    default:
      return MEMBER_STATUS_DONE;
  }
}

/** Builds the normalized terminal error for a finished child run. */
function terminalRunError(
  a: AgentAdapter,
  run: ChildRunSignal,
  status: TaskStatus | undefined,
): Error | undefined {
  switch (status) {
    case taskFailed:
      return normalizeSubAgentRunError(
        a.id(),
        run.timedOut(),
        run.canceled(),
        new Error("sub-agent run failed"),
      );
    case taskIncomplete:
      return normalizeSubAgentRunError(
        a.id(),
        run.timedOut(),
        run.canceled(),
        new Error("sub-agent run incomplete"),
      );
    case taskCanceled:
      return normalizeSubAgentRunError(
        a.id(),
        run.timedOut(),
        run.canceled(),
        new Error("sub-agent run canceled"),
      );
    default:
      return undefined;
  }
}

// --- DelegateSubAgentTool --------------------------------------------------

/** Runs exactly one delegated sub-agent task synchronously. */
export class DelegateSubAgentTool implements Tool {
  private manager: AgentManager;
  private busy = false;

  constructor(manager: AgentManager) {
    this.manager = manager;
  }

  name(): string {
    return "delegate_subagent";
  }

  description(): string {
    return "Delegate one bounded independent subtask to a blocking sub-agent. Waits until completion and returns a summarized result.";
  }

  promptSnippet(): string {
    return "Delegate one bounded independent subtask to a blocking sub-agent";
  }

  promptGuidelines(): string[] {
    return [
      "Use delegate_subagent when the subtask requires multi-step exploration (grep many files, trace code paths, run multiple commands) but you only need the final answer — the intermediate steps would bloat your context",
      "Do NOT delegate single-tool tasks (read one file, run one command) — direct execution is cheaper",
      "Do NOT delegate tasks smaller than ~3 tool calls, tasks needing user clarification mid-way, or highly stateful work depending on conversation history",
      "Write a specific task: state the exact goal, list relevant file paths/names, specify expected output format, and include stop conditions",
      "Only one delegated sub-agent can run at a time; review its result before acting — treat the output as evidence, not ground truth",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A specific, bounded task description. Must include: (1) the exact goal or question, (2) relevant file paths or search patterns, (3) expected output format, (4) stop conditions.",
        },
        mode: {
          type: "string",
          enum: ["plan", "agent", "yolo", "os"],
          description:
            "Sub-agent execution mode. Defaults to the parent agent's mode; if unavailable, falls back to 'yolo'.",
        },
        work_dir: {
          type: "string",
          description:
            "Working directory for the sub-agent (defaults to current directory).",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict sub-agent to specific tools (empty = all tools except nested sub-agent/delegate).",
        },
        max_iterations: {
          type: "integer",
          default: 50,
          description: "Maximum tool-call iterations.",
        },
        system_prompt_extra: {
          type: "string",
          description: "Additional context or constraints for the sub-agent.",
        },
      },
      required: ["task"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.busy) {
      throw new Error("a delegated sub-agent is already running");
    }
    this.busy = true;
    try {
      const started = Date.now();
      const task = stringParam(params, "task").trim();
      if (task === "") throw new Error("task is required");

      let mode = stringParam(params, "mode");
      if (mode === "") {
        const parentMode = parentModeFromToolContext(ctx);
        if (parentMode !== undefined && parentMode !== "") mode = parentMode;
      }
      const workDir = stringParam(params, "work_dir");
      let maxIter = 50;
      const v = params["max_iterations"];
      if (typeof v === "number" && v > 0) maxIter = Math.trunc(v);
      const extra = stringParam(params, "system_prompt_extra");
      const toolFilter = stringArrayParam(params, "tools");

      const parentId = agentIDFromToolContext(ctx);
      const sink = eventSinkFromToolContext(ctx);
      const policy = defaultSubAgentPolicy();
      const run = childRunSignal(
        parentContextFor(ctx),
        policy.timeoutPerAgentMs,
      );

      let a: AgentAdapter;
      try {
        a = this.manager.create({
          parentId: parentId ?? "",
          mode,
          workDir,
          tools: toolFilter,
          // A blocking delegate's caller is parked inside this tool call, so
          // nobody could answer a child question. Remove the tool instead.
          excludeTools: ["question"],
          systemPromptExtra: extra,
          maxIterations: maxIter,
        });
      } catch (err) {
        run.cancel();
        throw new Error(
          `create delegated sub-agent: ${(err as Error).message}`,
        );
      }
      this.manager.markRunning(a.id());
      this.manager.setCancel(a.id(), run.cancel);

      let runErr: Error | undefined;
      let completed = false;
      let canceled = false;
      let toolCallCount = 0;
      const toolNames: Record<string, number> = {};
      try {
        for await (const e of a.run(buildSubAgentTask(task), run.signal)) {
          if (e.type === eventToolApprovalRequest && sink !== undefined) {
            sendParentEvent(sink, {
              type: EVENT_TOOL_APPROVAL_REQUEST,
              agentId: a.id(),
              approvalId: e.approvalId,
              approvalTool: e.approvalTool,
              approvalArgs: e.approvalArgs,
            });
          }
          forwardChildAgentEvent(sink, a.id(), e);
          if (e.type === eventQuestionRequest) {
            forwardMemberQuestion(this.manager, sink, a.id(), e, undefined);
          }
          if (e.type === eventToolCall) {
            toolCallCount++;
            const name = e.toolName ?? e.toolCall?.name ?? "";
            if (name !== "") toolNames[name] = (toolNames[name] ?? 0) + 1;
          }
          switch (e.type) {
            case eventRunFinished:
              completed = true;
              switch (e.status) {
                case taskFailed:
                  runErr = terminalRunError(a, run, e.status);
                  this.manager.markError(a.id(), runErr);
                  break;
                case taskCanceled:
                  canceled = true;
                  runErr = terminalRunError(a, run, e.status);
                  this.manager.markCanceled(a.id(), runErr);
                  break;
                default:
                  this.manager.markDone(a.id(), lastAssistantResponse(a));
              }
              break;
            case eventDone:
              if (!completed) {
                completed = true;
                this.manager.markDone(a.id(), lastAssistantResponse(a));
              }
              break;
            case eventError:
              if (!completed) {
                completed = true;
                runErr = normalizeSubAgentRunError(
                  a.id(),
                  run.timedOut(),
                  run.canceled(),
                  e.error ?? new Error("sub-agent run failed"),
                );
                this.manager.markError(a.id(), runErr);
              }
              break;
          }
        }
      } finally {
        this.manager.detachChild(a.id());
        run.cancel();
        this.manager.setCancel(a.id(), undefined);
      }

      if (!completed && run.signal.aborted) {
        runErr = normalizeSubAgentRunError(
          a.id(),
          run.timedOut(),
          run.canceled(),
          new Error("sub-agent run stopped"),
        );
        this.manager.markError(a.id(), runErr);
      } else if (!completed) {
        this.manager.markDone(a.id(), lastAssistantResponse(a));
      }

      const response = lastAssistantResponse(a);
      const result: Record<string, unknown> = {
        handle: a.id(),
        status: "done",
        result: response,
        duration: goDurationString(Date.now() - started),
        tool_calls: toolCallCount,
        tool_breakdown: toolNames,
      };
      if (runErr !== undefined) {
        result["status"] = "error";
        result["error"] = runErr.message;
        if (response !== "") result["partial_result"] = response;
      }
      if (canceled) {
        result["status"] = "canceled";
        if (response !== "") result["partial_result"] = response;
      }
      return createTextToolResult(JSON.stringify(result));
    } finally {
      this.busy = false;
    }
  }
}

// --- SubAgentStatusTool ----------------------------------------------------

/** Queries sub-agent status and results. */
export class SubAgentStatusTool implements Tool {
  private manager: AgentManager;

  constructor(manager: AgentManager) {
    this.manager = manager;
  }

  name(): string {
    return "subagent_status";
  }

  description(): string {
    return "Query the status and results of a sub-agent.";
  }

  promptSnippet(): string {
    return "Check sub-agent status and get results";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        handle: { type: "string", description: "The sub-agent handle ID" },
      },
      required: ["handle"],
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const handle = stringParam(params, "handle");
    if (handle === "") throw new Error("handle is required");

    const st = this.manager.status(handle);
    const a = this.manager.get(handle);
    if (st === undefined && a === undefined) {
      throw new Error(`sub-agent ${JSON.stringify(handle)} not found`);
    }

    let status = st?.state ?? "";
    if (status === "") status = "unknown";
    let lastResponse = st?.result ?? "";
    let messageCount = 0;
    if (a !== undefined) messageCount = a.getMessages().length;
    if (lastResponse === "" && a !== undefined) {
      lastResponse = lastAssistantResponse(a);
    }

    const result: Record<string, unknown> = {
      handle,
      status,
      message_count: messageCount,
    };
    if (lastResponse !== "") result["last_response"] = lastResponse;
    if (st !== undefined && st.error !== "") result["error"] = st.error;
    if (st?.updatedAt !== undefined) {
      result["updated_at"] = st.updatedAt.toISOString();
    }
    return createTextToolResult(JSON.stringify(result));
  }
}

// --- SubAgentSendTool ------------------------------------------------------

/** Sends a follow-up message to a running sub-agent. */
export class SubAgentSendTool implements Tool {
  private manager: AgentManager;

  constructor(manager: AgentManager) {
    this.manager = manager;
  }

  name(): string {
    return "subagent_send";
  }

  description(): string {
    return "Send a follow-up message to a running sub-agent.";
  }

  promptSnippet(): string {
    return "Send follow-up instructions to a sub-agent";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        handle: { type: "string", description: "The sub-agent handle ID" },
        message: { type: "string", description: "The follow-up message" },
      },
      required: ["handle", "message"],
    };
  }

  execute(ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const handle = stringParam(params, "handle");
    const message = stringParam(params, "message");
    if (handle === "" || message === "") {
      throw new Error("handle and message are required");
    }
    const a = this.manager.get(handle);
    if (a === undefined) {
      throw new Error(`sub-agent ${JSON.stringify(handle)} not found`);
    }

    const policy = defaultSubAgentPolicy();
    const run = childRunSignal(parentContextFor(ctx), policy.timeoutPerAgentMs);
    this.manager.markRunning(a.id());
    this.manager.setCancel(a.id(), run.cancel);

    const sink = eventSinkFromToolContext(ctx);
    void (async () => {
      try {
        for await (const e of a.run(message, run.signal)) {
          if (e.type === eventToolApprovalRequest && sink !== undefined) {
            sendParentEvent(sink, {
              type: EVENT_TOOL_APPROVAL_REQUEST,
              agentId: a.id(),
              approvalId: e.approvalId,
              approvalTool: e.approvalTool,
              approvalArgs: e.approvalArgs,
            });
          }
          forwardChildAgentEvent(sink, a.id(), e);
          if (e.type === eventQuestionRequest) {
            forwardMemberQuestion(this.manager, sink, a.id(), e, undefined);
          }
          switch (e.type) {
            case eventRunFinished:
              switch (e.status) {
                case taskFailed:
                  this.manager.markError(
                    a.id(),
                    terminalRunError(a, run, e.status),
                  );
                  break;
                case taskIncomplete:
                  this.manager.markIncomplete(
                    a.id(),
                    terminalRunError(a, run, e.status),
                  );
                  break;
                case taskCanceled:
                  this.manager.markCanceled(
                    a.id(),
                    terminalRunError(a, run, e.status),
                  );
                  break;
                default:
                  this.manager.markDone(a.id(), lastAssistantResponse(a));
              }
              break;
            case eventDone:
              this.manager.markDone(a.id(), lastAssistantResponse(a));
              break;
            case eventError:
              this.manager.markError(
                a.id(),
                normalizeSubAgentRunError(
                  a.id(),
                  run.timedOut(),
                  run.canceled(),
                  e.error ?? new Error("sub-agent run failed"),
                ),
              );
              break;
          }
        }
        if (run.signal.aborted) {
          const st = this.manager.status(a.id());
          if (st === undefined || !isTerminalManagedState(st.state)) {
            this.manager.markError(
              a.id(),
              normalizeSubAgentRunError(
                a.id(),
                run.timedOut(),
                run.canceled(),
                new Error("sub-agent run stopped"),
              ),
            );
          }
        }
      } finally {
        run.cancel();
        this.manager.setCancel(a.id(), undefined);
      }
    })();

    return createTextToolResult(
      `{"handle":${JSON.stringify(handle)},"status":"message_sent"}`,
    );
  }
}

// --- SubAgentAnswerTool ----------------------------------------------------

/** Answers a blocking question a running member asked the lead. */
export class SubAgentAnswerTool implements Tool {
  private manager: AgentManager;

  constructor(manager: AgentManager) {
    this.manager = manager;
  }

  name(): string {
    return "subagent_answer";
  }

  description(): string {
    return "Answer a question a running sub-agent asked you (the lead). Use the member handle and question_id from the [MEMBER_QUESTION] message; the member unblocks and continues its task.";
  }

  promptSnippet(): string {
    return "Answer a member's blocking question so it can continue";
  }

  promptGuidelines(): string[] {
    return [
      'When a [MEMBER_QUESTION] message or a subagent_wait entry with status "question" appears, answer it with subagent_answer instead of ignoring it',
      "Pass the exact question_id from the message; use the member handle as the target",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The sub-agent handle ID that asked the question",
        },
        question_id: {
          type: "string",
          description: "The question_id from the [MEMBER_QUESTION] message",
        },
        answer: {
          type: "string",
          description: "The answer for the member to continue with",
        },
      },
      required: ["handle", "question_id", "answer"],
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const handle = stringParam(params, "handle");
    const questionID = stringParam(params, "question_id");
    const answer = stringParam(params, "answer");
    if (
      handle.trim() === "" || questionID.trim() === "" || answer.trim() === ""
    ) {
      throw new Error("handle, question_id and answer are required");
    }
    const target = this.manager.get(handle);
    if (target === undefined) {
      throw new Error(`sub-agent ${JSON.stringify(handle)} not found`);
    }
    if (!target.deliverQuestionAnswer(questionID, answer)) {
      throw new Error(
        `question ${questionID} is not pending on ${handle}: it was already answered, expired, or never belonged to that member`,
      );
    }
    return createTextToolResult(`Answered ${handle}'s question ${questionID}.`);
  }
}

// --- SubAgentDestroyTool ---------------------------------------------------

/** Destroys a sub-agent and releases resources. */
export class SubAgentDestroyTool implements Tool {
  private manager: AgentManager;

  constructor(manager: AgentManager) {
    this.manager = manager;
  }

  name(): string {
    return "subagent_destroy";
  }

  description(): string {
    return "Destroy a sub-agent and release resources.";
  }

  promptSnippet(): string {
    return "Destroy a finished sub-agent";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        handle: { type: "string", description: "The sub-agent handle ID" },
      },
      required: ["handle"],
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const handle = stringParam(params, "handle");
    if (handle === "") throw new Error("handle is required");
    try {
      this.manager.destroy(handle);
    } catch (err) {
      throw new Error(`destroy sub-agent: ${(err as Error).message}`);
    }
    return createTextToolResult(
      `{"handle":${JSON.stringify(handle)},"status":"destroyed"}`,
    );
  }
}

// --- memberNotifier --------------------------------------------------------

/**
 * Enqueues at most one terminal MemberCompletion per spawned sub-agent run into
 * the session mailbox. A null mailbox (no expert team bound) makes notify a
 * no-op.
 */
export class memberNotifier {
  private mailbox?: MemberMailbox;
  private memberID: string;
  private displayName: string;
  private notified = false;

  constructor(
    mailbox: MemberMailbox | undefined,
    memberID: string,
    displayName: string,
  ) {
    this.mailbox = mailbox;
    this.memberID = memberID;
    this.displayName = displayName;
  }

  notify(status: string, payload: string): void {
    if (this.mailbox === undefined || this.notified) return;
    this.notified = true;
    const completion: MemberCompletion = createMemberCompletion();
    completion.memberId = this.memberID;
    completion.displayName = this.displayName;
    completion.status = status;
    completion.payload = payload;
    this.mailbox.enqueue(completion);
  }
}

/** Returns the error text for a failed run, falling back to the response. */
export function memberTerminalPayload(
  runErr: Error | undefined,
  a: AgentAdapter,
): string {
  if (runErr !== undefined) return runErr.message;
  return lastAssistantResponse(a);
}
