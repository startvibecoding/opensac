// Translated from internal/mcp/server_test.go

import { assert, assertEquals } from "@std/assert";
import { type ServerHandler, type ServerTool, serveStdio } from "./server.ts";

const fixture: ServerHandler = {
  listTools(_signal: AbortSignal): ServerTool[] {
    return [{ name: "lookup", inputSchema: { type: "object" } }];
  },
  callTool(_signal, name, args) {
    return {
      content: [{ type: "text", text: name + ":" + JSON.stringify(args) }],
    };
  },
};

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function collectingStream(): {
  stream: WritableStream<Uint8Array>;
  text: () => string;
} {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  const text = () => {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(out);
  };
  return { stream, text };
}

Deno.test("serveStdio dispatches standard tool methods", async () => {
  const input = streamFrom(
    `{"jsonrpc":"2.0","id":1,"method":"initialize"}\n` +
      `{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n` +
      `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup","arguments":{"query":"runtime"}}}\n`,
  );
  const out = collectingStream();
  await serveStdio(new AbortController().signal, input, out.stream, fixture);
  const lines = out.text().trim().split("\n");
  assertEquals(lines.length, 3);
  const initialized = JSON.parse(lines[0]);
  assert(
    initialized.result.capabilities.tools !== undefined,
    "initialize response must advertise the tools capability",
  );
  assert(lines[1].includes("lookup"));
  assert(lines[2].includes("lookup"));
  assert(lines[2].includes("runtime"));
});
