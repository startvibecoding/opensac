// Ported from internal/messaging/wechat/crypto.go

import { createCipheriv, createDecipheriv } from "node:crypto";
import { decodeBase64, decodeBase64Url, encodeBase64 } from "@std/encoding";

const hexPattern = /^[0-9a-fA-F]{32}$/;

/** EncryptAESECB encrypts plaintext with AES-128-ECB and PKCS7 padding. */
export function encryptAESECB(
  plaintext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (key.length !== 16) {
    throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  }
  const block = createCipheriv("aes-128-ecb", key, null);
  block.setAutoPadding(false);
  const padded = pkcs7Pad(plaintext, 16);
  const ciphertext = new Uint8Array(padded.length);
  ciphertext.set(block.update(padded));
  ciphertext.set(block.final(), padded.length - 16);
  return ciphertext;
}

/** DecryptAESECB decrypts AES-128-ECB ciphertext and removes PKCS7 padding. */
export function decryptAESECB(
  ciphertext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (key.length !== 16) {
    throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  }
  if (ciphertext.length % 16 !== 0) {
    throw new Error(
      `ciphertext length ${ciphertext.length} is not a multiple of block size`,
    );
  }
  const block = createDecipheriv("aes-128-ecb", key, null);
  block.setAutoPadding(false);
  const plaintext = new Uint8Array(ciphertext.length);
  plaintext.set(block.update(ciphertext));
  plaintext.set(block.final(), ciphertext.length - 16);
  return pkcs7Unpad(plaintext);
}

/** GenerateAESKey generates a random 16-byte AES key. */
export function generateAESKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * DecodeAESKey decodes an aes_key from the protocol. Handles: direct hex (32
 * chars), base64(raw 16 bytes), base64(hex string 32 chars).
 */
export function decodeAESKey(encoded: string): Uint8Array {
  if (hexPattern.test(encoded)) {
    return decodeHex(encoded);
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(encoded);
  } catch (err) {
    try {
      decoded = decodeBase64Url(encoded);
    } catch {
      throw new Error(`cannot base64 decode aes_key: ${err}`);
    }
  }
  if (decoded.length === 16) {
    return decoded;
  }
  if (
    decoded.length === 32 && hexPattern.test(new TextDecoder().decode(decoded))
  ) {
    return decodeHex(new TextDecoder().decode(decoded));
  }
  throw new Error(
    `decoded aes_key has unexpected length ${decoded.length} (want 16 or 32)`,
  );
}

/** EncodeAESKeyHex returns the hex string of a key. */
export function encodeAESKeyHex(key: Uint8Array): string {
  return encodeHex(key);
}

/** EncodeAESKeyBase64 returns base64(hex) for CDNMedia.aes_key. */
export function encodeAESKeyBase64(key: Uint8Array): string {
  return encodeBase64(new TextEncoder().encode(encodeHex(key)));
}

function pkcs7Pad(data: Uint8Array, blockSize: number): Uint8Array {
  const padding = blockSize - (data.length % blockSize);
  const padded = new Uint8Array(data.length + padding);
  padded.set(data);
  padded.fill(padding, data.length);
  return padded;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    throw new Error("empty data");
  }
  const padding = data[data.length - 1];
  if (padding > data.length || padding === 0) {
    throw new Error("invalid PKCS7 padding");
  }
  return data.slice(0, data.length - padding);
}

/** encodeHex is a tiny local hex encoder. */
export function encodeHex(data: Uint8Array): string {
  let out = "";
  for (const byte of data) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** decodeHex is a tiny local hex decoder. */
export function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
