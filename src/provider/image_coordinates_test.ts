import { assert, assertEquals } from "@std/assert";
import {
  mapNormalizedRectToOriginal,
  mapPointToOriginal,
  mapRectToOriginal,
} from "./mod.ts";

Deno.test("ImageContentMapPointToOriginal", () => {
  const img = {
    data: "",
    mimeType: "",
    width: 100,
    height: 50,
    originalWidth: 200,
    originalHeight: 100,
  };
  const [x, y, ok] = mapPointToOriginal(img, 25, 10);
  assert(ok);
  assertEquals(x, 50);
  assertEquals(y, 20);
});

Deno.test("ImageContentMapPointToOriginalWithCrop", () => {
  const img = {
    data: "",
    mimeType: "",
    width: 100,
    height: 50,
    originalWidth: 400,
    originalHeight: 300,
    cropped: true,
    cropX: 40,
    cropY: 30,
    cropWidth: 200,
    cropHeight: 100,
  };
  const [x, y, ok] = mapPointToOriginal(img, 50, 25);
  assert(ok);
  assertEquals(x, 140);
  assertEquals(y, 80);
});

Deno.test("ImageContentMapRectToOriginal", () => {
  const img = {
    data: "",
    mimeType: "",
    width: 100,
    height: 50,
    originalWidth: 200,
    originalHeight: 100,
  };
  const [x, y, w, h, ok] = mapRectToOriginal(img, 10, 5, 20, 10);
  assert(ok);
  assertEquals([x, y, w, h], [20, 10, 40, 20]);
});

Deno.test("ImageContentMapNormalizedRectToOriginal", () => {
  const img = {
    data: "",
    mimeType: "",
    width: 100,
    height: 50,
    originalWidth: 200,
    originalHeight: 100,
  };
  const [x, y, w, h, ok] = mapNormalizedRectToOriginal(
    img,
    100,
    200,
    300,
    400,
    1000,
  );
  assert(ok);
  assertEquals([x, y, w, h], [20, 20, 60, 40]);
});

Deno.test("ImageContentMapPointToOriginalRejectsMissingMetadata", () => {
  const img = { data: "", mimeType: "", width: 100, height: 50 };
  const [, , ok] = mapPointToOriginal(img, 1, 1);
  assert(!ok);
});
