// (stateless support helpers).
//
// The `Agent` struct and its methods stay with the not-yet-ported core loop in
// `agent.ts`. This module ports the pure helpers the loop is built on:
// context/message cloning, tool-call argument normalization, recovery-message
// builders, truncation classification, and read-only/side-effect tool
// classification.
//
// Deviations: `json.RawMessage` arguments map to decoded `unknown`;
// `time.Duration.String` is reproduced by `goDurationString`; `context.Context`
// maps to `ToolContext`/`AbortSignal`.

import {
  type ContentBlock,
  type Message,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "../provider/types.ts";
import { type Provider } from "../provider/provider.ts";
import {
  defaultProviderConfig,
  getProviderConfig,
  isWebSearchEnabled,
  type Settings,
} from "../config/settings.ts";
import {
  hostedToolImageGeneration,
  hostedToolOpenAIResponsesWebSearch,
  hostedToolWebSearch,
  resolveAdapterConfig,
} from "../provider/mod.ts";
import {
  type ExecutionTimeoutProvider,
  type Tool,
  type ToolContext,
} from "../tools/mod.ts";

/** AgentContext holds the current agent context. */
export interface AgentContext {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}

/** Clones an agent context, deep-copying its messages and tool list. */
export function cloneAgentContext(
  ctx: AgentContext | null | undefined,
): AgentContext | null {
  if (ctx === null || ctx === undefined) {
    return null;
  }
  return {
    systemPrompt: ctx.systemPrompt,
    messages: cloneMessages(ctx.messages),
    tools: [...ctx.tools],
  };
}

/** Deep-clones provider messages. */
export function cloneMessages(messages: Message[]): Message[] {
  if (messages.length === 0) {
    return [];
  }
  return messages.map((msg) => cloneMessage(msg));
}

/** Deep-clones messages and drops any per-message usage. */
export function cloneMessagesWithoutUsage(messages: Message[]): Message[] {
  const cloned = cloneMessages(messages);
  for (const msg of cloned) {
    msg.usage = undefined;
  }
  return cloned;
}

/** Deep-clones one provider message. */
export function cloneMessage(msg: Message): Message {
  const cloned: Message = { ...msg };
  if ((msg.contents?.length ?? 0) > 0) {
    cloned.contents = msg.contents!.map((block) => cloneContentBlock(block));
  }
  if (msg.usage !== undefined) {
    cloned.usage = { ...msg.usage } as Usage;
  }
  return cloned;
}

/** Deep-clones one content block. */
export function cloneContentBlock(block: ContentBlock): ContentBlock {
  const cloned: ContentBlock = { ...block };
  if (block.image !== undefined) {
    cloned.image = { ...block.image };
  }
  if (block.toolCall !== undefined) {
    cloned.toolCall = { ...block.toolCall };
    cloned.toolCall.arguments = cloneArguments(block.toolCall.arguments);
  }
  if (block.cache_control !== undefined) {
    cloned.cache_control = { ...block.cache_control };
  }
  return cloned;
}

function cloneArguments(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args === "object") {
    try {
      return structuredClone(args);
    } catch {
      return args;
    }
  }
  return args;
}

/**
 * normalizeToolCallArguments decodes a tool call's argument payload into a
 * plain object, or returns `null` when there is nothing to decode. When the
 * payload is not valid JSON it is preserved in `invalidArguments`, replaced
 * with an empty object, and the decode failure is thrown (matching
 * `JSON.parse` semantics); callers that treat malformed model output as a
 * business branch catch it to build a notice.
 */
export function normalizeToolCallArguments(
  tc: ToolCallBlock | null | undefined,
): Record<string, unknown> | null {
  if (
    tc === null ||
    tc === undefined ||
    tc.arguments === null ||
    tc.arguments === undefined
  ) {
    return null;
  }
  if (typeof tc.arguments === "string") {
    if (tc.arguments.length === 0) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tc.arguments);
    } catch (err) {
      if ((tc.invalidArguments ?? "") === "") {
        tc.invalidArguments = tc.arguments;
      }
      tc.arguments = {};
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }
  if (typeof tc.arguments === "object" && !Array.isArray(tc.arguments)) {
    return tc.arguments as Record<string, unknown>;
  }
  return null;
}

