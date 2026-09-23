import { assert } from "@std/assert";
import { isContextOverflowError } from "./mod.ts";

Deno.test("IsContextOverflowError", () => {
  const tests: Array<[string, unknown, boolean]> = [
    ["nil", null, false],
    [
      "openai code",
      `API error 400: {"error":{"code":"context_length_exceeded"}}`,
      true,
    ],
    [
      "openai message",
      "This model's maximum context length is 128000 tokens",
      true,
    ],
    ["anthropic", "prompt is too long: 213462 tokens > 200000 maximum", true],
    [
      "moonshot",
      "Invalid request: the request exceeds the maximum length limit of the model",
      true,
    ],
    ["kimi", "total tokens of image and text exceed max message tokens", true],
    ["context window", "request exceeds the model's context window", true],
    [
      "rate limit is not overflow",
      "API error 429: rate limit exceeded, please retry later",
      false,
    ],
    ["auth error", "API error 401: invalid api key", false],
    ["generic stream failure", "responses stream failed", false],
    ["network error", "connection reset by peer", false],
  ];
  for (const [name, err, want] of tests) {
    const actual = err == null ? null : new Error(String(err));
    assert(isContextOverflowError(actual) === want, name);
  }
});
