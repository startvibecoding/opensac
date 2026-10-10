import { type AdapterConfig, type VendorAdapter } from "./vendor.ts";
import { registerVendorAdapter } from "./vendor.ts";

/**
 * A vendor that users explicitly select via vendor="tencent-hy-plan". It
 * supports both OpenAI-compatible and Anthropic-compatible endpoints via base
 * URL path detection.
 */
class TencentHYPlanAdapter implements VendorAdapter {
  name(): string {
    return "tencent-hy-plan";
  }

  matchBaseURL(_baseURL: string): boolean {
    return false;
  }

  apply(cfg: AdapterConfig): void {
    if (cfg.api === "") {
      cfg.api = cfg.baseUrl.toLowerCase().includes("/plan/anthropic")
        ? "anthropic-messages"
        : "openai-chat";
    }
  }
}

/** Registers the Go vendor_tencent_hy_plan.go init() adapter. */
export function registerVendorTencentHyPlan(): void {
  registerVendorAdapter(new TencentHYPlanAdapter());
}
