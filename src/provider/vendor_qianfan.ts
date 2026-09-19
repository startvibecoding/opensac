// Ported from internal/provider/vendor_qianfan.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_qianfan.go init() adapters. */
export function registerVendorQianfan(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "qianfan",
      ["qianfan.baidubce.com", "aip.baidubce.com"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
