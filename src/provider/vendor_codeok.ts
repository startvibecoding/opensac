import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_codeok.go init() adapters. */
export function registerVendorCodeok(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "codeok",
      ["codeok.cc"],
      "",
      undefined,
      "openai-responses",
    ),
  );
}
