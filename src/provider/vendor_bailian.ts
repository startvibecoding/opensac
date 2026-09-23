import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_bailian.go init() adapters. */
export function registerVendorBailian(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("bailian", [
      "dashscope.aliyuncs.com",
      "token-plan.cn-beijing.maas.aliyuncs.com",
      "coding.dashscope.aliyuncs.com",
    ]),
  );
}
