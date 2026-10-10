// Core-owned ESM role runner: executes supervisor roles as managed child
// agents on the session's shared AgentManager and reports lifecycle/activity
// through a neutral event sink. All ESM policy stays in src/esm; this adapter
// only executes roles and projects host events, mirroring the TUI adapter it
// replaces (Go esmRuntimeAdapter + runESMRoleAgentWithTimeoutForRole).

import type { AgentAdapter } from "../agent/bridge.ts";
import type { AgentManager } from "../agent/manager.ts";
import { type AgentOptions } from "../agent/factory.ts";
import {
  type Event as PublicEvent,
  eventDone,
  eventRunFinished,
  eventTextDelta,
  eventThinkDelta,
  eventToolCall,
  eventToolExecutionEnd,
  taskCanceled,
  taskFailed,
  taskIncomplete,
} from "../../sdk/agent/mod.ts";
import {
  type Event,
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_CALL,
  EVENT_TOOL_EXECUTION_END,
  type TaskStatus} from "../agent/events.ts";
import {
  createRoleIncompleteError,
  EvidenceTracker,
  finalAssistantResponse,
  roleContext,
  type RoleRequest,
  type RoleResult,
  roleWorker,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventSink,
} from "../esm/mod.ts";

/** The neutral projection surface the adapter reports ESM activity through. */
export interface ESMRoleEventSink {
  /** True when the session's expert binding forces a team worker. */
  teamExpertActive(): boolean;
  /** Reports the child agent currently executing a role. */
  setActiveAgent(agentId: string): void;
  /** Clears the active-agent tracking when `agentId` is still active. */
  clearActiveAgent(agentId: string): void;
  /** Reports one child-agent activity event (canonical Agent event). */
  publishRoleEvent(event: Event): void;
  /** Reports one supervisor lifecycle message. */
  publishMessage(message: string): void;
}

/**
 * Executes ESM roles on a shared AgentManager and projects lifecycle events
 * through the sink. The Core Runtime Host owns the sink and translates
 * reported events into canonical Core run events.
 */
