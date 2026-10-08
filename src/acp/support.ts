// (the
// deterministic server-support helpers).
//
// This module owns the ACP pieces that do not need a live provider or Agent:
// startup-error classification, transcript cursors/paging, tool-call titles,
// deterministic replay message ids, and the elicitation/question projections.
// The ACP server itself (the stdio loop and `handlePrompt`/`handleAgentEvent`)
// lands in a later slice.
//
// Deviations: `json.RawMessage` maps to a decoded `unknown`; `time.Time` maps to
// `Date`; Go's `(value, error)` returns throw typed errors.

import { createHash } from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "@opensac/encoding/base64url";
import {
  type Response as DoctorResponse,
  STATUS_ERROR,
} from "../doctor/mod.ts";
import type { Message } from "../provider/types.ts";
import type { Manager } from "../session/manager.ts";
import type { SessionUpdate } from "./protocol.ts";
import { acpToolKind, textToolContent } from "./projection.ts";
import { utf8Length, utf8Prefix } from "./metadata.ts";

// ---------------------------------------------------------------------------
// Startup errors
// ---------------------------------------------------------------------------

/** A classified ACP startup failure serialized to stderr for the host. */
export class ACPStartupError extends Error {
  code: string;
  fix: string;
  override cause?: unknown;

  constructor(init: {
    code: string;
    message: string;
    fix?: string;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "ACPStartupError";
    this.code = init.code;
    this.fix = init.fix ?? "";
    this.cause = init.cause;
  }
}

/** Projects the first failing doctor check into an ACP startup error. */
export function startupErrorFromDoctor(
  result: DoctorResponse,
): ACPStartupError | null {
  for (const check of result.checks) {
    if (check.status !== STATUS_ERROR) continue;
    let code = "config_invalid";
    let message = (check.detail ?? "").trim().toLowerCase();
    if (check.id === "cwd") {
      code = "cwd_invalid";
      message = "working directory is unavailable";
    } else if (check.id === "provider.default") {
      if ((check.detail ?? "").toLowerCase().includes("unknown provider")) {
        code = "provider_unknown";
      } else {
        code = "provider_unusable";
      }
      message = doctorStartupMessage(check.detail ?? "");
    } else if (check.id === "model.default") {
      code = "model_unknown";
      message = doctorStartupMessage(check.detail ?? "");
    }
    if (message === "") message = check.title.toLowerCase() + " check failed";
    return new ACPStartupError({ code, message, fix: check.fix ?? "" });
  }
  return null;
}

/**
 * Normalizes a secret-free doctor detail for the one-line ACP error without
 * echoing any provider response or credential.
 */
export function doctorStartupMessage(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed === "") return "configuration is unusable";
  const colon = trimmed.indexOf(":");
  if (colon >= 0) {
    const head = trimmed.slice(0, colon).trim();
    const tail = trimmed.slice(colon + 1).trim();
    if (tail.toLowerCase() === "missing api key") {
      return "default provider " + head + " has no API key";
    }
  }
  return trimmed.toLowerCase();
}

/** Classifies an arbitrary startup failure without exposing its cause. */
export function classifyACPStartupError(error: unknown): ACPStartupError {
  if (error instanceof ACPStartupError) return error;
  const message = (error instanceof Error ? error.message : String(error))
    .toLowerCase();
  let code = "config_invalid";
  let publicMessage = "ACP configuration is invalid";
  let fix = "Check settings.json and ACP options";
  if (message.includes("unknown provider")) {
    code = "provider_unknown";
    publicMessage = "selected provider is not configured";
    fix = "Choose a configured provider";
  } else if (
    message.includes("model") &&
    (message.includes("available") || message.includes("unknown"))
  ) {
    code = "model_unknown";
    publicMessage = "selected model is not available for the provider";
    fix = "Choose a model listed for this provider";
  } else if (message.includes("api key") || message.includes("base url")) {
    code = "provider_unusable";
    publicMessage = "selected provider is unusable";
    fix = "Configure the provider API key and base URL";
  }
  return new ACPStartupError({
    code,
    message: publicMessage,
    fix,
    cause: error,
  });
}

/** Reports whether a failure occurred before ACP initialization. */
export function isStartupError(error: unknown): boolean {
  return error instanceof ACPStartupError;
}

