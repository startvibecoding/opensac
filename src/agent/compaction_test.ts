// Focused tests for the compaction settings bridge (port of compaction.go).

import { assertEquals } from "@opensac/assert";
import { compactionSettingsFromConfig } from "./compaction.ts";

Deno.test("compactionSettingsFromConfig copies every field", () => {
  assertEquals(
    compactionSettingsFromConfig({
      enabled: true,
      reserveTokens: 1000,
      keepRecentTokens: 2000,
      tokenizer: "deepseek",
      tokenizerModel: "deepseek-v3",
      template: "summary",
    }),
    {
      enabled: true,
      reserveTokens: 1000,
      keepRecentTokens: 2000,
      tokenizer: "deepseek",
      tokenizerModel: "deepseek-v3",
      template: "summary",
    },
  );
});

Deno.test("compactionSettingsFromConfig keeps zero limits for later normalization", () => {
  assertEquals(
    compactionSettingsFromConfig({
      enabled: false,
      reserveTokens: 0,
      keepRecentTokens: 0,
    }),
    {
      enabled: false,
      reserveTokens: 0,
      keepRecentTokens: 0,
      tokenizer: undefined,
      tokenizerModel: undefined,
      template: undefined,
    },
  );
});
