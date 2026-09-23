import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_google_vertex.go init() adapters. */
export function registerVendorGoogleVertex(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "google-vertex",
      ["aiplatform.googleapis.com"],
      "",
      undefined,
      "google-vertex",
    ),
  );
}
