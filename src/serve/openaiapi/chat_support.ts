// Ported from internal/serve/openaiapi/handler_chat.go (the pure helper half,
// including the assistant transcript-event builders and the tool-status
// summary cluster) plus events.go's `safeHostedItemRunData`. The server-bound
// handler stays with the later server slice; these helpers carry no runtime
// state (the agentruntime error classifier they call is a pure function).
//
// requestRunInput decodes the OpenAI-compatible transport envelope into
// Runtime-neutral text and authenticated one-shot byte streams. It never
// creates provider content; SessionRuntime.BuildUserMessage is the only
// conversion from these inputs to a provider.Message.

import { AttachmentImage } from "../../agentruntime/attachment.ts";
import type {
  InputIngress,
  InputStream,
  RunInput,
} from "../../agentruntime/input_materializer.ts";
import type { Model } from "../../provider/types.ts";
import {
  type Attachment,
  type HostedItem,
  type Message,
  newAssistantMessage,
  newUserMessage,
} from "../../provider/types.ts";
import {
  type Event,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  type TaskStatus,
} from "../../agent/events.ts";
import {
  classifyError,
  displayErrorMessage,
  PhaseModel,
  PhaseTool,
  SideEffectUnknown,
} from "../../agentruntime/error_info.ts";
import { truncateWithSuffix } from "../../util/truncate.ts";
import type { SessionMessageEntry } from "./session_mgr.ts";
import { planFromToolCall, validRawMessage } from "./session_mgr.ts";
import type {
  HostedItemEvent,
  RequestMessage,
  TranscriptStreamEvent,
} from "./types.ts";

/**
 * parseMessages extracts the last user message, system messages, and history
 * messages.
 */
export function parseMessages(msgs: RequestMessage[]): {
  lastUser: RequestMessage;
  systemMsgs: string[];
  history: RequestMessage[];
} {
  const systemMsgs: string[] = [];
  for (const m of msgs) {
    if (m.role === "system") systemMsgs.push(m.content);
  }

  // Find the last user message
  let lastIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) {
    return { lastUser: { role: "", content: "" }, systemMsgs, history: [] };
  }
  const lastUser = msgs[lastIdx];

  // Everything before the last user message (excluding system) is history
  const history: RequestMessage[] = [];
  for (let i = 0; i < lastIdx; i++) {
    if (msgs[i].role !== "system") history.push(msgs[i]);
  }
  return { lastUser, systemMsgs, history };
}

export function requestRunInput(
  m: RequestMessage,
): { input: RunInput; ingresses: InputIngress[] } {
  const contentParts = m.contentParts ?? [];
  if (contentParts.length === 0) {
    return {
      input: {
        text: m.content,
        resources: [],
        knowledgeBaseReferences: [],
        knowledgeCapsules: [],
        idempotencyKey: "",
      },
      ingresses: [],
    };
  }
  let text = m.content.trim();
  const textParts: string[] = [];
  const ingresses: InputIngress[] = [];
  contentParts.forEach((part, index) => {
    switch (part.type) {
      case "text":
        if (part.text !== undefined && part.text.trim() !== "") {
          textParts.push(part.text);
        }
        break;
      case "image_url": {
        if (part.image_url === undefined || part.image_url.url.trim() === "") {
          throw new Error("image_url content part is missing url");
        }
        const { mediaType, data } = decodeRequestImageDataURL(
          part.image_url.url,
        );
        ingresses.push(requestImageIngress(index, mediaType, data));
        break;
      }
      case "image": {
        if (
          part.image === undefined || part.image.data === "" ||
          part.image.mimeType === ""
        ) {
          throw new Error("image content part is missing data or mimeType");
        }
        validateImagePayload(part.image.mimeType, part.image.data);
        const data = base64Decode(part.image.data);
        ingresses.push(requestImageIngress(index, part.image.mimeType, data));
        break;
      }
      default:
        throw new Error(`unsupported content part type "${part.type}"`);
    }
  });
  if (text === "") text = textParts.join("\n");
  return {
    input: {
      text,
      resources: [],
      knowledgeBaseReferences: [],
      knowledgeCapsules: [],
      idempotencyKey: "",
    },
    ingresses,
  };
}

