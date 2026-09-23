//
// A standard stdio MCP server. Protocol framing, initialize and tool dispatch
// live here so domain packages provide handlers instead of their own JSON-RPC
// loop.

import {
  mcpProtocolVersion,
  parseRPCMessage,
  type RPCRequest,
  serverError,
  serverResult,
} from "./rpc.ts";

/** A tool exposed by a local MCP server. Mirrors the MCP tools/list contract. */
export interface ServerTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** One MCP tool-result content block. */
export interface ServerContent {
  type: string;
  text?: string;
}

/** The response payload of tools/call. */
export interface ServerToolResult {
  content?: ServerContent[];
  isError?: boolean;
}

/**
 * Supplies domain behavior for a standard stdio MCP server. Protocol framing,
 * initialize and tool dispatch remain in this module.
 */
export interface ServerHandler {
  listTools(signal: AbortSignal): ServerTool[] | Promise<ServerTool[]>;
  callTool(
    signal: AbortSignal,
    name: string,
    args: unknown,
  ): ServerToolResult | Promise<ServerToolResult>;
}

/** Reads newline-delimited JSON messages from a byte stream. */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Serves the MCP stdio transport until input closes or `signal` is aborted. It
 * supports initialize, tools/list and tools/call; optional resources/prompts
 * are reported as unsupported.
 */
export async function serveStdio(
  signal: AbortSignal,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  handler: ServerHandler,
): Promise<void> {
  if (!handler) throw new Error("MCP server handler is required");
  const writer = output.getWriter();
  let writeChain: Promise<void> = Promise.resolve();
  const write = (value: unknown): Promise<void> => {
    const data = new TextEncoder().encode(JSON.stringify(value) + "\n");
    writeChain = writeChain.then(() => writer.write(data));
    return writeChain;
  };

  for await (const line of readLines(input)) {
    if (signal.aborted) throw signal.reason;
    const request = parseRPCMessage(line);
    if (request === undefined) {
      await write(serverError(null, -32700, "parse error"));
      continue;
    }
    if ((request.method ?? "").trim() === "") {
      if ("id" in request && request.id !== undefined) {
        await write(serverError(request.id, -32600, "invalid request"));
      }
      continue;
    }
    if (!("id" in request) || request.id === undefined) {
      // Notifications, including notifications/initialized, need no reply.
      continue;
    }
    await write(await serveRequest(signal, handler, request));
  }
  await writeChain;
}

async function serveRequest(
  signal: AbortSignal,
  handler: ServerHandler,
  request: RPCRequest,
): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return serverResult(request.id, {
        protocolVersion: mcpProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "opensac-knowledge", version: "dev" },
      });
    case "tools/list": {
      let tools: ServerTool[];
      try {
        tools = await handler.listTools(signal);
      } catch (err) {
        return serverError(request.id, -32000, (err as Error).message);
      }
      return serverResult(request.id, { tools });
    }
    case "tools/call": {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: unknown;
      };
      if (
        typeof request.params !== "object" ||
        request.params === null ||
        (params.name ?? "").trim() === ""
      ) {
        return serverError(
          request.id,
          -32602,
          "tools/call requires a tool name",
        );
      }
      let args = params.arguments;
      if (args === undefined || args === null) args = {};
      let result: ServerToolResult;
      try {
        result = await handler.callTool(signal, params.name!.trim(), args);
      } catch (err) {
        result = {
          isError: true,
          content: [{ type: "text", text: (err as Error).message }],
        };
      }
      return serverResult(request.id, result);
    }
    default:
      return serverError(request.id, -32601, "method not found");
  }
}
