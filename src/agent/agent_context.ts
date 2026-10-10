// (stateless helpers).
//
// The `Agent`-bound methods of agent_context.go (request assembly,
// compaction, content-rejection/overflow recovery, history accessors) stay
// with the not-yet-ported core loop in `agent.ts`. This module ports the pure
// helpers they are built on so they can be tested on their own.
//
// Deviations: `context.Context` maps to `AbortSignal`; Go's `[2]int` marker
// tuple maps to a `readonly [number, number]`; `json.Marshal` for token
// estimation maps to `JSON.stringify`.

import {
  type ContentBlock,
  createCost,
  createToolResultMessage,
  type ImageContent,
  type Message,
  type ToolDefinition,
  type Usage,
} from "../provider/types.ts";
import { type Provider } from "../provider/provider.ts";
import { retryDelay } from "../provider/retry.ts";
import {
  estimateGuardTokens,
  estimateTextTokens,
  GenericTokenEstimator,
  type TokenEstimator,
} from "../context/tokenizer.ts";
import { type ToolImage } from "./events.ts";

/** Default auto-compaction threshold (fraction of the context window). */
export const defaultAutoCompactionThreshold = 0.80;

/** Safety margin reserved when clamping an output limit to the context window. */
export const contextTokenSafetyMargin = 512;

export const unsupportedImageToolResultMessage =
  "tool result contains image content, but the selected model does not support image input; select a vision-capable model to continue";

/**
 * maxContentRejectionStages bounds the content-rejection recovery. Stage 1
 * strips images introduced since the last real user turn (the current turn's
 * user message and tool results); stage 2 strips every remaining image in the
 * conversation. Two stages guarantee recovery without an unbounded re-send loop.
 */
export const maxContentRejectionStages = 2;

/** Reports whether any content block carries image content. */
export function containsImageContent(contents: ContentBlock[]): boolean {
  for (const content of contents) {
    if (content.type === "image" || content.image !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * toolResultImages extracts the image payloads of a rich tool result so event
 * consumers can project them (for example ACP tool_call_update image content)
 * without re-parsing provider messages. The extracted data is the exact
 * base64 payload the tool produced; no re-encoding happens here.
 */
export function toolResultImages(
  contents: ContentBlock[],
): ToolImage[] | undefined {
  let images: ToolImage[] | undefined;
  for (const content of contents) {
    if (
      content.type !== "image" || content.image === undefined ||
      content.image.data === ""
    ) {
      continue;
    }
    if (images === undefined) images = [];
    images.push({
      mimeType: content.image.mimeType,
      data: content.image.data,
    });
  }
  return images;
}

/** Encoded image-request limits applied by the Agent Core admission check. */
export interface imageRequestBudget {
  maxImages: number;
  maxSingleBytes: number;
  maxTotalBytes: number;
}

/**
 * providerImageRequestBudget returns the encoded image payload limits for the
 * common provider wire formats. These limits are kept conservative here so raw
 * mode cannot bypass the final Agent Core request-admission check.
 */
export function providerImageRequestBudget(
  p: Provider | null | undefined,
  vendor: string,
): imageRequestBudget {
  const budget: imageRequestBudget = {
    maxImages: 0,
    maxSingleBytes: 20 << 20,
    maxTotalBytes: 0,
  };
  if (p === null || p === undefined) {
    return budget;
  }
  const providerKey = [vendor, p.name(), p.api()].join(" ").toLowerCase();
  if (providerKey.includes("groq")) {
    budget.maxImages = 5;
    budget.maxSingleBytes = 4 << 20;
    budget.maxTotalBytes = 4 << 20;
  } else if (providerKey.includes("bedrock")) {
    budget.maxSingleBytes = 5 << 20;
  } else if (providerKey.includes("anthropic")) {
    budget.maxSingleBytes = 10 << 20;
  }
  return budget;
}

/** Returns the encoded payload size of an image content block. */
export function encodedImagePayloadBytes(
  image: ImageContent | null | undefined,
): number {
  if (image === null || image === undefined) {
    return 0;
  }
  // ImageContent.data already contains base64, so its string length is the
  // encoded payload that crosses JSON provider APIs.
  return image.data.length + image.mimeType.length +
    "data:;base64,".length + 128;
}

function estimateToolDefinitionTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) {
    return 0;
  }
  let data: string;
  try {
    data = JSON.stringify(tools);
  } catch {
    return 0;
  }
  return estimateTextTokens(data);
}

/** Estimates the request-input tokens for system prompt + messages + tools. */
export function estimateChatRequestTokens(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
  estimator: TokenEstimator | null | undefined,
): number {
  const est = estimator ?? new GenericTokenEstimator();
  let total = estimateTextTokens(systemPrompt);
  total += estimateToolDefinitionTokens(tools);
  for (const msg of messages) {
    total += est.estimateTokens(msg);
  }
  return total;
}

/** Estimates a single tool result with the conservative guard heuristic. */
export function estimateGuardToolResultTokens(
  msg: Message,
  estimator: TokenEstimator | null | undefined,
): number {
  return estimateGuardTokens(msg, estimator ?? null);
}

/**
 * Estimates the request-input tokens using the conservative guard heuristic
 * for tool results.
 */
export function estimateGuardRequestTokens(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
  estimator: TokenEstimator | null | undefined,
): number {
  let total = estimateTextTokens(systemPrompt) +
    estimateToolDefinitionTokens(tools);
  for (const msg of messages) {
    total += estimateGuardToolResultTokens(msg, estimator);
  }
  return total;
}

/** Estimates usage for a request/assistant pair when the provider has no usage. */
export function estimateProviderUsage(
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
  assistant: Message,
  estimator: TokenEstimator | null | undefined,
): Usage {
  const est = estimator ?? new GenericTokenEstimator();
  const input = estimateChatRequestTokens(systemPrompt, messages, tools, est);
  const output = est.estimateTokens(assistant);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: createCost(),
  };
}

