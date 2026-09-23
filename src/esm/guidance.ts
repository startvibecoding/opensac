// (prompt rendering half)
//
// The Store guidance methods (add/pending/consume) live in store.ts; this
// module owns the prompt projection of queued guidance.

import type { ESMGuidance } from "../session/mod.ts";

/**
 * Renders queued user guidance as a prompt section. The guidance is user data:
 * it is listed verbatim and never treated as system or developer instructions
 * by the role prompts.
 */
export function formatGuidanceSuffix(items: ESMGuidance[]): string {
  if (items.length === 0) return "";
  let b = "\n\nUser guidance queued for this objective:\n";
  for (const item of items) {
    b += "- " + item.guidance + "\n";
  }
  return b;
}