function requestImageIngress(
  index: number,
  mediaType: string,
  data: Uint8Array,
): InputIngress {
  let filename = `image-${index + 1}`;
  if (mediaType.toLowerCase() === "image/jpeg") {
    filename += ".jpg";
  } else {
    const suffix = mediaType.toLowerCase().replace(/^image\//, "");
    if (suffix !== "") filename += `.${suffix}`;
  }
  return {
    origin: "api:chat-completions",
    eventId: "",
    itemIndex: index,
    reference: "inline-image",
    kind: AttachmentImage,
    filenameHint: filename,
    mediaTypeHint: mediaType,
    sizeHint: data.byteLength,
    open: (_signal: AbortSignal | undefined): InputStream => ({
      bytes: data,
      filename,
      mediaType,
      contentSize: data.byteLength,
    }),
  };
}

export function decodeRequestImageDataURL(dataURL: string): {
  mediaType: string;
  data: Uint8Array;
} {
  const marker = ";base64,";
  if (!dataURL.startsWith("data:image/")) {
    throw new Error("image_url must be a data:image URL");
  }
  const idx = dataURL.indexOf(marker);
  if (idx < 0) {
    throw new Error("image_url must contain base64 image data");
  }
  const mediaType = dataURL.slice("data:".length, idx);
  const encoded = dataURL.slice(idx + marker.length);
  validateImagePayload(mediaType, encoded);
  const data = base64Decode(encoded);
  return { mediaType, data };
}

export function validateImagePayload(mimeType: string, data: string): void {
  switch (mimeType) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      break;
    default:
      throw new Error(`unsupported image MIME type "${mimeType}"`);
  }
  try {
    base64Decode(data);
  } catch {
    throw new Error("invalid base64 image data");
  }
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** convertHistoryMessages converts OpenAI-format history to provider messages. */
export function convertHistoryMessages(msgs: RequestMessage[]): Message[] {
  const result: Message[] = [];
  for (const m of msgs) {
    switch (m.role) {
      case "user": {
        let text = m.content.trim();
        if (text === "") {
          const parts: string[] = [];
          for (const part of m.contentParts ?? []) {
            if (
              part.type === "text" && part.text !== undefined &&
              part.text.trim() !== ""
            ) {
              parts.push(part.text);
            }
          }
          text = parts.join("\n");
        }
        if (text !== "") result.push(newUserMessage(text));
        break;
      }
      case "assistant":
        result.push(newAssistantMessage([{ type: "text", text: m.content }]));
        break;
    }
  }
  return result;
}

/**
 * resolveToolEvent extracts tool name and call ID from an agent event,
 * falling back to ToolCall fields when top-level fields are empty.
 */
export function resolveToolEvent(ev: Event): { name: string; callID: string } {
  let name = ev.toolName ?? "";
  let callID = ev.toolCallId ?? "";
  if (ev.toolCall !== undefined && ev.toolCall !== null) {
    if (name === "") name = ev.toolCall.name;
    if (callID === "") callID = ev.toolCall.id;
  }
  return { name, callID };
}

/** modelIDs returns a comma-separated list of model IDs for error messages. */
export function modelIDs(models: { id: string }[]): string {
  return models.map((m) => m.id).join(", ");
}

export function hostedItemEvent(
  item: HostedItem | null,
): HostedItemEvent | null {
  if (item === null) return null;
  const safe = safeHostedItemRunData(item);
  const result: HostedItemEvent = {
    id: safe["id"] as string,
    type: safe["type"] as string,
    status: safe["status"] as string,
    outputIndex: safe["outputIndex"] as number,
  };
  if (safe["metadata"] !== undefined) {
    result.metadata = safe["metadata"] as Record<string, unknown>;
  }
  return result;
}

export function isOutputTruncationStopReason(reason: string): boolean {
  return ["length", "max_tokens", "max_output_tokens", "token_limit"].some(
    (candidate) => candidate.toLowerCase() === reason.toLowerCase(),
  );
}

/** subAgentStatusForTaskStatus maps the canonical TaskStatus to the transcript status string. */
export function subAgentStatusForTaskStatus(status: TaskStatus): string {
  switch (status) {
    case TaskFailed:
      return "error";
    case TaskIncomplete:
      return "incomplete";
    case TaskCanceled:
      return "canceled";
    default:
      return "done";
  }
}

export function sameWorkDir(a: string, b: string): boolean {
  if (a === "" || b === "") return a === b;
  // Go cleans both paths; the runtime is not Windows today, so the Windows
  // case-folding branch of the Go helper is unreachable (windows-only).
  return cleanPath(a) === cleanPath(b);
}

/** cloneModel copies a Model deeply enough for per-run mutation isolation. */
export function cloneModel(model: Model | undefined): Model | undefined {
  if (!model) return undefined;
  const copy: Model = { ...model, input: [...model.input] };
  if (model.compat) copy.compat = { ...model.compat };
  return copy;
}

/** A minimal filepath.Clean equivalent for work-directory comparisons. */
function cleanPath(p: string): string {
  const isAbs = p.startsWith("/");
  const parts: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      else if (!isAbs) parts.push("..");
    } else {
      parts.push(segment);
    }
  }
  const joined = parts.join("/");
  if (isAbs) return "/" + joined;
  return joined === "" ? "." : joined;
}

