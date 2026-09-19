// Ported from internal/provider/vendor_gitee.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_gitee.go init() adapters. */
export function registerVendorGitee(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter("gitee", ["ai.gitee.com", "api.moark.com"]),
  );
}
