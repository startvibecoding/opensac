import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_openrouter.go init() adapters. */
export function registerVendorOpenrouter(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("openrouter", ["openrouter.ai"]),
  );
}
