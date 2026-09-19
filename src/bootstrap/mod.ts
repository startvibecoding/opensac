// Ported from the Go `bootstrap` package (bootstrap/bootstrap.go).
//
// Importing this module registers the provider resolution hook
// (`agent.setResolveProviderFunc`) and the concrete provider factories
// (openai/anthropic/google) with the global provider registry, so
// `Builder.withProviderByName(...)` resolves providers without user code
// importing internal packages.
//
// The internal agent builder hook (`agent.setBuilderFunc`) is registered by
// `src/agent` once backlog #19 lands; until then `Builder.build()` throws the
// standard "internal builder is not registered" error.

// Register the concrete provider factories (each module self-registers).
import "../provider/factory/mod.ts";

export {
  ProviderAdapter,
  registerProviderBridge,
  streamEventTypeToPublic,
  streamRetryMaxAttempts,
} from "./provider_bridge.ts";
