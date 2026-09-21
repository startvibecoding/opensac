// Ported from internal/provider/openai/responses_codec.go
//
// Raw JSON documents (Go `json.RawMessage`) are carried as strings so streaming
// argument buffers and canonical archives keep their exact byte-level payload
// before redaction.

import { createHash } from "node:crypto";
import type { Attachment } from "../types.ts";
import {
  hostedToolDescriptorForType,
  type ResponsesHostedPolicy,
} from "./hosted_registry.ts";
import type {
  ResponsesCompletedObject,
  ResponsesOutputItem,
  ResponsesSSEEvent,
  ResponsesUsage,
} from "./responses.ts";

export const responsesMaxCanonicalItemBytes = 128 * 1024;
export const responsesMaxMetadataBytes = 16 * 1024;

export const errResponsesStop = new Error(
  "responses stream reached terminal event",
);
export const errResponsesAbort = new Error("responses stream aborted");
export const errResponsesComputerUseUnsupported = new Error(
  "Responses computer use is not supported by this version",
);

export interface ResponsesSSEFrame {
  event: string;
  id: string;
  data: string;
  sequence: number;
}

/**
 * Streaming SSE frame reader for the Responses API. It deliberately leaves JSON
 * decoding to the schema-aware event normalizer. Accepts a streaming body or a
 * raw string (used by tests).
 */
export async function* responsesSSEFrames(
  input: ReadableStream<Uint8Array> | string | null,
): AsyncGenerator<ResponsesSSEFrame> {
  let eventName = "";
  let eventID = "";
  let data: string[] = [];
  let sequence = 0;

  const dispatch = (): ResponsesSSEFrame | undefined => {
    if (data.length === 0) {
      eventName = "";
      eventID = "";
      return undefined;
    }
    sequence++;
    const frame: ResponsesSSEFrame = {
      event: eventName,
      id: eventID,
      data: data.join("\n"),
      sequence,
    };
    eventName = "";
    eventID = "";
    data = [];
    return frame;
  };

  const handleLine = (line: string): ResponsesSSEFrame | undefined => {
    line = line.replace(/\n$/, "").replace(/\r$/, "");
    if (line === "") {
      return dispatch();
    }
    if (line.startsWith(":")) {
      // SSE comments are keep-alive frames.
      return undefined;
    }
    let field = line;
    let value = "";
    const colon = line.indexOf(":");
    if (colon >= 0) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "id":
        eventID = value;
        break;
      case "data":
        data.push(value);
        // A number of OpenAI-compatible gateways emit one complete JSON event
        // per line without the blank-line separator required by SSE. Preserve
        // that legacy behavior while still supporting multi-line data frames.
        if (eventName === "" && eventID === "") {
          const joined = data.join("\n");
          if (joined === "[DONE]" || isValidJSON(joined)) {
            return dispatch();
          }
        }
        break;
      default:
        break;
    }
    return undefined;
  };

  if (typeof input === "string") {
    const lines = input.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      // Preserve the trailing newline semantics: the final empty string after a
      // trailing \n is skipped, matching Go's ReadString loop.
      if (isLast && lines[i] === "") break;
      const frame = handleLine(lines[i]);
      if (frame !== undefined) yield frame;
    }
    const final = dispatch();
    if (final !== undefined) yield final;
    return;
  }

  if (input === null) return;
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const frame = handleLine(line);
      if (frame !== undefined) yield frame;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) {
    const frame = handleLine(buffer);
    if (frame !== undefined) yield frame;
  }
  const final = dispatch();
  if (final !== undefined) yield final;
}

/** Consumes SSE frames, returning the first callback error (or undefined). */
export async function decodeResponsesSSE(
  input: ReadableStream<Uint8Array> | string | null,
  fn: (frame: ResponsesSSEFrame) => Error | undefined,
): Promise<Error | undefined> {
  for await (const frame of responsesSSEFrames(input)) {
    const err = fn(frame);
    if (err !== undefined) return err;
  }
  return undefined;
}

