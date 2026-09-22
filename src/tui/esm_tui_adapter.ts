// TUI host adapter for the shared ESM Supervisor, ported from the Go TUI's
// esmRuntimeAdapter + runESMRoleAgentWithTimeoutForRole.
//
// Roles run as managed child agents on the session's shared AgentManager; the
// child's events are forwarded into the AppController so the activity store
// (and therefore the Ctrl+O detail panel and the ESM panel activity line) show
// what each role agent is doing. ESM policy stays in src/esm.

import type { AgentAdapter } from "../agent/bridge.ts";
import type { AgentManager } from "../agent/manager.ts";
import type { AgentOptions } from "../agent/factory.ts";
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
  Event,
  EventRunFinished,
  EventTextDelta,
  EventThinkDelta,
  EventToolCall,
  EventToolExecutionEnd,
  type TaskStatus,
} from "../agent/events.ts";
import {
  EvidenceTracker,
  finalAssistantResponse,
  newRoleIncompleteError,
  roleContext,
  type RoleRequest,
  type RoleResult,
  roleWorker,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventSink,
} from "../esm/mod.ts";
import type { AppController } from "./app_controller.ts";

/** The ESM role execution surface the adapter needs from the session. */
export interface ESMRoleHost {
  readonly controller: AppController;
  teamExpertActive(): boolean;
  setESMActiveAgent(id: string): void;
  clearESMActiveAgent(id: string): void;
}

/**
 * TuiESMRuntimeAdapter executes ESM roles on the shared AgentManager and
 * projects lifecycle events into the TUI controller.
 */
export class TuiESMRuntimeAdapter implements RuntimeAdapter, RuntimeEventSink {
  #manager: AgentManager;
  #host: ESMRoleHost;
  #workDir: string;
  #mode: string;

  constructor(
    manager: AgentManager,
    host: ESMRoleHost,
    workDir: string,
    mode: string,
  ) {
    this.#manager = manager;
    this.#host = host;
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

  /** Publishes a supervisor lifecycle message as a status row. */
  publishESMEvent(event: RuntimeEvent): void {
    if (event.message !== "") {
      this.#host.controller.addMessage(event.message, "status");
    }
  }

  async #driveRole(
    signal: AbortSignal | undefined,
    req: RoleRequest,
  ): Promise<RoleResult> {
    const started = new Date();
    const teamWorker = req.role === roleWorker && this.#host.teamExpertActive();
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
    this.#host.setESMActiveAgent(childId);
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
              runErr = newRoleIncompleteError(
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
      this.#host.clearESMActiveAgent(childId);
      try {
        this.#manager.destroy(childId);
      } catch {
        // Already destroyed by a racing abort.
      }
    }
  }

  /** Maps one child event onto the internal event shape the controller folds. */
  #publishRoleEvent(childId: string, ev: PublicEvent): void {
    let out: Event;
    switch (ev.type) {
      case eventTextDelta:
        out = {
          type: EventTextDelta,
          agentId: childId,
          textDelta: ev.textDelta,
        };
        break;
      case eventThinkDelta:
        out = {
          type: EventThinkDelta,
          agentId: childId,
          thinkDelta: ev.thinkDelta,
        };
        break;
      case eventToolCall:
        out = {
          type: EventToolCall,
          agentId: childId,
          toolName: ev.toolName,
          toolCallId: ev.toolCallId,
          toolArgs: ev.toolArgs,
        };
        break;
      case eventToolExecutionEnd:
        out = {
          type: EventToolExecutionEnd,
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
          type: EventRunFinished,
          agentId: childId,
          status: ev.status as TaskStatus | undefined,
          error: ev.error,
        };
        break;
      default:
        return;
    }
    out.agentId = childId;
    this.#host.controller.handleAgentEvent(out);
  }
}
