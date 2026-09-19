// Ported from internal/provider/vendor_openai.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_openai.go init() adapters. */
export function registerVendorOpenai(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "openai",
      ["api.openai.com"],
      "",
      undefined,
      "openai-responses",
    ),
  );
}
