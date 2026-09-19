// Ported from internal/a2a/handler.go.
//
// `net/http` maps to standard `Request`/`Response`; `http.Flusher` maps to a
// streaming `ReadableStream`. Go's `<-chan TaskEvent` subscriber channel maps
// to an `EventQueue` with an async `next()`.

import type { Message, Task, TaskError, TaskEvent } from "./task.ts";
import { newTaskID, taskStateFailed, TaskStore } from "./task.ts";

/** JSONRPCRequest represents a JSON-RPC 2.0 request. */
export interface JSONRPCRequest {
  jsonrpc: string;
  method?: string;
  params?: unknown;
  id?: unknown;
}

/** JSONRPCError represents a JSON-RPC 2.0 error. */
export interface JSONRPCError {
  code: number;
  message: string;
}

/** JSONRPCResponse represents a JSON-RPC 2.0 response. */
export interface JSONRPCResponse {
  jsonrpc: string;
  result?: unknown;
  error?: JSONRPCError;
  id: unknown;
}

/** SendMessageParams represents the params for message/send. */
export interface SendMessageParams {
  task_id?: string;
  message?: Message;
}

/** AgentExecutor processes A2A tasks by running them through the agent loop. */
export interface AgentExecutor {
  executeTask(
    ctx: AbortSignal,
    task: Task,
    msg: Message,
  ): Promise<AsyncIterable<TaskEvent>>;
}

const terminalStates = new Set([
  "completed",
  "incomplete",
  "failed",
  "canceled",
]);

function isTerminal(state: string): boolean {
  return terminalStates.has(state);
}

/** EventQueue is the TS stand-in for Go's buffered subscription channel. */
export class EventQueue {
  private buffer: TaskEvent[] = [];
  private waiters: ((ev: TaskEvent | undefined) => void)[] = [];
  private closed = false;

  push(ev: TaskEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(ev);
    } else if (this.buffer.length < 100) {
      this.buffer.push(ev);
    }
  }

  next(): Promise<TaskEvent | undefined> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift());
    }
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(undefined);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

interface TaskRun {
  controller: AbortController;
}

/** Handler handles A2A JSON-RPC requests. */
export class Handler {
  private taskStore: TaskStore;
  private executor: AgentExecutor;
  private subscriberLists = new Map<string, EventQueue[]>();
  private runs = new Map<string, TaskRun>();

  constructor(executor: AgentExecutor, taskStore?: TaskStore) {
    this.executor = executor;
    this.taskStore = taskStore ?? new TaskStore();
  }

  /** GetTaskStore returns the task store. */
  getTaskStore(): TaskStore {
    return this.taskStore;
  }

  /** ServeHTTP handles A2A JSON-RPC requests at /a2a. */
  async serveHTTP(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    let rpc: JSONRPCRequest;
    try {
      rpc = (await req.json()) as JSONRPCRequest;
    } catch {
      return this.writeError(null, -32700, "Parse error");
    }
    if (rpc === null || typeof rpc !== "object") {
      return this.writeError(null, -32700, "Parse error");
    }

    if (rpc.jsonrpc !== "2.0") {
      return this.writeError(
        rpc.id ?? null,
        -32600,
        'Invalid Request: jsonrpc must be "2.0"',
      );
    }

    const isSSE = (req.headers.get("Accept") ?? "").includes(
      "text/event-stream",
    );

    switch (rpc.method) {
      case "message/send":
        return await this.handleSendMessage(req, rpc, isSSE);
      case "task/get":
        return this.handleGetTask(rpc);
      case "task/cancel":
        return this.handleCancelTask(rpc);
      default:
        return this.writeError(
          rpc.id ?? null,
          -32601,
          "Method not found: " + (rpc.method ?? ""),
        );
    }
  }

  /** handleSendMessage processes message/send. */
  async handleSendMessage(
    req: Request,
    rpc: JSONRPCRequest,
    isSSE: boolean,
  ): Promise<Response> {
    const params = (rpc.params ?? {}) as SendMessageParams;
    return await this.sendMessage(params, req.signal, isSSE, rpc.id ?? null);
  }

