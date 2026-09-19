// Ported from internal/provider/vendor_xiaomi.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_xiaomi.go init() adapters. */
export function registerVendorXiaomi(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("xiaomi-token-plan-ams", [
      "token-plan-ams.xiaomimimo.com",
    ], "xiaomi"),
  );
  registerVendorAdapter(
    new SimpleVendorAdapter("xiaomi-token-plan-cn", [
      "token-plan-cn.xiaomimimo.com",
    ], "xiaomi"),
  );
  registerVendorAdapter(
    new SimpleVendorAdapter("xiaomi-token-plan-sgp", [
      "token-plan-sgp.xiaomimimo.com",
    ], "xiaomi"),
  );
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "xiaomi",
      ["api.xiaomimimo.com", "api.xiaomi.com"],
      "xiaomi",
    ),
  );
}
