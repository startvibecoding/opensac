import { assert, assertEquals, assertThrows } from "@opensac/assert";
import type { ProviderConfig } from "../config/mod.ts";
import {
  createMockProvider,
  createProvider,
  globalProviderRegistry,
  listProviders,
  type Provider,
  ProviderRegistry,
  register,
  resolveProvider,
  setGlobalProviderRegistry,
  vendorFromBaseURL,
} from "./mod.ts";

function cfg(partial: Partial<ProviderConfig>): ProviderConfig {
  return { models: [], ...partial };
}

Deno.test("ProviderRegistryRegisterAndCreate", () => {
  const r = new ProviderRegistry();
  r.register(
    "test",
    (_cfg) =>
      createMockProvider("test", [{ id: "m1", name: "Model 1" } as never], []),
  );
  assert(r.has("test"));
  assert(!r.has("nonexistent"));
  const p = r.create("test", cfg({}));
  assertEquals(p.name(), "test");
});

Deno.test("ProviderRegistryCreateNotFound", () => {
  const r = new ProviderRegistry();
  assertThrows(() => r.create("nonexistent", cfg({})));
});

Deno.test("ProviderRegistryList", () => {
  const r = new ProviderRegistry();
  r.register("a", (_cfg) => null as unknown as Provider);
  r.register("b", (_cfg) => null as unknown as Provider);
  assertEquals(r.list().length, 2);
});

