import { type AdapterConfig, type VendorAdapter } from "./vendor.ts";
import { registerVendorAdapter } from "./vendor.ts";

/**
 * A vendor that users explicitly select via vendor="volcengine-codingplan". It
 * auto-detects the API protocol from the baseURL path: /api/coding/v3 →
 * openai-chat, /api/coding → anthropic-messages. It does not participate in
 * automatic domain-based vendor detection.
 */
class VolccodingplanAdapter implements VendorAdapter {
  name(): string {
    return "volcengine-codingplan";
  }

  matchBaseURL(_baseURL: string): boolean {
    return false;
  }

  apply(cfg: AdapterConfig): void {
    if (cfg.api === "") {
      cfg.api = cfg.baseUrl.toLowerCase().includes("/api/coding/v3")
        ? "openai-chat"
        : "anthropic-messages";
    }
  }
}

/** Registers the Go vendor_volcengine_codingplan.go init() adapter. */
export function registerVendorVolcengineCodingplan(): void {
  registerVendorAdapter(new VolccodingplanAdapter());
}
