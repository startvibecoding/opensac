// Ported from internal/imageproc/imageproc.go
//
// Unlike the Go original, decoding/encoding goes through npm codecs
// (`imagescript` for PNG/JPEG/GIF + resize/crop/encode, `@jsquash/webp` for
// WebP decode). The read/decode path is therefore async. Geometry, limits, and
// MIME selection mirror the Go implementation; the resampling kernel differs
// (imagescript rather than `x/image/draw` CatmullRom), so encoded bytes are not
// bit-identical (the Go tests only assert geometry/limits/MIME).

import { Image } from "imagescript";
import { decode as decodeWebp } from "@jsquash/webp";
import type { Family, Hint } from "./policy.ts";
import { inferFamily } from "./policy.ts";

/** Image processing mode. */
export type Mode = "auto" | "fast" | "detail" | "raw";

/** Default maximum accepted input size in bytes. */
export const defaultMaxFileBytes = 10 << 20;
/** Default maximum accepted pixel count. */
export const defaultMaxPixels = 40_000_000;

/** Crop rectangle (source pixels). */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Image processing policy. */
export interface Policy {
  mode?: Mode;
  maxFileBytes?: number;
  maxPixels?: number;
  maxLongEdge?: number;
  maxOutputBytes?: number;
  crop?: Crop;
}

