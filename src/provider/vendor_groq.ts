import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_groq.go init() adapters. */
export function registerVendorGroq(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("groq", ["api.groq.com"]),
  );
}
