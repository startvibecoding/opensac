// Public surface of src/provider/anthropic (ported from
// internal/provider/anthropic). Importing this module runs the provider
// registration, mirroring the Go package init().

export {
  anthropicAdaptiveEffort,
  anthropicToolChoiceFor,
  decodeToolArguments,
  defaultModels,
  mergeToolCallInput,
  modelSupportsParallelToolCalls,
  modelSupportsToolChoice,
  newProvider,
  newProviderWithHTTPClient,
  newProviderWithModels,
  newProviderWithModelsAndOptions,
  newProviderWithModelsAndProxy,
  Provider,
  thinkingBudget,
  useAdaptiveThinking,
} from "./provider.ts";
export { convertCompat, resolveAnthropicModels } from "./register.ts";

// Side-effect import: registers "anthropic" and "anthropic-messages".
import "./register.ts";
