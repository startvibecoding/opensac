/**
 * Matches provider error messages that indicate the request was rejected
 * because it exceeds the model's context window. Patterns are matched
 * case-insensitively as substrings. Keep this list specific so rate-limit and
 * quota errors are not misclassified as context overflow.
 */
const contextOverflowPatterns: string[] = [
  "context_length_exceeded", // OpenAI error code
  "context length", // "maximum context length is N tokens"
  "context window", // "exceeds the model's context window"
  "context limit", // "context limit exceeded"
  "prompt is too long", // Anthropic
  "input is too long", // generic
  "maximum length limit", // Moonshot/Kimi
  "exceeds the maximum number of tokens", // Gemini
  "max message tokens", // Kimi image/text total
  "request entity too large", // HTTP 413 style
];

/**
 * Reports whether err looks like a provider-side rejection caused by an
 * oversized request (context window exceeded).
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err == null) return false;
  const msg = errMessage(err).toLowerCase();
  return contextOverflowPatterns.some((pattern) => msg.includes(pattern));
}

/** Extracts a lowercase error message from an unknown thrown value. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
