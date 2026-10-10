//
// `json.RawMessage` parameter schemas map to plain JSON objects; the Go error
// returns map to `throw`. `workflow_run` executes worker agents through the
// shared `AgentHost`/`AgentManager` (`./agent_host.ts`), mirroring the Go
// binding to `internal/agent`.

import { configDir } from "../config/settings.ts";
import * as path from "../compat/path.ts";
import { type AgentID } from "../../sdk/agent/types.ts";
import {
  type Event as PublicEvent,
  eventDone,
  eventError,
  eventStatus,
} from "../../sdk/agent/mod.ts";
import {
  agentIDFromToolContext,
  type EventSink,
  eventSinkFromToolContext,
  parentModeFromToolContext,
  parentRunContextFromToolContext,
} from "../agent/agent.ts";
import type { AgentManager } from "../agent/manager.ts";
import { forwardChildAgentEvent } from "../agent/subagent.ts";
import {
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";
import { type ActiveRegistry, createActiveRegistry } from "./active.ts";
import { AgentHost } from "./agent_host.ts";
import { lintEvalTimeoutMs } from "./js.ts";
import { Runner } from "./runner.ts";
import { FileStore } from "./store.ts";
import {
  type AgentResult,
  type AgentTask,
  type Host,
  isCanceled,
  type ProgressEvent,
  type RunState,
  statusCanceled,
  statusDone,
  statusError,
  type Store,
} from "./types.ts";

/** The default on-disk location for workflow run state. */
export function defaultStore(): Store {
  return new FileStore(path.join(configDir(), "workflows", "runs"));
}

/** Collects task keys while evaluating a workflow without running agents. */
class LintHost implements Host {
  tasks: string[] = [];

  runAgent(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    if (signal?.aborted) {
      return Promise.reject(new Error("aborted"));
    }
    const key = lintTaskStorageKey(
      task.phase ?? "",
      task.name,
      task.instanceKey ?? "",
    );
    this.tasks.push(key);
    return Promise.resolve({
      key,
      name: task.name,
      phase: task.phase,
      instanceKey: task.instanceKey,
      status: statusDone,
      result: "__workflow_lint_placeholder__",
      startedAt: new Date(),
    });
  }
}

function lintTaskStorageKey(
  phase: string,
  name: string,
  instanceKey: string,
): string {
  let base = name;
  if (phase !== "") base = phase + "." + name;
  if (instanceKey === "") return base;
  return base + "[" + instanceKey + "]";
}

/** The lint result reported by `workflow_lint`. */
export interface LintResult {
  valid: boolean;
  status: string;
  error?: string;
  tasks?: string[];
  results?: string[];
}

/** Lints workflow source with the default (fast) evaluation budget. */
export function lintWorkflowSource(
  source: string,
  signal?: AbortSignal,
): Promise<LintResult> {
  return lintWorkflowSourceWithin(source, lintEvalTimeoutMs, signal);
}

/**
 * Runs the same lint with an explicit VM evaluation budget, so fast-fail
 * behavior is testable without waiting for the production lint timeout.
 */
export async function lintWorkflowSourceWithin(
  source: string,
  evalTimeoutMs: number,
  signal?: AbortSignal,
): Promise<LintResult> {
  const host = new LintHost();
  const runner = new Runner({
    host,
    active: createActiveRegistry(),
    concurrency: 100,
    evalTimeoutMs,
  });
  let state;
  let err: unknown;
  try {
    state = await runner.run(source, signal);
  } catch (e) {
    err = e;
    state = workflowStateOf(e);
  }
  const res: LintResult = {
    valid: err === undefined,
    status: "",
    tasks: sortedStrings(host.tasks),
  };
  if (state !== undefined && state !== null) {
    res.status = state.status;
    res.results = sortedResultKeys(state.results ?? {});
  }
  if (res.status === "") {
    res.status = err !== undefined ? statusError : statusDone;
  }
  if (err !== undefined) {
    res.error = err instanceof Error ? err.message : String(err);
  }
  return res;
}

function workflowStateOf(err: unknown): {
  status: string;
  results?: Record<string, AgentResult>;
} | undefined {
  const state = (err as { workflowState?: unknown }).workflowState;
  if (state !== undefined && state !== null) {
    return state as { status: string; results?: Record<string, AgentResult> };
  }
  return undefined;
}

function sortedResultKeys(
  results: Record<string, AgentResult>,
): string[] {
  const keys = Object.keys(results);
  return sortedStrings(keys);
}

function sortedStrings(values: string[]): string[] {
  if (values.length === 0) return [];
  return [...values].sort();
}

/** Validates workflow JavaScript DSL without running worker agents. */
export class LintTool implements Tool {
  name(): string {
    return "workflow_lint";
  }

  description(): string {
    return "Validate workflow JavaScript DSL syntax and references without running worker agents.";
  }

  promptSnippet(): string {
    return "Validate workflow JavaScript DSL before workflow_run";
  }

  promptGuidelines(): string[] {
    return [
      "Use workflow_lint before workflow_run when generating or modifying non-trivial workflow DSL.",
      "workflow_lint validates JavaScript syntax, workflow/phase/agent calls, agent options, required prompts, and result references without invoking worker agents.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Complete raw JavaScript workflow DSL source to validate. Do not pass Markdown fences.",
        },
      },
      required: ["source"],
    };
  }

  async execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    let source = typeof params.source === "string" ? params.source : "";
    source = source.trim();
    if (source === "") throw new Error("source is required");
    const result = await lintWorkflowSource(source);
    return createTextToolResult(JSON.stringify(result));
  }
}

