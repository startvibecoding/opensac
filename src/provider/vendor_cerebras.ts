import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_cerebras.go init() adapters. */
export function registerVendorCerebras(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("cerebras", ["api.cerebras.ai"]),
  );
}
