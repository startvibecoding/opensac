import { type ProviderConfig } from "../config/mod.ts";
import { type Provider } from "./provider.ts";
import {
  getVendorAdapter,
  listVendorAdapters,
  resolveAdapterConfig,
} from "./vendor.ts";
// Side-effect import mirroring Go's package-level init() vendor registration.
import "./vendors.ts";

/** Creates a Provider from a ProviderConfig. */
export type ProviderFactory = (cfg: ProviderConfig) => Provider;

/** Manages provider factory registration and creation. */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  /** Registers a provider factory by name. */
  register(name: string, factory: ProviderFactory): void {
    this.factories.set(name, factory);
  }

  /** Creates a provider by name using the given config. */
  create(name: string, cfg: ProviderConfig): Provider {
    const factory = this.factories.get(name);
    if (factory === undefined) {
      throw new Error(`provider "${name}" not registered`);
    }
    return factory(cfg);
  }

  /** Returns all registered provider names. */
  list(): string[] {
    return [...this.factories.keys()];
  }

  /** Checks if a provider is registered. */
  has(name: string): boolean {
    return this.factories.has(name);
  }
}

let globalRegistry = new ProviderRegistry();

/** Returns the global registry instance. */
export function globalProviderRegistry(): ProviderRegistry {
  return globalRegistry;
}

/** Test seam mirroring Go's swappable package-level registry variable. */
export function setGlobalProviderRegistry(registry: ProviderRegistry): void {
  globalRegistry = registry;
}

/** Registers a provider factory in the global registry. */
export function register(name: string, factory: ProviderFactory): void {
  globalRegistry.register(name, factory);
}

/** Creates a provider using the global registry. */
export function createProvider(name: string, cfg: ProviderConfig): Provider {
  return globalRegistry.create(name, cfg);
}

/** Returns all registered provider names. */
export function listProviders(): string[] {
  return globalRegistry.list();
}

/**
 * Resolves a provider from config with three-level fallback:
 * 1. explicit vendor
 * 2. baseUrl auto-detect
 * 3. generic fallback by API protocol
 */
export function resolveProvider(cfg: ProviderConfig): Provider {
  const resolved = resolveAdapterConfig(cfg);
  if (resolved.vendor !== "") {
    if (globalRegistry.has(resolved.vendor)) {
      return globalRegistry.create(resolved.vendor, cfg);
    }
  }

  switch (resolved.api) {
    case "openai-chat":
      return globalRegistry.create("openai-chat", cfg);
    case "openai-responses":
      return globalRegistry.create("openai-responses", cfg);
    case "anthropic-messages":
      return globalRegistry.create("anthropic-messages", cfg);
    case "google-gemini":
      return globalRegistry.create("google-gemini", cfg);
    case "google-vertex":
      return globalRegistry.create("google-vertex", cfg);
    default:
      throw new Error(
        `unsupported API type: ${resolved.api} (use 'openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini', or 'google-vertex')`,
      );
  }
}

/**
 * Attempts to identify the vendor from a base URL. Returns empty string if no
 * match.
 */
export function vendorFromBaseURL(baseURL: string): string {
  const lower = baseURL.toLowerCase();
  for (const name of listVendorAdapters()) {
    const adapter = getVendorAdapter(name);
    if (adapter !== undefined && adapter.matchBaseURL(lower)) return name;
  }
  return "";
}
