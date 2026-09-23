//
// `net/http/httptest` maps to `Deno.serve` on an ephemeral localhost port.

import { assert, assertEquals } from "@std/assert";
import { createNoneSandbox } from "../sandbox/mod.ts";
import { createRegistry, type Tool } from "../tools/mod.ts";
import type { RPCRequest } from "./rpc.ts";
import { type Callbacks, Client, closeClients, connectServers } from "./mcp.ts";

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function startServer(
  handler: (req: RPCRequest, raw: Request) => unknown | Promise<unknown>,
): TestServer {
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal },
    async (raw) => {
      let req: RPCRequest;
      try {
        req = (await raw.json()) as RPCRequest;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const result = await handler(req, raw);
      if (result instanceof Response) return result;
      return Response.json(result);
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

function ok(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

Deno.test("connect MCPServers HTTP registers and executes", async () => {
  let sampled = false;
  let notified = false;

  const srv = startServer((req) => {
    switch (req.method) {
      case "initialize":
        return ok(req.id, { protocolVersion: "2025-11-25" });
      case "notifications/initialized":
        return ok(req.id, {});
      case "tools/list":
        return ok(req.id, {
          tools: [{
            name: "echo",
            description: "echo tool",
            inputSchema: { type: "object" },
          }],
        });
      case "resources/list":
        return ok(req.id, {
          resources: [{ uri: "file://README.md", name: "readme" }],
        });
      case "prompts/list":
        return ok(req.id, {
          prompts: [{ name: "summarize", description: "summarize prompt" }],
        });
      case "tools/call":
        return ok(req.id, { content: [{ type: "text", text: "ok" }] });
      case "resources/read":
        return ok(req.id, {
          contents: [{ type: "text", text: "resource-body" }],
        });
      case "prompts/get":
        return ok(req.id, {
          description: "prompt-desc",
          messages: [{
            role: "user",
            content: { type: "text", text: "prompt-text" },
          }],
        });
      case "sampling/createMessage":
        sampled = true;
        return ok(req.id, { content: [{ type: "text", text: "sampled" }] });
      case "notifications/progress":
        notified = true;
        return ok(req.id, {});
      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: "method not found" },
        };
    }
  });

  const registry = createRegistry(Deno.makeTempDirSync(), createNoneSandbox());
  registry.registerDefaults();

  const callbacks: Callbacks = {
    onNotification: (serverName, method) => {
      if (serverName === "mock-http" && method === "notifications/progress") {
        notified = true;
      }
    },
    onSamplingCreateMessage: (signal, serverName, params) => {
      void signal;
      void params;
      if (serverName !== "mock-http") {
        return { error: undefined, result: undefined };
      }
      sampled = true;
      return { result: { content: [{ type: "text", text: "sampled" }] } };
    },
  };

  let clients;
  try {
    clients = await connectServers(
      new AbortController().signal,
      [{ name: "mock-http", type: "http", url: srv.url }],
      registry,
      callbacks,
    );
    assertEquals(clients.length, 1);

    const tools: Tool[] = registry.all();
    const gotTool = tools.find((t) => t.name().includes("_echo"));
    const gotResource = tools.find((t) => t.name().includes("_resource_"));
    const gotPrompt = tools.find((t) => t.name().includes("_prompt_"));
    assert(
      gotTool && gotResource && gotPrompt,
      "expected tool/resource/prompt",
    );

    await gotTool!.execute({}, {});
    const resOut = await gotResource!.execute({}, {});
    assert(resOut.text.includes("resource-body"), resOut.text);
    const promptOut = await gotPrompt!.execute({}, {});
    assert(promptOut.text.includes("prompt-text"), promptOut.text);

    await clients[0].handleInboundRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "sampling/createMessage",
      params: { messages: [{ role: "user", content: "hi" }] },
    });
    clients[0].handleInboundNotification({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 0.5 },
    });
    assert(sampled, "expected sampling callback to be triggered");
    assert(notified, "expected notification callback to be triggered");
  } finally {
    if (clients) closeClients(clients);
    await srv.close();
  }
});

Deno.test("MCP HTTP session id header round trip", async () => {
  const sid = "sid-123";
  const srv = startServer((req, raw) => {
    const headers: Record<string, string> = {};
    if (!raw.headers.get("Mcp-Session-Id")) headers["Mcp-Session-Id"] = sid;
    return Response.json(ok(req.id, { tools: [] }), { headers });
  });

  const registry = createRegistry(Deno.makeTempDirSync(), createNoneSandbox());
  registry.registerDefaults();
  let clients;
  try {
    clients = await connectServers(
      new AbortController().signal,
      [{ name: "sid-server", type: "http", url: srv.url }],
      registry,
      {},
    );
    assertEquals(clients[0].currentSessionID(), sid);
  } finally {
    if (clients) closeClients(clients);
    await srv.close();
  }
});

Deno.test("MCP HTTP rejects mismatched response id", async () => {
  const srv = startServer(() => {
    // Echo a *string* id, which never matches the numeric request id.
    return { jsonrpc: "2.0", id: "1", result: {} };
  });
  const client = new Client("wrong-id", "http", {});
  client.httpURL = srv.url;
  try {
    let threw = false;
    try {
      await client.callHTTP(
        new AbortController().signal,
        "tools/list",
        undefined,
      );
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("does not match request id"),
        (err as Error).message,
      );
    }
    assert(threw, "expected mismatched response ID error");
  } finally {
    client.close();
    await srv.close();
  }
});

Deno.test("MCP HTTP propagates runtime operation id", async () => {
  const operationID = "tool:stable-mcp-operation";
  let seen = "";
  const srv = startServer((req, raw) => {
    seen = raw.headers.get("Idempotency-Key") ?? "";
    return ok(req.id, {});
  });
  const client = new Client("operation-id", "http", {});
  client.httpURL = srv.url;
  try {
    await client.callHTTP(
      new AbortController().signal,
      "tools/call",
      { name: "write" },
      operationID,
    );
    assertEquals(seen, operationID);
  } finally {
    client.close();
    await srv.close();
  }
});

Deno.test("MCP HTTP close cancels in-flight request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = Promise.withResolvers<void>();
  const srv = startServer(async () => {
    started.resolve();
    await gate;
    return new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new Client("cancel-http", "http", {});
  client.httpURL = srv.url;
  const done = client.callHTTP(
    new AbortController().signal,
    "tools/list",
    undefined,
  ).then(() => "ok", (err: Error) => err.message);
  await started.promise;
  client.close();
  const outcome = await done;
  assert(outcome !== "ok", "in-flight request succeeded after client close");
  release();
  await srv.close();
});

Deno.test("connect MCP servers returns resource discovery error", async () => {
  const srv = startServer((req) => {
    switch (req.method) {
      case "initialize":
        return ok(req.id, { protocolVersion: "2025-11-25" });
      case "tools/list":
        return ok(req.id, { tools: [] });
      case "resources/list":
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "resource backend unavailable" },
        };
      default:
        return ok(req.id, {});
    }
  });
  const registry = createRegistry(Deno.makeTempDirSync(), createNoneSandbox());
  try {
    let threw = false;
    try {
      await connectServers(
        new AbortController().signal,
        [{ name: "discovery-error", type: "http", url: srv.url }],
        registry,
        {},
      );
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("resource backend unavailable"),
        (err as Error).message,
      );
    }
    assert(threw, "expected resource discovery failure");
  } finally {
    await srv.close();
  }
});
