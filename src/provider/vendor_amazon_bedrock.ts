import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_amazon_bedrock.go init() adapters. */
export function registerVendorAmazonBedrock(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "amazon-bedrock",
      ["bedrock-runtime", "bedrock-api"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
