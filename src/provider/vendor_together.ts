import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_together.go init() adapters. */
export function registerVendorTogether(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("together", ["api.together.xyz"]),
  );
}
