// Translated tests from internal/acp/acp_artifact_test.go and
// internal/acp/acp_mcp_test.go for the ACP prompt/input conversion layer.

import { assertEquals, assertThrows } from "@opensac/assert";
import { encodeBase64 } from "@opensac/encoding/base64";
import { join } from "@opensac/path";
import {
  acpAttachmentKind,
  ACPPromptContentError,
  acpPromptRequestSnapshot,
  encodedACPIngress,
  promptToIngresses,
  promptToRunInput,
  promptToText,
  resolveACPResourcePath,
} from "./input.ts";

Deno.test("promptToIngresses normalizes every declared capability", () => {
  const workspace = Deno.makeTempDirSync();
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngPath = join(workspace, "pixel.png");
  Deno.writeFileSync(pngPath, pngBytes);

  const { text, ingresses } = promptToIngresses(
    [
      { type: "text", text: "describe" },
      { type: "image", mimeType: "image/png", data: encodeBase64(pngBytes) },
      {
        type: "audio",
        mimeType: "audio/wav",
        data: encodeBase64(new TextEncoder().encode("RIFFdata")),
      },
      {
        type: "resource",
        name: "notes.md",
        mimeType: "text/markdown",
        data: encodeBase64(new TextEncoder().encode("# notes")),
      },
      {
        type: "resource_link",
        name: "pixel",
        uri: `file://${pngPath}`,
        mimeType: "image/png",
      },
    ],
    workspace,
    [],
    "acp:caps",
  );

  assertEquals(text, "describe");
  assertEquals(ingresses.length, 4);
  assertEquals(
    ingresses.map((ingress) => ingress.kind),
    ["image", "audio", "file", "image"],
  );
});

Deno.test("promptToIngresses reads a local resource link over Runtime", async () => {
  const workspace = Deno.makeTempDirSync();
  const path = join(workspace, "notes.md");
  Deno.writeFileSync(path, new TextEncoder().encode("hello"));

  const { text, ingresses } = promptToIngresses(
    [
      { type: "text", text: "read this" },
      {
        type: "resource_link",
        name: "notes",
        uri: `file://${path}`,
        mimeType: "text/markdown",
      },
    ],
    workspace,
    [],
    "acp:test",
  );

  assertEquals(text, "read this");
  assertEquals(ingresses.length, 1);
  assertEquals(ingresses[0].kind, "file");
  assertEquals(ingresses[0].origin, "acp");
  const stream = await ingresses[0].open(undefined);
  assertEquals(stream.bytes, new TextEncoder().encode("hello"));
});

Deno.test("promptToIngresses rejects a remote resource URI", () => {
  const workspace = Deno.makeTempDirSync();
  assertThrows(
    () =>
      promptToIngresses(
        [
          {
            type: "resource_link",
            name: "remote",
            uri: "https://example.com/a",
          },
        ],
        workspace,
        [],
        "acp:test",
      ),
    ACPPromptContentError,
  );
});

Deno.test("promptToText rejects non-text and promptToRunInput rejects resources", () => {
  assertThrows(() => promptToText([{ type: "image" }]), ACPPromptContentError);
  assertThrows(
    () =>
      promptToRunInput([
        { type: "text", text: "read this" },
        {
          type: "resource_link",
          name: "notes",
          uri: "file:///notes.md",
          mimeType: "text/markdown",
          size: 12,
        },
      ]),
    ACPPromptContentError,
  );
});

Deno.test("resolveACPResourcePath confines resources to the workspace", () => {
  const workspace = Deno.makeTempDirSync();
  const outside = Deno.makeTempDirSync();
  const outsideFile = join(outside, "secret.txt");
  Deno.writeFileSync(outsideFile, new TextEncoder().encode("x"));
  assertThrows(
    () => resolveACPResourcePath(`file://${outsideFile}`, workspace, []),
    ACPPromptContentError,
  );

  const localFile = join(workspace, "ok.txt");
  Deno.writeFileSync(localFile, new TextEncoder().encode("ok"));
  const resolved = resolveACPResourcePath(
    `file://localhost${localFile}`,
    workspace,
    [],
  );
  assertEquals(resolved, Deno.realPathSync(localFile));

  assertThrows(
    () => resolveACPResourcePath("https://example.com/a", workspace, []),
    ACPPromptContentError,
  );
});

Deno.test("encodedACPIngress requires base64 data and defaults image media type", async () => {
  assertThrows(
    () => encodedACPIngress({ type: "image", data: "" }, "acp:test", 0),
    ACPPromptContentError,
  );
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const ingress = encodedACPIngress(
    { type: "image", data: `data:image/png;base64,${encodeBase64(bytes)}` },
    "acp:test",
    2,
  );
  assertEquals(ingress.kind, "image");
  assertEquals(ingress.mediaTypeHint, "image/png");
  assertEquals(ingress.filenameHint, "acp-2");
  assertEquals(ingress.eventId, "acp:test:2");
  const stream = await ingress.open(undefined);
  assertEquals(stream.bytes, bytes);
});

Deno.test("acpAttachmentKind maps content and media types", () => {
  assertEquals(acpAttachmentKind("image", ""), "image");
  assertEquals(acpAttachmentKind("audio", ""), "audio");
  assertEquals(acpAttachmentKind("", "image/webp; charset=x"), "image");
  assertEquals(acpAttachmentKind("", "audio/wav"), "audio");
  assertEquals(acpAttachmentKind("", "video/mp4"), "video");
  assertEquals(acpAttachmentKind("", "application/pdf"), "file");
});

Deno.test("acpPromptRequestSnapshot requires a materializer for resources", () => {
  assertThrows(
    () => {
      acpPromptRequestSnapshot(null, "hi", {
        text: "hi",
        resources: [{
          resourceId: "r1",
          kind: "file",
          relativePath: "a",
          filename: "a",
          mediaType: "text/plain",
          bytes: 1,
        }],
        knowledgeBaseReferences: [],
        knowledgeCapsules: [],
        idempotencyKey: "",
      });
    },
    ACPPromptContentError,
    "snapshot input materializer is unavailable",
  );

  const snapshot = acpPromptRequestSnapshot(null, "hi", {
    text: "hi",
    resources: [],
    knowledgeBaseReferences: [{ knowledgeBaseId: "kb1", required: true }],
    knowledgeCapsules: [{
      knowledgeBaseId: "kb1",
      knowledgeBaseName: "Docs",
      snapshotId: "snap-1",
      text: "body",
      citations: [],
    }],
    idempotencyKey: "",
  });
  const parsed = JSON.parse(snapshot) as {
    text: string;
    knowledge: Array<{ knowledgeBaseId: string; snapshotId: string }>;
  };
  assertEquals(parsed.text, "hi");
  assertEquals(parsed.knowledge[0].knowledgeBaseId, "kb1");
  assertEquals(parsed.knowledge[0].snapshotId, "snap-1");
});
