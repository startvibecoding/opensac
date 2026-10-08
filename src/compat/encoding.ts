// Project-owned replacement for the JSR `@std/encoding/base64` and
// `@std/encoding/base64url` modules, backed by `node:buffer`. See `./path.ts`
// for the rationale.

import { Buffer } from "node:buffer";

/** Encodes bytes (or a UTF-8 string) as standard base64. */
export function encodeBase64(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64");
}

/** Decodes standard base64 into bytes. */
export function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** Encodes bytes (or a UTF-8 string) as URL-safe base64. */
export function encodeBase64Url(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64url");
}

/** Decodes URL-safe base64 into bytes. */
export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64url"));
}
