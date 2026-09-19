// Ported from internal/a2a/a2a_test.go.
//
// `httptest` maps to plain `Request`/`Response` handlers and `Deno.serve` on an
// ephemeral localhost port; `context.Background()` maps to an AbortSignal.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type AgentExecutor,
  type EventQueue,
  newHandler,
  newServer,
} from "./mod.ts";
import { defaultConfig, getListenAddr, getWorkDir } from "./config.ts";
import { defaultAgentCard, handleAgentCard } from "./agent_card.ts";
import { newClient } from "./client.ts";
import type { Message, Task, TaskEvent } from "./task.ts";
import {
  newTaskID,
  newTaskStore,
  taskStateCanceled,
  taskStateCompleted,
  taskStateFailed,
  taskStateSubmitted,
  taskStateWorking,
} from "./task.ts";

interface RawServer {
  url: string;
  close: () => Promise<void>;
}

function startJSONServer(
  handler: (req: Record<string, unknown>, raw: Request) => unknown | Response,
): RawServer {
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal },
    (raw: Request) => {
      return (async () => {
        let req: Record<string, unknown> = {};
        if (raw.method !== "GET" && raw.method !== "HEAD") {
          try {
            req = (await raw.json()) as Record<string, unknown>;
          } catch {
            return new Response("bad json", { status: 400 });
          }
        }
        const result = handler(req, raw);
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      })();
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost" + path, {
    method: "POST",
    body,
    headers,
  });
}

function ctx(): AbortSignal {
  return new AbortController().signal;
}

// mockExecutor implements AgentExecutor for testing.
class MockExecutor implements AgentExecutor {
  response: string;
  err?: Error;

  constructor(response = "", err?: Error) {
    this.response = response;
    this.err = err;
  }

  executeTask(
    ctx: AbortSignal,
    task: Task,
    _msg: Message,
  ): Promise<AsyncIterable<TaskEvent>> {
    if (this.err !== undefined) return Promise.reject(this.err);
    const response = this.response;
    return Promise.resolve(
      (async function* () {
        void ctx;
        yield {
          task_id: task.id,
          state: taskStateWorking,
          message: {
            role: "agent",
            parts: [{ type: "text", text: response }],
          },
          timestamp: new Date().toISOString(),
        } satisfies TaskEvent;
        yield {
          task_id: task.id,
          state: taskStateCompleted,
          artifact: {
            name: "response",
            parts: [{ type: "text", text: response }],
          },
          timestamp: new Date().toISOString(),
        } satisfies TaskEvent;
      })(),
    );
  }
}

class BlockingExecutor implements AgentExecutor {
  started = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();

  executeTask(
    ctx: AbortSignal,
    task: Task,
    _msg: Message,
  ): Promise<AsyncIterable<TaskEvent>> {
    const started = this.started;
    const release = this.release;
    return Promise.resolve(
      (async function* () {
        started.resolve();
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => {
            if (ctx.aborted) resolve();
            else {
              ctx.addEventListener("abort", () => resolve(), { once: true });
            }
          }),
        ]);
        if (ctx.aborted) return;
        yield {
          task_id: task.id,
          state: taskStateCompleted,
          timestamp: new Date().toISOString(),
        } satisfies TaskEvent;
      })(),
    );
  }
}

class CancelAwareExecutor implements AgentExecutor {
  started = Promise.withResolvers<void>();
  canceled = Promise.withResolvers<void>();

  executeTask(
    ctx: AbortSignal,
    task: Task,
    _msg: Message,
  ): Promise<AsyncIterable<TaskEvent>> {
    const started = this.started;
    const canceled = this.canceled;
    return Promise.resolve(
      (async function* () {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (ctx.aborted) resolve();
          else ctx.addEventListener("abort", () => resolve(), { once: true });
        });
        canceled.resolve();
        yield {
          task_id: task.id,
          state: taskStateFailed,
          error: { code: -32000, message: "aborted" },
          timestamp: new Date().toISOString(),
        } satisfies TaskEvent;
      })(),
    );
  }
}

