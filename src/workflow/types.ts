// Ported from internal/workflow/types.go.
//
// The workflow data model and the injectable Host/Store contracts. The Go
// structs' `json:"..."` tags are camelCase and map directly to the TS property
// names, so serialization is a plain JSON.stringify.
//
// Deviation: Go `time.Time` maps to `Date` (serialized as an ISO-8601 string).

/** Workflow run statuses (mirrors the Go constants). */
export const statusRunning = "running";
export const statusDone = "done";
export const statusIncomplete = "incomplete";
export const statusError = "error";
export const statusCanceled = "canceled";

/** Describes one workflow worker-agent invocation. */
export interface AgentTask {
  name: string;
  phase?: string;
  instanceKey?: string;
  prompt: string;
  mode?: string;
  workDir?: string;
  tools?: string[];
  maxIterations?: number;
  systemPromptExtra?: string;
}

/** Captures the completed worker-agent output. */
export interface AgentResult {
  key: string;
  name: string;
  phase?: string;
  instanceKey?: string;
  status: string;
  result?: string;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
  duration?: string;
}

/** Captures runtime state for a workflow phase. */
export interface PhaseState {
  name: string;
  status: string;
  startedAt: Date;
  finishedAt?: Date;
  tasks?: string[];
  error?: string;
}

/** A timestamped log entry emitted by the workflow DSL. */
export interface WorkflowLog {
  time: Date;
  message: string;
}

/** The persisted workflow run state. */
export interface RunState {
  id: string;
  name: string;
  status: string;
  startedAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
  phases?: PhaseState[];
  results?: Record<string, AgentResult>;
  logs?: WorkflowLog[];
  error?: string;
}

/** A lightweight workflow lifecycle update. */
export interface ProgressEvent {
  runId?: string;
  name?: string;
  phase?: string;
  task?: string;
  status?: string;
  message?: string;
  time?: Date;
}

/**
 * Host runs workflow worker-agent tasks. The Go `context.Context` maps to an
 * optional `AbortSignal`.
 */
export interface Host {
  runAgent(task: AgentTask, signal?: AbortSignal): Promise<AgentResult>;
}

/** Persists workflow run state. */
export interface Store {
  save(state: RunState, signal?: AbortSignal): Promise<void>;
  load(id: string, signal?: AbortSignal): Promise<RunState>;
  list(signal?: AbortSignal): Promise<RunState[]>;
}

/** Throws a DOMException-shaped AbortError used across the workflow module. */
export function abortError(message = "workflow aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/** Reports whether an error represents caller cancellation. */
export function isCanceled(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Throws when the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}
