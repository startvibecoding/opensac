// Ported from internal/provider/vendor_ctyun_plan.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_ctyun_plan.go init() adapters. */
export function registerVendorCtyunPlan(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("ctyun-plan", ["wishub-x6.ctyun.cn"]),
  );
}