Deno.test("DefaultConfig", () => {
  const cfg = defaultConfig();
  assertEquals(cfg.port, 8093);
  assertEquals(cfg.host, "127.0.0.1");
  assert(!cfg.enabled);
});

Deno.test("GetListenAddr", () => {
  const cfg = { enabled: false, host: "127.0.0.1", port: 9090 };
  assertEquals(getListenAddr(cfg), "127.0.0.1:9090");
});

Deno.test("GetWorkDir", () => {
  assertEquals(
    getWorkDir({ enabled: false, host: "h", port: 1, work_dir: "/tmp/test" }),
    "/tmp/test",
  );
  const wd = getWorkDir({ enabled: false, host: "h", port: 1 });
  assert(wd !== "");
});

Deno.test("TaskStore", () => {
  const store = newTaskStore();

  const task = store.create("task_1");
  assertEquals(task.id, "task_1");
  assertEquals(task.state, taskStateSubmitted);

  const got = store.get("task_1");
  assert(got !== undefined);
  assertEquals(got!.id, "task_1");
  assertStrictEquals(store.get("nonexistent"), undefined);

  store.setState("task_1", taskStateWorking);
  assertEquals(store.get("task_1")!.state, taskStateWorking);

  const updated = store.get("task_1")!;
  updated.state = taskStateCompleted;
  store.update(updated);
  assertEquals(store.get("task_1")!.state, taskStateCompleted);
});

Deno.test("TaskStoreGetReturnsCopy", () => {
  const store = newTaskStore();
  const task = store.create("task_1");
  task.state = taskStateCompleted;
  task.message = {
    role: "user",
    parts: [{ type: "text", text: "original" }],
  };
  task.metadata = { k: "v" };
  store.update(task);

  const got = store.get("task_1")!;
  got.state = taskStateFailed;
  got.message!.parts[0].text = "mutated";
  got.metadata!["k"] = "mutated";

  const again = store.get("task_1")!;
  assertEquals(again.state, taskStateCompleted);
  assertEquals(again.message!.parts[0].text, "original");
  assertEquals(again.metadata!["k"], "v");
});

Deno.test("HandlerCancelStopsExecutionAndPreservesTerminalState", async () => {
  const executor = new CancelAwareExecutor();
  const handler = newHandler(executor);
  handler.getTaskStore().create("cancel-task");

  const request = post(
    "/a2a",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        task_id: "cancel-task",
        message: { role: "user", parts: [{ type: "text", text: "work" }] },
      },
      id: 1,
    }),
    { "Content-Type": "application/json" },
  );

  const done = handler.serveHTTP(request).catch(() => undefined);
  await executor.started.promise;
  handler.handleCancelTask({
    jsonrpc: "2.0",
    params: { task_id: "cancel-task" },
    id: 2,
  });
  await executor.canceled.promise;
  await done;
  assertEquals(
    handler.getTaskStore().get("cancel-task")!.state,
    taskStateCanceled,
  );
});

Deno.test("NewTaskIDConcurrentUnique", async () => {
  const count = 500;
  const ids = await Promise.all(
    Array.from({ length: count }, () => Promise.resolve(newTaskID())),
  );
  const seen = new Set<string>();
  for (const id of ids) {
    assert(!seen.has(id), `duplicate id: ${id}`);
    seen.add(id);
  }
});

Deno.test("TaskStateTransitions", () => {
  const states = [
    taskStateSubmitted,
    taskStateWorking,
    taskStateCompleted,
    taskStateFailed,
    taskStateCanceled,
  ];
  for (const state of states) {
    assert(state !== "");
  }
});

Deno.test("DefaultAgentCard", () => {
  const card = defaultAgentCard("0.1.27", "http://localhost:8093");
  assertEquals(card.name, "VibeCoding");
  assertEquals(card.version, "0.1.27");
  assertEquals(card.url, "http://localhost:8093/a2a");
  assert(card.capabilities.streaming);
  assertEquals(card.skills.length, 3);
});