function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export interface ResponsesResponseItem {
  id: string;
  type: string;
  status: string;
  outputIndex: number;
  callID: string;
  name: string;
  /** raw JSON text of the tool arguments */
  arguments?: string;
  input: string;
  /** canonical redacted item JSON text */
  canonical?: string;
}

export interface ResponsesNormalizedResponse {
  id: string;
  status: string;
  previousResponseID: string;
  conversationID: string;
  incompleteReason: string;
  usage?: ResponsesUsage;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
  items: ResponsesResponseItem[];
  unknownItems: number;
  unknownEventTypes: string[];
  unsupportedItemTypes: string[];
}

export interface ProviderToolCall {
  key: string;
  id: string;
  itemID: string;
  name: string;
  kind: string;
  input: string;
  /** raw JSON text */
  arguments?: string;
}

export class ResponsesNormalizer {
  items = new Map<string, ResponsesResponseItem>();
  itemOrder: string[] = [];
  argumentBytes = new Map<string, string>();
  response: ResponsesNormalizedResponse = {
    id: "",
    status: "",
    previousResponseID: "",
    conversationID: "",
    incompleteReason: "",
    items: [],
    unknownItems: 0,
    unknownEventTypes: [],
    unsupportedItemTypes: [],
  };
  hostedPolicies?: Record<string, ResponsesHostedPolicy>;

