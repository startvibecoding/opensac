// Ported from internal/provider/vendor_test.go

import { assertEquals } from "@std/assert";
import type { ProviderConfig } from "../config/mod.ts";
import { resolveAdapterConfig, vendorFromBaseURL } from "./mod.ts";

function cfg(partial: Partial<ProviderConfig>): ProviderConfig {
  return { models: [], ...partial };
}

Deno.test("ResolveAdapterConfigExplicitVendor", () => {
  const resolved = resolveAdapterConfig(cfg({
    vendor: "deepseek",
    baseUrl: "https://example.com/v1",
    api: "openai-chat",
  }));
  assertEquals(resolved.vendor, "deepseek");
  assertEquals(resolved.thinkingFormat, "deepseek");
});

Deno.test("ResolveAdapterConfigExplicitVendorDefaultAPI", () => {
  const resolved = resolveAdapterConfig(cfg({ vendor: "Anthropic" }));
  assertEquals(resolved.vendor, "anthropic");
  assertEquals(resolved.api, "anthropic-messages");
});

Deno.test("ResolveAdapterConfigResponsesVendorsDefaultAPI", () => {
  const tests: Array<[string, string]> = [
    ["https://api.openai.com/v1", "openai"],
    ["https://www.codeok.cc/v1", "codeok"],
    ["https://co.yes.vg/v1", "yescode"],
  ];
  for (const [baseUrl, vendor] of tests) {
    const resolved = resolveAdapterConfig(cfg({ baseUrl }));
    assertEquals(resolved.vendor, vendor, baseUrl);
    assertEquals(resolved.api, "openai-responses", baseUrl);
  }
});

Deno.test("ResolveAdapterConfigBaseURLDetect", () => {
  const resolved = resolveAdapterConfig(cfg({
    baseUrl: "https://api.deepseek.com/anthropic",
    api: "anthropic-messages",
  }));
  assertEquals(resolved.vendor, "deepseek");
  assertEquals(resolved.thinkingFormat, "deepseek");
});

Deno.test("ResolveAdapterConfigPreservesExplicitThinkingFormat", () => {
  const resolved = resolveAdapterConfig(cfg({
    vendor: "deepseek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-chat",
    thinkingFormat: "openai",
  }));
  assertEquals(resolved.thinkingFormat, "openai");
});

Deno.test("ResolveAdapterConfigGenericFallback", () => {
  const resolved = resolveAdapterConfig(
    cfg({ baseUrl: "https://unknown.example.com/v1" }),
  );
  assertEquals(resolved.vendor, "");
  assertEquals(resolved.api, "openai-chat");
});

Deno.test("ResolveAdapterConfigGoogleGemini", () => {
  const resolved = resolveAdapterConfig(cfg({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  }));
  assertEquals(resolved.vendor, "google-gemini");
  assertEquals(resolved.api, "google-gemini");
});

Deno.test("ResolveAdapterConfigGoogleVertex", () => {
  const resolved = resolveAdapterConfig(cfg({
    baseUrl:
      "https://aiplatform.googleapis.com/v1/projects/test/locations/global/publishers/google/models",
  }));
  assertEquals(resolved.vendor, "google-vertex");
  assertEquals(resolved.api, "google-vertex");
});

Deno.test("ResolveAdapterConfigExplicitVendorKimi", () => {
  const resolved = resolveAdapterConfig(cfg({
    vendor: "kimi",
    baseUrl: "https://api.kimi.com/coding",
    api: "anthropic-messages",
  }));
  assertEquals(resolved.vendor, "kimi");
  assertEquals(resolved.thinkingFormat, "");
});

Deno.test("ResolveAdapterConfigExplicitVendorZai", () => {
  const resolved = resolveAdapterConfig(cfg({
    vendor: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    api: "openai-chat",
  }));
  assertEquals(resolved.vendor, "zai");
  assertEquals(resolved.thinkingFormat, "zai");
});

Deno.test("ResolveAdapterConfigBaseURLDetectKimi", () => {
  for (
    const url of ["https://api.moonshot.cn/v1", "https://api.kimi.com/coding"]
  ) {
    const resolved = resolveAdapterConfig(cfg({ baseUrl: url }));
    assertEquals(resolved.vendor, "kimi", url);
  }
});

Deno.test("ResolveAdapterConfigBaseURLDetectZai", () => {
  for (
    const url of [
      "https://api.z.ai/api/coding/paas/v4",
      "https://open.bigmodel.cn/api/coding/paas/v4",
    ]
  ) {
    const resolved = resolveAdapterConfig(cfg({ baseUrl: url }));
    assertEquals(resolved.vendor, "zai", url);
    assertEquals(resolved.thinkingFormat, "zai", url);
  }
});

Deno.test("VendorFromBaseURLDetectsXiaomiTokenPlan", () => {
  assertEquals(
    vendorFromBaseURL("https://token-plan-cn.xiaomimimo.com/v1"),
    "xiaomi-token-plan-cn",
  );
});

Deno.test("VendorFromBaseURLDetectsGoogleAdapters", () => {
  const tests: Array<[string, string]> = [
    [
      "https://generativelanguage.googleapis.com/v1beta/models",
      "google-gemini",
    ],
    [
      "https://aiplatform.googleapis.com/v1/projects/test/locations/global/publishers/google/models",
      "google-vertex",
    ],
  ];
  for (const [url, expected] of tests) {
    assertEquals(vendorFromBaseURL(url), expected, url);
  }
});

Deno.test("ResolveAdapterConfigBaseURLDetectAgnes", () => {
  for (
    const [url, vendor] of [
      ["https://apihub.agnes-ai.com/v1", "agnes"],
      ["https://api.agnes-ai.cn/v1", "agnes"],
    ]
  ) {
    const resolved = resolveAdapterConfig(
      cfg({ baseUrl: url, api: "openai-chat" }),
    );
    assertEquals(resolved.vendor, vendor, url);
    assertEquals(resolved.api, "openai-chat", url);
  }
});

Deno.test("ResolveAdapterConfigExplicitVendorAgnes", () => {
  const resolved = resolveAdapterConfig(cfg({
    vendor: "Agnes",
    baseUrl: "https://apihub.agnes-ai.com/v1",
  }));
  assertEquals(resolved.vendor, "agnes");
  assertEquals(resolved.api, "openai-chat");
});

Deno.test("ResolveAdapterConfigExplicitVendorAMDRadeon", () => {
  const resolved = resolveAdapterConfig(cfg({
    vendor: "amd-radeon",
    baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
    api: "openai-chat",
  }));
  assertEquals(resolved.vendor, "amd-radeon");
  assertEquals(resolved.api, "openai-chat");
});

Deno.test("ResolveAdapterConfigBaseURLDetectAMDRadeon", () => {
  const resolved = resolveAdapterConfig(cfg({
    baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
  }));
  assertEquals(resolved.vendor, "amd-radeon");
  assertEquals(resolved.api, "openai-chat");
});