/** Result metadata describing the transformations that were applied. */
export interface Meta {
  width: number;
  height: number;
  bytes: number;
  originalWidth: number;
  originalHeight: number;
  originalBytes: number;
  resized: boolean;
  cropped: boolean;
  transcoded: boolean;
  scale: number;
  detail: string;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/** A prepared image ready to send to a provider. */
export interface Result {
  data: Uint8Array;
  mimeType: string;
  meta: Meta;
}

/** Normalizes a mode string. */
export function normalizeMode(s: string): Mode {
  switch (s.trim().toLowerCase()) {
    case "fast":
      return "fast";
    case "detail":
      return "detail";
    case "raw":
      return "raw";
    default:
      return "auto";
  }
}

/** Returns the default policy for a mode. */
export function defaultPolicy(mode: Mode): Policy {
  const p: Policy = {
    mode,
    maxFileBytes: defaultMaxFileBytes,
    maxPixels: defaultMaxPixels,
  };
  switch (mode) {
    case "fast":
      p.maxLongEdge = 1024;
      p.maxOutputBytes = 2 << 20;
      break;
    case "detail":
      p.maxLongEdge = 2048;
      p.maxOutputBytes = 6 << 20;
      break;
    case "raw":
      p.maxOutputBytes = defaultMaxFileBytes;
      break;
    default:
      p.mode = "auto";
      p.maxLongEdge = 1568;
      p.maxOutputBytes = 3 << 20;
  }
  return p;
}

function normalizePolicy(policy: Policy): Required<Omit<Policy, "crop">> & {
  crop?: Crop;
} {
  const mode = policy.mode ?? "auto";
  const base = defaultPolicy(mode);
  if ((policy.maxFileBytes ?? 0) > 0) base.maxFileBytes = policy.maxFileBytes;
  if ((policy.maxPixels ?? 0) > 0) base.maxPixels = policy.maxPixels;
  if ((policy.maxLongEdge ?? 0) > 0) base.maxLongEdge = policy.maxLongEdge;
  if ((policy.maxOutputBytes ?? 0) > 0) {
    base.maxOutputBytes = policy.maxOutputBytes;
  }
  if (policy.crop) base.crop = { ...policy.crop };
  return base as Required<Omit<Policy, "crop">> & { crop?: Crop };
}

/** Reads a file and prepares it. */
export async function prepareFile(
  path: string,
  policy: Policy,
): Promise<Result> {
  const data = Deno.readFileSync(path);
  return await prepareBytes(data, policy);
}

/** Prepares raw image bytes according to the policy. */
export async function prepareBytes(
  data: Uint8Array,
  policyIn: Policy,
): Promise<Result> {
  const policy = normalizePolicy(policyIn);
  const maxFileBytes = policy.maxFileBytes;
  if (maxFileBytes > 0 && data.length > maxFileBytes) {
    throw new Error(
      `image file too large: ${data.length} bytes (max ${maxFileBytes})`,
    );
  }

  const sourceFormat = sniffFormat(data);
  if (sourceFormat === "") {
    throw new Error("inspect image: unknown image format");
  }
  const decoded = await decodeImage(data, sourceFormat);
  const image = decoded;

  const cfgWidth = image.width;
  const cfgHeight = image.height;
  if (cfgWidth <= 0 || cfgHeight <= 0) {
    throw new Error(
      `inspect image: invalid dimensions ${cfgWidth}x${cfgHeight}`,
    );
  }
  const pixels = cfgWidth * cfgHeight;
  if (policy.maxPixels > 0 && pixels > policy.maxPixels) {
    throw new Error(
      `image has too many pixels: ${pixels} (max ${policy.maxPixels})`,
    );
  }

  const sourceMime = mimeFromFormat(sourceFormat);
  const meta: Meta = {
    width: cfgWidth,
    height: cfgHeight,
    bytes: data.length,
    originalWidth: cfgWidth,
    originalHeight: cfgHeight,
    originalBytes: data.length,
    resized: false,
    cropped: false,
    transcoded: false,
    scale: 1,
    detail: policy.mode,
    cropX: 0,
    cropY: 0,
    cropWidth: 0,
    cropHeight: 0,
  };

  if (policy.mode === "raw" && policy.crop === undefined) {
    return { data, mimeType: sourceMime, meta };
  }

  const cropResult = normalizedCrop(policy.crop, cfgWidth, cfgHeight);
  const cropRect = cropResult.rect;
  const needsCrop = cropResult.needsCrop;

  let sourceW = cfgWidth;
  let sourceH = cfgHeight;
  if (needsCrop) {
    sourceW = cropRect.width;
    sourceH = cropRect.height;
    meta.width = sourceW;
    meta.height = sourceH;
    meta.cropped = true;
    meta.cropX = cropRect.x;
    meta.cropY = cropRect.y;
    meta.cropWidth = sourceW;
    meta.cropHeight = sourceH;
  }

  const scaled = scaledDimensions(sourceW, sourceH, policy.maxLongEdge ?? 0);
  const targetW = scaled.width;
  const targetH = scaled.height;
  const scale = scaled.scale;
  const needsResize = targetW !== sourceW || targetH !== sourceH;
  const needsTranscode = sourceMime !== "image/png" &&
    sourceMime !== "image/jpeg";
  const tooLarge = policy.maxOutputBytes > 0 &&
    data.length > policy.maxOutputBytes;
  if (!needsCrop && !needsResize && !needsTranscode && !tooLarge) {
    return { data, mimeType: sourceMime, meta };
  }

  let img = image;
  if (needsCrop) img = cropImage(img, cropRect);
  if (needsResize) {
    img = resizeImage(img, targetW, targetH);
    meta.width = targetW;
    meta.height = targetH;
    meta.resized = true;
    meta.scale = scale;
  }

  const encoded = await encodeForPolicy(img, sourceMime, policy);
  if (encoded.capResized) {
    meta.width = encoded.width;
    meta.height = encoded.height;
    meta.resized = true;
    if (sourceW > 0) meta.scale = encoded.width / sourceW;
  }
  meta.bytes = encoded.data.length;
  meta.transcoded = encoded.mimeType !== sourceMime ||
    sourceFormat !== formatFromMime(encoded.mimeType);
  return { data: encoded.data, mimeType: encoded.mimeType, meta };
}

// ── Decoding ────────────────────────────────────────────────────────────────

/** Detects the image container format from magic bytes. */
export function sniffFormat(data: Uint8Array): string {
  if (
    data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 &&
    data[2] === 0x4e && data[3] === 0x47
  ) {
    return "png";
  }
  if (
    data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
  ) {
    return "gif";
  }
  if (
    data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 &&
    data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 &&
    data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "webp";
  }
  return "";
}

async function decodeImage(data: Uint8Array, format: string): Promise<Image> {
  if (format === "webp") {
    const ab = new Uint8Array(data).buffer as ArrayBuffer;
    const decoded = await decodeWebp(ab);
    const img = new Image(decoded.width, decoded.height);
    img.bitmap.set(decoded.data);
    return img;
  }
  try {
    return await Image.decode(data);
  } catch (err) {
    throw new Error(`decode image: ${(err as Error).message}`);
  }
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Scales dimensions so the long edge fits within maxLongEdge. */
export function scaledDimensions(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number; scale: number } {
  if (maxLongEdge <= 0 || (width <= maxLongEdge && height <= maxLongEdge)) {
    return { width, height, scale: 1 };
  }
  const longEdge = Math.max(width, height);
  const scale = maxLongEdge / longEdge;
  let w = Math.round(width * scale);
  let h = Math.round(height * scale);
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  return { width: w, height: h, scale };
}

function normalizedCrop(
  crop: Crop | undefined,
  width: number,
  height: number,
): { rect: Crop; needsCrop: boolean } {
  if (!crop) {
    return { rect: { x: 0, y: 0, width: 0, height: 0 }, needsCrop: false };
  }
  if (crop.width <= 0 || crop.height <= 0) {
    throw new Error("invalid crop: width and height must be positive");
  }
  if (crop.x < 0 || crop.y < 0) {
    throw new Error("invalid crop: x and y must be non-negative");
  }
  if (
    crop.x + crop.width > width || crop.y + crop.height > height
  ) {
    throw new Error(
      `invalid crop: rectangle ${crop.width}x${crop.height}+${crop.x}+${crop.y} exceeds image bounds ${width}x${height}`,
    );
  }
  if (
    crop.x === 0 && crop.y === 0 && crop.width === width &&
    crop.height === height
  ) {
    return { rect: crop, needsCrop: false };
  }
  return { rect: crop, needsCrop: true };
}

function resizeImage(img: Image, width: number, height: number): Image {
  return img.resize(width, height);
}

function cropImage(img: Image, rect: Crop): Image {
  return img.crop(rect.x, rect.y, rect.width, rect.height);
}

// ── Encoding ────────────────────────────────────────────────────────────────

interface EncodedOnce {
  data: Uint8Array;
  mimeType: string;
}

interface Encoded {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  capResized: boolean;
}

async function encodeForPolicy(
  img: Image,
  sourceMime: string,
  policy: Required<Omit<Policy, "crop">> & { crop?: Crop },
): Promise<Encoded> {
  const first = await encodeForPolicyOnce(img, sourceMime, policy);
  let width = img.width;
  let height = img.height;
  const maxOutputBytes = policy.maxOutputBytes;
  if (maxOutputBytes <= 0 || first.data.length <= maxOutputBytes) {
    return { ...first, width, height, capResized: false };
  }

  let working = img;
  let out = first.data;
  let mimeType = first.mimeType;
  let resized = false;
  for (let attempts = 0; attempts < 12 && width > 1 && height > 1; attempts++) {
    let ratio = Math.sqrt(maxOutputBytes / out.length) * 0.9;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 0.95) ratio = 0.9;
    let nextW = Math.floor(width * ratio);
    let nextH = Math.floor(height * ratio);
    if (nextW < 1) nextW = 1;
    if (nextH < 1) nextH = 1;
    if (nextW === width && width > 1) nextW--;
    if (nextH === height && height > 1) nextH--;
    if (nextW === width && nextH === height) break;

    working = resizeImage(working, nextW, nextH);
    width = nextW;
    height = nextH;
    resized = true;
    const enc = await encodeForPolicyOnce(working, sourceMime, policy);
    out = enc.data;
    mimeType = enc.mimeType;
    if (out.length <= maxOutputBytes) {
      return { data: out, mimeType, width, height, capResized: resized };
    }
  }
  throw new Error(
    `encoded image too large: ${out.length} bytes (max ${maxOutputBytes})`,
  );
}

async function encodeForPolicyOnce(
  img: Image,
  sourceMime: string,
  policy: { maxOutputBytes: number },
): Promise<EncodedOnce> {
  const maxOutputBytes = policy.maxOutputBytes;
  if (hasTransparency(img)) {
    return { data: await img.encode(), mimeType: "image/png" };
  }
  if (sourceMime === "image/png") {
    const data = await img.encode();
    if (maxOutputBytes <= 0 || data.length <= maxOutputBytes) {
      return { data, mimeType: "image/png" };
    }
  }
  const qualities = [90, 85, 80, 75, 70];
  for (const quality of qualities) {
    const data = await img.encodeJPEG(
      quality as Parameters<Image["encodeJPEG"]>[0],
    );
    if (
      maxOutputBytes <= 0 || data.length <= maxOutputBytes || quality === 70
    ) {
      return { data, mimeType: "image/jpeg" };
    }
  }
  throw new Error("encode image: no encoder selected");
}

function hasTransparency(img: Image): boolean {
  const bitmap = img.bitmap;
  const pixels = img.width * img.height;
  for (let i = 0; i < pixels; i++) {
    if (bitmap[i * 4 + 3] !== 0xff) return true;
  }
  return false;
}

/** Maps a Go-style image format name to a MIME type. */
export function mimeFromFormat(format: string): string {
  switch (format.toLowerCase()) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Maps a MIME type to a Go-style image format name. */
export function formatFromMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "";
  }
}