  apply(event: ResponsesSSEEvent, raw: string): Error | undefined {
    if (event.response !== undefined && event.response !== null) {
      this.applyResponse(event.response);
    }

    switch (event.type) {
      case "response.created":
      case "response.queued":
      case "response.in_progress":
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.refusal.delta":
      case "response.refusal.done":
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_part.done":
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done":
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
      case "error":
        // These events are handled by the stream parser or response envelope;
        // keeping them explicit prevents them from being reported as unknown.
        break;
      case "response.output_item.added":
      case "response.output_item.done": {
        if (event.item === undefined || event.item === null) {
          return new Error(
            `responses event ${JSON.stringify(event.type)} is missing item`,
          );
        }
        const item = this.upsertItem(
          event.item,
          event.output_index ?? 0,
          responsesEventItemRaw(raw),
        );
        if (isUnsupportedResponsesItemType(item.type)) {
          this.recordUnsupportedItemType(item.type);
        }
        if (
          event.type === "response.output_item.done" &&
          item.type === "function_call"
        ) {
          if (item.arguments === undefined || item.arguments === "") {
            item.arguments = this.arguments(
              event.item.id ?? "",
              event.output_index ?? 0,
            );
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const keyErr = responsesEventItemKey(
          event.item_id ?? "",
          event.output_index ?? -1,
        );
        if (keyErr !== undefined) return keyErr;
        const key = responsesToolKey(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if ((event.delta ?? "") !== "") {
          this.argumentBytes.set(
            key,
            (this.argumentBytes.get(key) ?? "") + event.delta,
          );
        }
        const item = this.ensureItem(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if (item.type === "") item.type = "function_call";
        item.arguments = this.arguments(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        break;
      }
      case "response.function_call_arguments.done": {
        const keyErr = responsesEventItemKey(
          event.item_id ?? "",
          event.output_index ?? -1,
        );
        if (keyErr !== undefined) return keyErr;
        const key = responsesToolKey(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if (event.arguments !== undefined && event.arguments !== "") {
          this.argumentBytes.set(key, responsesArgumentsText(event.arguments));
        }
        const item = this.ensureItem(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if (item.type === "") item.type = "function_call";
        item.arguments = this.arguments(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        break;
      }
      case "response.custom_tool_call_input.delta": {
        const keyErr = responsesEventItemKey(
          event.item_id ?? "",
          event.output_index ?? -1,
        );
        if (keyErr !== undefined) return keyErr;
        const key = responsesToolKey(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if ((event.delta ?? "") !== "") {
          this.argumentBytes.set(
            key,
            (this.argumentBytes.get(key) ?? "") + event.delta,
          );
        }
        const item = this.ensureItem(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if (item.type === "") item.type = "custom_tool_call";
        item.input =
          this.arguments(event.item_id ?? "", event.output_index ?? 0) ??
            "";
        break;
      }
      case "response.custom_tool_call_input.done": {
        const keyErr = responsesEventItemKey(
          event.item_id ?? "",
          event.output_index ?? -1,
        );
        if (keyErr !== undefined) return keyErr;
        const key = responsesToolKey(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if ((event.input ?? "") !== "") {
          this.argumentBytes.set(key, event.input ?? "");
        }
        const item = this.ensureItem(
          event.item_id ?? "",
          event.output_index ?? 0,
        );
        if (item.type === "") item.type = "custom_tool_call";
        item.input =
          this.arguments(event.item_id ?? "", event.output_index ?? 0) ??
            "";
        break;
      }
      default:
        this.recordUnknownEventType(event.type);
    }

    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      this.applyResponse(event.response);
    }
    return undefined;
  }

  recordUnknownEventType(eventType: string): void {
    if (eventType === "") return;
    if (this.response.unknownEventTypes.includes(eventType)) return;
    if (this.response.unknownEventTypes.length >= 16) return;
    this.response.unknownEventTypes.push(eventType);
  }

  applyResponse(response: ResponsesCompletedObject | undefined | null): void {
    if (response === undefined || response === null) return;
    this.response.id = response.id ?? "";
    this.response.status = response.status ?? "";
    this.response.previousResponseID = response.previous_response_id ?? "";
    this.response.conversationID = responsesConversationID(response);
    this.response.usage = response.usage;
    this.response.error = response.error;
    if (response.incomplete_details !== undefined) {
      this.response.incompleteReason = response.incomplete_details?.reason ??
        "";
    }
    const output = response.output ?? [];
    for (let index = 0; index < output.length; index++) {
      const item = decodeResponsesOutputItem(output[index], index);
      if (item === undefined) continue;
      this.upsertDecodedItem(item);
      if (isUnsupportedResponsesItemType(item.type)) {
        this.recordUnsupportedItemType(item.type);
      }
    }
  }

  upsertItem(
    item: ResponsesOutputItem,
    outputIndex: number,
    raw: string,
  ): ResponsesResponseItem {
    const decoded: ResponsesResponseItem = {
      id: item.id ?? "",
      type: item.type ?? "",
      status: item.status ?? "",
      outputIndex,
      callID: item.call_id ?? "",
      name: item.name ?? "",
      arguments: responsesArgumentsRaw(item.arguments),
      input: item.input ?? "",
      canonical: canonicalResponsesJSON(raw, responsesMaxCanonicalItemBytes),
    };
    this.upsertDecodedItem(decoded);
    return decoded;
  }

  upsertDecodedItem(item: ResponsesResponseItem): void {
    let key = responsesToolKey(item.id, item.outputIndex);
    // Some gateways omit item.id in response.completed.output even though the
    // streaming output_item.added event included it. Output indexes are unique
    // within a response, so merge that completion snapshot into the streamed
    // item instead of archiving/replaying it as a second item.
    if (item.id === "") {
      for (const existingKey of this.items.keys()) {
        const existing = this.items.get(existingKey);
        if (
          existing !== undefined && existing.outputIndex === item.outputIndex
        ) {
          key = existingKey;
          break;
        }
      }
    }
    const existing = this.items.get(key);
    if (existing !== undefined) {
      if (item.id !== "") existing.id = item.id;
      if (item.type !== "") existing.type = item.type;
      if (item.status !== "") existing.status = item.status;
      if (item.callID !== "") existing.callID = item.callID;
      if (item.name !== "") existing.name = item.name;
      if (item.arguments !== undefined && item.arguments !== "") {
        existing.arguments = item.arguments;
      }
      if (item.input !== "") existing.input = item.input;
      if (item.canonical !== undefined && item.canonical !== "") {
        existing.canonical = item.canonical;
      }
      return;
    }
    this.items.set(key, item);
    this.itemOrder.push(key);
    this.response.items.push(item);
    if (!isKnownResponsesItemType(item.type)) {
      this.response.unknownItems++;
    }
    if (isUnsupportedResponsesItemType(item.type)) {
      this.recordUnsupportedItemType(item.type);
    }
  }

  recordUnsupportedItemType(itemType: string): void {
    if (itemType === "") return;
    if (this.response.unsupportedItemTypes.includes(itemType)) return;
    this.response.unsupportedItemTypes.push(itemType);
  }

  ensureItem(itemID: string, outputIndex: number): ResponsesResponseItem {
    const key = responsesToolKey(itemID, outputIndex);
    const existing = this.items.get(key);
    if (existing !== undefined) return existing;
    const item: ResponsesResponseItem = {
      id: itemID,
      type: "",
      status: "",
      outputIndex,
      callID: "",
      name: "",
      input: "",
    };
    this.upsertDecodedItem(item);
    return item;
  }

  arguments(itemID: string, outputIndex: number): string | undefined {
    const key = responsesToolKey(itemID, outputIndex);
    return this.argumentBytes.get(key);
  }

  toolCalls(): ProviderToolCall[] {
    const calls: ProviderToolCall[] = [];
    for (const key of this.itemOrder) {
      const item = this.items.get(key);
      if (item === undefined) continue;
      if (item.type !== "function_call" && item.type !== "custom_tool_call") {
        continue;
      }
      let args = item.arguments;
      const input = item.input;
      let kind = "function";
      if (item.type === "custom_tool_call") {
        kind = "custom";
        let customInput = input;
        if (customInput === "") {
          customInput = this.arguments(item.id, item.outputIndex) ?? "";
        }
        args = JSON.stringify({ input: customInput });
      } else if (args === undefined || args === "") {
        args = this.arguments(item.id, item.outputIndex);
      }
      calls.push({
        key,
        id: item.callID,
        itemID: item.id,
        name: item.name,
        kind,
        input,
        arguments: args,
      });
    }
    return calls;
  }

  metadata(): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {
      itemCount: this.response.items.length,
    };
    if (this.response.unknownItems > 0) {
      metadata["unknownItemCount"] = this.response.unknownItems;
    }
    if (this.response.unknownEventTypes.length > 0) {
      metadata["unknownEventTypes"] = [...this.response.unknownEventTypes];
    }
    if (this.response.unsupportedItemTypes.length > 0) {
      metadata["unsupportedItemTypes"] = [
        ...this.response.unsupportedItemTypes,
      ];
      metadata["computerUseRejected"] = true;
    }
    if (this.response.id !== "") metadata["responseId"] = this.response.id;
    if (this.response.status !== "") {
      metadata["responseStatus"] = this.response.status;
    }
    if (this.response.previousResponseID !== "") {
      metadata["previousResponseId"] = this.response.previousResponseID;
    }
    if (this.response.conversationID !== "") {
      metadata["conversationId"] = this.response.conversationID;
    }
    if (this.response.incompleteReason !== "") {
      metadata["incompleteReason"] = this.response.incompleteReason;
    }
    return limitResponsesMetadata(metadata);
  }

  unsupportedError(): Error | undefined {
    if (this.response.unsupportedItemTypes.length === 0) return undefined;
    return new Error(
      `${errResponsesComputerUseUnsupported.message}: item type ${
        JSON.stringify(this.response.unsupportedItemTypes[0])
      }`,
    );
  }

  hostedPolicyError(): Error | undefined {
    const policy = this.hostedPolicies?.["code_interpreter"];
    if (policy === undefined || !policy.configured || !policy.maxCallsSet) {
      return undefined;
    }
    let count = 0;
    for (const item of this.response.items) {
      if (item.type === "code_interpreter_call") count++;
    }
    if (count > policy.maxCalls) {
      return new Error(
        `code interpreter call quota exceeded: ${count} calls (limit ${policy.maxCalls})`,
      );
    }
    return undefined;
  }

  attachments(): Attachment[] {
    const seen = new Set<string>();
    const attachments: Attachment[] = [];
    for (const item of this.response.items) {
      if (item.canonical === undefined || item.canonical === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(item.canonical);
      } catch {
        continue;
      }
      // The registry is consulted here as an observation boundary. It does not
      // reject unknown types; canonical archive preservation remains
      // forward-compatible with newer upstream hosted items.
      collectResponsesAttachments(
        value,
        item.id,
        item.type,
        item.status,
        "",
        "",
        seen,
        attachments,
      );
    }
    return attachments;
  }
}

export function newResponsesNormalizer(): ResponsesNormalizer {
  return new ResponsesNormalizer();
}

/**
 * Only exposes references from known output contexts. In particular, it does
 * not turn arbitrary URLs (for example a remote MCP server URL) into clickable
 * UI attachments.
 */
export function collectResponsesAttachments(
  value: unknown,
  itemID: string,
  rootType: string,
  status: string,
  parentType: string,
  inheritedContainerID: string,
  seen: Set<string>,
  out: Attachment[],
): void {
  // A remote MCP server controls its own output payload. Do not convert its
  // nested URLs into browser-visible attachments before a dedicated MCP
  // lifecycle has applied its egress and provenance policies. The registry is
  // intentionally advisory: unknown future item types remain archivable.
  const descriptor = hostedToolDescriptorForType(rootType);
  if (descriptor !== undefined && descriptor.attachmentKinds.length === 0) {
    return;
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      collectResponsesAttachments(
        nested,
        itemID,
        rootType,
        status,
        parentType,
        inheritedContainerID,
        seen,
        out,
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  const typed = value as Record<string, unknown>;
  let containerID = inheritedContainerID;
  const currentContainer = typed["container_id"];
  if (typeof currentContainer === "string" && currentContainer !== "") {
    containerID = currentContainer;
  }
  let itemType = typeof typed["type"] === "string" ? typed["type"] : "";
  if (itemType === "") itemType = parentType;
  const lowerType = itemType.toLowerCase();
  if (lowerType === "code_interpreter_call") {
    const cid = typed["container_id"];
    if (typeof cid === "string" && cid !== "" && itemID !== "") {
      const key = `artifact\x00${itemID}\x00${cid}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          kind: "artifact",
          name: "Code Interpreter container",
          providerRef: cid,
          metadata: responsesAttachmentMetadata(
            typed,
            itemID,
            rootType,
            status,
            {
              tool: "code_interpreter",
            },
          ),
        });
      }
    }
  }
  if (lowerType === "image_generation_call") {
    const encoded = typed["result"];
    if (typeof encoded === "string" && encoded !== "" && itemID !== "") {
      const sum = sha256Hex(encoded);
      const key = `image\x00${itemID}\x00${sum}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          kind: "image",
          name: "generated image",
          mediaType: "image/png",
          providerRef: itemID,
          metadata: responsesAttachmentMetadata(
            typed,
            itemID,
            rootType,
            status,
            {
              sha256: sum,
              encodedBytes: encoded.length,
            },
          ),
        });
      }
    }
  }
  let kind = "";
  if (lowerType.includes("file") || lowerType.includes("container")) {
    kind = "file";
  } else if (lowerType.includes("citation") || lowerType.includes("search")) {
    kind = "citation";
  } else if (lowerType.includes("image")) {
    kind = "image";
  }
  if (kind !== "") {
    let attachmentURL = typeof typed["url"] === "string" ? typed["url"] : "";
    if (attachmentURL === "") {
      attachmentURL = typeof typed["file_url"] === "string"
        ? typed["file_url"]
        : "";
    }
    attachmentURL = safeResponsesAttachmentURL(attachmentURL);
    let name = typeof typed["title"] === "string" ? typed["title"] : "";
    if (name === "") {
      name = typeof typed["filename"] === "string" ? typed["filename"] : "";
    }
    let ref = typeof typed["file_id"] === "string" ? typed["file_id"] : "";
    if (ref === "") {
      ref = typeof typed["container_id"] === "string"
        ? typed["container_id"]
        : "";
    }
    // Keep text annotations even when a gateway omits the URL or file reference.
    // Their offsets/title/type remain useful provenance and allow a later
    // provider-specific resolver to enrich the citation.
    const hasStart = "start_index" in typed;
    const hasEnd = "end_index" in typed;
    if (
      attachmentURL !== "" || ref !== "" ||
      (kind === "citation" && (hasStart || hasEnd))
    ) {
      const key = `${kind}\x00${attachmentURL}\x00${ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        const extra: Record<string, unknown> = {
          annotationType: itemType,
          title: name,
        };
        if (containerID !== "") extra["containerId"] = containerID;
        const metadata = responsesAttachmentMetadata(
          typed,
          itemID,
          rootType,
          status,
          extra,
        );
        out.push({
          kind,
          name,
          url: attachmentURL === "" ? undefined : attachmentURL,
          providerRef: ref === "" ? undefined : ref,
          metadata,
        });
      }
    }
  }
  for (const nested of Object.values(typed)) {
    collectResponsesAttachments(
      nested,
      itemID,
      rootType,
      status,
      itemType,
      containerID,
      seen,
      out,
    );
  }
}

/**
 * Keeps provider output from becoming an active browser target unless it is a
 * credential-free HTTPS URL. References without a safe URL are still archived
 * through providerRef for audit and future provider-specific retrieval.
 */
export function safeResponsesAttachmentURL(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL((raw ?? "").trim());
  } catch {
    return "";
  }
  if (
    parsed.protocol !== "https:" || parsed.host === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    return "";
  }
  if (isPrivateNetworkIP(host)) return "";
  // Go reconstructs the URL from url.Parse and returns it without a path when
  // the input omitted one; the WHATWG URL always materializes "/".
  if (parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") {
    return `${parsed.protocol}//${parsed.host}`;
  }
  return parsed.toString();
}

function sha256Hex(text: string): string {
  // Go uses crypto/sha256 synchronously. Deno's WebCrypto SubtleCrypto is
  // async, so use node:crypto's synchronous createHash for byte-accurate
  // digests in the same call sites (dedup keys and truncation metadata).
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Retains only stable output provenance. It is deliberately derived from
 * canonical, redacted items rather than arbitrary remote MCP fields or raw tool
 * payloads.
 */
export function responsesAttachmentMetadata(
  value: Record<string, unknown>,
  itemID: string,
  itemType: string,
  status: string,
  extra: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (itemID !== "") metadata["responseItemId"] = itemID;
  if (itemType !== "") metadata["responseItemType"] = itemType;
  if (status !== "") metadata["status"] = status;
  const containerID = value["container_id"];
  if (typeof containerID === "string" && containerID !== "") {
    metadata["containerId"] = containerID;
  }
  for (const field of ["score", "start_index", "end_index"]) {
    if (field in value) metadata[field] = value[field];
  }
  for (const [key, fieldValue] of Object.entries(extra)) {
    metadata[key] = fieldValue;
  }
  if (Object.keys(metadata).length === 0) return undefined;
  return metadata;
}

export function responsesEventItemKey(
  itemID: string,
  outputIndex: number,
): Error | undefined {
  if (itemID === "" && outputIndex < 0) {
    return new Error("responses event is missing item identity");
  }
  return undefined;
}

export function decodeResponsesOutputItem(
  raw: string | Record<string, unknown>,
  outputIndex: number,
): ResponsesResponseItem | undefined {
  // Go's json.RawMessage is byte-oriented; the port receives either the raw
  // wire text or the already-parsed response object. Canonicalize once here so
  // both shapes archive identically.
  let rawText: string;
  let parsed: Record<string, unknown>;
  if (typeof raw === "string") {
    rawText = raw;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else {
    try {
      rawText = JSON.stringify(raw);
    } catch {
      return undefined;
    }
    parsed = raw;
  }
  const id = typeof parsed["id"] === "string" ? parsed["id"] : "";
  const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
  const canonical = canonicalResponsesJSON(
    rawText,
    responsesMaxCanonicalItemBytes,
  );
  if (type === "") {
    return {
      id,
      type: "",
      status: "",
      outputIndex,
      callID: "",
      name: "",
      input: "",
      canonical,
    };
  }
  return {
    id,
    type,
    status: typeof parsed["status"] === "string" ? parsed["status"] : "",
    outputIndex,
    callID: typeof parsed["call_id"] === "string" ? parsed["call_id"] : "",
    name: typeof parsed["name"] === "string" ? parsed["name"] : "",
    arguments: responsesArgumentsRaw(parsed["arguments"]),
    input: typeof parsed["input"] === "string" ? parsed["input"] : "",
    canonical,
  };
}

export function responsesArgumentsRaw(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    // Go distinguishes a JSON string literal (unquoted) from raw object bytes.
    // A decoded string is already unquoted here.
    return raw;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}

export function responsesArgumentsText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

export function responsesEventItemRaw(raw: string): string {
  try {
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    if (envelope["item"] !== undefined && envelope["item"] !== null) {
      return JSON.stringify(envelope["item"]);
    }
  } catch {
    // fall through
  }
  return raw;
}

export function isKnownResponsesItemType(itemType: string): boolean {
  switch (itemType) {
    case "message":
    case "reasoning":
    case "function_call":
    case "function_call_output":
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "item_reference":
    case "web_search_call":
    case "file_search_call":
    case "code_interpreter_call":
    case "image_generation_call":
    case "mcp_call":
    case "mcp_call_output":
      return true;
    default:
      return false;
  }
}

export function isUnsupportedResponsesItemType(itemType: string): boolean {
  switch (itemType) {
    case "computer_call":
    case "computer_call_output":
      return true;
    default:
      return false;
  }
}

export function canonicalResponsesJSON(
  raw: string,
  maxBytes: number,
): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const redacted = redactResponsesValue(value);
  let canonical: string;
  try {
    canonical = JSON.stringify(redacted);
  } catch {
    return undefined;
  }
  const byteLength = new TextEncoder().encode(canonical).length;
  if (byteLength <= maxBytes) return canonical;
  const truncated = JSON.stringify({
    _truncated: true,
    sha256: sha256Hex(canonical),
    bytes: byteLength,
  });
  return truncated;
}

export function redactResponsesValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => redactResponsesValue(nested));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (
      const [key, nested] of Object.entries(value as Record<string, unknown>)
    ) {
      if (isSensitiveResponsesKey(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = redactResponsesValue(nested);
    }
    return result;
  }
  return value;
}

export function isSensitiveResponsesKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("-", "_").replaceAll(
    " ",
    "_",
  );
  for (
    const marker of [
      "authorization",
      "api_key",
      "apikey",
      "access_token",
      "refresh_token",
      "secret",
      "password",
      "cookie",
      "credential",
    ]
  ) {
    if (normalized.includes(marker)) return true;
  }
  return false;
}

export function limitResponsesMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined || Object.keys(metadata).length === 0) {
    return undefined;
  }
  let encoded = "";
  try {
    encoded = JSON.stringify(metadata);
  } catch {
    return { metadataTruncated: true };
  }
  if (new TextEncoder().encode(encoded).length <= responsesMaxMetadataBytes) {
    return metadata;
  }
  return { metadataTruncated: true };
}

export function responsesToolKey(itemID: string, outputIndex: number): string {
  if (itemID !== "") return `${itemID}#${outputIndex}`;
  return String(outputIndex);
}

export function responsesConversationID(
  response: ResponsesCompletedObject | undefined | null,
): string {
  if (response === undefined || response === null) return "";
  const raw = response.conversation;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    if (typeof value["id"] === "string") return value["id"];
  }
  return "";
}

function isPrivateNetworkIP(host: string): boolean {
  host = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (host.includes(":")) {
    const lower = host.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (
      lower.startsWith("fe80") || lower.startsWith("fc") ||
      lower.startsWith("fd")
    ) {
      return true;
    }
    return false;
  }
  const parts = host.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