// --- events.go: safe hosted-item projection ---

/**
 * safeHostedItemRunData keeps durable hosted lifecycle events useful for
 * reconnects without persisting arbitrary provider metadata. Canonical output
 * remains in the provider archive, where its dedicated redaction/size policy
 * applies.
 */
export function safeHostedItemRunData(
  item: HostedItem | null,
): Record<string, unknown> {
  if (item === null) return {};
  const data: Record<string, unknown> = {
    id: boundedHostedString(item.id ?? ""),
    type: boundedHostedString(item.type ?? ""),
    status: boundedHostedString(item.status ?? ""),
    outputIndex: item.outputIndex ?? 0,
  };
  const allowed = new Set([
    "annotationType",
    "title",
    "start_index",
    "end_index",
    "score",
    "responseItemId",
    "responseItemType",
    "status",
    "tool",
  ]);
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.metadata ?? {})) {
    if (!allowed.has(key)) continue;
    if (typeof value === "string") {
      metadata[key] = boundedHostedString(value);
    } else if (
      typeof value === "boolean" || typeof value === "number" || value === null
    ) {
      metadata[key] = value;
    }
  }
  if (Object.keys(metadata).length > 0) data["metadata"] = metadata;
  return data;
}

const maxHostedRunString = 512;

function boundedHostedString(value: string): string {
  if (value.length <= maxHostedRunString) return value;
  return value.slice(0, maxHostedRunString) + "...";
}

// --- handler_chat.go: assistant transcript builders and tool-status summary ---

export function errorString(err: unknown): string {
  if (err === null || err === undefined) return "";
  return safeAgentErrorMessage(err);
}

export function safeAgentErrorMessage(err: unknown): string {
  const info = classifyError(err, {
    phase: PhaseModel,
    sideEffectState: SideEffectUnknown,
  });
  const message = displayErrorMessage(info).trim();
  if (message !== "") return message;
  return "The run could not be completed.";
}

export function assistantDeltaTranscriptEvent(
  text: string,
  agentId: string,
  ...memberEvent: Event[]
): TranscriptStreamEvent {
  const entry: SessionMessageEntry = {
    agentId,
    role: "assistant",
    content: text,
  };
  if (memberEvent.length > 0) {
    applyMemberEventMetadata(entry, memberEvent[0]);
  }
  return { type: "assistant_delta", message: entry };
}

export function assistantAttachmentsTranscriptEvent(
  items: Attachment[],
  agentId: string,
): TranscriptStreamEvent {
  return {
    type: "attachments",
    message: {
      agentId,
      role: "assistant",
      attachments: items ? [...items] : [],
    },
  };
}

export function messageTranscriptEvent(
  entry: SessionMessageEntry,
): TranscriptStreamEvent {
  return { type: "message", message: entry };
}