export class AgentManagerESMAdapter
  implements RuntimeAdapter, RuntimeEventSink {
  #manager: AgentManager;
  #sink: ESMRoleEventSink;
  #workDir: string;
  #mode: string;

  constructor(
    manager: AgentManager,
    sink: ESMRoleEventSink,
    workDir: string,
    mode: string,
  ) {
    this.#manager = manager;
    this.#sink = sink;
    this.#workDir = workDir;
    this.#mode = mode;
  }

  async runRole(
    signal: AbortSignal | undefined,
    req: RoleRequest,
  ): Promise<RoleResult> {
    // Role scope supplies the shared deadline policy (worker/critic/audit
    // roles carry no wall-clock deadline; the recovery observer is bounded).
    const scope = roleContext(signal, req.role);
    try {
      return await this.#driveRole(scope.signal, req);
    } finally {
      scope.cancel();
    }
  }

  async runRecoveryObserver(
    signal: AbortSignal | undefined,
    req: RoleRequest,
    _interruption: unknown,
  ): Promise<RoleResult> {
    const scope = roleContext(signal, req.role);
    try {
      return await this.#driveRole(scope.signal, req);
    } finally {
      scope.cancel();
    }
  }

  /** Publishes a supervisor lifecycle message through the sink. */
  publishESMEvent(event: RuntimeEvent): void {
    if (event.message !== "") {
      this.#sink.publishMessage(event.message);
    }
  }

  async #driveRole(
    signal: AbortSignal | undefined,
    req: RoleRequest,
  ): Promise<RoleResult> {
    const started = new Date();
    const teamWorker = req.role === roleWorker && this.#sink.teamExpertActive();
    const opts: AgentOptions = {
      id: req.runId,
      isSubAgent: true,
      mode: this.#mode !== "" ? this.#mode : req.mode,
      workDir: this.#workDir,
      tools: req.tools,
      maxIterations: req.maxIterations,
      multiAgent: teamWorker,
      delegateMode: false,
      workflows: false,
      ownsSessionMailbox: teamWorker,
    };
    const child: AgentAdapter = this.#manager.create(opts);
    const childId = child.id();
    this.#sink.setActiveAgent(childId);
    try {
      this.#manager.markRunning(childId);
      const result: RoleResult = {
        response: "",
        tokens: 0,
        durationMs: 0,
        toolCalls: 0,
        toolNames: new Map<string, number>(),
        toolError: new Map<string, boolean>(),
      };
      const tracker = new EvidenceTracker();
      let completed = false;
      let runErr: unknown = undefined;
      for await (const ev of child.run(req.prompt, signal)) {
        this.#publishRoleEvent(childId, ev);
        if (ev.usage) {
          let n = ev.usage.totalTokens;
          if (n <= 0) n = ev.usage.inputTokens + ev.usage.outputTokens;
          result.tokens += n;
        }
        tracker.observe(ev as PublicEvent);
        switch (ev.type) {
          case eventRunFinished:
            completed = true;
            if (ev.status === taskIncomplete) {
              runErr = createRoleIncompleteError(
                req.role,
                ev.stopReason ?? "",
                ev.error,
              );
              this.#manager.markIncomplete(childId, runErr as Error);
            } else if (ev.status === taskFailed || ev.status === taskCanceled) {
              runErr = ev.error;
              this.#manager.markError(childId, ev.error);
            } else {
              this.#manager.markDone(
                childId,
                finalAssistantResponse(child.getMessages()),
              );
            }
            break;
          case eventDone:
            if (!completed) {
              completed = true;
              this.#manager.markDone(
                childId,
                finalAssistantResponse(child.getMessages()),
              );
            }
            break;
          default:
            break;
        }
      }
      if (!completed) {
        runErr = signal?.reason ?? new Error("esm role ended without terminal");
        this.#manager.markError(childId, runErr as Error);
      }
      result.durationMs = Date.now() - started.getTime();
      result.response = finalAssistantResponse(child.getMessages());
      const summary = tracker.summary();
      result.toolCalls = summary.toolCalls;
      result.toolNames = summary.toolNames;
      result.toolError = summary.toolError;
      if (runErr !== undefined) throw runErr;
      return result;
    } finally {
      this.#sink.clearActiveAgent(childId);
      try {
        this.#manager.destroy(childId);
      } catch {
        // Already destroyed by a racing abort.
      }
    }
  }

  /** Maps one child event onto the canonical Agent event shape. */
  #publishRoleEvent(childId: string, ev: PublicEvent): void {
    let out: Event;
    switch (ev.type) {
      case eventTextDelta:
        out = {
          type: EVENT_TEXT_DELTA,
          agentId: childId,
          textDelta: ev.textDelta,
        };
        break;
      case eventThinkDelta:
        out = {
          type: EVENT_THINK_DELTA,
          agentId: childId,
          thinkDelta: ev.thinkDelta,
        };
        break;
      case eventToolCall:
        out = {
          type: EVENT_TOOL_CALL,
          agentId: childId,
          toolName: ev.toolName,
          toolCallId: ev.toolCallId,
          toolArgs: ev.toolArgs,
        };
        break;
      case eventToolExecutionEnd:
        out = {
          type: EVENT_TOOL_EXECUTION_END,
          agentId: childId,
          toolName: ev.toolName,
          toolCallId: ev.toolCallId,
          toolArgs: ev.toolArgs,
          toolResult: ev.toolResult,
          toolError: ev.toolError,
        };
        break;
      case eventRunFinished:
        out = {
          type: EVENT_RUN_FINISHED,
          agentId: childId,
          status: ev.status as TaskStatus | undefined,
          error: ev.error,
        };
        break;
      default:
        return;
    }
    out.agentId = childId;
    this.#sink.publishRoleEvent(out);
  }
}