/** Runs a JavaScript workflow DSL script that orchestrates worker agents. */
export class RunTool implements Tool {
  #manager?: AgentManager;
  #store?: Store;
  #active: ActiveRegistry;

  constructor(
    manager?: AgentManager,
    store?: Store,
    active?: ActiveRegistry,
  ) {
    this.#manager = manager;
    this.#store = store;
    this.#active = active ?? createActiveRegistry();
  }

  name(): string {
    return "workflow_run";
  }

  description(): string {
    return "Run a JavaScript workflow DSL script that orchestrates worker agents.";
  }

  promptSnippet(): string {
    return "Run a multi-phase JavaScript workflow with worker agents";
  }

  promptGuidelines(): string[] {
    return [
      "Use workflow_lint before workflow_run when generating or modifying non-trivial workflow DSL.",
      "Use workflow_run for multi-phase tasks with independent worker-agent branches and fan-in verification.",
      "Write workflow DSL using plain JavaScript syntax; do not use Markdown code fences.",
      'Before calling workflow_run, ensure the source is one complete workflow("name", body) form with valid JavaScript and closed strings.',
      'Use plain JavaScript arrays for tools, for example tools: ["read", "grep"].',
      "Use key for repeated logical agents, especially inside loops; keyed results are stored as phase.agent[key].",
      "Keep worker prompts explicit and bounded; use result to pass prior phase outputs into later phases.",
      "Set timeoutSeconds to the expected workflow duration; use 0 only for intentional continuous workflows that must not hit the default tool deadline.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            'Complete raw JavaScript workflow DSL source. Must call workflow("name", body) with valid JavaScript; do not pass Markdown fences.',
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 0,
          description:
            "Agent-level timeout for this workflow_run call in seconds. Omit to use the default tool timeout; set to 0 for intentional continuous workflows with no agent-level deadline.",
        },
      },
      required: ["source"],
    };
  }

  executionTimeout(
    params: Record<string, unknown>,
  ): { durationMs: number; provided: boolean } {
    const raw = params.timeoutSeconds;
    if (raw === undefined) return { durationMs: 0, provided: false };
    const seconds = numericParam(raw);
    if (seconds === undefined || seconds < 0) {
      return { durationMs: 0, provided: false };
    }
    if (seconds === 0) return { durationMs: 0, provided: true };
    return { durationMs: seconds * 1000, provided: true };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    let source = typeof params.source === "string" ? params.source : "";
    source = source.trim();
    if (source === "") throw new Error("source is required");

    const parentId = agentIDFromToolContext(ctx);
    const parentSink = eventSinkFromToolContext(ctx);
    const parentRunCtx = parentRunContextFromToolContext(ctx);
    const parentMode = parentModeFromToolContext(ctx);

    const host = new AgentHost();
    host.manager = this.#manager;
    host.parentId = parentId ?? "";
    host.parentMode = parentMode ?? "";
    host.parentSink = parentSink;
    host.parentRunCtx = parentRunCtx;

    const runner = new Runner({
      host,
      store: this.#store,
      active: this.#active,
      progress: (ev: ProgressEvent) => {
        const sink: EventSink | undefined = parentSink;
        if (sink === undefined || (ev.runId ?? "") === "") return;
        let msg = (ev.message ?? "").trim();
        if (msg === "") {
          msg = [ev.phase ?? "", ev.task ?? "", ev.status ?? ""]
            .join(" ")
            .trim();
        }
        let eventType = eventStatus;
        let eventErr: Error | undefined;
        if ((ev.phase ?? "") === "" && (ev.task ?? "") === "") {
          switch (ev.status) {
            case statusDone:
              eventType = eventDone;
              break;
            case statusError:
            case statusCanceled:
              eventType = eventError;
              if (msg !== "") eventErr = new Error(msg);
              break;
          }
        }
        forwardChildAgentEvent(sink, `workflow:${ev.runId}` as AgentID, {
          type: eventType,
          statusMessage: msg,
          error: eventErr,
        } as PublicEvent);
      },
    });

    try {
      const state = await runner.run(source, ctx.signal);
      return runToolResult(state);
    } catch (err) {
      const state = (err as { workflowState?: RunState }).workflowState;
      if (isCanceled(err) && state !== undefined) {
        return runToolResult(state);
      }
      throw err;
    }
  }
}