/**
 * completeProviderUsage fills missing provider-reported usage counters from the
 * local estimate, returning the estimate when no provider usage exists.
 */
export function completeProviderUsage(
  usage: Usage | null | undefined,
  estimated: Usage | null | undefined,
): Usage | null {
  if (usage === null || usage === undefined) {
    return estimated ?? null;
  }
  const est = estimated ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: createCost(),
  };
  if (usage.input <= 0) {
    if (usage.totalTokens > 0 && usage.output > 0) {
      usage.input = usage.totalTokens - usage.output;
    }
    if (usage.input <= 0) {
      usage.input = est.input;
    }
  }
  if (usage.output <= 0) {
    usage.output = est.output;
  }
  if (usage.totalTokens <= 0) {
    usage.totalTokens = usage.input + usage.cacheRead + usage.cacheWrite +
      usage.output;
  }
  return usage;
}

/**
 * repairDanglingToolCalls returns a copy of messages where every assistant
 * toolCall is directly followed by a matching toolResult. Results that were
 * recorded later in history (e.g. an aborted run appended them after newer
 * messages) are moved next to their assistant message; tool calls that never
 * produced a result (e.g. the run was interrupted before completion) get a
 * synthesized error result. Strict tool APIs (Kimi/OpenAI) reject requests
 * where an assistant tool_call has no adjacent tool response, so this keeps
 * the request valid even when the persisted history was left inconsistent by
 * an interrupted run. The input slice is never mutated.
 */
