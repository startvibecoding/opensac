// Ported from internal/context/tokenizer_bench_test.go (the deterministic
// accuracy test; the Go benchmarks were not translated).

import { assertEquals } from "@std/assert";
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
