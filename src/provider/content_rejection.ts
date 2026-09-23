import { errMessage } from "./context_overflow.ts";

/**
 * Matches provider error messages that indicate a permanent content-policy
 * refusal rather than a transient failure. Retrying the identical request can
 * never succeed, so these must not consume the retry budget.
 */
const contentRejectionPatterns: string[] = [
  "datainspectionfailed",
  "data inspection",
  "input image data may contain",
  "inappropriate content",
  "content policy",
  "content moderation",
  "content_filter",
  "content filter",
  "prohibited content",
  "flagged as sensitive",
];

/**
 * Reports whether err is a permanent provider refusal caused by content
 * inspection/moderation.
 */
export function isContentRejectionError(err: unknown): boolean {
  if (err == null) return false;
  const msg = errMessage(err).toLowerCase();
  return contentRejectionPatterns.some((pattern) => msg.includes(pattern));
}