/**
 * Writes the machine-readable startup line to the given sink (stderr by
 * default), mirroring `OPENSAC_ACP_ERROR {json}`.
 */
export function writeACPStartupError(
  error: unknown,
  write?: (line: string) => void,
): void {
  const startup = error instanceof ACPStartupError
    ? error
    : classifyACPStartupError(error);
  const payload: Record<string, string> = {
    code: startup.code,
    message: startup.message,
  };
  if (startup.fix !== "") payload.fix = startup.fix;
  const line = `OPENSAC_ACP_ERROR ${JSON.stringify(payload)}\n`;
  if (write !== undefined) {
    write(line);
    return;
  }
  Deno.stderr.writeSync(new TextEncoder().encode(line));
}

// ---------------------------------------------------------------------------
// Transcript cursors and paging
// ---------------------------------------------------------------------------

/** Default transcript page size. */
export const transcriptPageDefaultSize = 40;
/** Maximum transcript page size. */
export const transcriptPageMaxSize = 100;

/** The additive transcript-page projection. */
export interface TranscriptPageResult {
  sessionId: string;
  updates: SessionUpdate[];
  nextCursor?: string;
}

/** Encodes a transcript offset as an opaque cursor. */
export function encodeTranscriptCursor(before: number): string {
  return encodeBase64Url(
    new TextEncoder().encode(`acp-history-v1:${before}`),
  );
}

/** Decodes a transcript cursor, throwing on an invalid value. */
export function decodeTranscriptCursor(cursor: string): number {
  let raw: Uint8Array;
  try {
    raw = decodeBase64Url(cursor);
  } catch {
    throw new Error("invalid history cursor");
  }
  const text = new TextDecoder().decode(raw);
  const prefix = "acp-history-v1:";
  if (!text.startsWith(prefix)) throw new Error("invalid history cursor");
  const rest = text.slice(prefix.length);
  if (!/^\d+$/.test(rest)) throw new Error("invalid history cursor");
  const before = Number.parseInt(rest, 10);
  if (!Number.isFinite(before) || before < 0) {
    throw new Error("invalid history cursor");
  }
  return before;
}

/** Clamps a requested transcript page size to the supported range. */
export function transcriptPageSize(limit: number): number {
  if (limit <= 0) return transcriptPageDefaultSize;
  if (limit > transcriptPageMaxSize) return transcriptPageMaxSize;
  return limit;
}

/**
 * Projects one window of canonical session messages as standard `session/update`
 * entries. Clients gain no second transcript or content model.
 */
export function transcriptPage(
  sessionID: string,
  mgr: Manager | null | undefined,
  cursor: string,
  limit: number,
  registry: ToolTitleRegistry,
): TranscriptPageResult {
  if (mgr === null || mgr === undefined) {
    throw new Error("session is unavailable");
  }
  const state = mgr.getReplayState();
  let before = state.messages.length;
  if (cursor !== "") {
    before = decodeTranscriptCursor(cursor);
    if (before > state.messages.length) {
      throw new Error("invalid history cursor");
    }
  }
  const start = Math.max(0, before - transcriptPageSize(limit));
  const result: TranscriptPageResult = { sessionId: sessionID, updates: [] };
  for (let index = start; index < before; index++) {
    const entryID = index < state.entryIDs.length ? state.entryIDs[index] : "";
    result.updates.push(
      ...messageUpdates(registry, sessionID, state.messages[index], entryID),
    );
  }
  if (start > 0) result.nextCursor = encodeTranscriptCursor(start);
  return result;
}

