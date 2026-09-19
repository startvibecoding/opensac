// Ported from internal/context/tokenizer.go
//
// Deviation: `json.RawMessage` tool-call arguments map to `unknown` (decoded
// JSON). Byte-length accounting serializes them back to text with the same
// helper the provider debug logging uses, and falls back to `invalidArguments`
// when the original bytes were not valid JSON.

import { type Family, type Hint, inferFamily } from "../imageproc/mod.ts";
import type {
  ContentBlock,
  ImageContent,
  Message,
  Model,
} from "../provider/types.ts";
import { deepSeekTokenCount } from "./deepseek_tokenizer.ts";
import type { CompactionSettings } from "./compaction.ts";

/** Estimates the context footprint of provider messages. */
export interface TokenEstimator {
  estimateTokens(msg: Message): number;
  estimateMessagesTokens(messages: Message[]): number;
}

function stringifyToolArguments(block: ContentBlock): string {
  const call = block.toolCall;
  if (call === undefined) return "";
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

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * GenericTokenEstimator uses the embedded DeepSeek V3 byte-level BPE tokenizer
 * for text and the existing provider-aware formulas for images.
 */
export class GenericTokenEstimator implements TokenEstimator {
  estimateTokens(msg: Message): number {
    return estimateMessageTokens(msg, estimateImageTokens);
  }

  estimateMessagesTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg);
    }
    return total;
  }
}

/**
 * ModelAwareTokenEstimator uses the same local DeepSeek V3 tokenizer for all
 * text. Model-specific image formulas are retained because image tokens are
 * not represented by the text tokenizer.
 */
export class ModelAwareTokenEstimator implements TokenEstimator {
  readonly model: Model | null;

  constructor(model: Model | null) {
    this.model = model;
  }

  estimateTokens(msg: Message): number {
    return estimateMessageTokens(
      msg,
      (image) => estimateImageTokensForModelOrGeneric(image, this.model),
    );
  }

  estimateMessagesTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg);
    }
    return total;
  }
}

function estimateMessageTokens(
  msg: Message,
  estimateImage: (image: ImageContent | undefined) => number,
): number {
  let tokens = 0;
  if (msg.contents !== undefined && msg.contents.length > 0) {
    for (const block of msg.contents) {
      switch (block.type) {
        case "text":
          tokens += deepSeekTokenCount(block.text ?? "");
          break;
        case "thinking":
          tokens += deepSeekTokenCount(block.thinking ?? "");
          break;
        case "toolCall":
          if (block.toolCall !== undefined) {
            tokens += deepSeekTokenCount(block.toolCall.name);
            tokens += deepSeekTokenCount(stringifyToolArguments(block));
          }
          break;
        case "image":
          tokens += estimateImage(block.image);
          break;
      }
    }
    return tokens;
  }
  return deepSeekTokenCount(msg.content ?? "");
}

function estimateImageTokens(image: ImageContent | undefined): number {
  if (
    image !== undefined && (image.width ?? 0) > 0 && (image.height ?? 0) > 0
  ) {
    return estimateGenericImageTokens(image.width!, image.height!);
  }
  // Preserve the previous minimum visual-token cost and payload-size guard.
  let imageChars = 4800;
  if (image !== undefined && image.data.length > imageChars) {
    imageChars = image.data.length;
  }
  return Math.floor((imageChars + 3) / 4);
}

function estimateImageTokensForModelOrGeneric(
  image: ImageContent | undefined,
  model: Model | null,
): number {
  const tokens = estimateImageTokensForModel(image, model);
  if (tokens > 0) return tokens;
  return estimateImageTokens(image);
}

/**
 * ResolveTokenEstimator returns the configured estimator. Text always uses the
 * embedded DeepSeek V3 tokenizer; the model only affects image accounting.
 */
export function resolveTokenEstimator(
  settings: CompactionSettings,
  model: Model | null,
): TokenEstimator {
  void settings.tokenizer; // retained for config compatibility
  if (model !== null) {
    return new ModelAwareTokenEstimator(model);
  }
  return new GenericTokenEstimator();
}

/** EstimateTextTokens returns the shared local text token estimate. */
export function estimateTextTokens(text: string): number {
  return deepSeekTokenCount(text);
}