Deno.test("HandleAgentCard", async () => {
  const card = defaultAgentCard("0.1.27", "http://localhost:8093");
  const handler = handleAgentCard(card);

  const res = handler(
    new Request("http://localhost/.well-known/agent.json"),
  );
  assertEquals(res.status, 200);
  const got = await res.json();
  assertEquals(got.name, "VibeCoding");

  const res2 = handler(
    new Request("http://localhost/.well-known/agent.json", { method: "POST" }),
  );
  assertEquals(res2.status, 405);
});

Deno.test("ServerAuthProtectsA2AEndpoints", async () => {
  const srv = newServer(
    { enabled: true, host: "127.0.0.1", port: 8093, auth_token: "secret" },
    "0.1.27",
    new MockExecutor("ok"),
  );

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "message/send",
    params: {
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    },
    id: 1,
  });

  const cases = [
    { name: "missing", auth: "", status: 401 },
    { name: "invalid", auth: "Bearer wrong", status: 401 },
    { name: "valid", auth: "Bearer secret", status: 200 },
  ];
  for (const tc of cases) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (tc.auth !== "") headers["Authorization"] = tc.auth;
    const res = await srv.handleRequest(post("/a2a", body, headers));
    assertEquals(res.status, tc.status, tc.name);
  }
});

Deno.test("ServerAuthLeavesAgentCardPublic", async () => {
  const srv = newServer(
    { enabled: true, host: "127.0.0.1", port: 8093, auth_token: "secret" },
    "0.1.27",
    new MockExecutor(),
  );
  const res = await srv.handleRequest(
    new Request("http://localhost/.well-known/agent.json"),
  );
  assertEquals(res.status, 200);
});

Deno.test("HandlerMessageSend", async () => {
  const handler = newHandler(new MockExecutor("Hello from agent"));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "message/send",
    params: {
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    },
    id: 1,
  });
  const res = await handler.serveHTTP(
    post("/a2a", body, { "Content-Type": "application/json" }),
  );
  assertEquals(res.status, 200);
  const resp = await res.json();
  assert(resp.error === undefined);
  assertEquals(resp.jsonrpc, "2.0");
});

Deno.test("HandlerMessageSendPersistsWorkingMessage", async () => {
  const executor = new BlockingExecutor();
  const handler = newHandler(executor);
  handler.getTaskStore().create("persist_task");

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "message/send",
    params: {
      task_id: "persist_task",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    },
    id: 1,
  });
  const done = handler.serveHTTP(
    post("/a2a", body, { "Content-Type": "application/json" }),
  );

  await executor.started.promise;
  const task = handler.getTaskStore().get("persist_task")!;
  assertEquals(task.state, taskStateWorking);
  assert(task.message !== undefined);
  assertEquals(task.message!.parts[0].text, "hello");

  executor.release.resolve();
  await done;
});

Deno.test("HandlerGetTask", async () => {
  const handler = newHandler(new MockExecutor("done"));
  const task = handler.getTaskStore().create("test_task");
  task.state = taskStateCompleted;
  handler.getTaskStore().update(task);

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "task/get",
    params: { task_id: "test_task" },
    id: 2,
  });
  const res = await handler.serveHTTP(
    post("/a2a", body, { "Content-Type": "application/json" }),
  );
  assertEquals(res.status, 200);
  const resp = await res.json();
  assert(resp.error === undefined);
});

Deno.test("HandlerCancelTask", async () => {
  const handler = newHandler(new MockExecutor("done"));
  const task = handler.getTaskStore().create("cancel_task");
  task.state = taskStateWorking;
  handler.getTaskStore().update(task);

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "task/cancel",
    params: { task_id: "cancel_task" },
    id: 3,
  });
  const res = await handler.serveHTTP(
    post("/a2a", body, { "Content-Type": "application/json" }),
  );
  assertEquals(res.status, 200);
  assertEquals(
    handler.getTaskStore().get("cancel_task")!.state,
    taskStateCanceled,
  );
});

