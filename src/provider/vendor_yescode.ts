// Ported from internal/provider/vendor_yescode.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_yescode.go init() adapters. */
export function registerVendorYescode(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "yescode",
      ["co.yes.vg"],
      "",
      undefined,
      "openai-responses",
    ),
  );
}