let toolCallFallbackCounter = 0;

/**
 * nextToolCallFallbackID returns a process-wide unique fallback ID for a
 * provider tool call that arrived without an ID. This is the TS projection of
 * Go's atomic `provider.NextToolCallFallbackID`.
 */
export function nextToolCallFallbackID(prefix: string): string {
  toolCallFallbackCounter += 1;
  return `${prefix}_${toolCallFallbackCounter}`;
}

/**
 * normalizeMessage returns a deep-enough copy of msg for safe persistence and
 * replay. It repairs every embedded tool call while leaving the caller's
 * message and argument buffers untouched. The returned notices identify tool
 * calls that were repaired so the Agent can make the recovery visible to the
 * model instead of silently changing a request.
 *
 * This is the TS projection of Go's `provider.NormalizeMessage`.
 */
export function normalizeMessage(msg: Message): [Message, string[]] {
  const normalized: Message = { ...msg };
  const notices: string[] = [];
  const contents = msg.contents;
  if (contents === undefined || contents.length === 0) {
    return [normalized, notices];
  }
  const out: ContentBlock[] = [];
  for (const block of contents) {
    const cloned = cloneContentBlock(block);
    if (cloned.toolCall !== undefined && cloned.toolCall !== null) {
      const call = { ...cloned.toolCall };
      const emptyBefore =
        typeof call.arguments === "string" && call.arguments.length === 0;
      let argErr: Error | null = null;
      try {
        normalizeToolCallArguments(call);
      } catch (thrown) {
        argErr = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
      if (emptyBefore || argErr !== null) {
        let notice = `tool ${JSON.stringify(call.name)}`;
        notice +=
          argErr !== null ? ": invalid JSON arguments" : ": empty arguments";
        notices.push(notice);
      }
      cloned.toolCall = call;
    }
    out.push(cloned);
  }
  normalized.contents = out;
  return [normalized, notices];
}

/**
 * retryCompatibilityStatus renders the status line used for compatibility with
 * adapters that only understand the retry status message.
 */
export function retryCompatibilityStatus(
  attempt: number,
  maxAttempts: number,
  retryAfterMS: number,
): string {
  if (attempt > 0 && maxAttempts > 0) {
    let message = `Retrying (attempt ${attempt}/${maxAttempts})`;
    if (retryAfterMS > 0) {
      message += `; waiting ${goDurationString(retryAfterMS)}`;
    }
    return message + "...";
  }
  return "Retrying...";
}

const outputRecoveryTailCharacters = 1200;

/** Builds the output-limit recovery continuation message. */
export function buildOutputRecoveryMessage(partial: string): string {
  const runes = Array.from(partial);
  const tail =
    runes.length > outputRecoveryTailCharacters
      ? runes.slice(runes.length - outputRecoveryTailCharacters).join("")
      : partial;
  return (
    "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.\n\n" +
    "The previous assistant response ended with this exact suffix. Do not repeat any line, table row, code line, or prose that already appears in it; output only text that comes after this suffix:\n\n<previous_response_suffix>\n" +
    tail +
    "\n</previous_response_suffix>"
  );
}

/**
 * buildStreamRecoveryMessage instructs the model to resume an interrupted
 * response from the exact point where the stream died.
 */
export function buildStreamRecoveryMessage(partial: string): string {
  const base =
    "The connection was interrupted while you were responding. Resume directly from the exact point where your previous response stopped — no apology, no recap of what you were doing. Pick up mid-thought or mid-word if that is where the cut happened.";
  const runes = Array.from(partial);
  const tail =
    runes.length > outputRecoveryTailCharacters
      ? runes.slice(runes.length - outputRecoveryTailCharacters).join("")
      : partial;
  if (tail === "") {
    return base;
  }
  return (
    base +
    "\n\nThe interrupted response ended with this exact suffix. Do not repeat any line, table row, code line, or prose that already appears in it; output only text that comes after this suffix:\n\n<previous_response_suffix>\n" +
    tail +
    "\n</previous_response_suffix>"
  );
}

/** Reports whether a provider stop reason indicates output truncation. */
export function isOutputTruncationReason(reason: string): boolean {
  switch (reason.trim().toLowerCase()) {
    case "max_tokens":
    case "max-tokens":
    case "length":
    case "max_output_tokens":
    case "token_limit":
      return true;
    default:
      return false;
  }
}

/** Returns the plain text of a message when it is replayable as text. */
export function replayTextContent(message: Message): string | undefined {
  if ((message.contents?.length ?? 0) === 0) {
    return message.content ?? "";
  }
  const parts: string[] = [];
  for (const content of message.contents!) {
    if (content.type !== "text") {
      return undefined;
    }
    parts.push(content.text ?? "");
  }
  if (parts.length === 0) {
    const text = message.content ?? "";
    return text !== "" ? text : undefined;
  }
  return parts.join("\n");
}

/** Resolves the provider name used for usage statistics. */
export function usageStatsProviderName(cfg: {
  vendor?: string;
  provider?: Provider | null;
}): string {
  if ((cfg.vendor ?? "") !== "") {
    return cfg.vendor as string;
  }
  if (cfg.provider !== null && cfg.provider !== undefined) {
    return cfg.provider.name();
  }
  return "";
}

/** Reports whether a tool is known to be read-only. */
export function isReadOnlyToolName(name: string): boolean {
  switch (name.trim().toLowerCase()) {
    case "read":
    case "grep":
    case "find":
    case "ls":
    case "jobs":
    case "skill_ref":
    case "question":
    case "plan":
      return true;
    default:
      return false;
  }
}

/** Reports whether a tool may have side effects. */
export function isSideEffectingToolName(name: string): boolean {
  return !isReadOnlyToolName(name);
}

/** Builds the persisted summary of a tool execution result. */
export function toolExecutionResultSummary(
  content: string,
  isError: boolean,
): { content: string; isError: boolean } {
  return { content, isError };
}

/**
 * Parses a persisted tool execution result summary, returning a conservative
 * fallback when the summary is missing or empty.
 */
export function parseToolExecutionResultSummary(raw: unknown): {
  content: string;
  isError: boolean;
} {
  const fallback =
    "A prior tool execution completed; its result is available in the session transcript.";
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { content: fallback, isError: false };
  }
  const value = raw as { content?: unknown; isError?: unknown };
  if (typeof value.content !== "string" || value.content === "") {
    return { content: fallback, isError: false };
  }
  return { content: value.content, isError: value.isError === true };
}

