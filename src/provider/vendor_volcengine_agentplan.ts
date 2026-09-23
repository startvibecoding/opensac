import type { AdapterConfig, VendorAdapter } from "./vendor.ts";
import { registerVendorAdapter } from "./vendor.ts";

/**
 * A vendor that users explicitly select via vendor="volcengine-agentplan". It
 * auto-detects the API protocol from the baseURL path: /api/plan/v3 →
 * openai-chat, /api/plan → anthropic-messages. It does not participate in
 * automatic domain-based vendor detection.
 */
class VolcagentplanAdapter implements VendorAdapter {
  name(): string {
    return "volcengine-agentplan";
  }

  matchBaseURL(_baseURL: string): boolean {
    return false;
  }

  apply(cfg: AdapterConfig): void {
    if (cfg.api === "") {
      cfg.api = cfg.baseUrl.toLowerCase().includes("/api/plan/v3")
        ? "openai-chat"
        : "anthropic-messages";
    }
  }
}

/** Registers the Go vendor_volcengine_agentplan.go init() adapter. */
export function registerVendorVolcengineAgentplan(): void {
  registerVendorAdapter(new VolcagentplanAdapter());
}
