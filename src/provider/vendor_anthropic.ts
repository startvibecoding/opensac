import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_anthropic.go init() adapters. */
export function registerVendorAnthropic(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "anthropic",
      ["api.anthropic.com"],
      "",
      undefined,
      "anthropic-messages",
    ),
  );
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "claude",
      [],
      "",
      undefined,
      "anthropic-messages",
    ),
  );
}
