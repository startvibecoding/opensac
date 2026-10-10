// Focused tests for the ported net/http DetectContentType sniffing subset.

import { runtime } from "../platform/runtime.ts";
import { assertEquals } from "../compat/assert.ts";
import { detectAttachmentMediaType, detectContentType } from "./media_type.ts";
import { test } from "#testing";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const onePixelPng = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8P6sAAAAASUVORK5CYII=",
);

test("DetectContentTypeSniffsCommonMedia", () => {
  assertEquals(detectContentType(onePixelPng), "image/png");
  assertEquals(
    detectContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assertEquals(
    detectContentType(new TextEncoder().encode("GIF89a....")),
    "image/gif",
  );
  assertEquals(
    detectContentType(
      new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP........"),
    ),
    "image/webp",
  );
  assertEquals(
    detectContentType(new TextEncoder().encode("%PDF-1.7")),
    "application/pdf",
  );
  assertEquals(
    detectContentType(new TextEncoder().encode("  hello world")),
    "text/plain; charset=utf-8",
  );
  assertEquals(
    detectContentType(new Uint8Array([0x00, 0x01, 0x02, 0x03])),
    "application/octet-stream",
  );
});

test("DetectAttachmentMediaTypeReadsFileBytes", async () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-media-" });
  const file = `${dir}/pixel.png`;
  await runtime.writeFile(file, onePixelPng);
  assertEquals(await detectAttachmentMediaType(file), "image/png");
});
