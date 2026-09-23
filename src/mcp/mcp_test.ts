import { assert, assertEquals } from "@std/assert";
import { RPCError } from "./rpc.ts";
import {
  type Callbacks,
  classifyMCPBlock,
  Client,
  connectServers,
  extractSamplingPrompt,
  isMCPMethodNotFound,
  mcpContentToText,
  parseSSECallResponse,
  sanitizeToolName,
  uniqueToolName,
} from "./mcp.ts";
import { createRegistry } from "../tools/mod.ts";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function collector(): {
  stream: WritableStream<Uint8Array>;
  text: () => string;
} {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return {
    stream,
    text: () => {
      let len = 0;
      for (const c of chunks) len += c.length;
      const out = new Uint8Array(len);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return new TextDecoder().decode(out);
    },
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("uniqueToolName", () => {
  const existing = new Set(["mcp_a_b", "mcp_a_b_2"]);
  assertEquals(uniqueToolName("mcp_a_b", existing), "mcp_a_b_3");
});

Deno.test("sanitizeToolName", () => {
  assertEquals(sanitizeToolName("a/b c"), "a_b_c");
  assertEquals(sanitizeToolName("///"), "tool");
});

Deno.test("mcpContentToText", () => {
  const out = mcpContentToText([
    { type: "text", text: "hello" },
    { type: "json", json: { k: "v" } },
    { type: "image", mimeType: "image/png" },
  ]);
  assertEquals(out, 'hello\n{"k":"v"}\n[image content: image/png]');
});

Deno.test("readLoop responds to ping", async () => {
  const out = collector();
  const client = new Client("test", "stdio", {});
  client.stdinWriter = out.stream.getWriter();
  await client.readLoop(
    streamFrom('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'),
  );
  await delay(20);
  assert(out.text().includes('"id":1'), `got ${out.text()}`);
  assert(out.text().includes('"result":{}'), `got ${out.text()}`);
});

Deno.test("readLoop response not blocked by sampling", async () => {
  const out = collector();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const client = new Client("test", "stdio", {});
  client.stdinWriter = out.stream.getWriter();
  client.callbacks = {
    onSamplingCreateMessage: async () => {
      await gate;
      return { result: { model: "test" } };
    },
  };
  let received: unknown;
  client.pending.set("2", {
    resolve: (r) => {
      received = r;
    },
  });

  await client.readLoop(
    streamFrom(
      `{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage","params":{}}\n` +
        `{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n`,
    ),
  );
  assert(
    received !== undefined &&
      (received as { error?: unknown }).error === undefined,
    "ordinary response was blocked by the sampling callback",
  );
  assertEquals((received as { result: unknown }).result, { ok: true });
  release();
});

Deno.test("parseSSECallResponse requires matching id", async () => {
  const stream = streamFrom(
    'data: {"jsonrpc":"2.0","result":{"wrong":true}}\n\n' +
      'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
  );
  const result = await parseSSECallResponse(stream, 7);
  assertEquals(result, { ok: true });
});

Deno.test("isMCPMethodNotFound", () => {
  assert(isMCPMethodNotFound(new RPCError(-32601, "method not found")));
  assert(!isMCPMethodNotFound(new RPCError(-32000, "server failed")));
  assert(!isMCPMethodNotFound(new Error("method not found")));
});

Deno.test("MCP SSE rejects invalid message URL", async () => {
  const registry = createRegistry(Deno.makeTempDirSync(), undefined);
  let threw = false;
  try {
    await connectServers(
      new AbortController().signal,
      [{
        name: "invalid-sse",
        type: "sse",
        url: "http://127.0.0.1/events",
        messageUrl: "file:///tmp/messages",
      }],
      registry,
      {},
    );
  } catch (err) {
    threw = true;
    assert(
      (err as Error).message.includes("messageUrl must be a valid http(s) URL"),
      (err as Error).message,
    );
  }
  assert(threw, "expected an invalid message URL error");
});

Deno.test("handleInboundNotification no panic", () => {
  const c = new Client("srv", "stdio", {});
  c.handleInboundNotification({ method: "notifications/progress" });
  c.handleInboundNotification({ method: "logging/message" });
  c.handleInboundNotification({ method: "notifications/cancelled" });
  c.handleInboundNotification({ method: "notifications/unknown" });
});

Deno.test("extractSamplingPrompt", () => {
  const raw = {
    messages: [
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "text", text: "world" }] },
    ],
  };
  assertEquals(extractSamplingPrompt(raw), "hello\nworld");
});

Deno.test("classifyMCPBlock", () => {
  const cases: Array<{
    name: string;
    block: Record<string, unknown>;
    kind: string;
    mime: string;
  }> = [
    {
      name: "text block",
      block: { type: "text", text: "hi" },
      kind: "text",
      mime: "",
    },
    {
      name: "json block",
      block: { type: "json", json: {} },
      kind: "json",
      mime: "",
    },
    {
      name: "audio block",
      block: { type: "audio", mimeType: "audio/wav" },
      kind: "audio",
      mime: "audio/wav",
    },
    {
      name: "typed image uses data",
      block: { type: "image", data: "AAA", mimeType: "image/png" },
      kind: "image",
      mime: "image/png",
    },
    {
      name: "resource blob image",
      block: { blob: "AAA", mimeType: "image/png" },
      kind: "image",
      mime: "image/png",
    },
    {
      name: "resource blob non-image",
      block: { blob: "AAA", mimeType: "application/pdf" },
      kind: "blob",
      mime: "application/pdf",
    },
    {
      name: "resource text has no type",
      block: { text: "hello", mimeType: "text/plain" },
      kind: "text",
      mime: "text/plain",
    },
    {
      name: "untyped data is an image",
      block: { data: "AAA", mimeType: "image/png" },
      kind: "image",
      mime: "image/png",
    },
  ];
  for (const tc of cases) {
    const [kind, , mime] = classifyMCPBlock(tc.block);
    assertEquals(kind, tc.kind, tc.name);
    assertEquals(mime, tc.mime, tc.name);
  }
});