/** Shows workflow run status. */
export class StatusTool implements Tool {
  #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  name(): string {
    return "workflow_status";
  }

  description(): string {
    return "Show workflow run status. Pass an id for details, or omit id to list recent runs.";
  }

  promptSnippet(): string {
    return "Inspect workflow run status and results";
  }

  promptGuidelines(): string[] {
    return [
      "Use workflow_status to inspect workflow run state without invoking the LLM.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Workflow run id. Omit to list recent runs.",
        },
      },
    };
  }

  async execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    let id = typeof params.id === "string" ? params.id : "";
    id = id.trim();
    if (id === "") {
      const runs = await this.#store.list();
      return createTextToolResult(JSON.stringify(runs));
    }
    const state = await this.#store.load(id);
    return createTextToolResult(JSON.stringify(state));
  }
}

/** Cancels an active workflow run by id. */
export class CancelTool implements Tool {
  #active: ActiveRegistry;

  constructor(active: ActiveRegistry) {
    this.#active = active;
  }

  name(): string {
    return "workflow_cancel";
  }

  description(): string {
    return "Cancel an active workflow run by id.";
  }

  promptSnippet(): string {
    return "Cancel an active workflow run";
  }

  promptGuidelines(): string[] {
    return [
      "Use workflow_cancel only for active workflow runs that should be interrupted.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow run id" },
      },
      required: ["id"],
    };
  }

  execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    return Promise.resolve().then(() => {
      let id = typeof params.id === "string" ? params.id : "";
      id = id.trim();
      if (id === "") throw new Error("id is required");
      if (!this.#active.cancel(id)) {
        throw new Error(`workflow run ${JSON.stringify(id)} is not active`);
      }
      return createTextToolResult(
        JSON.stringify({ id, status: statusCanceled }),
      );
    });
  }
}

/** Constructs the lint tool. */
export function createLintTool(): LintTool {
  return new LintTool();
}

/** Constructs the run tool. */
export function createRunTool(
  manager?: AgentManager,
  store?: Store,
  active?: ActiveRegistry,
): RunTool {
  return new RunTool(manager, store, active);
}

/** Constructs the status tool. */
export function createStatusTool(store: Store): StatusTool {
  return new StatusTool(store);
}

/** Constructs the cancel tool. */
export function createCancelTool(active?: ActiveRegistry): CancelTool {
  return new CancelTool(active ?? createActiveRegistry());
}

/**
 * Registers the workflow tools. `workflow_lint`, `workflow_status`, and
 * `workflow_cancel` are always registered; `workflow_run` is registered only
 * when a manager is supplied, matching the Go `RegisterTools` requirement that
 * the run tool has an AgentManager. (The Go helper returns early when the
 * manager is missing; here the read-only tools stay available without one.)
 */
export function registerWorkflowTools(
  registry: Registry | undefined,
  opts: {
    manager?: AgentManager;
    store?: Store;
    active?: ActiveRegistry;
  } = {},
): void {
  if (registry === undefined || registry === null) return;
  const store = opts.store ?? defaultStore();
  const active = opts.active ?? createActiveRegistry();
  registry.register(createLintTool());
  if (opts.manager !== undefined && opts.manager !== null) {
    registry.register(createRunTool(opts.manager, store, active));
  }
  registry.register(createStatusTool(store));
  registry.register(createCancelTool(active));
}

/** Serializes a completed workflow run into the `workflow_run` tool result. */
export function runToolResult(state: RunState): ToolResult {
  return createTextToolResult(JSON.stringify({
    id: state.id,
    name: state.name,
    status: state.status,
    results: summarizeResults(state),
  }));
}

/** Maps each stored result key to its terminal status. */
export function summarizeResults(state: RunState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, result] of Object.entries(state.results ?? {})) {
    out[key] = result.status;
  }
  return out;
}

function numericParam(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return undefined;
}
