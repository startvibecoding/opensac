// Ported from internal/provider/vendor_zai.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_zai.go init() adapters. */
export function registerVendorZai(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("zai", ["api.z.ai", "open.bigmodel.cn"], "zai"),
  );
}
