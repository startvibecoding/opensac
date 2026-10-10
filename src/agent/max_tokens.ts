import { type Model } from "../provider/types.ts";

const defaultAutoMaxTokens = 8192;

/**
 * ResolveMaxTokens returns the output limit configured for the active model.
 * Known models use a conservative default cap; explicit model configuration is
 * preserved exactly so an explicit value never gets silently changed.
 */
export function resolveMaxTokens(model: Model | null | undefined): number {
  if (model == null) return 0;
  if (model.maxTokensSet) return model.maxTokens;
  if (model.maxTokens > 0 && model.maxTokens < defaultAutoMaxTokens) {
    return model.maxTokens;
  }
  if (model.maxTokens > 0) return defaultAutoMaxTokens;
  return 0;
}

/**
 * ResolveMaxTokensValue returns an explicit per-request value when set. An
 * explicit zero on a model disables the output-token parameter; otherwise the
 * configured model limit is used.
 */
export function resolveMaxTokensValue(
  explicit: number,
  model: Model | null | undefined,
): number {
  if (explicit > 0) return explicit;
  if (model != null) {
    if (model.maxTokensSet && model.maxTokens === 0) return 0;
    if (model.maxTokens > 0) return model.maxTokens;
  }
  return 0;
}
