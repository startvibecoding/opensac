// Ported from internal/a2a/client.go.
//
// `net/http` maps to `fetch`; `context.Context` maps to an `AbortSignal`.
// The SSE reader is an async generator over the response body.

import type { AgentCard } from "./agent_card.ts";
import type { JSONRPCRequest, JSONRPCResponse } from "./handler.ts";
import type { Message, Task, TaskEvent } from "./task.ts";

/** Client is an A2A protocol client for sending tasks to other A2A servers. */
export class Client {
  private baseURL: string;
  private authToken: string;
  private timeoutMs: number;

  constructor(baseURL: string, authToken: string, timeoutMs = 300_000) {
    this.baseURL = baseURL;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  /** SendMessage sends a message to an A2A server (sync response). */
  async sendMessage(
    ctx: AbortSignal,
    taskID: string,
    msg: Message,
  ): Promise<Task> {
    const req: JSONRPCRequest = {
      jsonrpc: "2.0",
      method: "message/send",
      params: { task_id: taskID, message: msg },
      id: 1,
    };
    return (await this.doRPC(ctx, req)) as Task;
  }

  /** SendMessageStream sends a message and returns SSE events. */
  async sendMessageStream(
    ctx: AbortSignal,
    taskID: string,
    msg: Message,
  ): Promise<AsyncIterable<TaskEvent>> {
    const req: JSONRPCRequest = {
      jsonrpc: "2.0",
      method: "message/send",
      params: { task_id: taskID, message: msg },
      id: 1,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (this.authToken !== "") {
      headers["Authorization"] = "Bearer " + this.authToken;
    }

    const resp = await this.fetchWithTimeout(ctx, this.baseURL + "/a2a", {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    if (resp.status !== 200) {
      await resp.body?.cancel();
      throw new Error(`a2a request: status ${resp.status}`);
    }
    if (resp.body === null) {
      throw new Error("a2a request: empty body");
    }
    return readSSE(ctx, resp.body);
  }

  /** GetTask gets the current state of a task. */
  async getTask(ctx: AbortSignal, taskID: string): Promise<Task> {
    const req: JSONRPCRequest = {
      jsonrpc: "2.0",
      method: "task/get",
      params: { task_id: taskID },
      id: 2,
    };
    return (await this.doRPC(ctx, req)) as Task;
  }

  /** CancelTask cancels a running task. */
  async cancelTask(ctx: AbortSignal, taskID: string): Promise<Task> {
    const req: JSONRPCRequest = {
      jsonrpc: "2.0",
      method: "task/cancel",
      params: { task_id: taskID },
      id: 3,
    };
    return (await this.doRPC(ctx, req)) as Task;
  }

  /** GetAgentCard retrieves the Agent Card from the server. */
  async getAgentCard(ctx: AbortSignal): Promise<AgentCard> {
    const resp = await this.fetchWithTimeout(
      ctx,
      this.baseURL + "/.well-known/agent.json",
      { method: "GET" },
    );
    if (resp.status !== 200) {
      await resp.body?.cancel();
      throw new Error(`get agent card: status ${resp.status}`);
    }
    return (await resp.json()) as AgentCard;
  }

  private async doRPC(ctx: AbortSignal, req: JSONRPCRequest): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authToken !== "") {
      headers["Authorization"] = "Bearer " + this.authToken;
    }

    let resp: Response;
    try {
      resp = await this.fetchWithTimeout(ctx, this.baseURL + "/a2a", {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new Error(`a2a rpc: ${(err as Error).message}`);
    }

    let rpcResp: JSONRPCResponse;
    try {
      rpcResp = (await resp.json()) as JSONRPCResponse;
    } catch (err) {
      throw new Error(`decode response: ${(err as Error).message}`);
    }

    if (rpcResp.error !== undefined && rpcResp.error !== null) {
      throw new Error(
        `a2a error ${rpcResp.error.code}: ${rpcResp.error.message}`,
      );
    }
    return rpcResp.result;
  }

  private async fetchWithTimeout(
    ctx: AbortSignal,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([ctx, timeout]);
    return await fetch(url, { ...init, signal });
  }
}

/** NewClient creates a new A2A client. */
export function newClient(
  baseURL: string,
  authToken: string,
): Client {
  return new Client(baseURL, authToken);
}

/** Reads SSE `data:` frames from a response body. */
export async function* readSSE(
  ctx: AbortSignal,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<TaskEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let remaining = "";
  try {
    while (true) {
      if (ctx.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      remaining += decoder.decode(value, { stream: true });
      while (true) {
        const idx = remaining.indexOf("\n\n");
        if (idx < 0) break;
        const frame = remaining.slice(0, idx);
        remaining = remaining.slice(idx + 2);
        if (frame.startsWith("data: ")) {
          const data = frame.slice(6);
          try {
            yield JSON.parse(data) as TaskEvent;
          } catch {
            // Ignore malformed frames, matching the Go reader.
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Body already closed.
    }
  }
}
