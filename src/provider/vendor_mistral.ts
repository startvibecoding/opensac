import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_mistral.go init() adapters. */
export function registerVendorMistral(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "mistral",
      ["api.mistral.ai"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
