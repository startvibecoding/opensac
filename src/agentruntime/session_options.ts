//
// The front-end-neutral representation of a session's mutable settings. ACP
// serializes `SessionConfigOption` directly as a select option; other adapters
// render the same catalog in their native UI.
//
// Deviation: `map[string]provider.Provider` maps to `Record<string, Provider>`;
// Go's `sort` maps to `Array.prototype.sort`.

import type { Model, ThinkingLevel } from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import {
  thinkingHigh,
  thinkingLow,
  thinkingMax,
  thinkingMedium,
  thinkingMinimal,
  thinkingOff,
  thinkingXHigh,
} from "../provider/types.ts";
import { qualifiedModel } from "../provider/factory/factory.ts";
import { MODE_AGENT, MODE_OS, MODE_PLAN, MODE_YOLO } from "./source.ts";

/** One select option in a mutable session setting. */
export interface SessionConfigOption {
  type: string;
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue: string;
  options?: SessionConfigOptionChoice[];
}

/** One value in a mutable session option. */
export interface SessionConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

/** Stable protocol-neutral option identifiers. */
export const CONFIG_OPTION_PROVIDER = "provider";
export const CONFIG_OPTION_MODEL = "model";
export const CONFIG_OPTION_MODE = "mode";
export const CONFIG_OPTION_THINKING_LEVEL = "thinking_level";
export const CONFIG_OPTION_SANDBOX = "sandbox";
export const CONFIG_OPTION_BROWSER = "browser";
export const CONFIG_OPTION_WEB_SEARCH = "web_search";
/**
 * Selects the Runtime-owned expert bundle for a session. Replacing one non-empty
 * value is deliberately rejected by `SetExpert`; adapters must create a fork
 * with `forkWithExpert` instead.
 */
export const CONFIG_OPTION_EXPERT = "expert";

/** The set of providers available to a session runtime. */
export type ProviderCatalog = Record<string, Provider>;

/** The persisted/runtime model identity for one session. */
export interface SessionModelBinding {
  providerName: string;
  model: Model | null;
}

/**
 * Builds the standard provider, model, mode, and thinking catalogs when no
 * provider catalog is available to the caller.
 */
export function sessionConfigOptions(
  providerName: string,
  models: Model[],
  model: Model | null,
  mode: string,
  thinking: ThinkingLevel,
): SessionConfigOption[] {
  return sessionConfigOptionsWithProviders(
    providerName,
    {},
    models,
    model,
    mode,
    thinking,
  );
}

/**
 * Builds provider, model, mode, and thinking catalogs. The model catalog is
 * intentionally scoped to the current provider so selecting a provider cascades
 * immediately to its models.
 */
export function sessionConfigOptionsWithProviders(
  providerName: string,
  providers: ProviderCatalog,
  models: Model[],
  model: Model | null,
  mode: string,
  thinking: ThinkingLevel,
): SessionConfigOption[] {
  const modelChoices: SessionConfigOptionChoice[] = [];
  const seen = new Set<string>();
  for (const candidate of models) {
    if (candidate === null || candidate.id === "") continue;
    const value = qualifiedModel(providerName, candidate);
    if (seen.has(value)) continue;
    seen.add(value);
    let name = candidate.name;
    if (name === "") name = candidate.id;
    modelChoices.push({ value, name });
  }
  modelChoices.sort((a, b) =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  );
  const providerNames: string[] = [];
  for (const rawName of Object.keys(providers)) {
    const name = rawName.trim();
    if (name === "" || providers[rawName] === null) continue;
    providerNames.push(name);
  }
  providerNames.sort();
  const providerChoices: SessionConfigOptionChoice[] = providerNames.map(
    (name) => ({ value: name, name: providerDisplayName(name) }),
  );
  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: CONFIG_OPTION_PROVIDER,
      name: "Provider",
      category: "provider",
      currentValue: providerName,
      options: providerChoices,
    },
    {
      type: "select",
      id: CONFIG_OPTION_MODEL,
      name: "Model",
      category: "model",
      currentValue: model === null ? "" : qualifiedModel(providerName, model),
      options: modelChoices,
    },
    {
      type: "select",
      id: CONFIG_OPTION_MODE,
      name: "Mode",
      category: "mode",
      currentValue: mode,
      options: [
        { value: MODE_AGENT, name: "Agent" },
        { value: MODE_PLAN, name: "Plan" },
        { value: MODE_YOLO, name: "Yolo" },
        { value: MODE_OS, name: "OS" },
      ],
    },
  ];
  if (model !== null && model.reasoning) {
    options.push({
      type: "select",
      id: CONFIG_OPTION_THINKING_LEVEL,
      name: "Thinking level",
      category: "thought_level",
      currentValue: thinking,
      options: [
        { value: thinkingOff, name: "Off" },
        { value: thinkingMinimal, name: "Minimal" },
        { value: thinkingLow, name: "Low" },
        { value: thinkingMedium, name: "Medium" },
        { value: thinkingHigh, name: "High" },
        { value: thinkingXHigh, name: "XHigh" },
        { value: thinkingMax, name: "Max" },
      ],
    });
  }
  return options;
}

/** Renders a provider identifier as a display name, mirroring Go. */
export function providerDisplayName(name: string): string {
  const parts = name.split(/[-_.]/).filter((part) => part !== "");
  const out = parts.map((part) => {
    switch (part.toLowerCase()) {
      case "openai":
        return "OpenAI";
      case "api":
        return "API";
      case "agentplan":
        return "AgentPlan";
      default:
        return part.slice(0, 1).toUpperCase() + part.slice(1);
    }
  });
  if (out.length === 0) return name;
  return out.join(" ");
}

/** Validates a config option value without provider-specific assumptions. */
export function validateThinkingLevel(value: string): ThinkingLevel {
  const trimmed = value.trim();
  if (trimmed === "") return thinkingMedium;
  switch (trimmed) {
    case thinkingOff:
    case thinkingMinimal:
    case thinkingLow:
    case thinkingMedium:
    case thinkingHigh:
    case thinkingXHigh:
    case thinkingMax:
      return trimmed;
    default:
      throw new Error(`invalid thinking level "${value}"`);
  }
}
