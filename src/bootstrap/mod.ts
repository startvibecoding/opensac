// Ported from the Go `bootstrap` package (bootstrap/bootstrap.go).
//
// Importing this module registers the provider resolution hook
// (`agent.setResolveProviderFunc`) and the concrete provider factories
// (openai/anthropic/google) with the global provider registry, so
// `Builder.withProviderByName(...)` resolves providers without user code
// importing internal packages.
//
// The internal agent builder hook (`agent.setBuilderFunc`) is registered by
// importing `src/agent/factory.ts`, whose module-level call mirrors the Go
// `internal/agent` `init()` that `bootstrap` blank-imports.

// Register the concrete provider factories (each module self-registers).
import "../provider/factory/mod.ts";
// Register the internal agent builder hook (agent.setBuilderFunc).
import "../agent/factory.ts";

export {
  ProviderAdapter,
  registerProviderBridge,
  streamEventTypeToPublic,
  streamRetryMaxAttempts,
} from "./provider_bridge.ts";
