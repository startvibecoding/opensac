// (the deterministic
// accuracy test; the Go benchmarks were not translated).

import { assertEquals } from "@std/assert";
import { deepSeekTokenCount } from "./deepseek_tokenizer.ts";
import type { Message } from "../provider/types.ts";
import { GenericTokenEstimator } from "./mod.ts";

Deno.test("TokenEstimationCJKAccuracy", () => {
  const tests: Array<[string, string, number, number, string]> = [
    [
      "Chinese_8chars",
      "你好世界测试消息",
      24,
      4,
      "DeepSeek V3 tokenizer result",
    ],
    [
      "Japanese_10chars",
      "こんにちは世界テスト",
      30,
      7,
      "DeepSeek V3 tokenizer result",
    ],
    [
      "Korean_10chars",
      "안녕하세요세계테스트",
      30,
      9,
      "DeepSeek V3 tokenizer result",
    ],
    [
      "English_40chars",
      "Hello world this is a test message here!",
      40,
      9,
      "DeepSeek V3 tokenizer result",
    ],
  ];

  const estimator = new GenericTokenEstimator();
  for (const [name, text, byteLen, wantTokens] of tests) {
    const message: Message = {
      role: "user",
      content: text,
      timestamp: new Date(),
    };
    const estimated = estimator.estimateTokens(message);
    assertEquals(
      new TextEncoder().encode(text).length,
      byteLen,
      `${name} byte length`,
    );
    assertEquals(estimated, wantTokens, name);
  }
});

Deno.test("deepSeekTokenCount memoizes without changing counts", () => {
  const samples = [
    "Hello world this is a test message here!",
    "你好世界测试消息",
    "export function f(x: number): number { return x * 2; }\n",
    "mixed 混合 text with\nnewlines\tand tabs",
    "",
  ];
  const cold = samples.map((s) => deepSeekTokenCount(s));
  assertEquals(cold[0], 9, "cold count matches the reference value");
  assertEquals(cold[4], 0, "empty text counts zero");

  // Warm passes (cache hits) must agree with the cold computation.
  assertEquals(samples.map((s) => deepSeekTokenCount(s)), cold, "warm pass");
  // Distinct string instances with equal content share the memoized value.
  const rebuilt = samples.map((s) => s.slice(0));
  assertEquals(
    rebuilt.map((s) => deepSeekTokenCount(s)),
    cold,
    "equal-content strings",
  );
});

Deno.test("deepSeekTokenCount stays correct after cache eviction", () => {
  const keep = "Hello world this is a test message here!";
  const first = deepSeekTokenCount(keep);
  // Push far more distinct entries through than the cache caps allow.
  for (let i = 0; i < 70000; i++) {
    deepSeekTokenCount(
      `cache eviction pressure ${i} with some more words here`,
    );
  }
  // `keep` is certainly evicted by now; the recomputed value must still match.
  assertEquals(deepSeekTokenCount(keep), first, "recomputed after eviction");
});
