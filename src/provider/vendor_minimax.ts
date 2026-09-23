import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_minimax.go init() adapters. */
export function registerVendorMinimax(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("minimax", ["api.minimaxi.com"]),
  );
}
