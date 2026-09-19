// Ported from internal/provider/vendor_mthreads_plan.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_mthreads_plan.go init() adapters. */
export function registerVendorMthreadsPlan(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("mthreads-plan", [
      "coding-plan-endpoint.kuaecloud.net",
    ]),
  );
}
