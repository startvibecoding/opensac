// Translated from internal/agentruntime/knowledge_mcp_test.go.
//
// Go's `TestKnowledgeMCPConnectsAsStandardTool` spawns a subprocess MCP server
// and connects a real stdio client. This port drives the same standard stdio
// protocol path in-process through `serveStdio` with in-memory streams, which
// exercises the identical JSON-RPC framing and tool dispatch without a second
// Deno process. `TestKnowledgeMCPHandlerReturnsBoundedCitedSnapshotEvidence`
// is translated directly.

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { mcpProtocolVersion } from "../mcp/rpc.ts";
import { serveStdio } from "../mcp/server.ts";
import { createKnowledgeBase } from "../session/mod.ts";
import { KnowledgeMCPHandler, knowledgeMCPToolName } from "./knowledge_mcp.ts";
import {
  defaultKnowledgeBaseIndexPolicy,
  newKnowledgeBaseService,
} from "./knowledgebase.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
}

function writeFile(root: string, relative: string, body: string): void {
  const full = path.join(root, relative);
  Deno.mkdirSync(path.dirname(full), { recursive: true });
  Deno.writeTextFileSync(full, body);
}

async function prepareIndexedBase(): Promise<{
  sessionDir: string;
  baseID: string;
}> {
  const sessionDir = tempDir();
  const source = tempDir();
  writeFile(
    source,
    "runtime.md",
    "# Runtime\n\nThe Runtime owns durable Runs.\n",
  );
  const base = createKnowledgeBase(sessionDir, {
    name: "Runtime",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "test",
    model: "test-model",
    mode: "yolo",
    schedule: "manual",
    enabled: true,
  });
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  await service.index(undefined, base.id);
  return { sessionDir, baseID: base.id };
}

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

Deno.test("knowledge MCP connects as standard tool", async () => {
  const { sessionDir, baseID } = await prepareIndexedBase();
  const handler = KnowledgeMCPHandler.create(sessionDir, [baseID]);
  const input = streamFrom(
    `{"jsonrpc":"2.0","id":1,"method":"initialize"}\n` +
      `{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n` +
      `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"${knowledgeMCPToolName}","arguments":{"knowledgeBaseId":"${baseID}","query":"durable runtime"}}}\n`,
  );
  const out = collectingStream();
  await serveStdio(
    new AbortController().signal,
    input,
    out.stream,
    handler,
  );
  const lines = out.text().trim().split("\n");
  assertEquals(lines.length, 3);
  const initialized = JSON.parse(lines[0]);
  assertEquals(initialized.result.protocolVersion, mcpProtocolVersion);
  assert(initialized.result.capabilities.tools !== undefined);
  assert(lines[1].includes(knowledgeMCPToolName));
  for (const want of ["runtime.md", "chunkId", "snapshotId"]) {
    assert(
      lines[2].includes(want),
      `MCP tool result missing ${JSON.stringify(want)}`,
    );
  }
});

Deno.test(
  "knowledge MCP handler returns bounded cited snapshot evidence",
  async () => {
    const { sessionDir, baseID } = await prepareIndexedBase();
    const handler = KnowledgeMCPHandler.create(sessionDir, [baseID]);

    const tools = handler.listTools(new AbortController().signal);
    assertEquals(tools.length, 1);
    assertEquals(tools[0].name, knowledgeMCPToolName);

    const result = handler.callTool(
      new AbortController().signal,
      knowledgeMCPToolName,
      { knowledgeBaseId: baseID, query: "durable runtime" },
    );
    assertEquals(result.content?.length, 1);
    const text = result.content?.[0]?.text ?? "";
    assert(text.includes("runtime.md"));
    assert(text.includes("chunkId"));
    const decoded = JSON.parse(text);
    assertEquals(decoded.knowledgeBaseId, baseID);
    assertEquals(decoded.truncated, false);
    assert(decoded.evidence.length >= 1);
    assertEquals(
      decoded.evidence[0].citations[0].path,
      "runtime.md",
    );

    assertThrows(() =>
      handler.callTool(
        new AbortController().signal,
        knowledgeMCPToolName,
        { knowledgeBaseId: "not-configured", query: "runtime" },
      )
    );

    assertThrows(
      () =>
        handler.callTool(
          new AbortController().signal,
          knowledgeMCPToolName,
          { knowledgeBaseId: baseID, query: "runtime", extra: true },
        ),
      Error,
      "unknown field",
    );
    assertThrows(() =>
      handler.callTool(
        new AbortController().signal,
        "unknown_tool",
        { knowledgeBaseId: baseID, query: "runtime" },
      )
    );
  },
);
