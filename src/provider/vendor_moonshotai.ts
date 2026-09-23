import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_moonshotai.go init() adapters. */
export function registerVendorMoonshotai(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("moonshotai", ["api.moonshot.ai"]),
  );
}
