// Ported from internal/a2a/task.go.
//
// Wire DTOs keep the Go `json:"..."` tags verbatim (snake_case) so the A2A
// protocol JSON shape is preserved 1:1; time.Time maps to an RFC3339 string.
// `sync.RWMutex` is dropped (Deno is single-threaded).

/** TaskState represents the state of an A2A task. */
export type TaskState = string;

export const taskStateSubmitted: TaskState = "submitted";
export const taskStateWorking: TaskState = "working";
export const taskStateCompleted: TaskState = "completed";
export const taskStateIncomplete: TaskState = "incomplete";
export const taskStateFailed: TaskState = "failed";
export const taskStateCanceled: TaskState = "canceled";

/** Task represents an A2A task. */
export interface Task {
  id: string;
  state: TaskState;
  message?: Message;
  artifacts?: Artifact[];
  error?: TaskError;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Message represents an A2A message (text or structured). */
export interface Message {
  role: string; // "user" or "agent"
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

/** MessagePart is a part of a message. */
export interface MessagePart {
  type: string; // "text"
  text?: string;
}

/** Artifact represents output produced by an agent task. */
export interface Artifact {
  name?: string;
  description?: string;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

/** TaskError represents an error in task processing. */
export interface TaskError {
  code: number;
  message: string;
}

/** TaskEvent is sent via SSE for streaming task updates. */
export interface TaskEvent {
  task_id: string;
  state: TaskState;
  message?: Message;
  artifact?: Artifact;
  error?: TaskError;
  timestamp: string;
}

let fallbackTaskCounter = 0;

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

/** Generates a fresh random task ID with a monotonic fallback. */
export function newTaskID(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  if (b.some((x) => x !== 0)) {
    return "task_" + bytesToHex(b);
  }
  fallbackTaskCounter += 1;
  return `task_${Date.now() * 1_000_000}_${fallbackTaskCounter}`;
}

/** TaskStore manages task storage. */
export class TaskStore {
  private tasks = new Map<string, Task>();

  /** Create creates a new task. */
  create(id: string): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id,
      state: taskStateSubmitted,
      created_at: now,
      updated_at: now,
      metadata: {},
    };
    this.tasks.set(id, task);
    return cloneTask(task)!;
  }

  /** Get returns a task by ID. */
  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    return cloneTask(task);
  }

  /** Update updates a task. */
  update(task: Task): void {
    const copy = cloneTask(task)!;
    copy.updated_at = new Date().toISOString();
    this.tasks.set(copy.id, copy);
  }

  /** SetState updates the task state. */
  setState(id: string, state: TaskState): void {
    const task = this.tasks.get(id);
    if (task !== undefined) {
      task.state = state;
      task.updated_at = new Date().toISOString();
    }
  }

  // Cancel marks a task terminally canceled. Later completion attempts preserve
  // this state so a canceled execution cannot be reported as successful.
  cancel(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    task.state = taskStateCanceled;
    task.updated_at = new Date().toISOString();
    return cloneTask(task);
  }

  // Finish records a terminal execution result unless the task was canceled.
  finish(
    id: string,
    state: TaskState,
    artifact?: Artifact,
    taskErr?: TaskError,
  ): Task | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    if (task.state === taskStateCanceled) {
      return cloneTask(task);
    }
    task.state = state;
    if (artifact !== undefined) {
      task.artifacts = [...(task.artifacts ?? []), cloneArtifact(artifact)];
    }
    if (taskErr !== undefined) {
      task.error = { ...taskErr };
    }
    task.updated_at = new Date().toISOString();
    return cloneTask(task);
  }
}

/** Create newTaskStore. */
export function newTaskStore(): TaskStore {
  return new TaskStore();
}

/** Clone returns a deep copy of the task value. */
export function cloneTask(t: Task | undefined): Task | undefined {
  if (t === undefined) return undefined;
  const copy: Task = { ...t };
  copy.message = cloneMessage(t.message);
  if (t.artifacts !== undefined && t.artifacts.length > 0) {
    copy.artifacts = t.artifacts.map((a) => cloneArtifact(a));
  } else {
    copy.artifacts = t.artifacts;
  }
  if (t.error !== undefined) copy.error = { ...t.error };
  copy.metadata = cloneMap(t.metadata);
  return copy;
}

function cloneMessage(msg: Message | undefined): Message | undefined {
  if (msg === undefined) return undefined;
  const copy: Message = { ...msg };
  copy.parts = msg.parts.map((p) => ({ ...p }));
  copy.metadata = cloneMap(msg.metadata);
  return copy;
}

function cloneArtifact(artifact: Artifact): Artifact {
  const copy: Artifact = { ...artifact };
  copy.parts = artifact.parts.map((p) => ({ ...p }));
  copy.metadata = cloneMap(artifact.metadata);
  return copy;
}

function cloneMap(
  m: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (m === undefined || Object.keys(m).length === 0) return undefined;
  return { ...m };
}
