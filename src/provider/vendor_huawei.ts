import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_huawei.go init() adapters. */
export function registerVendorHuawei(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("huawei", ["api.modelarts-maas.com"]),
  );
}