export function subAgentStatusTranscriptEvent(
  agentId: string,
  status: string,
  summary: string,
  ...memberEvent: Event[]
): TranscriptStreamEvent {
  const entry: SessionMessageEntry = {
    agentId,
    role: "status",
    content: status,
    summary,
    isError: status === "error",
  };
  if (memberEvent.length > 0) {
    applyMemberEventMetadata(entry, memberEvent[0]);
  }
  return { type: "subagent_status", message: entry };
}

export function applyMemberEventMetadata(
  entry: SessionMessageEntry | null | undefined,
  ev: Event,
): void {
  if (!entry || !ev.memberId) return;
  entry.memberId = ev.memberId;
  entry.expertId = ev.expertId;
  entry.memberDisplayName = ev.memberDisplayName;
  entry.memberEmoji = ev.memberEmoji;
  entry.memberRole = ev.memberRole;
}

/**
 * transcriptToolCallEntry ports handler_chat.go's tool-call transcript entry
 * builder. `ev.toolCall` overrides the resolved name/call ID and carries the
 * raw arguments when present.
 */
export function transcriptToolCallEntry(
  name: string,
  callID: string,
  ev: Event,
): SessionMessageEntry {
  let entryName = name;
  let entryCallID = callID;
  let args = rawToolArgs(ev.toolArgs);
  let invalidArguments = "";
  const toolCall = ev.toolCall;
  if (toolCall) {
    if (toolCall.name !== "") entryName = toolCall.name;
    if (toolCall.id !== "") entryCallID = toolCall.id;
    if (toolCall.arguments !== undefined && toolCall.arguments !== null) {
      args = validRawMessage(toolCall.arguments);
    }
    invalidArguments = toolCall.invalidArguments ?? "";
  }
  const entry: SessionMessageEntry = {
    role: "toolCall",
    agentId: String(ev.agentId ?? ""),
    toolCallId: entryCallID,
    toolName: entryName,
    arguments: args,
    invalidArguments,
    plan: planFromToolCall(entryName, args),
  };
  applyMemberEventMetadata(entry, ev);
  return entry;
}

/** transcriptToolResultEntry ports handler_chat.go's tool-result transcript builder. */
export function transcriptToolResultEntry(
  name: string,
  ev: Event,
  status: string,
): SessionMessageEntry {
  const isError = status === "failed" || ev.toolError != null;
  let summary = summarizeToolStatusResult(ev.toolResult ?? "");
  if (isError) {
    summary = safeToolErrorSummary(ev.toolResult ?? "", ev.toolError);
  }
  const entry: SessionMessageEntry = {
    role: "toolResult",
    agentId: String(ev.agentId ?? ""),
    toolCallId: ev.toolCallId,
    toolName: name,
    isError,
    summary,
    hasDetail: ev.toolCallId !== "",
  };
  applyMemberEventMetadata(entry, ev);
  return entry;
}

/** rawToolArgs serializes tool arguments; invalid JSON collapses to null. */
export function rawToolArgs(
  args: Record<string, unknown> | undefined,
): unknown {
  if (!args || Object.keys(args).length === 0) return null;
  try {
    const data = JSON.stringify(args);
    if (data === undefined) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function summarizeToolStatusResult(result: string): string {
  const text = (result ?? "").trim();
  if (text === "") return "(empty result)";
  const normalized = text.replaceAll("\r\n", "\n");
  const idx = normalized.indexOf("\n");
  const firstLine = idx >= 0 ? normalized.slice(0, idx) : normalized;
  return truncateWithSuffix(firstLine, 140, "...");
}

export function toolStatusSummary(
  result: string,
  toolErr: unknown,
): string {
  if (toolErr !== null && toolErr !== undefined) {
    return safeToolErrorSummary(result, toolErr);
  }
  return summarizeToolStatusResult(result);
}

export function safeToolErrorSummary(result: string, toolErr: unknown): string {
  const err = toolErr ??
    new Error((result ?? "").trim() === "" ? "" : (result ?? "").trim());
  const info = classifyError(err, {
    phase: PhaseTool,
    sideEffectState: SideEffectUnknown,
  });
  return displayErrorMessage(info);
}
