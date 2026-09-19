// Ported from internal/provider/vendor_ant_ling.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_ant_ling.go init() adapters. */
export function registerVendorAntLing(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("ant-ling", ["api.ant-ling.com"]),
  );
}