  /**
   * sendMessage creates/loads the task, registers the run, and executes the
   * task either synchronously or as an SSE stream. Shared by the JSON-RPC and
   * REST entry points.
   */
  async sendMessage(
    params: SendMessageParams,
    parent: AbortSignal,
    isSSE: boolean,
    reqID: unknown,
  ): Promise<Response> {
    if (params.message === undefined || params.message === null) {
      return this.writeError(
        reqID,
        -32602,
        "Invalid params: message is required",
      );
    }

    let task: Task | undefined;
    if (params.task_id !== undefined && params.task_id !== "") {
      task = this.taskStore.get(params.task_id);
      if (task === undefined) {
        return this.writeError(
          reqID,
          -32000,
          "Task not found: " + params.task_id,
        );
      }
    } else {
      task = this.taskStore.create(newTaskID());
    }

    task.message = params.message;
    task.state = "working";
    this.taskStore.update(task);
    const { controller } = this.registerRun(parent, task.id);

    try {
      if (isSSE) {
        return await this.streamResponse(
          controller.signal,
          task,
          params.message,
        );
      } else {
        return await this.syncResponse(
          controller.signal,
          task,
          params.message,
          reqID,
        );
      }
    } finally {
      this.unregisterRun(task.id);
    }
  }

  /** syncResponse processes the task synchronously. */
  async syncResponse(
    signal: AbortSignal,
    task: Task,
    msg: Message,
    reqID: unknown,
  ): Promise<Response> {
    let eventIter: AsyncIterable<TaskEvent>;
    try {
      eventIter = await this.executor.executeTask(signal, task, msg);
    } catch (err) {
      const message = (err as Error).message;
      this.taskStore.finish(task.id, taskStateFailed, undefined, {
        code: -32000,
        message,
      });
      return this.writeError(reqID, -32000, message);
    }

    let lastEvent: TaskEvent | undefined;
    for await (const ev of eventIter) {
      lastEvent = ev;
      this.broadcast(task.id, ev);
    }

    let state: string = lastEvent?.state ?? "";
    let lastError: TaskError | undefined = lastEvent?.error;
    if (state === "") {
      state = taskStateFailed;
      lastError = {
        code: -32000,
        message: "task ended without a terminal event",
      };
    }
    const finished = this.taskStore.finish(
      task.id,
      state,
      lastEvent?.artifact,
      lastError,
    );

    return jsonResponse({
      jsonrpc: "2.0",
      result: finished,
      id: reqID,
    });
  }