const defaultToolExecutionTimeoutMS = 5 * 60 * 1000;

/**
 * toolExecutionContext applies a tool's execution timeout over the parent tool
 * context. A non-positive duration disables the agent-level deadline while
 * preserving parent cancellation.
 */
export function toolExecutionContext(
  ctx: ToolContext,
  tool: Tool,
  params: Record<string, unknown>,
): { ctx: ToolContext; cancel: () => void } {
  let timeoutMS = defaultToolExecutionTimeoutMS;
  const provider = tool as Partial<ExecutionTimeoutProvider>;
  if (typeof provider.executionTimeout === "function") {
    const override = provider.executionTimeout(params);
    if (override.provided) {
      timeoutMS = override.durationMs;
    }
  }
  if (timeoutMS <= 0) {
    return { ctx, cancel: () => {} };
  }

  const controller = new AbortController();
  const parent = ctx.signal;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent !== undefined) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMS);
  const cancel = () => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  };
  return { ctx: { ...ctx, signal: controller.signal }, cancel };
}

/**
 * goDurationString reproduces Go's `time.Duration.String` for a millisecond
 * value, which is what event status messages expose.
 */
export function goDurationString(ms: number): string {
  let u = Math.trunc(ms) * 1e6; // nanoseconds
  const neg = u < 0;
  if (neg) u = -u;
  if (u === 0) return "0s";

  let out: string;
  if (u < 1e9) {
    let prec: number;
    let unit: string;
    if (u < 1000) {
      prec = 0;
      unit = "n";
    } else if (u < 1e6) {
      prec = 3;
      unit = "µ";
    } else {
      prec = 6;
      unit = "m";
    }
    const { int, frac } = fmtFracDigits(u, prec);
    out = `${int}${frac}${unit}s`;
  } else {
    const { int: secs, frac } = fmtFracDigits(u, 9);
    const s = secs % 60;
    let rest = Math.floor(secs / 60);
    let body = `${s}${frac}s`;
    if (rest > 0) {
      const mins = rest % 60;
      rest = Math.floor(rest / 60);
      body = `${mins}m${body}`;
      if (rest > 0) {
        body = `${rest}h${body}`;
      }
    }
    out = body;
  }
  return (neg ? "-" : "") + out;
}

