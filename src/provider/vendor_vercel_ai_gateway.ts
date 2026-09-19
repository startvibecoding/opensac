// Ported from internal/provider/vendor_vercel_ai_gateway.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_vercel_ai_gateway.go init() adapters. */
export function registerVendorVercelAiGateway(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("vercel-ai-gateway", ["ai-gateway.vercel.sh"]),
  );
}