/**
 * EstimateGuardTokens returns a conservative request-size estimate for one
 * message. It uses the shared tokenizer, with a payload-size floor for tool
 * results whose repetitive content can compress unusually well under BPE.
 */
export function estimateGuardTokens(
  msg: Message,
  estimator: TokenEstimator | null,
): number {
  const est = estimator ?? new GenericTokenEstimator();
  const tokens = est.estimateTokens(msg);
  if (msg.role !== "toolResult") {
    return tokens;
  }
  const floor = Math.floor((estimateMessageChars(msg) + 3) / 4);
  if (floor > tokens) {
    return floor;
  }
  return tokens;
}

function estimateMessageChars(msg: Message): number {
  return estimateMessageCharsWithImageEstimator(msg, estimateImageChars);
}

function estimateMessageCharsWithImageEstimator(
  msg: Message,
  estimateImage: (image: ImageContent | undefined) => number,
): number {
  let chars = 0;

  if (msg.contents !== undefined && msg.contents.length > 0) {
    // Rich content blocks take precedence; avoid double-counting with Content.
    for (const block of msg.contents) {
      switch (block.type) {
        case "text":
          chars += byteLen(block.text ?? "");
          break;
        case "thinking":
          chars += byteLen(block.thinking ?? "");
          break;
        case "toolCall":
          if (block.toolCall !== undefined) {
            chars += byteLen(block.toolCall.name);
            chars += byteLen(stringifyToolArguments(block));
          }
          break;
        case "image":
          chars += estimateImage(block.image);
          break;
      }
    }
  } else if ((msg.content ?? "") !== "") {
    chars += byteLen(msg.content!);
  }

  return chars;
}

function estimateImageChars(image: ImageContent | undefined): number {
  if (
    image !== undefined && (image.width ?? 0) > 0 && (image.height ?? 0) > 0
  ) {
    const tokens = estimateGenericImageTokens(image.width!, image.height!);
    return tokens * 4;
  }
  // Preserve the existing minimum visual-token cost and payload-size guard.
  // Provider-specific image estimators can replace this through TokenEstimator
  // without changing callers.
  let imageChars = 4800;
  if (image !== undefined && image.data.length > imageChars) {
    imageChars = image.data.length;
  }
  return imageChars;
}

function estimateGenericImageTokens(width: number, height: number): number {
  return ceilDiv(width, 512) * ceilDiv(height, 512) * 800;
}

function estimateImageTokensForModel(
  image: ImageContent | undefined,
  model: Model | null,
): number {
  if (
    image === undefined || (image.width ?? 0) <= 0 ||
    (image.height ?? 0) <= 0 ||
    model === null
  ) {
    return 0;
  }
  const hint: Hint = {
    providerID: model.provider,
    modelID: model.id,
  };
  const family: Family = inferFamily(hint);
  switch (family) {
    case "anthropic":
    case "anthropic-bedrock":
      return estimatePatchImageTokens(image.width!, image.height!, 28);
    case "gemini":
      return estimateGeminiImageTokens(image.width!, image.height!);
    case "qwen":
      return estimatePatchImageTokens(image.width!, image.height!, 28);
    case "openai":
    case "grok":
      return estimateOpenAIImageTokens(image);
    default:
      return 0;
  }
}

function estimatePatchImageTokens(
  width: number,
  height: number,
  patch: number,
): number {
  return ceilDiv(width, patch) * ceilDiv(height, patch);
}

function estimateGeminiImageTokens(width: number, height: number): number {
  if (width <= 384 && height <= 384) {
    return 258;
  }
  return ceilDiv(width, 768) * ceilDiv(height, 768) * 258;
}

function estimateOpenAIImageTokens(image: ImageContent): number {
  switch ((image.detail ?? "").trim().toLowerCase()) {
    case "fast":
    case "low":
      return 85;
    default: {
      const tiles = ceilDiv(image.width!, 512) * ceilDiv(image.height!, 512);
      return 85 + 170 * tiles;
    }
  }
}

function ceilDiv(n: number, d: number): number {
  if (d <= 0) {
    return 0;
  }
  return Math.floor((n + d - 1) / d);
}

/**
 * Shared stateless generic estimator instance. The Go zero-value
 * `GenericTokenEstimator{}` carries no state, so a singleton is equivalent.
 */
export const genericTokenEstimator: TokenEstimator =
  new GenericTokenEstimator();
