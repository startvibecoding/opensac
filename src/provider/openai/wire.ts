// Shared helpers for the openai subprovider, extracted from provider.go and
// responses.go so the chat and Responses modules can reuse them.
//
// `json.RawMessage` handling: the Go provider keeps raw JSON bytes for tool
// arguments and replay items. TypeScript has no byte array JSON marshaling, so
// this codec carries raw JSON documents as strings and exposes
// `toJSON()`/parse helpers where a decoded value is required.

import type { ContentBlock, Message } from "../types.ts";

/** Clones a string map (undefined stays undefined). */
export function cloneStringMap(
  src: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (src === undefined || Object.keys(src).length === 0) return undefined;
  return { ...src };
}

/** Clones a string slice (undefined stays undefined). */
export function cloneStringSlice(
  src: string[] | undefined,
): string[] | undefined {
  if (src === undefined) return undefined;
  return [...src];
}

/** Clones a bool pointer (undefined stays undefined). */
export function cloneBoolPtr(src: boolean | undefined): boolean | undefined {
  return src === undefined ? undefined : src;
}

/** Clones a raw JSON document carried as a string. */
export function cloneRawMessage(src: string | undefined): string | undefined {
  return src === undefined ? undefined : src;
}

/** Clones custom HTTP headers (undefined stays undefined). */
export function cloneHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined || Object.keys(headers).length === 0) {
    return undefined;
  }
  return { ...headers };
}

/** Normalizes an image detail hint to the provider-neutral value. */
export function normalizeImageDetail(detail: string): string {
  switch ((detail ?? "").trim().toLowerCase()) {
    case "fast":
    case "low":
      return "low";
    case "auto":
      return "auto";
    case "detail":
    case "high":
      return "high";
    case "raw":
    case "original":
      return "high";
    default:
      return "";
  }
}

/**
 * Keeps the newest images and replaces older image blocks with a compact
 * marker. Text and tool-result descriptions remain available while providers
 * with small image limits receive a valid request.
 */
export function limitImageHistory(
  messages: Message[],
  maxImages: number,
): Message[] {
  if (maxImages <= 0) return messages;
  let imageCount = 0;
  for (const msg of messages) {
    for (const block of msg.contents ?? []) {
      if (block.type === "image" && block.image != null) imageCount++;
    }
  }
  if (imageCount <= maxImages) return messages;

  const result = messages.slice();
  let toOmit = imageCount - maxImages;
  for (let i = 0; i < result.length; i++) {
    const contents = result[i].contents;
    if (contents === undefined || contents.length === 0) continue;
    const replaced: ContentBlock[] = [];
    for (const block of contents) {
      if (block.type === "image" && block.image != null && toOmit > 0) {
        replaced.push({
          type: "text",
          text: "[image omitted: provider image limit]",
        });
        toOmit--;
        continue;
      }
      replaced.push(block);
    }
    result[i] = { ...result[i], contents: replaced };
  }
  return result;
}

/**
 * Serializes provider-neutral tool-call arguments to the OpenAI wire string.
 * `arguments` normally holds a decoded JSON value; a string is passed through
 * verbatim (this is how `invalidArguments` is represented after normalization).
 */
export function toolArgumentsString(
  args: unknown,
  invalid?: string,
): string {
  if (invalid !== undefined && invalid !== "") return invalid;
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}