/** Builds the deterministic replay message id for one message segment. */
export function replayMessageID(
  sessionID: string,
  kind: string,
  text: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionID}\u0000${kind}\u0000${text}`, "utf8")
    .digest();
  return `acp_replay_${kind}_${digest.subarray(0, 8).toString("hex")}`;
}

/** Projects one persisted message onto its ACP session updates. */
export function messageUpdates(
  registry: ToolTitleRegistry,
  sessionID: string,
  msg: Message,
  entryID: string,
): SessionUpdate[] {
  const messageID = (kind: string, index: number, text: string): string => {
    if (entryID === "") return replayMessageID(sessionID, kind, text);
    return replayMessageID(sessionID, kind, `${entryID}:${index}`);
  };
  const updates: SessionUpdate[] = [];
  if (msg.role === "assistant") {
    const contents = msg.contents ?? [];
    for (let index = 0; index < contents.length; index++) {
      const content = contents[index];
      if (content.type === "thinking" && (content.thinking ?? "") !== "") {
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          messageId: messageID("thought", index, content.thinking ?? ""),
          content: { type: "text", text: content.thinking ?? "" },
        });
      } else if (content.type === "text" && (content.text ?? "") !== "") {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          messageId: messageID("message", index, content.text ?? ""),
          content: { type: "text", text: content.text ?? "" },
        });
      } else if (
        content.type === "toolCall" && content.toolCall !== undefined
      ) {
        const rawInput = parseToolArguments(content.toolCall.arguments);
        const title = registry.rememberToolTitle(
          content.toolCall.id,
          content.toolCall.name,
          rawInput,
        );
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: content.toolCall.id,
          title,
          kind: acpToolKind(content.toolCall.name),
          status: "pending",
          rawInput: toolRawInput(rawInput),
        });
      }
    }
    return updates;
  }
  if (msg.role === "user") {
    let text = msg.content ?? "";
    if (text === "") {
      for (const content of msg.contents ?? []) {
        if (content.type === "text" && (content.text ?? "") !== "") {
          text = content.text ?? "";
          break;
        }
      }
    }
    if (text !== "") {
      updates.push({
        sessionUpdate: "user_message_chunk",
        messageId: messageID("user", 0, text),
        content: { type: "text", text },
      });
    }
    return updates;
  }
  if (msg.role === "toolResult") {
    const rawOutput = { content: msg.content ?? "" };
    const status = msg.isError === true ? "failed" : "completed";
    const title = registry.toolTitleFor(
      msg.toolCallId ?? "",
      msg.toolName ?? "",
    );
    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: msg.toolCallId ?? "",
      title,
      kind: acpToolKind(msg.toolName ?? ""),
      status,
      content: textToolContent(msg.content ?? ""),
      rawOutput,
    });
  }
  return updates;
}

// ---------------------------------------------------------------------------
// Tool titles
// ---------------------------------------------------------------------------

/** Expands the raw tool input projection (`{args, ...args}`). */
export function toolRawInput(
  args: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  const raw: Record<string, unknown> = { args: args ?? null };
  if (args !== undefined && args !== null) {
    for (const [key, value] of Object.entries(args)) raw[key] = value;
  }
  return raw;
}

/** Builds a bounded, human-readable tool-call title. */
export function toolTitle(
  name: string,
  args: Record<string, unknown> | undefined | null,
): string {
  if (args === undefined || args === null) return name;
  let details: string[] = [];
  switch (name) {
    case "bash":
      details = appendStringArg(details, "command", args);
      break;
    case "read":
    case "write":
    case "edit":
    case "ls":
      details = appendStringArg(details, "path", args);
      break;
    case "grep":
    case "find":
      details = appendStringArg(details, "pattern", args);
      details = appendStringArg(details, "path", args);
      break;
    default:
      for (const key of ["command", "path", "pattern", "query", "name"]) {
        details = appendStringArg(details, key, args);
        if (details.length > 0) break;
      }
  }
  if (details.length === 0) return name;
  return name + ": " + truncateTitle(details.join(" "));
}

function appendStringArg(
  details: string[],
  key: string,
  args: Record<string, unknown>,
): string[] {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") return details;
  if (key === "command") return [...details, value];
  return [...details, `${key}=${value}`];
}

/** Truncates a one-line title to 160 UTF-8 bytes, matching Go's byte slice. */
export function truncateTitle(title: string): string {
  const maxTitleLength = 160;
  const normalized = title.replace(/\n/g, " ").trim();
  if (utf8Length(normalized) <= maxTitleLength) return normalized;
  return utf8Prefix(normalized, maxTitleLength - 3) + "...";
}

/** Projects an Agent stop/finish reason onto the ACP stop-reason vocabulary. */
export function normalizeStopReason(reason: string): string {
  switch (reason) {
    case "":
    case "stop":
    case "end_turn":
    case "tool_use":
      return "end_turn";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "max_turn_requests":
      return "max_turn_requests";
    case "cancelled":
    case "aborted":
      return "cancelled";
    default:
      return "refusal";
  }
}

/** Per-session tool-call title cache (Go's `server.toolTitles`). */
export class ToolTitleRegistry {
  #titles = new Map<string, string>();

  /** Records a title once per tool-call id; an existing title wins. */
  rememberToolTitle(
    toolCallID: string,
    name: string,
    args: Record<string, unknown> | undefined | null,
  ): string {
    const title = toolTitle(name, args);
    const existing = this.#titles.get(toolCallID);
    if (existing !== undefined && existing !== "") {
      if (existing !== name) return existing;
      return existing;
    }
    this.#titles.set(toolCallID, title);
    return title;
  }

  /** Returns the remembered title for a tool-call id, or the fallback. */
  toolTitleFor(toolCallID: string, fallback: string): string {
    const title = this.#titles.get(toolCallID);
    if (title !== undefined && title !== "") return title;
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Config values, elicitation, questions
// ---------------------------------------------------------------------------

/**
 * Decodes one config-option value. A string passes through (honoring
 * `allowEmpty`); a boolean normalizes to `"true"`/`"false"`; anything else is
 * rejected.
 */
export function acpConfigValue(raw: unknown, allowEmpty: boolean): string {
  if (typeof raw === "string") {
    if (raw.trim() === "" && !allowEmpty) {
      throw new Error("config value must not be empty");
    }
    return raw;
  }
  if (typeof raw === "boolean") return raw ? "true" : "false";
  throw new Error("config value must be a string or boolean");
}

/** The elicitation protocol marker persisted for standard-form replay. */
export const acpElicitationFormProtocol = "acp-elicitation-form";

/** One standard ACP elicitation request body. */
export interface ElicitationCreateRequest {
  sessionId: string;
  message: string;
  mode: string;
  requestedSchema: Record<string, unknown>;
}

/** One standard ACP elicitation result body. */
export interface ElicitationResult {
  action: string;
  content?: Record<string, unknown>;
}

/** One ACP question request body. */
export interface QuestionRequest {
  sessionId: string;
  question: string;
  options: string[];
  explanation?: string;
  timeoutMs: number;
  protocol?: string;
}

/** One ACP question result body. */
export interface QuestionResult {
  ok?: boolean;
  cancelled?: boolean;
  answer?: string;
  answers?: string[];
}

/** Builds the standard-form elicitation request for one question. */
export function elicitationRequestForQuestion(
  request: QuestionRequest,
): ElicitationCreateRequest {
  const answerSchema: Record<string, unknown> = {
    type: "string",
    title: "Answer",
    description: request.explanation ?? "",
  };
  if (request.options.length > 0) answerSchema.enum = [...request.options];
  return {
    sessionId: request.sessionId,
    message: request.question,
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: { answer: answerSchema },
      required: ["answer"],
    },
  };
}

/**
 * Decodes a question response. Standard-form elicitation accepts the legacy
 * result shape as a fallback so a reconnecting client that no longer
 * advertises form support does not create a second decision state.
 */
export function questionAnswer(
  raw: unknown,
  standardElicitation: boolean,
): { answer: string; status: string } {
  const record = asRecord(raw);
  if (standardElicitation) {
    if (record !== undefined && record.action === "accept") {
      const content = asRecord(record.content);
      const answer = typeof content?.answer === "string" ? content.answer : "";
      return { answer, status: "resolved" };
    }
    if (
      record !== undefined && typeof record.answer === "string" &&
      record.answer !== ""
    ) {
      return { answer: record.answer, status: "resolved" };
    }
    return { answer: "", status: "cancelled" };
  }
  if (record === undefined) return { answer: "", status: "cancelled" };
  if (record.cancelled === true) return { answer: "", status: "cancelled" };
  if (typeof record.ok === "boolean" && !record.ok) {
    return { answer: "", status: "cancelled" };
  }
  let answer = typeof record.answer === "string" ? record.answer.trim() : "";
  if (
    answer === "" && Array.isArray(record.answers) &&
    record.answers.length > 0 &&
    typeof record.answers[0] === "string"
  ) {
    answer = (record.answers[0] as string).trim();
  }
  if (answer === "") return { answer: "", status: "cancelled" };
  return { answer, status: "resolved" };
}

function parseToolArguments(
  args: unknown,
): Record<string, unknown> | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") {
    try {
      return asRecord(JSON.parse(args));
    } catch {
      return undefined;
    }
  }
  return asRecord(args);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
