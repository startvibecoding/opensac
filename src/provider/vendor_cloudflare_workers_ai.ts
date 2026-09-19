// Ported from internal/provider/vendor_cloudflare_workers_ai.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_cloudflare_workers_ai.go init() adapters. */
export function registerVendorCloudflareWorkersAi(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "cloudflare-workers-ai",
      ["api.cloudflare.com"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
