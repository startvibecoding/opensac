import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_huggingface.go init() adapters. */
export function registerVendorHuggingface(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("huggingface", ["router.huggingface.co"]),
  );
}
