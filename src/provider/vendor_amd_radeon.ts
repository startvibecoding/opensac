import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_amd_radeon.go init() adapters. */
export function registerVendorAmdRadeon(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("amd-radeon", ["developer.amd.com.cn"]),
  );
}