export function repairDanglingToolCalls(messages: Message[]): Message[] {
  let hasToolCall = false;
  for (const msg of messages) {
    for (const c of msg.contents ?? []) {
      if (c.type === "toolCall" && c.toolCall !== undefined) {
        hasToolCall = true;
        break;
      }
    }
    if (hasToolCall) {
      break;
    }
  }
  if (!hasToolCall) {
    return messages;
  }

  // Positions of toolResult messages by tool call ID.
  const resultIndex = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "toolResult" && (msg.toolCallId ?? "") !== "") {
      const id = msg.toolCallId as string;
      const list = resultIndex.get(id);
      if (list === undefined) {
        resultIndex.set(id, [i]);
      } else {
        list.push(i);
      }
    }
  }

  const consumed = new Set<number>(); // toolResult indices already placed
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "toolResult" && consumed.has(i)) {
      continue;
    }
    out.push(msg);
    if (msg.role !== "assistant") {
      continue;
    }
    const ids: string[] = [];
    for (const c of msg.contents ?? []) {
      if (
        c.type === "toolCall" && c.toolCall !== undefined &&
        c.toolCall.id !== ""
      ) {
        ids.push(c.toolCall.id);
      }
    }
    if (ids.length === 0) {
      continue;
    }
    const pending = new Set<string>(ids);
    // Consume toolResults that already directly follow this assistant message.
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (
        next.role !== "toolResult" || !pending.has(next.toolCallId ?? "") ||
        consumed.has(j)
      ) {
        break;
      }
      out.push(next);
      consumed.add(j);
      pending.delete(next.toolCallId as string);
    }
    // Pull matching results recorded later in history up next to the assistant
    // message.
    for (const id of ids) {
      if (!pending.has(id)) {
        continue;
      }
      for (const j of resultIndex.get(id) ?? []) {
        if (j > i && !consumed.has(j)) {
          out.push(messages[j]);
          consumed.add(j);
          pending.delete(id);
          break;
        }
      }
    }
    // Synthesize error results for tool calls that never produced a result.
    for (const id of ids) {
      if (!pending.has(id)) {
        continue;
      }
      let name = "";
      for (const c of msg.contents ?? []) {
        if (
          c.type === "toolCall" && c.toolCall !== undefined &&
          c.toolCall.id === id
        ) {
          name = c.toolCall.name;
          break;
        }
      }
      out.push(
        createToolResultMessage(
          id,
          name,
          "[Interrupted] Tool execution was aborted before a result was recorded.",
          true,
        ),
      );
      pending.delete(id);
    }
  }
  return out;
}

/** Reports whether a tool result is a synthesized context-guard placeholder. */
export function isContextGuardToolResult(msg: Message): boolean {
  return msg.role === "toolResult" &&
    (msg.content ?? "").startsWith("[Context guard]");
}

/** Builds the context-guard replacement for an oversized tool result. */
export function contextGuardToolResult(
  msg: Message,
  estimatedTokens: number,
  budgetTokens: number,
  contextWindow: number,
  reserveTokens: number,
): Message {
  let toolName = msg.toolName ?? "";
  if (toolName === "") {
    toolName = "tool";
  }
  const content = `[Context guard] The ${
    JSON.stringify(toolName)
  } tool output was omitted because sending it would exceed the model context window (estimated request: ${estimatedTokens} tokens; input budget: ${budgetTokens} tokens; context window: ${contextWindow}; reserved for output: ${reserveTokens}). Retry with a narrower scope: use read with offset/limit, grep/find with path/include/maxResults, or request smaller chunks and summarize incrementally.`;
  return {
    role: "toolResult",
    content,
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    isError: true,
    timestamp: msg.timestamp,
  };
}

/**
 * clampMaxTokensToContext reduces an output limit so input + output + the
 * safety margin fits the model context window.
 */
export function clampMaxTokensToContext(
  maxTokens: number,
  contextWindow: number,
  estimatedInputTokens: number,
): number {
  if (maxTokens <= 0 || contextWindow <= 0 || estimatedInputTokens <= 0) {
    return maxTokens;
  }
  let available = contextWindow - estimatedInputTokens -
    contextTokenSafetyMargin;
  if (available < 1) {
    available = 1;
  }
  if (maxTokens > available) {
    return available;
  }
  return maxTokens;
}

/**
 * selectCacheMarkers returns the indices of the two newest non-system-injected
 * messages, or -1 when absent. Index 1 is the newest marker, index 0 the second
 * newest.
 */
export function selectCacheMarkers(messages: Message[]): [number, number] {
  let newest = -1;
  let secondNewest = -1;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].systemInjected === true) {
      continue;
    }
    if (count === 0) {
      newest = i;
    } else if (count === 1) {
      secondNewest = i;
      break;
    }
    count++;
  }
  return [secondNewest, newest];
}

/**
 * applyCacheMarkers returns a deep copy of messages with an ephemeral
 * cache_control breakpoint added to the last content block of each marked
 * message. The input is never mutated.
 */
