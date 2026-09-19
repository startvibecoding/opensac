// Ported from internal/provider/vendor_github_copilot.go

import { registerVendorAdapter, SimpleVendorAdapter } from "./vendor.ts";

/** Registers the Go vendor_github_copilot.go init() adapters. */
export function registerVendorGithubCopilot(): void {
  registerVendorAdapter(
    new SimpleVendorAdapter(
      "github-copilot",
      ["api.individual.githubcopilot.com", "api.githubcopilot.com"],
      "",
      undefined,
      "openai-chat",
    ),
  );
}
