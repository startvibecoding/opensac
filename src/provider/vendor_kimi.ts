// Ported from internal/provider/vendor_kimi.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_kimi.go init() adapters. */
export function registerVendorKimi(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("kimi", ["api.moonshot.cn", "api.kimi.com"]),
  );
}
