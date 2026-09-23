import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_cloudflare_ai_gateway.go init() adapters. */
export function registerVendorCloudflareAiGateway(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "cloudflare-ai-gateway",
      ["gateway.ai.cloudflare.com"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