// ── Policy from hints ───────────────────────────────────────────────────────

function capFileLimit(policy: Policy, max: number): void {
  if (max <= 0) return;
  if ((policy.maxFileBytes ?? 0) <= 0 || (policy.maxFileBytes ?? 0) > max) {
    policy.maxFileBytes = max;
  }
}

function raiseFileLimit(policy: Policy, min: number): void {
  if (min <= 0) return;
  if ((policy.maxFileBytes ?? 0) > 0 && (policy.maxFileBytes ?? 0) < min) {
    policy.maxFileBytes = min;
  }
}

function capOutputLimit(policy: Policy, max: number): void {
  if (max <= 0) return;
  if ((policy.maxOutputBytes ?? 0) <= 0 || (policy.maxOutputBytes ?? 0) > max) {
    policy.maxOutputBytes = max;
  }
}

function raiseDetailLongEdge(policy: Policy, min: number): void {
  if (
    policy.mode === "detail" && (policy.maxLongEdge ?? 0) > 0 &&
    (policy.maxLongEdge ?? 0) < min
  ) {
    policy.maxLongEdge = min;
  }
}

/** Builds a policy for the given provider/model hints. */
export function policyForHint(h: Hint, mode: Mode): Policy {
  const policy = defaultPolicy(mode);
  switch (inferFamily(h)) {
    case "openai":
    case "anthropic":
    case "gemini":
    case "grok":
      raiseFileLimit(policy, 20 << 20);
      break;
    case "anthropic-bedrock":
      capFileLimit(policy, 4 << 20);
      capOutputLimit(policy, 3 << 20);
      break;
    case "amazon-nova":
      capOutputLimit(policy, 4 << 20);
      break;
    case "doubao-seed":
    case "qwen":
    case "kimi":
    case "glm":
      raiseDetailLongEdge(policy, 2560);
      break;
    case "mistral":
    case "minimax":
      capOutputLimit(policy, 5 << 20);
      break;
    case "mimo":
    case "llama-vision":
    case "gemma-vision":
      capOutputLimit(policy, 4 << 20);
      break;
    default:
      break;
  }
  const providerText = [
    h.providerID ?? "",
    h.providerName ?? "",
    h.vendor ?? "",
    h.baseURL ?? "",
  ].map((s) =>
    s.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-").replaceAll(
      ":",
      "-",
    )
  ).join(" ");
  if (providerText.includes("groq") || providerText.includes("api.groq.com")) {
    capOutputLimit(policy, 3 << 20);
  }
  return policy;
}

export type { Family };
