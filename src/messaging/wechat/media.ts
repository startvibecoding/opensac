// Ported from internal/messaging/wechat/media.go

import { createDecipheriv } from "node:crypto";
import { decodeAESKey } from "./crypto.ts";
import { CDNBaseURL, type Client, withMediaTimeout } from "./protocol.ts";
import type { CDNMedia } from "./types.ts";

/**
 * OpenCDNMedia opens the event-authenticated content represented by media.
 * iLink media is AES-128-ECB encrypted in observed clients. The decrypting
 * stream intentionally streams into the Runtime attachment store, so the
 * channel adapter never owns a local media file or unbounded byte slice.
 */
export async function openCDNMedia(
  client: Client | null,
  signal: AbortSignal,
  media: CDNMedia,
  aesKeyOverride: string,
): Promise<ReadableStream<Uint8Array>> {
  if (client === null || client.fetchFn === null) {
    throw new Error("wechat media client is not configured");
  }
  const downloadURL = wechatMediaURL(media);
  const requestSignal = withMediaTimeout(signal);
  const res = await client.fetchFn(downloadURL, { signal: requestSignal });
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    throw new Error(`download wechat media: HTTP ${res.status}`);
  }
  const body = res.body;
  if (body === null) {
    throw new Error("download wechat media: empty body");
  }
  let keySource = aesKeyOverride.trim();
  if (keySource === "") {
    keySource = (media.aes_key ?? "").trim();
  }
  // Some observed iLink events omit encryption metadata. Preserve the bytes
  // instead of inventing a key; Runtime still performs its normal size and
  // image content validation before the input reaches an Agent.
  if (keySource === "") {
    return body;
  }
  const key = decodeAESKey(keySource);
  return newAESECBDecryptStream(body, key);
}

/** wechatMediaURL mirrors wechatMediaURL. */
export function wechatMediaURL(media: CDNMedia): string {
  const fullURL = (media.full_url ?? "").trim();
  if (fullURL !== "") {
    let parsed: URL;
    try {
      parsed = new URL(fullURL);
    } catch {
      throw new Error("invalid WeChat media download URL");
    }
    if (parsed.protocol !== "https:" || parsed.host === "") {
      throw new Error("invalid WeChat media download URL");
    }
    return parsed.toString();
  }
  if ((media.encrypt_query_param ?? "").trim() === "") {
    throw new Error("wechat media has no download reference");
  }
  return CDNBaseURL + "/download?encrypted_query_param=" +
    encodeURIComponent(media.encrypt_query_param!);
}

/**
 * newAESECBDecryptStream decrypts AES-ECB and validates PKCS#7 padding while
 * retaining only one final block. It is deliberately a stream rather than a
 * Uint8Array helper: AttachmentService enforces its normal accepted-byte cap
 * while data is copied into private Runtime storage.
 */
export function newAESECBDecryptStream(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
): ReadableStream<Uint8Array> {
  if (source === null) {
    throw new Error("wechat media source is nil");
  }
  if (key.length !== 16) {
    throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  return ReadableStream.from(decryptGenerator(source, decipher));
}

interface DecipherLike {
  update(data: Uint8Array): Uint8Array;
}

async function* decryptGenerator(
  source: ReadableStream<Uint8Array>,
  decipher: DecipherLike,
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  let pending = new Uint8Array(0);
  let lastBlock: Uint8Array | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined || value.length === 0) {
        continue;
      }
      pending = concatBytes(pending, value);
      const usable = pending.length - (pending.length % 16);
      if (usable > 0) {
        const chunk = pending.slice(0, usable);
        pending = pending.slice(usable);
        const decrypted = decipher.update(chunk);
        let out = new Uint8Array(0);
        for (let pos = 0; pos + 16 <= decrypted.length; pos += 16) {
          if (lastBlock !== null) {
            out = concatBytes(out, lastBlock);
          }
          lastBlock = decrypted.slice(pos, pos + 16);
        }
        if (out.length > 0) {
          yield out;
        }
      }
    }
    if (pending.length !== 0) {
      throw new Error(
        "wechat media ciphertext length is not a multiple of AES block size",
      );
    }
    if (lastBlock === null) {
      throw new Error("wechat media ciphertext is empty");
    }
    const padding = lastBlock[lastBlock.length - 1];
    if (padding === 0 || padding > lastBlock.length) {
      throw new Error("wechat media has invalid PKCS7 padding");
    }
    for (let i = lastBlock.length - padding; i < lastBlock.length; i++) {
      if (lastBlock[i] !== padding) {
        throw new Error("wechat media has invalid PKCS7 padding");
      }
    }
    const final = lastBlock.slice(0, lastBlock.length - padding);
    if (final.length > 0) {
      yield final;
    }
  } finally {
    reader.releaseLock();
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
