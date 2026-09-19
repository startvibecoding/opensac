// Ported from internal/provider/vendor_google_gemini.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_google_gemini.go init() adapters. */
export function registerVendorGoogleGemini(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "google-gemini",
      ["generativelanguage.googleapis.com"],
      "",
      undefined,
      "google-gemini",
    ),
  );
}
