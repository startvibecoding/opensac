//
// AgentHost runs workflow tasks through the existing AgentManager. Go's
// `chan<- internalagent.Event` maps to an `EventSink` threaded through the tool
// context, and the two `context.Context`s combine into a derived AbortSignal
// that fires when either the run or its parent cancels.

import { type AgentID } from "../../sdk/agent/types.ts";
import {
  type Event as PublicEvent,
  eventDone,
  eventError,
  eventRunFinished,
  eventToolApprovalRequest,
  taskCanceled,
  taskFailed,
  taskIncomplete,
} from "../../sdk/agent/mod.ts";
import { type Event, EVENT_TOOL_APPROVAL_REQUEST } from "../agent/events.ts";
import type { AgentManager } from "../agent/manager.ts";
import { type RunContext } from "../agent/run_context.ts";
import {
  forwardChildAgentEvent,
  lastAssistantResponse,
  sendParentEvent,
} from "../agent/subagent.ts";
import { resultStorageKey } from "./runner.ts";
import {
  type AgentResult,
  type AgentTask,
  type Host,
  statusCanceled,
  statusDone,
  statusError,
  statusIncomplete,
} from "./types.ts";

type EventSink = (ev: Event) => boolean;

/** A combined cancellation signal derived from two optional signals. */
interface CombinedCancellation {
  signal: AbortSignal | undefined;
  cancel: () => void;
}

function combineCancellation(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): CombinedCancellation {
  if (a === undefined) return { signal: b, cancel: () => {} };
  if (b === undefined) return { signal: a, cancel: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      a.removeEventListener("abort", onAbort);
      b.removeEventListener("abort", onAbort);
    },
  };
}

/** Runs workflow tasks through the existing AgentManager. */
export class AgentHost implements Host {
  manager?: AgentManager;
  parentId: AgentID = "";
  parentMode = "";
  parentSink?: EventSink;
  parentRunCtx?: RunContext;

  async runAgent(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    const manager = this.manager;
    if (manager === undefined) {
      throw new Error("agent manager is not initialized");
    }
    let mode = task.mode ?? "";
    if (mode === "") mode = this.parentMode;
    if (mode === "") mode = "yolo";
    let maxIter = task.maxIterations ?? 0;
    if (maxIter <= 0) maxIter = 50;

    const run = combineCancellation(signal, this.parentRunCtx?.signal);

    const a = manager.create({
      id: workflowAgentID(task.name, task.instanceKey ?? ""),
      parentId: this.parentId,
      mode,
      workDir: task.workDir,
      tools: task.tools,
      systemPromptExtra: task.systemPromptExtra,
      maxIterations: maxIter,
      multiAgent: false,
      delegateMode: false,
      workflows: false,
    });

    const started = new Date();
    manager.markRunning(a.id());
    let runErr: Error | undefined;
    let resultStatus: string = statusDone;
    let completed = false;
    try {
      for await (const ev of a.run(buildTaskPrompt(task), run.signal)) {
        if (
          ev.type === eventToolApprovalRequest && this.parentSink !== undefined
        ) {
          sendParentEvent(this.parentSink, {
            type: EVENT_TOOL_APPROVAL_REQUEST,
            agentId: a.id(),
            approvalId: ev.approvalId,
            approvalTool: ev.approvalTool,
            approvalArgs: ev.approvalArgs,
          });
        }
        forwardChildAgentEvent(this.parentSink, a.id(), ev as PublicEvent);
        switch (ev.type) {
          case eventRunFinished:
            completed = true;
            switch (ev.status) {
              case taskFailed:
                runErr = ev.error ??
                  new Error("workflow worker failed");
                manager.markError(a.id(), runErr);
                break;
              case taskIncomplete:
                runErr = ev.error;
                manager.markIncomplete(a.id(), runErr);
                resultStatus = statusIncomplete;
                break;
              case taskCanceled:
                resultStatus = statusCanceled;
                runErr = ev.error ??
                  new Error("workflow worker canceled");
                manager.markCanceled(a.id(), runErr);
                break;
              default:
                manager.markDone(a.id(), lastAssistantResponse(a));
            }
            break;
          case eventDone:
            if (!completed) {
              completed = true;
              manager.markDone(a.id(), lastAssistantResponse(a));
            }
            break;
          case eventError:
            if (!completed) {
              completed = true;
              runErr = ev.error;
              manager.markError(a.id(), ev.error);
            }
            break;
        }
      }
      if (!completed && run.signal?.aborted) {
        runErr = abortErrorFrom(run.signal);
        manager.markError(a.id(), runErr);
      }
    } finally {
      run.cancel();
      manager.destroy(a.id());
    }

    const result: AgentResult = {
      key: "",
      name: task.name,
      phase: task.phase,
      instanceKey: task.instanceKey,
      status: statusDone,
      result: lastAssistantResponse(a),
      startedAt: started,
      finishedAt: new Date(),
    };
    if (resultStatus === statusIncomplete) {
      result.status = statusIncomplete;
      if (runErr !== undefined) result.error = runErr.message;
      return result;
    }
    if (runErr !== undefined) {
      result.status = resultStatus;
      if (resultStatus === statusDone) result.status = statusError;
      result.error = runErr.message;
      if (
        resultStatus === statusIncomplete || resultStatus === statusCanceled
      ) {
        return result;
      }
      throw runErr;
    }
    return result;
  }
}

function abortErrorFrom(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow worker canceled");
}

/** Builds the stable agent ID for one workflow task. */
export function workflowAgentID(
  name: string,
  instanceKey: string,
): AgentID {
  name = name.trim();
  if (name === "") return "";
  let key = name;
  if (instanceKey !== "") {
    key = resultStorageKey(name, instanceKey.trim());
  }
  return `agent-${key}`;
}

/** Builds the worker prompt for one workflow task. */
export function buildTaskPrompt(task: AgentTask): string {
  const prompt = task.prompt.trim();
  if ((task.instanceKey ?? "") !== "") {
    return `Workflow task: ${task.name}
Instance key: ${task.instanceKey}
Phase: ${task.phase ?? ""}

${prompt}

Return a concise final result with evidence and risks.`;
  }
  return `Workflow task: ${task.name}
Phase: ${task.phase ?? ""}

${prompt}

Return a concise final result with evidence and risks.`;
}
