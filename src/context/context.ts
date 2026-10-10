import { type Message, type Usage } from "../provider/types.ts";
import { genericTokenEstimator, type TokenEstimator } from "./tokenizer.ts";

/**
 * ContextUsage holds the current request-input footprint. totalTokens is the
 * context-window total and is deliberately input-only; output tokens from a
 * previous response are not counted as current context.
 */
export interface ContextUsage {
  /** Deprecated alias for totalTokens. */
  tokens: number;
  /** Full current input footprint. */
  totalTokens: number;
  /** Non-cache input tokens. */
  input: number;
  /** Input tokens served from cache. */
  cacheRead: number;
  /** Input tokens written to cache. */
  cacheWrite: number;
  /** Maximum context window. */
  contextWindow: number;
  percent?: number;
}

/** Estimates token count for a message using the default estimator. */
export function estimateTokens(msg: Message): number {
  return genericTokenEstimator.estimateTokens(msg);
}

/**
 * CalculateContextTokens returns the provider-reported input footprint. It
 * excludes output tokens because this value is used against the next request's
 * context window.
 */
export function calculateContextTokens(
  usage: Usage | null | undefined,
): number {
  if (usage === null || usage === undefined) {
    return 0;
  }
  if (usage.totalTokens > 0 && usage.output >= 0) {
    const input = usage.totalTokens - usage.output;
    if (input > 0) {
      return input;
    }
  }
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * EstimateContextTokens estimates context tokens from messages using the
 * shared local tokenizer and provider usage when available.
 */
export function estimateContextTokens(messages: Message[]): {
  tokens: number;
  lastUsageIndex: number;
} {
  return estimateContextTokensWithEstimator(messages, genericTokenEstimator);
}

/**
 * ContextUsageFromMessages returns a detailed input-footprint estimate. A
 * provider usage record is authoritative for the latest completed assistant
 * turn; only messages added after it are estimated locally.
 */
export function contextUsageFromMessages(
  messages: Message[],
  estimator: TokenEstimator | null,
): ContextUsage {
  const est = estimator ?? genericTokenEstimator;
  let last = -1;
  let usage: Usage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      msg.usage !== undefined &&
      calculateContextTokens(msg.usage) > 0
    ) {
      last = i;
      usage = msg.usage;
      break;
    }
  }
  const result: ContextUsage = {
    tokens: 0,
    totalTokens: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextWindow: 0,
  };
  if (usage !== undefined) {
    result.totalTokens = calculateContextTokens(usage);
    result.cacheRead = usage.cacheRead;
    result.cacheWrite = usage.cacheWrite;
    // ContextUsage.input is the non-cache portion of the input footprint.
    // Provider usage is normalized here because OpenAI-compatible APIs
    // commonly include cached tokens in their prompt_tokens field while
    // Anthropic reports them separately.
    result.input = result.totalTokens - result.cacheRead - result.cacheWrite;
    if (result.input < 0) {
      result.input = usage.input;
    }
    if (result.totalTokens === 0) {
      result.totalTokens = result.input + result.cacheRead + result.cacheWrite;
    }
  }
  let start = 0;
  if (last >= 0) {
    start = last + 1;
  }
  for (const msg of messages.slice(start)) {
    const tokens = est.estimateTokens(msg);
    result.totalTokens += tokens;
    // Locally estimated trailing content has no provider cache attribution.
    result.input += tokens;
  }
  result.tokens = result.totalTokens;
  return result;
}

/**
 * EstimateContextTokensWithEstimator estimates context tokens using provider
 * usage when available, then the supplied estimator for trailing messages.
 */
export function estimateContextTokensWithEstimator(
  messages: Message[],
  estimator: TokenEstimator,
): { tokens: number; lastUsageIndex: number } {
  const result = contextUsageFromMessages(messages, estimator);
  let lastUsageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      msg.usage !== undefined &&
      calculateContextTokens(msg.usage) > 0
    ) {
      lastUsageIndex = i;
      break;
    }
  }
  return { tokens: result.totalTokens, lastUsageIndex };
}

/** Checks if compaction should trigger based on context usage. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  if (contextWindow <= 0) {
    return false;
  }
  return contextTokens > contextWindow - reserveTokens;
}

/**
 * Checks if compaction should trigger based on the percentage of the context
 * window currently occupied.
 */
export function shouldCompactPercent(
  contextTokens: number,
  contextWindow: number,
  threshold: number,
): boolean {
  if (contextWindow <= 0 || threshold <= 0) {
    return false;
  }
  let t = threshold;
  if (t > 1) {
    t = t / 100;
  }
  return contextTokens / contextWindow >= t;
}
