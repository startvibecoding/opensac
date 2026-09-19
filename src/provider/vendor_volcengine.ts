// Ported from internal/provider/vendor_volcengine.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_volcengine.go init() adapters. */
export function registerVendorVolcengine(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "volcengine",
      ["ark.cn-beijing.volces.com"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
