// Ported from internal/provider/vendor_deepseek.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_deepseek.go init() adapters. */
export function registerVendorDeepseek(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("deepseek", ["api.deepseek.com"], "deepseek"),
  );
}
