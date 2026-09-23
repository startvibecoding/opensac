import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_fireworks.go init() adapters. */
export function registerVendorFireworks(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("fireworks", ["api.fireworks.ai"]),
  );
}