export function applyCacheMarkers(
  messages: Message[],
  markers: readonly [number, number],
): Message[] {
  if (markers[0] === -1 && markers[1] === -1) {
    return messages;
  }

  // Create a deep copy to avoid modifying the original messages.
  const result: Message[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const copy: Message = { ...msg };
    if ((msg.contents?.length ?? 0) > 0) {
      copy.contents = msg.contents!.map((cb) => {
        const block: ContentBlock = { ...cb };
        if (cb.image !== undefined) {
          block.image = { ...cb.image };
        }
        if (cb.toolCall !== undefined) {
          block.toolCall = { ...cb.toolCall };
        }
        if (cb.cache_control !== undefined) {
          block.cache_control = { ...cb.cache_control };
        }
        return block;
      });
    }
    result[i] = copy;
  }

  for (const idx of markers) {
    if (idx < 0 || idx >= result.length) {
      continue;
    }
    const msg = result[idx];
    if ((msg.contents?.length ?? 0) > 0) {
      msg.contents![msg.contents!.length - 1].cache_control = {
        type: "ephemeral",
      };
    } else if ((msg.content ?? "") !== "") {
      msg.contents = [{
        type: "text",
        text: msg.content,
        cache_control: { type: "ephemeral" },
      }];
      msg.content = "";
    }
  }

  return result;
}

/**
 * contentRejectionPlaceholder is the model-visible replacement for an image the
 * provider permanently refused.
 */
export function contentRejectionPlaceholder(
  images: number,
  detail: string,
): string {
  let reason = "the provider's content filter rejected it";
  if (detail.trim() !== "") {
    reason = `the provider's content filter rejected it (${detail.trim()})`;
  }
  return `[image unavailable] ${images} image(s) could not be sent to the model: ${reason}. The image data has been removed from the conversation so it can continue, and you can no longer see it. If the task depends on this image, tell the user the image was blocked by the provider's content inspection and ask them to describe the content or provide a different image.`;
}

/**
 * stripImagesFromMessage removes every image content block from a message and
 * records a single model-visible placeholder explaining the removal. It returns
 * the rewritten message and the number of images removed.
 */
export function stripImagesFromMessage(
  msg: Message,
  detail: string,
): [Message, number] {
  if (!containsImageContent(msg.contents ?? [])) {
    return [msg, 0];
  }
  const kept: ContentBlock[] = [];
  let removed = 0;
  for (const block of msg.contents ?? []) {
    if (block.type === "image" || block.image !== undefined) {
      removed++;
      continue;
    }
    kept.push(block);
  }
  if (removed === 0) {
    return [msg, 0];
  }
  if (kept.length === 0) {
    msg.contents = undefined;
  } else {
    msg.contents = kept;
  }
  const placeholder = contentRejectionPlaceholder(removed, detail);
  if ((msg.content ?? "").trim() === "") {
    msg.content = placeholder;
  } else {
    msg.content = msg.content + "\n\n" + placeholder;
  }
  return [msg, removed];
}

/**
 * lastUserTurnIndex returns the index of the newest real (non system-injected)
 * user message, or 0 when the conversation has none.
 */
export function lastUserTurnIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].systemInjected !== true) {
      return i;
    }
  }
  return 0;
}

/** contentOverride is one stripped message and the persisted entry it replaces. */
export interface contentOverride {
  entryID: string;
  message: Message;
}

/**
 * streamRecoveryRetryDelay bounds retry pressure while a provider is
 * unavailable. It shares the provider backoff curve but stays in Agent Core
 * because this retry resumes an already-started logical turn.
 */
export function streamRecoveryRetryDelay(attempt: number): number {
  const a = attempt < 1 ? 1 : attempt;
  return retryDelay(a - 1, 1000);
}

/**
 * waitForStreamRecoveryRetry waits without making cancellation sluggish. A
 * cancelled signal still resolves true so the loop reaches its canonical
 * cancellation terminal path on the next iteration.
 */
export function waitForStreamRecoveryRetry(
  ctx: AbortSignal | null | undefined,
  delayMs: number,
): Promise<boolean> {
  if (delayMs <= 0) {
    return Promise.resolve(true);
  }
  if (ctx !== null && ctx !== undefined && ctx.aborted) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), delayMs);
    if (ctx !== null && ctx !== undefined) {
      ctx.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    }
  });
}