  /** streamResponse processes the task with SSE streaming. */
  async streamResponse(
    signal: AbortSignal,
    task: Task,
    msg: Message,
  ): Promise<Response> {
    let eventIter: AsyncIterable<TaskEvent>;
    try {
      eventIter = await this.executor.executeTask(signal, task, msg);
    } catch (err) {
      const message = (err as Error).message;
      const failed = this.taskStore.finish(
        task.id,
        taskStateFailed,
        undefined,
        {
          code: -32000,
          message,
        },
      );
      return sseResponse([
        {
          task_id: task.id,
          state: failed?.state ?? taskStateFailed,
          error: failed?.error,
          timestamp: new Date().toISOString(),
        },
      ]);
    }

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const encoder = new TextEncoder();
        try {
          for await (const ev of eventIter) {
            controller.enqueue(encoder.encode(sseFrame(ev)));
            this.broadcast(task.id, ev);
            if (isTerminal(ev.state)) {
              this.taskStore.finish(task.id, ev.state, ev.artifact, ev.error);
            }
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  /** handleGetTask returns the current state of a task. */
  handleGetTask(rpc: JSONRPCRequest): Response {
    const params = (rpc.params ?? {}) as { task_id?: string };
    const task = this.taskStore.get(params.task_id ?? "");
    if (task === undefined) {
      return this.writeError(
        rpc.id ?? null,
        -32000,
        "Task not found: " + (params.task_id ?? ""),
      );
    }
    return jsonResponse({
      jsonrpc: "2.0",
      result: task,
      id: rpc.id ?? null,
    });
  }

  /** handleCancelTask cancels a running task. */
  handleCancelTask(rpc: JSONRPCRequest): Response {
    const params = (rpc.params ?? {}) as { task_id?: string };
    const task = this.taskStore.get(params.task_id ?? "");
    if (task === undefined) {
      return this.writeError(
        rpc.id ?? null,
        -32000,
        "Task not found: " + (params.task_id ?? ""),
      );
    }
    if (task.state !== "working" && task.state !== "submitted") {
      return this.writeError(
        rpc.id ?? null,
        -32000,
        "Task cannot be canceled in state: " + task.state,
      );
    }
    this.cancelRun(params.task_id ?? "");
    const canceled = this.taskStore.cancel(params.task_id ?? "");
    return jsonResponse({
      jsonrpc: "2.0",
      result: canceled,
      id: rpc.id ?? null,
    });
  }

  private registerRun(parent: AbortSignal, taskID: string): TaskRun {
    const controller = new AbortController();
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener(
        "abort",
        () => controller.abort(parent.reason),
        { once: true },
      );
    }
    const run: TaskRun = { controller };
    this.runs.set(taskID, run);
    return run;
  }

  private unregisterRun(taskID: string): void {
    const run = this.runs.get(taskID);
    if (this.runs.get(taskID) === run) {
      this.runs.delete(taskID);
    }
    run?.controller.abort();
  }

  private cancelRun(taskID: string): void {
    this.runs.get(taskID)?.controller.abort();
  }

  /** Subscribe adds an SSE subscriber for task events. */
  subscribe(taskID: string): EventQueue {
    const q = new EventQueue();
    const list = this.subscriberLists.get(taskID) ?? [];
    list.push(q);
    this.subscriberLists.set(taskID, list);
    return q;
  }

  /** Unsubscribe removes an SSE subscriber. */
  unsubscribe(taskID: string, q: EventQueue): void {
    const list = this.subscriberLists.get(taskID);
    if (list === undefined) return;
    const idx = list.indexOf(q);
    if (idx >= 0) {
      list.splice(idx, 1);
      q.close();
    }
    if (list.length === 0) {
      this.subscriberLists.delete(taskID);
    }
  }

  /** broadcast sends an event to all subscribers of a task. */
  broadcast(taskID: string, event: TaskEvent): void {
    const list = this.subscriberLists.get(taskID);
    if (list === undefined) return;
    for (const q of list) q.push(event);
  }

  /** writeError writes a JSON-RPC error response. */
  writeError(id: unknown, code: number, msg: string): Response {
    return jsonResponse({
      jsonrpc: "2.0",
      error: { code, message: msg },
      id,
    });
  }

  /** SubscribeSSE handles SSE subscription for task events at /a2a/events. */
  subscribeSSE(req: Request): Response {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const url = new URL(req.url);
    const taskID = url.searchParams.get("task_id") ?? "";
    if (taskID === "") {
      return new Response("task_id is required", { status: 400 });
    }

    const q = this.subscribe(taskID);
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const encoder = new TextEncoder();
        try {
          while (true) {
            const event = await q.next();
            if (event === undefined) return;
            controller.enqueue(encoder.encode(sseFrame(event)));
            if (isTerminal(event.state)) return;
          }
        } finally {
          this.unsubscribe(taskID, q);
          controller.close();
        }
      },
      cancel: () => {
        this.unsubscribe(taskID, q);
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }
}

/** NewHandler creates a new A2A handler. */
export function newHandler(executor: AgentExecutor): Handler {
  return new Handler(executor);
}

/** NewTaskStore re-export convenience. */
export { TaskStore };

function jsonResponse(rpc: JSONRPCResponse): Response {
  return new Response(JSON.stringify(rpc), {
    headers: { "Content-Type": "application/json" },
  });
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };
}

function sseFrame(event: TaskEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(events: TaskEvent[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(sseFrame(ev)));
      controller.close();
    },
  });
  return new Response(body, { headers: sseHeaders() });
}
