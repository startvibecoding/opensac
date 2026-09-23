// (the pure,
// server-independent half of the ACP projection layer).
//
// These helpers turn Agent Core events, task plans, tool results, and canonical
// Runtime identities into the ACP wire vocabulary. They carry no server state,
// so they are ported ahead of the ACP server (`handlePrompt`/`handleAgentEvent`
// and the stdio loop), which lands in a later slice.
//
// Deviations: `json.RawMessage` maps to decoded `unknown`; `time.Duration` maps
// to milliseconds (via `goDurationString`); `[]byte` maps to `Uint8Array`;
// Go's `(value, error)` returns throw typed errors.

import { createHash } from "node:crypto";
import { isAbsolute } from "@std/path";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import {
  type Event,
  EVENT_COMPACTION_END,
  EVENT_COMPACTION_START,
  EVENT_TURN_END,
  EVENT_TURN_START,
  type EventType,
  type ToolImage,
} from "../agent/events.ts";
import { goDurationString } from "../agent/agent_support.ts";
import { RPCError } from "../mcp/rpc.ts";
import { isNonTerminalSessionRunStatus } from "../session/run_status.ts";
import type { FileDiff, TaskPlan } from "../tools/mod.ts";
import {
  type PlanEntry,
  type RequestQuestionOption,
  type RequestQuestionPayload,
  type SessionUpdate,
  ToolCallContent,
  type ToolCallLocation,
} from "./protocol.ts";

/** The OpenSAC ACP extension namespace. */
export const opensacExtensionNamespace = "opensac.dev";

/** The maximum bytes projected for one tool-result image (2 MiB). */
export const acpToolImageMaxBytes = 2 << 20;
/** The maximum number of images projected in one `tool_call_update`. */
export const acpToolImageMaxCount = 4;

/** Builds a structured JSON-RPC error carrying a stable machine code. */
export function acpStructuredRPCError(
  rpcCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown> | null,
): RPCError {
  const data: Record<string, unknown> = { code };
  if (extra !== undefined && extra !== null) {
    for (const [key, value] of Object.entries(extra)) data[key] = value;
  }
  return new RPCError(rpcCode, message, data);
}

/**
 * Maps a canonical durable Run status (or RunState) onto the projected ACP
 * vocabulary `running|completed|failed|cancelled|incomplete`. Non-terminal
 * durable statuses project as running; unknown terminal-ish values degrade to
 * failed rather than inventing new vocabulary.
 */
export function acpRunStatus(status: string): string {
  const trimmed = status.trim();
  switch (trimmed) {
    case "completed":
      return "completed";
    case "incomplete":
      return "incomplete";
    case "failed":
    case "timed_out":
    case "expired":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
  }
  if (isNonTerminalSessionRunStatus(trimmed)) return "running";
  return "failed";
}

/** Maps an internal Agent event type onto its additive ACP event name. */
export function acpEventName(eventType: EventType): string {
  switch (eventType) {
    case EVENT_COMPACTION_START:
      return "compaction_started";
    case EVENT_COMPACTION_END:
      return "compaction_finished";
    case EVENT_TURN_START:
      return "turn_started";
    case EVENT_TURN_END:
      return "turn_finished";
    default:
      return "unknown";
  }
}

/** Maps a tool name onto the ACP tool-kind vocabulary. */
export function acpToolKind(name: string): string {
  switch (name) {
    case "read":
    case "ls":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "grep":
    case "find":
      return "search";
    case "bash":
      return "execute";
    case "plan":
      return "think";
    default:
      return "other";
  }
}

/** Normalizes a hosted-tool status onto the ACP vocabulary. */
export function acpHostedStatus(status: string): string {
  switch (status) {
    case "completed":
    case "incomplete":
    case "expired":
    case "failed":
    case "cancelled":
    case "canceled":
      return status;
    default:
      return "in_progress";
  }
}

/** Wraps plain text as a single ACP text content entry. */
export function textToolContent(text: string): ToolCallContent[] {
  if (text === "") return [];
  return [
    new ToolCallContent({
      type: "content",
      content: { type: "text", text },
    }),
  ];
}

/** Projects a task plan's steps onto ACP plan entries. */
export function acpPlanEntries(plan: TaskPlan): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const step of plan.steps) {
    let status = "pending";
    switch (step.status) {
      case "running":
        status = "in_progress";
        break;
      case "done":
      case "failed":
        status = "completed";
        break;
    }
    entries.push({ content: step.title, priority: "medium", status });
  }
  return entries;
}

/** Projects a task plan's title/note onto the OpenSAC extension metadata. */
export function acpPlanMeta(
  plan: TaskPlan,
): Record<string, unknown> | undefined {
  if (plan.title === "" && plan.note === "") return undefined;
  return {
    [opensacExtensionNamespace]: { title: plan.title, note: plan.note },
  };
}