Deno.test("HandlerInvalidJSON", async () => {
  const handler = newHandler(new MockExecutor());
  const res = await handler.serveHTTP(
    post("/a2a", "not json", { "Content-Type": "application/json" }),
  );
  assertEquals(res.status, 200);
  const resp = await res.json();
  assert(resp.error !== undefined);
  assertEquals(resp.error.code, -32700);
});

Deno.test("HandlerInvalidMethod", async () => {
  const handler = newHandler(new MockExecutor());
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "unknown/method",
    id: 1,
  });
  const res = await handler.serveHTTP(
    post("/a2a", body, { "Content-Type": "application/json" }),
  );
  const resp = await res.json();
  assert(resp.error !== undefined);
  assertEquals(resp.error.code, -32601);
});

Deno.test("HandlerInvalidJSONRPCVersion", async () => {
  const handler = newHandler(new MockExecutor());
  const body = JSON.stringify({
    jsonrpc: "1.0",
    method: "message/send",
    id: 1,
  });
  const res = await handler.serveHTTP(
    post("/a2a", body, { "Content-Type": "application/json" }),
  );
  const resp = await res.json();
  assert(resp.error !== undefined);
  assertEquals(resp.error.code, -32600);
});

Deno.test("HandlerMethodNotAllowed", async () => {
  const handler = newHandler(new MockExecutor());
  const res = await handler.serveHTTP(
    new Request("http://localhost/a2a", { method: "GET" }),
  );
  assertEquals(res.status, 405);
});

Deno.test("SubscribeUnsubscribe", async () => {
  const handler = newHandler(new MockExecutor());
  const q: EventQueue = handler.subscribe("task_1");
  assert(q !== undefined);

  handler.broadcast("task_1", {
    task_id: "task_1",
    state: taskStateWorking,
    timestamp: new Date().toISOString(),
  });

  const ev = await q.next();
  assert(ev !== undefined);
  assertEquals(ev!.task_id, "task_1");

  handler.unsubscribe("task_1", q);
});

Deno.test("ClientSendMessage", async () => {
  const server = startJSONServer((req) => {
    return {
      jsonrpc: "2.0",
      result: {
        id: "task_123",
        state: taskStateCompleted,
        artifacts: [
          { name: "response", parts: [{ type: "text", text: "Hello!" }] },
        ],
      },
      id: req.id,
    };
  });
  try {
    const client = newClient(server.url, "");
    const task = await client.sendMessage(ctx(), "", {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    assertEquals(task.id, "task_123");
    assertEquals(task.state, taskStateCompleted);
  } finally {
    await server.close();
  }
});

Deno.test("ClientGetAgentCard", async () => {
  const card = defaultAgentCard("0.1.27", "http://localhost:8093");
  const server = startJSONServer(() => card);
  try {
    const client = newClient(server.url, "");
    const got = await client.getAgentCard(ctx());
    assertEquals(got.name, "VibeCoding");
  } finally {
    await server.close();
  }
});

Deno.test("ClientError", async () => {
  const server = startJSONServer(() => {
    return {
      jsonrpc: "2.0",
      error: { code: -32000, message: "task not found" },
      id: 1,
    };
  });
  try {
    const client = newClient(server.url, "");
    let threw = false;
    try {
      await client.sendMessage(ctx(), "", {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      });
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes("task not found"));
    }
    assert(threw);
  } finally {
    await server.close();
  }
});

Deno.test("ClientWithAuth", async () => {
  let gotToken = "";
  const server = startJSONServer((_req, raw) => {
    gotToken = raw.headers.get("Authorization") ?? "";
    return {
      jsonrpc: "2.0",
      result: { id: "t1", state: taskStateCompleted },
      id: 1,
    };
  });
  try {
    const client = newClient(server.url, "test-token");
    await client.sendMessage(ctx(), "", {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    assertEquals(gotToken, "Bearer test-token");
  } finally {
    await server.close();
  }
});
