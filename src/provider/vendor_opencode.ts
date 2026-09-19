// Ported from internal/provider/vendor_opencode.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_opencode.go init() adapters. */
export function registerVendorOpencode(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("opencode", ["opencode.ai"]),
  );
}