// A deterministic 1x1 PNG generated at test time (no external server or
// display required). The Go tests embed a fixture PNG that the npm image codec
// used by this port cannot decode, so the equivalent image is produced here.
import { Image } from "imagescript";
import { encodeBase64 } from "@std/encoding/base64";

async function makeTestPNG(): Promise<Uint8Array> {
  const img = new Image(1, 1);
  img.bitmap[0] = 10;
  img.bitmap[1] = 20;
  img.bitmap[2] = 30;
  img.bitmap[3] = 255;
  return await img.encode();
}

const mcpTestPNG = await makeTestPNG();
const mcpTestPNGBase64 = encodeBase64(mcpTestPNG);

Deno.test("MCP resource read result decodes blob", () => {
  const raw =
    `{"contents":[{"uri":"shot://1","mimeType":"image/png","blob":"${mcpTestPNGBase64}"}]}`;
  const out = JSON.parse(raw);
  assertEquals(out.contents.length, 1);
  assertEquals(out.contents[0].blob, mcpTestPNGBase64);
  assertEquals(out.contents[0].uri, "shot://1");
});

Deno.test("projectMCPContent projects image", async () => {
  const client = new Client("srv", "stdio", {});
  const { text, contents } = await client.projectMCPContent([
    { type: "text", text: '{"image_width":1464}' },
    { type: "image", data: mcpTestPNGBase64, mimeType: "image/png" },
  ]);
  assert(text.includes("image_width"), text);
  assert(text.includes("1x1"), text);
  assertEquals(contents?.length, 2);
  assertEquals(contents![0].type, "text");
  const image = contents![1];
  assertEquals(image.type, "image");
  assertEquals(image.image?.mimeType, "image/png");
  assertEquals(image.image?.width, 1);
  assertEquals(image.image?.height, 1);
  assert(image.image?.data, "projected image must carry a payload");
});

Deno.test("projectMCPContent keeps text-only shape", async () => {
  const client = new Client("srv", "stdio", {});
  const { text, contents } = await client.projectMCPContent([
    { type: "text", text: "hello" },
    { type: "json", json: { k: "v" } },
  ]);
  assertEquals(text, 'hello\n{"k":"v"}');
  assertEquals(contents, undefined);
});

Deno.test("projectMCPContent keeps audio placeholder", async () => {
  const client = new Client("srv", "stdio", {});
  const { text, contents } = await client.projectMCPContent([
    { type: "audio", mimeType: "audio/wav" },
  ]);
  assertEquals(text, "[audio content: audio/wav]");
  assertEquals(contents, undefined);
});

Deno.test("projectMCPContent degrades invalid payloads", async () => {
  const client = new Client("srv", "stdio", {});
  const notAnImage = btoa("not an image");
  const { text, contents } = await client.projectMCPContent([
    { type: "image", mimeType: "image/png" },
    { type: "image", data: "not-base64!!", mimeType: "image/png" },
    { type: "image", data: notAnImage, mimeType: "image/png" },
  ]);
  assertEquals(contents, undefined);
  for (const want of ["empty payload", "invalid base64 payload", "omitted"]) {
    assert(
      text.includes(want),
      `degradation note ${want} missing from ${text}`,
    );
  }
});

Deno.test("projectMCPContent caps image count", async () => {
  const client = new Client("srv", "stdio", {});
  const blocks = [];
  for (let i = 0; i < 6; i++) {
    blocks.push({
      type: "image",
      data: mcpTestPNGBase64,
      mimeType: "image/png",
    });
  }
  const { contents } = await client.projectMCPContent(blocks);
  const images = (contents ?? []).filter((b) => b.type === "image").length;
  assertEquals(images, 4);
  const { text } = await client.projectMCPContent(blocks);
  assert(text.includes("at most 4 images per tool result"), text);
});

Deno.test("projectMCPContent projects resource blob", async () => {
  const client = new Client("srv", "stdio", {});
  const { text, contents } = await client.projectMCPContent([
    { mimeType: "text/plain", text: "plain resource body" },
    { uri: "shot://1", mimeType: "image/png", blob: mcpTestPNGBase64 },
  ]);
  assert(text.includes("plain resource body"), text);
  assert(!text.includes('"type":""'), text);
  assertEquals(contents?.length, 2);
  assertEquals(contents![1].type, "image");
});

Deno.test("client image policy uses late binding", async () => {
  const client = new Client("srv", "stdio", {});
  let seen = "";
  client.imagePolicy = (mode) => {
    seen = mode;
    return { mode, maxLongEdge: 1, maxOutputBytes: 1 << 20 };
  };
  await client.projectMCPContent([
    { type: "image", data: mcpTestPNGBase64, mimeType: "image/png" },
  ]);
  assertEquals(seen, "auto");
});

Deno.test("client image policy falls back to defaults", () => {
  const client = new Client("srv", "stdio", {});
  assertEquals(client.imagePolicyFor("auto").mode, "auto");
});

// Keep the Callbacks type imported for parity coverage.
const _callbacks: Callbacks = {};
void _callbacks;
