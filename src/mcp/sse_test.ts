//
// The legacy HTTP+SSE transport maps `httptest` + `http.Flusher` to a
// `runtime.serve` response backed by a manually-driven `ReadableStream`.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { createNoneSandbox } from "../sandbox/mod.ts";
import { createRegistry, type Tool } from "../tools/mod.ts";
import { type RPCRequest } from "./rpc.ts";
import { closeClients, connectServers } from "./mcp.ts";
import { test } from "#testing";

type Handler = (req: RPCRequest, raw: Request) => unknown | Promise<unknown>;

interface RawServer {
  url: string;
  close: () => Promise<void>;
}

async function startJSONServer(handler: Handler): Promise<RawServer> {
  const ac = new AbortController();
  let port = 0;
  let resolvePort!: () => void;
  const portReady = new Promise<void>((resolve) => {
    resolvePort = resolve;
  });
  const server = runtime.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: ac.signal,
      onListen: (address) => {
        port = address.port;
        resolvePort();
      },
    },
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
  await portReady;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

const encoder = new TextEncoder();

function ok(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

test("MCP server SSE call flow", async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const streamReady = Promise.withResolvers<void>();
  const messageReqs: RPCRequest[] = [];

  const streamAC = new AbortController();
  let streamPort = 0;
  let resolveStreamPort!: () => void;
  const streamPortReady = new Promise<void>((resolve) => {
    resolveStreamPort = resolve;
  });
  const streamServer = runtime.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: streamAC.signal,
      onListen: (address) => {
        streamPort = address.port;
        resolveStreamPort();
      },
    },
    (raw) => {
      if (raw.method !== "GET") return new Response("no", { status: 405 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          streamReady.resolve();
        },
        cancel() {
          streamController = undefined;
        },
      });
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Mcp-Session-Id": "sse-sid",
        },
      });
    },
  );
  await streamPortReady;
  const streamURL = `http://127.0.0.1:${streamPort}`;

  const writeSSE = (v: unknown) => {
    if (!streamController) return;
    try {
      streamController.enqueue(
        encoder.encode(`data: ${JSON.stringify(v)}\n\n`),
      );
    } catch {
      // stream already closed
    }
  };

  const messageServer = await startJSONServer((req) => {
    messageReqs.push(req);
    switch (req.method) {
      case "initialize":
        return ok(req.id, { protocolVersion: "2025-11-25" });
      case "notifications/initialized":
        return ok(req.id, {});
      case "tools/list":
        return ok(req.id, {
          tools: [
            {
              name: "echo",
              description: "sse echo",
              inputSchema: { type: "object" },
            },
          ],
        });
      case "resources/list":
        return ok(req.id, { resources: [] });
      case "prompts/list":
        return ok(req.id, { prompts: [] });
      case "tools/call":
        writeSSE(ok(req.id, { content: [{ type: "text", text: "sse-ok" }] }));
        return new Response(null, { status: 202 });
      default:
        return ok(req.id, {});
    }
  });

  const registry = createRegistry(
    runtime.makeTempDirSync(),
    createNoneSandbox(),
  );
  registry.registerDefaults();
  let clients;
  try {
    clients = await connectServers(
      new AbortController().signal,
      [
        {
          name: "sse-server",
          type: "sse",
          url: streamURL,
          messageUrl: messageServer.url,
        },
      ],
      registry,
      {},
    );
    await streamReady.promise;

    const echoTool = registry
      .all()
      .find((t: Tool) => t.name().includes("_echo"));
    assert(echoTool, "expected sse echo tool registration");
    const out = await echoTool!.execute({}, {});
    assert(out.text.includes("sse-ok"), out.text);
    assert(messageReqs.length > 0, "expected posts to messageUrl");
    assertEquals(clients[0].currentSessionID(), "sse-sid");
  } finally {
    if (clients) closeClients(clients);
    streamAC.abort();
    await streamServer.finished;
    await messageServer.close();
  }
});

test("MCP server SSE notification callback", async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const streamReady = Promise.withResolvers<void>();
  const gotMethods: string[] = [];

  const streamAC = new AbortController();
  let streamPort = 0;
  let resolveStreamPort!: () => void;
  const streamPortReady = new Promise<void>((resolve) => {
    resolveStreamPort = resolve;
  });
  const streamServer = runtime.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: streamAC.signal,
      onListen: (address) => {
        streamPort = address.port;
        resolveStreamPort();
      },
    },
    (raw) => {
      if (raw.method !== "GET") return new Response("no", { status: 405 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          streamReady.resolve();
        },
        cancel() {
          streamController = undefined;
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  );
  await streamPortReady;
  const streamURL = `http://127.0.0.1:${streamPort}`;

  const messageServer = await startJSONServer((req) => {
    switch (req.method) {
      case "initialize":
        return ok(req.id, { protocolVersion: "2025-11-25" });
      case "tools/list":
        return ok(req.id, { tools: [] });
      case "resources/list":
        return ok(req.id, { resources: [] });
      case "prompts/list":
        return ok(req.id, { prompts: [] });
      default:
        return ok(req.id, {});
    }
  });

  const registry = createRegistry(
    runtime.makeTempDirSync(),
    createNoneSandbox(),
  );
  registry.registerDefaults();
  let clients;
  try {
    clients = await connectServers(
      new AbortController().signal,
      [
        {
          name: "notify-sse",
          type: "sse",
          url: streamURL,
          messageUrl: messageServer.url,
        },
      ],
      registry,
      {
        onNotification: (_serverName, method) => {
          gotMethods.push(method);
        },
      },
    );
    await streamReady.promise;

    streamController!.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: 0.5 },
        })}\n\n`,
      ),
    );

    const deadline = Date.now() + 2000;
    while (gotMethods.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(gotMethods.length > 0, "timeout waiting notification callback");
    assertEquals(gotMethods[0], "notifications/progress");
  } finally {
    if (clients) closeClients(clients);
    streamAC.abort();
    await streamServer.finished;
    await messageServer.close();
  }
});
