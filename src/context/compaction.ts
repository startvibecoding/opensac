//
// Deviations:
// - `context.Context` maps to an optional `AbortSignal` threaded through the
//   summary calls.
// - Go's goroutine fan-out over large tool results maps to a bounded async
//   worker pool (same `maxParallelToolCompactions` limit).
// - `json.RawMessage` tool arguments are serialized back to text for prompts.

import type { Provider } from "../provider/provider.ts";
import { retryDelay } from "../provider/retry.ts";
import {
  type ChatParams,
  type ContentBlock,
  createSystemInjectedUserMessage,
  createUserMessage,
  type Message,
  type Model,
  normalizeThinkingLevel,
  streamError,
  type StreamEvent,
  streamTextDelta,
  type ThinkingLevel,
  type ToolDefinition,
} from "../provider/types.ts";
import { truncateWithSuffix } from "../util/truncate.ts";
import { type TokenEstimator } from "./tokenizer.ts";
import {
  estimateGuardTokens,
  genericTokenEstimator,
  resolveTokenEstimator,
} from "./tokenizer.ts";

export const defaultMaxCompactionSummaryTokens = 4096;
export const defaultLargeToolResultTokens = 12000;

// Keep fan-out deliberately small: some providers enforce a low concurrent
// request limit and otherwise turn parallel sub-compaction into HTTP 429s.
export const maxParallelToolCompactions = 2;

function abs(x: number): number {
  return x < 0 ? -x : x;
}

/** CompactionSettings holds compaction configuration. */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  tokenizer?: string;
  tokenizerModel?: string;
  template?: string;
}

/** Returns default compaction settings. */
export function defaultCompactionSettings(): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  };
}

/** Applies runtime defaults for zero-valued limits. */
export function normalizeCompactionSettings(
  settings: CompactionSettings,
): CompactionSettings {
  const defaults = defaultCompactionSettings();
  const result = { ...settings };
  if (result.reserveTokens === 0) {
    result.reserveTokens = defaults.reserveTokens;
  }
  if (result.keepRecentTokens === 0) {
    result.keepRecentTokens = defaults.keepRecentTokens;
  }
  return result;
}

function compactionSummaryMaxTokens(
  settings: CompactionSettings,
  model: Model | null,
): number {
  let maxTokens = Math.trunc(settings.reserveTokens * 0.8);
  if (maxTokens <= 0 || maxTokens > defaultMaxCompactionSummaryTokens) {
    maxTokens = defaultMaxCompactionSummaryTokens;
  }
  if (model !== null && model.maxTokens > 0 && maxTokens > model.maxTokens) {
    maxTokens = model.maxTokens;
  }
  return maxTokens;
}

/** CompactionResult holds the result of a compaction operation. */
export interface CompactionResult {
  summary: string;
  firstKeptIndex: number;
  tokensBefore: number;
}

/**
 * CompactOptions controls how aggressively compaction should preserve recent
 * messages. Forced compaction is used for explicit user requests and may
 * produce a summary-only checkpoint when there is no older history outside the
 * recent keep window.
 */
export interface CompactOptions {
  force?: boolean;

  // Keep compaction requests aligned with the main agent request. The output
  // limit is intentionally separate, but reasoning and sampling settings are
  // carried through instead of falling back to provider defaults.
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  topP?: number;

  // Summarize is supplied by the agent runtime. It must execute the summary
  // through the normal sub-agent Agent loop; this package only prepares the
  // messages and never owns provider request construction.
  summarize?: (
    signal: AbortSignal | undefined,
    messages: Message[],
    maxTokens: number,
  ) => Promise<string>;
}

