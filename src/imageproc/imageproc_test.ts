//
// Test images are generated with the same npm codec used by the implementation;
// the assertions mirror the Go tests (geometry/limits/MIME, not exact bytes).

import { assert, assertEquals, assertRejects } from "@opensac/assert";
import { Image } from "imagescript";
import { defaultPolicy, prepareBytes } from "./mod.ts";

function testImage(width: number, height: number): Image {
  const img = new Image(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.bitmap[i] = x % 255;
      img.bitmap[i + 1] = y % 255;
      img.bitmap[i + 2] = 180;
      img.bitmap[i + 3] = 255;
    }
  }
  return img;
}

function noisyImage(width: number, height: number): Image {
  const img = new Image(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.bitmap[i] = (x * 37 + y * 17) % 256;
      img.bitmap[i + 1] = (x * 13 + y * 53) % 256;
      img.bitmap[i + 2] = (x * 91 + y * 29) % 256;
      img.bitmap[i + 3] = 255;
    }
  }
  return img;
}

function transparentImage(width: number, height: number): Image {
  const img = new Image(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.bitmap[i] = 20;
      img.bitmap[i + 1] = 120;
      img.bitmap[i + 2] = 220;
      img.bitmap[i + 3] = 80 + ((x + y) % 120);
    }
  }
  return img;
}

async function encodePNG(img: Image): Promise<Uint8Array> {
  return await img.encode();
}

async function encodeJPEG(img: Image, quality: number): Promise<Uint8Array> {
  return await img.encodeJPEG(quality as Parameters<Image["encodeJPEG"]>[0]);
}

Deno.test("prepareBytes resizes JPEG", async () => {
  const data = await encodeJPEG(testImage(200, 100), 90);
  const policy = defaultPolicy("fast");
  policy.maxLongEdge = 50;
  const result = await prepareBytes(data, policy);
  assertEquals(result.mimeType, "image/jpeg");
  assertEquals(result.meta.width, 50);
  assertEquals(result.meta.height, 25);
  assertEquals(result.meta.originalWidth, 200);
  assertEquals(result.meta.originalHeight, 100);
  assert(result.meta.resized);
  assert(result.meta.scale > 0 && result.meta.scale < 1);
});

Deno.test("prepareBytes raw preserves PNG", async () => {
  const data = await encodePNG(testImage(12, 8));
  const result = await prepareBytes(data, defaultPolicy("raw"));
  assertEquals(result.data, data);
  assertEquals(result.mimeType, "image/png");
  assertEquals(result.meta.width, 12);
  assertEquals(result.meta.height, 8);
});

Deno.test("prepareBytes crops image", async () => {
  const data = await encodePNG(testImage(120, 80));
  const policy = defaultPolicy("detail");
  policy.crop = { x: 10, y: 12, width: 40, height: 20 };
  const result = await prepareBytes(data, policy);
  assertEquals(result.meta.width, 40);
  assertEquals(result.meta.height, 20);
  assert(result.meta.cropped);
  assertEquals(result.meta.cropX, 10);
  assertEquals(result.meta.cropY, 12);
  assertEquals(result.meta.cropWidth, 40);
  assertEquals(result.meta.cropHeight, 20);
  assertEquals(result.meta.originalWidth, 120);
  assertEquals(result.meta.originalHeight, 80);
});

Deno.test("prepareBytes rejects out-of-bounds crop", async () => {
  const data = await encodePNG(testImage(20, 20));
  const policy = defaultPolicy("auto");
  policy.crop = { x: 10, y: 10, width: 20, height: 20 };
  await assertRejects(() => prepareBytes(data, policy));
});

Deno.test("prepareBytes rejects pixel limit", async () => {
  const data = await encodePNG(testImage(10, 10));
  const policy = defaultPolicy("auto");
  policy.maxPixels = 50;
  await assertRejects(() => prepareBytes(data, policy));
});

Deno.test("prepareBytes resizes to output limit", async () => {
  const data = await encodeJPEG(noisyImage(800, 600), 95);
  const policy = defaultPolicy("detail");
  policy.maxLongEdge = 800;
  policy.maxOutputBytes = 25 * 1024;
  const result = await prepareBytes(data, policy);
  assert(result.meta.bytes <= policy.maxOutputBytes);
  assert(result.meta.resized);
  assert(result.meta.width < 800 || result.meta.height < 600);
});

Deno.test("prepareBytes preserves transparent PNG", async () => {
  const data = await encodePNG(transparentImage(100, 80));
  const policy = defaultPolicy("detail");
  policy.maxLongEdge = 50;
  const result = await prepareBytes(data, policy);
  assertEquals(result.mimeType, "image/png");
  assertEquals(result.meta.width, 50);
  assertEquals(result.meta.height, 40);
});

Deno.test("prepareBytes decodes WebP", async () => {
  const b64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const result = await prepareBytes(data, defaultPolicy("auto"));
  assertEquals(result.meta.originalWidth, 1);
  assertEquals(result.meta.originalHeight, 1);
  assert(
    result.mimeType === "image/jpeg" || result.mimeType === "image/png",
    result.mimeType,
  );
});
