import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_bai.go init() adapter. */
export function registerVendorBai(): void {
  registerVendorAdapter(new SimpleVendorAdapter("bai", ["api.b.ai"]));
}
