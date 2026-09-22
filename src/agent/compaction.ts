// Ported from internal/agent/compaction.go.

import type { CompactionSettings as ConfigCompactionSettings } from "../config/settings.ts";
import type { CompactionSettings } from "../context/compaction.ts";

/**
 * Converts the user-facing settings.json compaction block into the agent-loop
 * compaction settings. All runtimes (CLI, TUI, ACP, cron)
 * must build agent compaction settings through this helper so no field is
 * dropped. Zero-valued limits are filled later by `normalizeCompactionSettings`
 * inside the Agent constructor.
 */
export function compactionSettingsFromConfig(
  c: ConfigCompactionSettings,
): CompactionSettings {
  return {
    enabled: c.enabled,
    reserveTokens: c.reserveTokens,
    keepRecentTokens: c.keepRecentTokens,
    tokenizer: c.tokenizer,
    tokenizerModel: c.tokenizerModel,
    template: c.template,
  };
}
