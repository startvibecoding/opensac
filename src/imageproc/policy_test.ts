import { assertEquals } from "@opensac/assert";
import { type Family, type Hint, inferFamily, policyForHint } from "./mod.ts";

Deno.test("inferFamily from default vision model IDs", () => {
  const cases: Array<[string, Hint, Family]> = [
    [
      "doubao seed turbo",
      { providerID: "volcengine-agentplan", modelID: "doubao-seed-2.1-turbo" },
      "doubao-seed",
    ],
    [
      "seed shorthand",
      { providerID: "volcengine-agentplan", modelID: "seed-2-pro" },
      "doubao-seed",
    ],
    [
      "qwen plus",
      { providerID: "alibaba-standard", modelID: "qwen3.7-plus" },
      "qwen",
    ],
    [
      "qwen routed",
      { providerID: "openrouter", modelID: "alibaba/qwen3.6-plus" },
      "qwen",
    ],
    [
      "kimi coding short id",
      { providerID: "kimi-coding", api: "anthropic-messages", modelID: "k2p7" },
      "kimi",
    ],
    [
      "minimax over anthropic api",
      {
        providerID: "minimax-anthropic",
        api: "anthropic-messages",
        modelID: "MiniMax-M3",
      },
      "minimax",
    ],
    [
      "bedrock claude",
      {
        providerID: "amazon-bedrock",
        modelID: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      },
      "anthropic-bedrock",
    ],
    [
      "amazon nova",
      { providerID: "amazon-bedrock", modelID: "amazon.nova-pro-v1:0" },
      "amazon-nova",
    ],
    [
      "gateway deepseek vision",
      { providerID: "alibaba-standard", modelID: "deepseek-v4-pro" },
      "deepseek-gateway-vision",
    ],
    [
      "direct deepseek remains generic",
      { providerID: "deepseek-openai", modelID: "deepseek-v4-flash" },
      "generic",
    ],
    [
      "llama vision",
      {
        providerID: "cloudflare-workers-ai",
        modelID: "@cf/meta/llama-4-scout-17b-16e-instruct",
      },
      "llama-vision",
    ],
    [
      "gemma vision",
      { providerID: "google-gemini", modelID: "gemma-4-26b-a4b-it" },
      "gemma-vision",
    ],
  ];
  for (const [name, hint, want] of cases) {
    assertEquals(inferFamily(hint), want, name);
  }
});

Deno.test("policyForHint applies provider limits", () => {
  const bedrock = policyForHint(
    {
      providerID: "amazon-bedrock",
      modelID: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    },
    "detail",
  );
  assertEquals(bedrock.maxFileBytes, 4 << 20);
  assertEquals(bedrock.maxOutputBytes, 3 << 20);

  const openai = policyForHint(
    { providerID: "openai", modelID: "gpt-4o" },
    "auto",
  );
  assertEquals(openai.maxFileBytes, 20 << 20);

  const qwen = policyForHint(
    { providerID: "alibaba-standard", modelID: "qwen3.7-plus" },
    "detail",
  );
  assertEquals(qwen.maxLongEdge, 2560);

  const groq = policyForHint(
    {
      providerID: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      modelID: "meta-llama/llama-4-scout-17b-16e-instruct",
    },
    "detail",
  );
  assertEquals(groq.maxOutputBytes, 3 << 20);
});
