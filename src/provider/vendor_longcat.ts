// Ported from internal/provider/vendor_longcat.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_longcat.go init() adapters. */
export function registerVendorLongcat(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("longcat", ["api.longcat.chat"]),
  );
}
