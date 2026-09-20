// Ported from internal/agentruntime/tool_fence.go.
//
// `beforeToolExecuteForRuntime` is the Runtime ownership fence installed for
// every Agent built by a SessionRuntime, including managed children. It runs
// late in the Agent Core tool path, after approval/waits and the durable
// operation claim, and blocks a side-effecting tool whose fenced execution
// lease no longer proves ownership. Go's `context.Context` maps to the
// `AbortSignal` carried on the `ToolContext`; the `*SessionRuntime` receiver
// maps to the narrow `ToolFenceRuntime` view so the hook has no import cycle
// with the SessionRuntime slice.

import type {
  BeforeToolExecuteContext,
  ToolCallBlockResult,
} from "../agent/mod.ts";
import type { Manager } from "../session/manager.ts";
import { validateRuntimeLease } from "../session/mod.ts";

/** The Runtime state the fence reads: identity, session manager, execution. */
export interface ToolFenceRuntime {
  readonly id: string;
  readonly manager: Manager | undefined;
  readonly execution:
    | { active(): { runId: string; active: boolean } }
    | undefined;
}

/**
 * Builds the Runtime ownership fence for one SessionRuntime. The returned hook
 * returns `undefined` (allow) or a blocking `ToolCallBlockResult`.
 */
export function beforeToolExecuteForRuntime(
  runtime: ToolFenceRuntime | null | undefined,
): (ctx: BeforeToolExecuteContext) => ToolCallBlockResult | undefined {
  return (
    toolCtx: BeforeToolExecuteContext,
  ): ToolCallBlockResult | undefined => {
    if (runtime === null || runtime === undefined || !toolCtx.sideEffecting) {
      return undefined;
    }
    const manager = runtime.manager;
    const execution = runtime.execution;
    let runtimeId = runtime.id;
    if (
      execution === undefined || manager === undefined ||
      (toolCtx.runId ?? "").trim() === ""
    ) {
      return undefined;
    }
    const signal = toolCtx.executionContext?.signal;
    if (signal !== undefined && signal.aborted) {
      return blockToolExecutionFence(cancellationReason(signal));
    }
    const active = execution.active();
    if (!active.active || active.runId !== toolCtx.runId) {
      return blockToolExecutionFence("the local execution is no longer active");
    }
    if (runtimeId === "") {
      const header = manager.getHeader();
      if (header !== null && header !== undefined) {
        runtimeId = header.id;
      }
    }
    if (runtimeId === "") {
      return blockToolExecutionFence("the session identity is unavailable");
    }
    try {
      validateRuntimeLease(
        manager.getSessionDir(),
        runtimeId,
        toolCtx.runId,
        "execution",
      );
    } catch (err) {
      return blockToolExecutionFence(errorMessage(err));
    }
    return undefined;
  };
}

/** Builds a blocking decision with the canonical Runtime fence reason. */
export function blockToolExecutionFence(reason: string): ToolCallBlockResult {
  const trimmed = (reason ?? "").trim();
  return {
    block: true,
    reason: `tool execution blocked by Runtime ownership fence: ${
      trimmed === "" ? "the execution lease could not be revalidated" : trimmed
    }`,
  };
}

function cancellationReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim() !== "") return reason;
  return "context canceled";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
