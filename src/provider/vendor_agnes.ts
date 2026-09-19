// Ported from internal/provider/vendor_agnes.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_agnes.go init() adapters. */
export function registerVendorAgnes(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("agnes", [
      "apihub.agnes-ai.com",
      "api.agnes-ai.cn",
    ]),
  );
}
