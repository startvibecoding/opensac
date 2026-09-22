// Ported from internal/config/model_preset.go.
//
// PresetModelConfig returns the best available draft defaults for a model ID.
// The current provider wins, followed by an exact model-ID match elsewhere in
// the built-in catalog. Unknown IDs receive safe generic defaults. This helper
// is for creating new model entries; it does not alter existing configuration.

import type { ModelConfig } from "./settings.ts";
import { defaultProviderConfigsAll } from "./settings.ts";

/** Conservative context-window fallback for unknown model IDs. */
const DEFAULT_MODEL_CONTEXT_WINDOW = 256_000;

/**
 * Returns the best available preset for the given model ID.
 *
 * Resolution order:
 * 1. Exact match in the current provider's built-in models
 * 2. Exact match in any other built-in provider (sorted by provider ID)
 * 3. Case-insensitive match across all built-in providers
 * 4. Generic defaults (reasoning=true, 256k context, text-only)
 */
export function presetModelConfig(
  providerID: string,
  modelID: string,
): ModelConfig {
  const trimmed = modelID.trim();
  if (trimmed === "") return genericModelConfig(trimmed);

  // 1. Try the current provider first
  if (providerID !== "") {
    const resolved = lookupInProvider(providerID, trimmed);
    if (resolved) return completeModelPreset(resolved, trimmed);
  }

  // 2. Search all built-in providers (exact match)
  const catalog = defaultProviderConfigsAll();
  const providerIDs = Object.keys(catalog).sort();
  for (const pid of providerIDs) {
    if (pid === providerID) continue; // already checked
    const found = lookupInProvider(pid, trimmed);
    if (found) return completeModelPreset(found, trimmed);
  }

  // 3. Case-insensitive search
  for (const pid of providerIDs) {
    const pc = catalog[pid];
    if (!pc) continue;
    const match = pc.models.find((m) =>
      m.id.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) return completeModelPreset({ ...match }, trimmed);
  }

  // 4. Generic defaults
  return genericModelConfig(trimmed);
}

function lookupInProvider(
  providerID: string,
  modelID: string,
): ModelConfig | undefined {
  const catalog = defaultProviderConfigsAll();
  const pc = catalog[providerID];
  if (!pc) return undefined;
  const match = pc.models.find((m) => m.id === modelID);
  return match ? { ...match } : undefined;
}

function completeModelPreset(model: ModelConfig, requestedID: string): ModelConfig {
  return {
    ...model,
    id: requestedID,
    name: model.name?.trim() || requestedID,
    contextWindow: (model.contextWindow ?? 0) > 0
      ? model.contextWindow
      : DEFAULT_MODEL_CONTEXT_WINDOW,
    input: model.input?.length ? model.input : ["text"],
  };
}

function genericModelConfig(modelID: string): ModelConfig {
  return {
    id: modelID,
    name: modelID,
    reasoning: true,
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    input: ["text"],
  };
}
