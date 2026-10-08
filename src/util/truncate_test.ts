import { assert, assertEquals } from "@opensac/assert";
import { truncateString, truncateWithSuffix } from "./truncate.ts";

Deno.test("TruncateStringKeepsValidUTF8", () => {
  const got = truncateString("你好世界", 5);
  // Deno strings are always valid UTF-16; assert it decodes to the first rune.
  assertEquals(got, "你");
});

Deno.test("TruncateWithSuffix", () => {
  const got = truncateWithSuffix("hello world", 5, "...");
  assertEquals(got, "hello...");
  assert(!truncateWithSuffix("🙂🙂", 5, "...").includes("\uFFFD"));
});

Deno.test("TruncateString fuzz invariants", () => {
  const seeds: Array<[string, number]> = [
    ["", 0],
    ["hello", 3],
    ["你好世界", 5],
    ["🙂🙂", 5],
    ["a", -1],
  ];
  for (const [input, limit] of seeds) {
    const got = truncateString(input, limit);
    if (limit <= 0) assertEquals(got, "");
    assert(new TextEncoder().encode(got).length <= Math.max(limit, 0));
    assert(input.startsWith(got));
  }
});
