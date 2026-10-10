import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_xai.go init() adapters. */
export function registerVendorXai(): void {
  registerVendorAdapter(new SimpleVendorAdapter("xai", ["api.x.ai"]));
}