/** CutPointResult holds information about where to cut the conversation. */
export interface CutPointResult {
  firstKeptIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/**
 * Finds valid cut points in messages. Valid cut points are user, assistant
 * messages (never tool results).
 */
export function findValidCutPoints(
  messages: Message[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex && i < messages.length; i++) {
    const msg = messages[i];
    switch (msg.role) {
      case "user":
      case "assistant":
        cutPoints.push(i);
        break;
      case "toolResult":
        // Never cut at tool results
        break;
    }
  }
  return cutPoints;
}

/**
 * Finds the user message that starts the turn containing the given index.
 */
export function findTurnStartIndex(
  messages: Message[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    if (messages[i].role === "user") {
      return i;
    }
  }
  return -1;
}

/** Finds the cut point that keeps approximately keepRecentTokens. */
export function findCutPoint(
  messages: Message[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  return findCutPointWithEstimator(
    messages,
    startIndex,
    endIndex,
    keepRecentTokens,
    genericTokenEstimator,
  );
}

/** Finds the cut point using the supplied token estimator. */
export function findCutPointWithEstimator(
  messages: Message[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  estimator: TokenEstimator | null,
): CutPointResult {
  const est = estimator ?? genericTokenEstimator;
  const cutPoints = findValidCutPoints(messages, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return {
      firstKeptIndex: startIndex,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  // Walk backwards from newest, accumulating estimated message sizes
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]; // Default: keep from first message

  const hi = Math.min(endIndex, messages.length);
  for (let i = hi - 1; i >= startIndex; i--) {
    const messageTokens = est.estimateTokens(messages[i]);
    accumulatedTokens += messageTokens;

    if (accumulatedTokens >= keepRecentTokens) {
      // Find the closest valid cut point to this entry
      let bestCut = cutPoints[0];
      let bestDist = abs(bestCut - i);
      for (const c of cutPoints) {
        const dist = abs(c - i);
        if (dist < bestDist) {
          bestDist = dist;
          bestCut = c;
        }
      }
      cutIndex = bestCut;
      break;
    }
  }

  // Determine if this is a split turn
  const isUserMessage = messages[cutIndex].role === "user";
  let turnStartIndex = -1;
  if (!isUserMessage) {
    turnStartIndex = findTurnStartIndex(messages, cutIndex, startIndex);
  }

  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

function messagesToSummarizeForCompaction(
  messages: Message[],
  settings: CompactionSettings,
  estimator: TokenEstimator,
  previousSummary: string,
): { messages: Message[]; cutPoint: CutPointResult } {
  const cutPoint = findCutPointWithEstimator(
    messages,
    0,
    messages.length,
    settings.keepRecentTokens,
    estimator,
  );

  let messagesToSummarize = messages.slice(0, cutPoint.firstKeptIndex);
  if (cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0) {
    messagesToSummarize = messages.slice(0, cutPoint.turnStartIndex);
  }
  messagesToSummarize = stripLeadingPreviousSummary(
    messagesToSummarize,
    previousSummary,
  );

  return { messages: messagesToSummarize, cutPoint };
}

/**
 * Reports whether compaction would have older messages to summarize after
 * preserving the configured recent context.
 */
export function hasCompactableMessages(
  messages: Message[],
  model: Model | null,
  settings: CompactionSettings,
  previousSummary: string,
): boolean {
  if (messages.length === 0) {
    return false;
  }
  const estimator = resolveTokenEstimator(settings, model);
  const { messages: messagesToSummarize } = messagesToSummarizeForCompaction(
    messages,
    settings,
    estimator,
    previousSummary,
  );
  return messagesToSummarize.length > 0;
}

/** Serializes messages to text for summarization. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    // Skip system-injected messages
    if (msg.systemInjected === true) {
      continue;
    }

    switch (msg.role) {
      case "user": {
        let content = msg.content ?? "";
        if (content === "") {
          content = serializeContentBlocks(msg.contents ?? []);
        }
        parts.push(`User: ${content}\n\n`);
        break;
      }
      case "assistant": {
        parts.push("Assistant: ");
        let content = msg.content ?? "";
        if (content === "") {
          content = serializeTextBlocks(msg.contents ?? []);
        }
        parts.push(content);
        for (const block of msg.contents ?? []) {
          switch (block.type) {
            case "thinking":
              parts.push(`[thinking: ${block.thinking ?? ""}]`);
              break;
            case "toolCall":
              if (block.toolCall !== undefined) {
                parts.push(
                  `[tool_call: ${block.toolCall.name}(${
                    stringifyArguments(block.toolCall)
                  })]`,
                );
              }
              break;
          }
        }
        parts.push("\n\n");
        break;
      }
      case "toolResult": {
        let content = msg.content ?? "";
        if (content === "") {
          content = serializeContentBlocks(msg.contents ?? []);
        }
        parts.push(
          `Tool Result [${msg.toolName ?? ""}]: ${
            truncateString(content, 500)
          }\n\n`,
        );
        break;
      }
    }
  }

  return parts.join("");
}

function serializeTextBlocks(blocks: ContentBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text") {
      out += block.text ?? "";
    }
  }
  return out;
}

function serializeContentBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if ((block.text ?? "") !== "") {
          parts.push(block.text!);
        }
        break;
      case "image":
        if (block.image !== undefined) {
          parts.push(`[image: ${block.image.mimeType}]`);
        } else {
          parts.push("[image]");
        }
        break;
      case "thinking":
        parts.push(`[thinking: ${block.thinking ?? ""}]`);
        break;
      case "toolCall":
        if (block.toolCall !== undefined) {
          parts.push(
            `[tool_call: ${block.toolCall.name}(${
              stringifyArguments(block.toolCall)
            })]`,
          );
        }
        break;
    }
  }
  return parts.join("\n");
}

function stringifyArguments(call: {
  arguments?: unknown;
  invalidArguments?: string;
}): string {
  if (call.invalidArguments !== undefined) return call.invalidArguments;
  const args = call.arguments;
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

function truncateString(s: string, maxLen: number): string {
  return truncateWithSuffix(s, maxLen, "...");
}

/** CompressionTemplate contains instructions for initial and update compaction. */
export interface CompressionTemplate {
  name: string;
  instruction: string;
  updateInstruction: string;
}

// defaultCompressionInstruction is injected into the conversation for
// Insert-then-Compress. This implements Rule R4.2: the compression instruction
// is a system_injected message.
const defaultCompressionInstruction =
  `Please create a structured context checkpoint summary of our conversation so far.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- Or "(none)" if none were mentioned

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- Or "(none)" if not applicable

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// defaultUpdateCompressionInstruction is used when there's an existing summary
// to update.
const defaultUpdateCompressionInstruction =
  `Please update the existing summary with new information from our conversation.

<existing-summary>
%s
</existing-summary>

RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the same EXACT format as the existing summary.`;

const codeCompressionInstruction =
  `Please create a structured coding checkpoint summary of our work so far.

Use this EXACT format:

## Goal
[What coding task is being solved?]

## Constraints & Preferences
- [User requirements, repo conventions, safety constraints]
- Or "(none)" if none were mentioned

## Code Changes
### Done
- [x] [Completed code or docs changes with exact file paths]

### In Progress
- [ ] [Current implementation or review state]

### Not Started
- [ ] [Planned but untouched follow-up work]

## Technical Decisions
- **[Decision]**: [Reason and affected files/functions]

## Verification
- [Commands run and results]
- [Commands not run and why]

## Next Steps
1. [Ordered continuation steps]

## Critical Context
- [Exact file paths, function names, errors, API contracts, or examples needed to continue]
- Or "(none)" if not applicable

Keep each section concise. Preserve exact file paths, function names, commands, and error messages.`;

const codeUpdateCompressionInstruction =
  `Please update the existing coding checkpoint summary with new information from our conversation.

<existing-summary>
%s
</existing-summary>

RULES:
- PRESERVE all still-relevant code changes, file paths, function names, commands, and error messages
- ADD new implementation progress, verification results, and technical decisions
- UPDATE Done/In Progress/Not Started based on what changed
- REMOVE stale next steps only when they are clearly completed or no longer relevant
- Keep the same EXACT format as the existing summary.`;

const conversationCompressionInstruction =
  `Please create a concise conversation checkpoint summary of our conversation so far.

Use this EXACT format:

## Objective
[What the user wants]

## Preferences
- [User preferences or constraints]
- Or "(none)" if none were mentioned

## Discussion So Far
- [Important points and outcomes]

## Decisions
- **[Decision]**: [Brief rationale]

## Open Items
1. [What remains unresolved or should happen next]

## Critical Details
- [Exact names, values, references, or examples needed to continue]
- Or "(none)" if not applicable

Keep it concise and preserve exact identifiers, paths, commands, and error messages.`;

const conversationUpdateCompressionInstruction =
  `Please update the existing conversation checkpoint summary with new information.

<existing-summary>
%s
</existing-summary>

RULES:
- PRESERVE still-relevant objective, preferences, decisions, and critical details
- ADD new outcomes and open items from the new messages
- UPDATE stale open items when completed
- Keep the same EXACT format as the existing summary.`;

/** Returns a built-in compression template. */
export function resolveCompressionTemplate(name: string): CompressionTemplate {
  switch ((name ?? "").trim().toLowerCase()) {
    case "code":
      return {
        name: "code",
        instruction: codeCompressionInstruction,
        updateInstruction: codeUpdateCompressionInstruction,
      };
    case "conversation":
      return {
        name: "conversation",
        instruction: conversationCompressionInstruction,
        updateInstruction: conversationUpdateCompressionInstruction,
      };
    default:
      return {
        name: "default",
        instruction: defaultCompressionInstruction,
        updateInstruction: defaultUpdateCompressionInstruction,
      };
  }
}

/**
 * Generates a summary using Insert-then-Compress pattern. This implements Rule
 * R4.1-R4.2: use the SAME system prompt and tools, not a separate call. The
 * compression instruction is injected as a system_injected user message at the
 * end of the conversation.
 */
export function generateSummaryInsertThenCompress(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  tools: ToolDefinition[] | null,
  previousSummary: string,
  maxTokens: number,
): Promise<string> {
  return generateSummaryInsertThenCompressWithOptions(
    signal,
    messages,
    p,
    model,
    systemPrompt,
    tools,
    previousSummary,
    maxTokens,
    resolveCompressionTemplate(""),
    {},
  );
}

/**
 * Generates a summary using the supplied compression template.
 */
export function generateSummaryInsertThenCompressWithTemplate(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  tools: ToolDefinition[] | null,
  previousSummary: string,
  maxTokens: number,
  template: CompressionTemplate,
): Promise<string> {
  return generateSummaryInsertThenCompressWithOptions(
    signal,
    messages,
    p,
    model,
    systemPrompt,
    tools,
    previousSummary,
    maxTokens,
    template,
    {},
  );
}

async function generateSummaryInsertThenCompressWithOptions(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  tools: ToolDefinition[] | null,
  previousSummary: string,
  maxTokens: number,
  template: CompressionTemplate,
  options: CompactOptions,
): Promise<string> {
  let tpl = template;
  if (tpl.instruction === "" || tpl.updateInstruction === "") {
    tpl = resolveCompressionTemplate("");
  }

  // Build compression instruction
  const instruction = previousSummary !== ""
    ? applyUpdateInstruction(tpl.updateInstruction, previousSummary)
    : tpl.instruction;

  // Create the compression instruction message (system_injected)
  const compressionMsg = createSystemInjectedUserMessage(instruction);

  // Build messages: original conversation + compression instruction
  const compactionMessages: Message[] = [...messages, compressionMsg];

  if (options.summarize !== undefined) {
    return options.summarize(signal, compactionMessages, maxTokens);
  }

  // Legacy standalone API fallback. Agent runtime always supplies Summarize.
  // Keep this for callers of the context package that predate the Agent loop.
  const params: ChatParams = {
    messages: compactionMessages,
    tools: tools ?? undefined,
    systemPrompt,
    thinkingLevel: normalizeThinkingLevel(options.thinkingLevel ?? ""),
    maxTokens,
    temperature: options.temperature,
    topP: options.topP,
    modelId: model !== null ? model.id : "",
    abort: signal,
  };

  const summary = await collectStream(p.chat(params), signal, "summarization");
  const result = summary.trim();
  if (result === "") {
    throw new Error("summarization returned empty result");
  }
  return result;
}

function applyUpdateInstruction(
  template: string,
  previousSummary: string,
): string {
  // Use a function replacement so `$` sequences in the summary are literal.
  return template.replace("%s", () => previousSummary);
}

async function collectStream(
  stream: AsyncIterable<StreamEvent>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<string> {
  let out = "";
  for await (const event of stream) {
    switch (event.type) {
      case streamTextDelta:
        out += event.textDelta ?? "";
        break;
      case streamError:
        if (event.error !== undefined) {
          if (isCancelOrDeadline(event.error, signal)) {
            throw event.error;
          }
          throw new Error(`${what} failed: ${errorMessage(event.error)}`);
        }
        break;
    }
  }
  return out;
}

/**
 * The legacy interface that delegates to Insert-then-Compress. Kept for
 * backward compatibility but now uses the same system prompt.
 * Deprecated: use generateSummaryInsertThenCompress directly.
 */
export function generateSummary(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  reserveTokens: number,
  previousSummary: string,
): Promise<string> {
  const maxTokens = compactionSummaryMaxTokens(
    { ...defaultCompactionSettings(), reserveTokens },
    model,
  );
  return generateSummaryInsertThenCompress(
    signal,
    messages,
    p,
    model,
    "",
    null,
    previousSummary,
    maxTokens,
  );
}

const largeToolResultCompressionInstruction =
  `Summarize the following tool result for a later conversation checkpoint.

Preserve exact file paths, identifiers, commands, error messages, decisions, and other facts needed to continue the task. Remove repetition and incidental detail. Return only the concise factual summary; do not call tools.

Tool: %s`;

/**
 * Replaces very large tool outputs with concise summaries before the
 * conversation-wide compaction. Each tool result is summarized independently
 * and concurrently, while preserving its original role and tool-call identity
 * so provider message ordering remains valid.
 */
export function compressLargeToolResults(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  estimator: TokenEstimator | null,
): Promise<Message[]> {
  return compressLargeToolResultsWithOptions(
    signal,
    messages,
    p,
    model,
    systemPrompt,
    estimator,
    {},
  );
}

async function compressLargeToolResultsWithOptions(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  estimator: TokenEstimator | null,
  options: CompactOptions,
): Promise<Message[]> {
  const est = estimator ?? genericTokenEstimator;
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "toolResult" &&
      estimateGuardTokens(msg, est) >= defaultLargeToolResultTokens
    ) {
      indices.push(i);
    }
  }
  if (indices.length === 0) {
    return messages;
  }

  const result: Message[] = messages.slice();
  const outputs = await mapConcurrent(
    indices,
    maxParallelToolCompactions,
    signal,
    async (index) => {
      try {
        return await summarizeToolResultWithOptions(
          signal,
          messages[index],
          p,
          model,
          systemPrompt,
          options,
        );
      } catch (err) {
        throw new Error(
          `compress tool result ${index}: ${errorMessage(err)}`,
          { cause: err },
        );
      }
    },
  );

  for (let n = 0; n < indices.length; n++) {
    const index = indices[n];
    const msg = result[index];
    result[index] = { ...msg, content: outputs[n], contents: undefined };
  }
  return result;
}

/**
 * Runs `fn` over `items` with at most `limit` concurrent tasks, preserving the
 * input order of the returned values. Mirrors the Go semaphore-bounded fan-out.
 */
async function mapConcurrent<T>(
  items: number[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: number, index: number) => Promise<T>,
): Promise<T[]> {
  const outputs = new Array<T>(items.length);
  let cursor = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const n = cursor++;
      if (n >= items.length) return;
      if (signal?.aborted) {
        firstError = abortReason(signal);
        return;
      }
      try {
        outputs[n] = await fn(items[n], n);
      } catch (err) {
        if (firstError === undefined) firstError = err;
        return;
      }
    }
  };
  const workerCount = Math.min(limit, Math.max(1, items.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (firstError !== undefined) {
    throw firstError;
  }
  return outputs;
}

export function summarizeToolResult(
  signal: AbortSignal | undefined,
  msg: Message,
  p: Provider,
  model: Model | null,
  systemPrompt: string,
): Promise<string> {
  return summarizeToolResultWithOptions(
    signal,
    msg,
    p,
    model,
    systemPrompt,
    {},
  );
}

async function summarizeToolResultWithOptions(
  signal: AbortSignal | undefined,
  msg: Message,
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  options: CompactOptions,
): Promise<string> {
  if (options.summarize !== undefined) {
    const prompt = toolResultSummaryPrompt(msg);
    return options.summarize(signal, [createUserMessage(prompt)], 2048);
  }

  const maxRateLimitRetries = 2;
  for (let attempt = 0;; attempt++) {
    try {
      return await summarizeToolResultOnceWithOptions(
        signal,
        msg,
        p,
        model,
        systemPrompt,
        options,
      );
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxRateLimitRetries) {
        throw err;
      }
      await sleep(retryDelay(attempt, 2000), signal);
    }
  }
}

export function summarizeToolResultOnce(
  signal: AbortSignal | undefined,
  msg: Message,
  p: Provider,
  model: Model | null,
  systemPrompt: string,
): Promise<string> {
  return summarizeToolResultOnceWithOptions(
    signal,
    msg,
    p,
    model,
    systemPrompt,
    {},
  );
}

async function summarizeToolResultOnceWithOptions(
  signal: AbortSignal | undefined,
  msg: Message,
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  options: CompactOptions,
): Promise<string> {
  const prompt = toolResultSummaryPrompt(msg);
  const params: ChatParams = {
    // Do not send a standalone toolResult message. Provider protocols require
    // a tool result to follow an assistant tool call, which is not present in
    // this independent sub-request. Encode the result as delimited user text.
    messages: [createUserMessage(prompt)],
    systemPrompt,
    thinkingLevel: normalizeThinkingLevel(options.thinkingLevel ?? ""),
    maxTokens: 2048,
    temperature: options.temperature,
    topP: options.topP,
    modelId: model !== null ? model.id : "",
    abort: signal,
  };
  const summary = await collectStream(
    p.chat(params),
    signal,
    "tool result summarization",
  );
  const result = summary.trim();
  if (result === "") {
    throw new Error("tool result summarization returned empty result");
  }
  return result;
}

function toolResultSummaryPrompt(msg: Message): string {
  let toolName = msg.toolName ?? "";
  if (toolName === "") {
    toolName = "tool";
  }
  let toolOutput = msg.content ?? "";
  if (msg.contents !== undefined && msg.contents.length > 0) {
    const parts: string[] = [];
    for (const block of msg.contents) {
      switch (block.type) {
        case "text":
          if ((block.text ?? "") !== "") {
            parts.push(block.text!);
          }
          break;
        case "thinking":
          if ((block.thinking ?? "") !== "") {
            parts.push(block.thinking!);
          }
          break;
      }
    }
    if (parts.length > 0) {
      toolOutput = parts.join("\n");
    }
  }
  if (toolOutput.trim() === "") {
    toolOutput = "Tool completed with no output.";
  }
  const instruction = largeToolResultCompressionInstruction.replace(
    "%s",
    () => toolName,
  );
  return `${instruction}\n\n<tool_result name=${
    goQuote(toolName)
  }>\n${toolOutput}\n</tool_result>`;
}

function isRateLimitError(err: unknown): boolean {
  if (err === null || err === undefined) {
    return false;
  }
  const message = errorMessage(err).toLowerCase();
  return message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("too many requests");
}

/**
 * Performs context compaction on the messages using Insert-then-Compress
 * pattern.
 */
export function compact(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  tools: ToolDefinition[] | null,
  settings: CompactionSettings,
  previousSummary: string,
): Promise<CompactionResult> {
  return compactWithOptions(
    signal,
    messages,
    p,
    model,
    systemPrompt,
    tools,
    settings,
    previousSummary,
    {},
  );
}

/** Performs context compaction with optional forced behavior. */
export async function compactWithOptions(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  systemPrompt: string,
  tools: ToolDefinition[] | null,
  settings: CompactionSettings,
  previousSummary: string,
  options: CompactOptions,
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error("no messages to compact");
  }

  const estimator = resolveTokenEstimator(settings, model);
  const tokensBefore = estimator.estimateMessagesTokens(messages);

  // Find cut point - keep recent messages, summarize older ones
  let { messages: messagesToSummarize, cutPoint } =
    messagesToSummarizeForCompaction(
      messages,
      settings,
      estimator,
      previousSummary,
    );

  if (messagesToSummarize.length === 0) {
    if (!options.force) {
      throw new Error("nothing to compact");
    }
    messagesToSummarize = stripLeadingPreviousSummary(
      messages,
      previousSummary,
    );
    if (messagesToSummarize.length === 0) {
      throw new Error("nothing to compact");
    }
    cutPoint = {
      firstKeptIndex: messages.length,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  // First compress oversized tool outputs independently. This keeps the
  // conversation-wide summarization request bounded while preserving each
  // tool result's role and call identity.
  try {
    messagesToSummarize = await compressLargeToolResultsWithOptions(
      signal,
      messagesToSummarize,
      p,
      model,
      systemPrompt,
      estimator,
      options,
    );
  } catch (err) {
    throw new Error(`compress large tool results: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  // Calculate max tokens for summary
  const maxTokens = compactionSummaryMaxTokens(settings, model);

  // Generate summary using Insert-then-Compress (R4.1-R4.2)
  let summary: string;
  try {
    summary = await generateSummaryInsertThenCompressWithOptions(
      signal,
      messagesToSummarize,
      p,
      model,
      systemPrompt,
      tools,
      previousSummary,
      maxTokens,
      resolveCompressionTemplate(settings.template ?? ""),
      options,
    );
  } catch (err) {
    throw new Error(`generate summary: ${errorMessage(err)}`, { cause: err });
  }

  // When IsSplitTurn is true, messagesToSummarize was truncated to
  // TurnStartIndex, so firstKeptIndex must reflect TurnStartIndex to avoid
  // silently dropping messages.
  let firstKept = cutPoint.firstKeptIndex;
  if (cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0) {
    firstKept = cutPoint.turnStartIndex;
  }

  return {
    summary,
    firstKeptIndex: firstKept,
    tokensBefore,
  };
}

/**
 * A compatibility wrapper that calls the old Compact signature.
 * Deprecated: use the new compact with systemPrompt and tools parameters.
 */
export function compactWithLegacyInterface(
  signal: AbortSignal | undefined,
  messages: Message[],
  p: Provider,
  model: Model | null,
  settings: CompactionSettings,
  previousSummary: string,
): Promise<CompactionResult> {
  return compact(
    signal,
    messages,
    p,
    model,
    "",
    null,
    settings,
    previousSummary,
  );
}

function stripLeadingPreviousSummary(
  messages: Message[],
  previousSummary: string,
): Message[] {
  if (previousSummary === "" || messages.length === 0) {
    return messages;
  }
  const first = messages[0];
  if (
    first.systemInjected === true && first.role === "user" &&
    first.content === previousSummary
  ) {
    return messages.slice(1);
  }
  return messages;
}

function goQuote(s: string): string {
  // Mirrors Go's %q for the ASCII tool names this path receives.
  return JSON.stringify(s);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function isCancelOrDeadline(
  err: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted === true) return true;
  if (err instanceof DOMException) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const message = err.message.toLowerCase();
    return message.includes("operation was aborted") ||
      message.includes("context canceled") ||
      message.includes("deadline exceeded");
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
