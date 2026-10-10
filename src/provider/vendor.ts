import { type ProviderConfig } from "../config/mod.ts";

/** AdapterConfig is the provider configuration after vendor defaults are applied. */
export interface AdapterConfig {
  vendor: string;
  api: string;
  baseUrl: string;
  thinkingFormat: string;
  cacheControl?: boolean;
}

/**
 * VendorAdapter applies vendor-specific defaults while keeping protocol
 * providers generic.
 */
export interface VendorAdapter {
  name(): string;
  matchBaseURL(baseURL: string): boolean;
  apply(cfg: AdapterConfig): void;
}

/** A data-driven vendor adapter keyed by base-URL substrings. */
export class SimpleVendorAdapter implements VendorAdapter {
  private readonly adapterName: string;
  private readonly domains: string[];
  private readonly thinkingFormatValue: string = "";
  private readonly cacheControlValue: boolean | undefined = undefined;
  private readonly defaultApi: string = "";

  constructor(
    adapterName: string,
    domains: string[],
    thinkingFormatValue: string = "",
    cacheControlValue: boolean | undefined = undefined,
    defaultApi: string = "",
  ) {
    this.adapterName = adapterName;
    this.domains = domains;
    this.thinkingFormatValue = thinkingFormatValue;
    this.cacheControlValue = cacheControlValue;
    this.defaultApi = defaultApi;
  }

  name(): string {
    return this.adapterName;
  }

  matchBaseURL(baseURL: string): boolean {
    const lower = baseURL.toLowerCase();
    return this.domains.some((d) => lower.includes(d.toLowerCase()));
  }

  apply(cfg: AdapterConfig): void {
    if (cfg.api === "" && this.defaultApi !== "") cfg.api = this.defaultApi;
    if (cfg.thinkingFormat === "" && this.thinkingFormatValue !== "") {
      cfg.thinkingFormat = this.thinkingFormatValue;
    }
    if (
      cfg.cacheControl === undefined &&
      this.cacheControlValue !== undefined
    ) {
      cfg.cacheControl = this.cacheControlValue;
    }
  }
}

const vendorOrder: string[] = [];
const vendorAdapters = new Map<string, VendorAdapter>();

/** Registers a vendor adapter. */
export function registerVendorAdapter(adapter: VendorAdapter | null): void {
  if (adapter == null || adapter.name() === "") return;
  const name = normalizeVendorName(adapter.name());
  if (!vendorAdapters.has(name)) vendorOrder.push(name);
  vendorAdapters.set(name, adapter);
}

/** Returns a registered vendor adapter by name. */
export function getVendorAdapter(name: string): VendorAdapter | undefined {
  return vendorAdapters.get(normalizeVendorName(name));
}

/** Returns registered vendor adapter names in registration order. */
export function listVendorAdapters(): string[] {
  return [...vendorOrder];
}

/** Applies provider protocol detection plus vendor defaults. */
export function resolveAdapterConfig(
  cfg: ProviderConfig | null | undefined,
): AdapterConfig {
  if (cfg == null) {
    return {
      vendor: "",
      api: "openai-chat",
      baseUrl: "",
      thinkingFormat: "",
    };
  }

  const resolved: AdapterConfig = {
    vendor: normalizeVendorName(cfg.vendor ?? ""),
    api: cfg.api ?? "",
    baseUrl: cfg.baseUrl ?? "",
    thinkingFormat: cfg.thinkingFormat ?? "",
  };
  if (cfg.cacheControl !== undefined) resolved.cacheControl = cfg.cacheControl;

  if (resolved.vendor !== "") {
    const adapter = getVendorAdapter(resolved.vendor);
    if (adapter !== undefined) adapter.apply(resolved);
    if (resolved.api === "") {
      resolved.api = protocolFromBaseURL(resolved.baseUrl);
    }
    return resolved;
  }

  for (const name of vendorOrder) {
    const adapter = vendorAdapters.get(name);
    if (adapter !== undefined && adapter.matchBaseURL(resolved.baseUrl)) {
      resolved.vendor = name;
      adapter.apply(resolved);
      break;
    }
  }

  if (resolved.api === "") {
    resolved.api = protocolFromBaseURL(resolved.baseUrl);
  }

  return resolved;
}

function protocolFromBaseURL(baseURL: string): string {
  if (baseURL.toLowerCase().includes("anthropic")) return "anthropic-messages";
  return "openai-chat";
}

/** Normalizes a vendor name for registry lookup. */
export function normalizeVendorName(name: string): string {
  return name.trim().toLowerCase();
}
