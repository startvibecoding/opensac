import { assertEquals } from "../compat/assert.ts";
import { type Model } from "../provider/types.ts";
import { resolveMaxTokens, resolveMaxTokensValue } from "./max_tokens.ts";
import { test } from "#testing";

function model(partial: Partial<Model>): Model {
  return {
    id: "m",
    name: "",
    provider: "",
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...partial,
  };
}

test("resolveMaxTokens uses model value", () => {
  const m = model({
    contextWindow: 128000,
    maxTokens: 64000,
    maxTokensSet: true,
  });
  assertEquals(resolveMaxTokens(m), 64000);
});

test("resolveMaxTokens uses conservative default for known model", () => {
  const m = model({ contextWindow: 128000, maxTokens: 64000 });
  assertEquals(resolveMaxTokens(m), 8192);
});

test("resolveMaxTokens uses native limit below default", () => {
  const m = model({ contextWindow: 8192, maxTokens: 4096 });
  assertEquals(resolveMaxTokens(m), 4096);
});

test("resolveMaxTokens returns zero when explicitly disabled", () => {
  const m = model({ maxTokens: 0, maxTokensSet: true });
  assertEquals(resolveMaxTokens(m), 0);
});

test("resolveMaxTokens returns zero when unknown", () => {
  assertEquals(resolveMaxTokens(null), 0);
  assertEquals(resolveMaxTokens(undefined), 0);
});

test("resolveMaxTokensValue prefers explicit", () => {
  const m = model({ maxTokens: 64000 });
  assertEquals(resolveMaxTokensValue(4096, m), 4096);
});
