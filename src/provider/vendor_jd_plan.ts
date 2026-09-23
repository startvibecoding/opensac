import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_jd_plan.go init() adapters. */
export function registerVendorJdPlan(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("jd-plan", ["agentrs.jd.com"]),
  );
}
