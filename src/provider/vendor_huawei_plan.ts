// Ported from internal/provider/vendor_huawei_plan.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_huawei_plan.go init() adapters. */
export function registerVendorHuaweiPlan(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("huawei-plan", ["api.modelarts-maas.com/plan/"]),
  );
}