/** Builds the stable ACP message ID for one stream segment. */
export function acpStreamMessageID(
  sessionID: string,
  promptID: string,
  kind: string,
  segment: number,
): string {
  return `acp_${sessionID}_${promptID}_${kind}_${segment}`;
}

/**
 * Deterministic message ID for fixture sessions that emit events without a
 * prompt, so their wire payload remains schema-valid.
 */
export function acpStreamFallbackMessageID(
  sessionID: string,
  thought: boolean,
): string {
  const kind = thought ? "thought" : "message";
  const digest = createHash("sha256")
    .update(`${sessionID}\u0000${kind}`, "utf8")
    .digest();
  return `acp_${kind}_${digest.subarray(0, 8).toString("hex")}`;
}

/** Projects a retry event onto its additive ACP notification payload. */
export function acpRetryEvent(
  sessionID: string,
  ev: Event,
): Record<string, unknown> {
  return {
    sessionId: sessionID,
    event: "retrying",
    message: acpRetryMessage(ev),
    attempt: ev.retryAttempt ?? 0,
    maxAttempts: ev.retryMaxAttempts ?? 0,
    retryAfterMs: ev.retryAfterMs ?? 0,
  };
}

/**
 * Deliberately uses the structured retry fields instead of a provider retry
 * reason, which may contain provider-specific or otherwise unsafe detail.
 */
export function acpRetryMessage(ev: Event): string {
  const attempt = ev.retryAttempt ?? 0;
  const maxAttempts = ev.retryMaxAttempts ?? 0;
  const retryAfterMs = ev.retryAfterMs ?? 0;
  if (attempt > 0 && maxAttempts > 0) {
    let message = `Retrying (attempt ${attempt}/${maxAttempts})`;
    if (retryAfterMs > 0) {
      message += `; waiting ${goDurationString(retryAfterMs)}`;
    }
    return message + "...";
  }
  return "Retrying...";
}

/** Projects a tool diff onto ACP tool-call locations (only absolute paths). */
export function toolCallLocations(
  diff: FileDiff | undefined,
): ToolCallLocation[] {
  if (diff === undefined || !isAbsolute(diff.path)) return [];
  return [{ path: diff.path }];
}

/** Renders a task plan as the human-readable ACP plan text. */
export function formatACPPlan(plan: TaskPlan | undefined): string {
  if (plan === undefined || plan.steps.length === 0) return "Plan updated.";
  const title = plan.title === "" ? "Plan" : plan.title;
  let out = title;
  for (const step of plan.steps) {
    out += `\n${planStatusMarker(step.status)} ${step.title}`;
  }
  if (plan.note !== "") out += "\nnote: " + plan.note;
  return out;
}

/** Maps one plan step status onto its compact marker. */
export function planStatusMarker(status: string): string {
  switch (status) {
    case "running":
      return ">";
    case "done":
      return "x";
    case "failed":
      return "!";
    default:
      return "-";
  }
}

/** Encodes one session-list offset as an opaque cursor. */
export function encodeSessionCursor(offset: number): string {
  return encodeBase64Url(new TextEncoder().encode(`acp-v1:${offset}`));
}

/** Decodes one session-list cursor, throwing on an invalid value. */
export function decodeSessionCursor(cursor: string): number {
  let raw: Uint8Array;
  try {
    raw = decodeBase64Url(cursor);
  } catch {
    throw new Error("invalid session cursor");
  }
  const text = new TextDecoder().decode(raw);
  const prefix = "acp-v1:";
  if (!text.startsWith(prefix)) throw new Error("invalid session cursor");
  const rest = text.slice(prefix.length);
  if (!/^[+-]?\d+$/.test(rest)) throw new Error("invalid session cursor");
  const offset = Number.parseInt(rest, 10);
  if (offset < 0) throw new Error("invalid session cursor");
  return offset;
}