function fmtFracDigits(v: number, prec: number): { int: number; frac: string } {
  let print = false;
  let frac = "";
  for (let i = 0; i < prec; i++) {
    const digit = v % 10;
    print = print || digit !== 0;
    if (print) {
      frac = String(digit) + frac;
    }
    v = Math.floor(v / 10);
  }
  if (print) {
    frac = "." + frac;
  }
  return { int: v, frac };
}

/**
 * Builds the hosted image-generation tool definition when the resolved provider
 * uses the OpenAI Responses API. Returns `[definition, true]` when the tool is
 * available, otherwise `[{ ... }, false]` (the definition is ignored).
 */
export function imageGenerationToolDefinition(
  settings: Settings | undefined,
  providerName: string,
): ToolDefinition | undefined {
  if (settings === undefined) {
    return undefined;
  }
  let name = providerName;
  if (name === "") name = settings.defaultProvider ?? "";
  if (name === "") name = "openai";
  let pc = getProviderConfig(settings, name);
  if (pc === undefined) pc = defaultProviderConfig(name);
  if (pc === undefined) {
    return undefined;
  }
  const resolved = resolveAdapterConfig(pc);
  if (resolved.api !== "responses" && resolved.api !== "openai-responses") {
    return undefined;
  }
  return {
    name: hostedToolImageGeneration,
    description: "",
    kind: "hosted",
    provider: name,
    providerType: resolved.api,
  };
}

/**
 * Builds the hosted web-search tool definition from settings. Returns
 * `[definition, true]` when web search is enabled, otherwise a disabled tuple.
 */
export function configuredWebSearchToolDefinition(
  settings: Settings | undefined,
): ToolDefinition | undefined {
  if (settings === undefined || !isWebSearchEnabled(settings)) {
    return undefined;
  }
  const cfg = settings.webSearch ?? {};
  let providerName = cfg.provider ?? "";
  if (providerName === "") providerName = settings.defaultProvider ?? "";
  if (providerName === "") providerName = "openai";

  let resolved;
  const pc = getProviderConfig(settings, providerName);
  if (pc !== undefined) {
    resolved = resolveAdapterConfig(pc);
  } else {
    resolved = resolveAdapterConfig({ models: [], api: "openai-chat" });
    switch (providerName) {
      case "anthropic":
        resolved = { ...resolved, api: "anthropic-messages" };
        break;
      case "openai":
        resolved = { ...resolved, api: "openai-responses" };
        break;
    }
  }

  let providerType = cfg.providerType ?? "";
  if (providerType === "") providerType = resolved.api;
  switch (providerType) {
    case "responses":
      providerType = "openai-responses";
      break;
    case "messages":
      providerType = "anthropic-messages";
      break;
  }

  return {
    name: hostedToolWebSearch,
    description: "",
    kind: "hosted",
    provider: providerName,
    providerType,
    model: cfg.model,
  };
}

/**
 * Builds the hosted OpenAI-Responses web-search tool definition when the
 * provider itself is using the Responses API. Returns a disabled tuple
 * otherwise.
 */
export function openAIResponsesWebSearchToolDefinition(
  p: Provider | undefined,
): ToolDefinition | undefined {
  if (
    p === undefined ||
    (p.api() !== "responses" && p.api() !== "openai-responses")
  ) {
    return undefined;
  }
  return {
    name: hostedToolOpenAIResponsesWebSearch,
    description: "",
    kind: "hosted",
    provider: p.name(),
    providerType: p.api(),
  };
}