Deno.test("VendorFromBaseURL", () => {
  const tests: Array<[string, string]> = [
    ["https://api.ant-ling.com", "ant-ling"],
    ["https://api.anthropic.com/v1/messages", "anthropic"],
    ["https://api.deepseek.com", "deepseek"],
    ["https://api.deepseek.com/anthropic", "deepseek"],
    ["https://api.cerebras.ai/v1", "cerebras"],
    ["https://router.huggingface.co/v1", "huggingface"],
    ["https://api.xiaomimimo.com/v1", "xiaomi"],
    ["https://api.moonshot.cn/v1", "kimi"],
    ["https://api.kimi.com/coding", "kimi"],
    ["https://api.moonshot.ai/v1", "moonshotai"],
    ["https://integrate.api.nvidia.com/v1", "nvidia"],
    ["https://api.openai.com/v1/chat/completions", "openai"],
    ["https://opencode.ai/v1", "opencode"],
    ["https://api.z.ai/api/coding/paas/v4", "zai"],
    ["https://open.bigmodel.cn/api/coding/paas/v4", "zai"],
    ["https://api.minimaxi.com/anthropic", "minimax"],
    ["https://ark.cn-beijing.volces.com/api", "volcengine"],
    ["https://aip.baidubce.com/rpc", "qianfan"],
    ["https://dashscope.aliyuncs.com/api", "bailian"],
    [
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "bailian",
    ],
    ["https://coding.dashscope.aliyuncs.com/v1", "bailian"],
    ["https://ai.gitee.com/v1", "gitee"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.together.xyz/v1", "together"],
    ["https://api.groq.com/openai", "groq"],
    ["https://api.fireworks.ai/inference", "fireworks"],
    [
      "https://generativelanguage.googleapis.com/v1beta/models",
      "google-gemini",
    ],
    [
      "https://aiplatform.googleapis.com/v1/projects/test/locations/global/publishers/google/models",
      "google-vertex",
    ],
    ["https://ai-gateway.vercel.sh/v1", "vercel-ai-gateway"],
    ["https://api.x.ai/v1", "xai"],
    ["https://www.codeok.cc/v1", "codeok"],
    ["https://co.yes.vg/v1", "yescode"],
    ["https://apihub.agnes-ai.com/v1", "agnes"],
    ["https://api.agnes-ai.cn/v1", "agnes"],
    ["https://unknown.example.com/v1", ""],
    ["", ""],
  ];
  for (const [url, expected] of tests) {
    assertEquals(vendorFromBaseURL(url), expected, url);
  }
});

function withRegistry(r: ProviderRegistry, fn: () => void): void {
  const orig = globalProviderRegistry();
  setGlobalProviderRegistry(r);
  try {
    fn();
  } finally {
    setGlobalProviderRegistry(orig);
  }
}

Deno.test("ResolveProviderExplicitVendor", () => {
  const r = new ProviderRegistry();
  r.register("myvendor", (_cfg) => createMockProvider("myvendor", [], []));
  withRegistry(r, () => {
    const p = resolveProvider(cfg({ vendor: "myvendor", api: "openai-chat" }));
    assertEquals(p.name(), "myvendor");
  });
});

Deno.test("ResolveProviderAutoDetect", () => {
  const r = new ProviderRegistry();
  r.register("deepseek", () => createMockProvider("deepseek", [], []));
  r.register("openai-chat", () => createMockProvider("openai-chat", [], []));
  r.register(
    "anthropic-messages",
    () => createMockProvider("anthropic-messages", [], []),
  );
  withRegistry(r, () => {
    const p = resolveProvider(
      cfg({ baseUrl: "https://api.deepseek.com", api: "openai-chat" }),
    );
    assertEquals(p.name(), "deepseek");
  });
});

Deno.test("ResolveProviderFallback", () => {
  const r = new ProviderRegistry();
  for (
    const name of [
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "google-gemini",
      "google-vertex",
    ]
  ) {
    r.register(name, () => createMockProvider(name, [], []));
  }
  withRegistry(r, () => {
    assertEquals(
      resolveProvider(
        cfg({ baseUrl: "https://unknown.example.com/v1", api: "openai-chat" }),
      ).name(),
      "openai-chat",
    );
    assertEquals(
      resolveProvider(
        cfg({
          baseUrl: "https://unknown.example.com/v1",
          api: "anthropic-messages",
        }),
      ).name(),
      "anthropic-messages",
    );
    assertEquals(
      resolveProvider(
        cfg({
          baseUrl: "https://unknown.example.com/v1",
          api: "openai-responses",
        }),
      ).name(),
      "openai-responses",
    );
  });
});

Deno.test("ResolveProviderUnknownAPI", () => {
  withRegistry(new ProviderRegistry(), () => {
    const err = assertThrows(() =>
      resolveProvider(cfg({ api: "unknown-api" }))
    ) as Error;
    assert(err.message.includes("unsupported API type"));
  });
});

Deno.test("ResolveProviderUnregisteredVendorUsesAPI", () => {
  const r = new ProviderRegistry();
  for (
    const name of [
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "google-gemini",
      "google-vertex",
    ]
  ) {
    r.register(name, () => createMockProvider(name, [], []));
  }
  withRegistry(r, () => {
    const cases: Array<[string, string]> = [
      ["openai-chat", "openai-chat"],
      ["openai-responses", "openai-responses"],
      ["anthropic-messages", "anthropic-messages"],
      ["google-gemini", "google-gemini"],
      ["google-vertex", "google-vertex"],
    ];
    for (const [api, want] of cases) {
      const p = resolveProvider(cfg({ vendor: "unregistered", api }));
      assertEquals(p.name(), want, api);
    }
  });
});

Deno.test("ResolveProviderVendorPriorityOverAPIFallback", () => {
  const r = new ProviderRegistry();
  r.register("openai", () => createMockProvider("openai", [], []));
  r.register(
    "openai-responses",
    () => createMockProvider("openai-responses", [], []),
  );
  withRegistry(r, () => {
    const p = resolveProvider(
      cfg({ vendor: "openai", api: "openai-responses" }),
    );
    assertEquals(p.name(), "openai");
  });
});

Deno.test("ResolveProviderGoogleFallback", () => {
  const r = new ProviderRegistry();
  r.register(
    "google-gemini",
    () => createMockProvider("google-gemini", [], []),
  );
  r.register(
    "google-vertex",
    () => createMockProvider("google-vertex", [], []),
  );
  withRegistry(r, () => {
    assertEquals(
      resolveProvider(
        cfg({
          baseUrl: "https://unknown.example.com/v1",
          api: "google-gemini",
        }),
      ).name(),
      "google-gemini",
    );
    assertEquals(
      resolveProvider(
        cfg({
          baseUrl: "https://unknown.example.com/v1",
          api: "google-vertex",
        }),
      ).name(),
      "google-vertex",
    );
  });
});

Deno.test("GlobalRegistry", () => {
  const orig = globalProviderRegistry();
  setGlobalProviderRegistry(new ProviderRegistry());
  try {
    register("global_test", () => createMockProvider("global_test", [], []));
    assert(listProviders().includes("global_test"));
    assertEquals(createProvider("global_test", cfg({})).name(), "global_test");
  } finally {
    setGlobalProviderRegistry(orig);
  }
});