/** Reports whether two string slices are equal and in the same order. */
export function sameStringSlice(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Decodes an already-decoded JSON object, returning undefined on failure. */
export function parseJSONRawToMap(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** Extracts the first non-empty sampling prompt from MCP params. */
export function extractSamplingPrompt(params: unknown): string {
  return extractSamplingInput(params).prompt;
}

/** Extracts the prompt, system prompt, and max tokens from MCP params. */
export function extractSamplingInput(params: unknown): {
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
} {
  let maxTokens = 0;
  if (params === undefined || params === null) {
    return { prompt: "", systemPrompt: "", maxTokens };
  }
  if (
    typeof params !== "object" || Array.isArray(params)
  ) {
    return {
      prompt: String(params).trim(),
      systemPrompt: "",
      maxTokens,
    };
  }
  const raw = params as Record<string, unknown>;
  if (typeof raw.maxTokens === "number" && Math.trunc(raw.maxTokens) > 0) {
    maxTokens = Math.trunc(raw.maxTokens);
  }
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const parts: string[] = [];
  let systemPrompt = "";
  for (const message of messages) {
    if (
      typeof message !== "object" || message === null || Array.isArray(message)
    ) {
      continue;
    }
    const msg = message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";
    const content = msg.content;
    let texts: string[] = [];
    if (typeof content === "string") {
      if (content.trim() !== "") texts = [content];
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          continue;
        }
        const block = item as Record<string, unknown>;
        if (
          block.type === "text" && typeof block.text === "string" &&
          block.text.trim() !== ""
        ) {
          texts.push(block.text);
        }
      }
      if (texts.length === 0) continue;
    }
    if (texts.length === 0) continue;
    const joined = texts.join("\n");
    if (role === "system") {
      if (systemPrompt === "") systemPrompt = joined;
      continue;
    }
    parts.push(joined);
  }
  return { prompt: parts.join("\n"), systemPrompt, maxTokens };
}

/** Builds the `opensac/requestQuestion` payload for one question request. */
export function requestQuestionPayloadFor(request: {
  question: string;
  options: string[];
  explanation: string;
}): RequestQuestionPayload {
  const options: RequestQuestionOption[] = [];
  for (const raw of request.options) {
    const option = raw.trim();
    if (option !== "") options.push({ id: option, label: option });
  }
  return {
    prompt: request.question,
    options,
    multi: false,
    title: "OpenSAC",
    placeholder: request.explanation,
  };
}

/**
 * Selects the question-projection method and payload. Uninitialized wire
 * clients keep the pre-v1 extension; initialized clients receive the
 * documented camelCase method.
 */
export function questionProjectionFor(
  initialized: boolean,
  request: {
    question: string;
    options: string[];
    explanation: string;
  },
): { method: string; params: unknown } {
  if (!initialized) {
    return {
      method: "_opensac/request_question",
      params: {
        question: request.question,
        options: request.options,
        explanation: request.explanation,
      },
    };
  }
  return {
    method: "opensac/requestQuestion",
    params: requestQuestionPayloadFor(request),
  };
}

/** Builds the additive artifact session update for one generated artifact. */
export function artifactSessionUpdate(
  artifactID: string,
  filename: string,
  kind: string,
  mediaType: string,
  size: number,
  runID: string,
): SessionUpdate {
  return {
    sessionUpdate: "artifact",
    artifactId: artifactID,
    filename,
    kind,
    mediaType,
    size,
    runId: runID,
    status: "generated",
  };
}

/** Formats a byte count using Go's compact binary-prefix projection. */
export function acpByteSize(value: number): string {
  const unit = 1024;
  if (value < unit) return `${value}B`;
  if (value < unit * unit) return `${(value / unit).toFixed(1)}KB`;
  return `${(value / (unit * unit)).toFixed(1)}MB`;
}

/**
 * Projects tool-result images as additive image content blocks. Images beyond
 * the per-update count or per-image size limit degrade to a text note carrying
 * the mime type and size.
 */
export function acpToolImageContents(images: ToolImage[]): ToolCallContent[] {
  if (images.length === 0) return [];
  const contents: ToolCallContent[] = [];
  const notes: string[] = [];
  let included = 0;
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    if (image.data.trim() === "") continue;
    let mimeType = image.mimeType.trim();
    if (mimeType === "") mimeType = "image/png";
    const decodedBytes = base64StdDecodedLen(image.data.length);
    if (decodedBytes > acpToolImageMaxBytes) {
      notes.push(
        `image ${index + 1} not projected: ${mimeType} (${
          acpByteSize(decodedBytes)
        }) exceeds the ${acpByteSize(acpToolImageMaxBytes)} per-image limit`,
      );
      continue;
    }
    if (included >= acpToolImageMaxCount) {
      notes.push(
        `image ${
          index + 1
        } not projected: a single tool_call_update carries at most ${acpToolImageMaxCount} images`,
      );
      continue;
    }
    included++;
    contents.push(
      new ToolCallContent({
        type: "content",
        content: { type: "image", mimeType, data: image.data },
      }),
    );
  }
  for (const note of notes) {
    contents.push(
      new ToolCallContent({
        type: "content",
        content: { type: "text", text: note },
      }),
    );
  }
  return contents;
}

/** Decodes one optional `projectId` value (string, null, or absent). */
export function acpOptionalProjectID(
  raw: unknown,
): { present: boolean; value: string } {
  if (raw === undefined) return { present: false, value: "" };
  if (raw === null) return { present: true, value: "" };
  if (typeof raw !== "string") {
    throw new Error("projectId must be a string or null");
  }
  return { present: true, value: raw.trim() };
}

function base64StdDecodedLen(n: number): number {
  return Math.trunc(n / 4) * 3;
}
