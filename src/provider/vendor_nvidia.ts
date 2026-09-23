import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_nvidia.go init() adapters. */
export function registerVendorNvidia(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("nvidia", ["integrate.api.nvidia.com"]),
  );
}
