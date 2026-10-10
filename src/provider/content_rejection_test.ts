import { assert } from "../compat/assert.ts";
import { isContentRejectionError, isRetryable } from "./mod.ts";
import { test } from "#testing";

test("IsContentRejectionError", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["nil", null, false],
    [
      "dashscope image inspection",
      `API error 400: {"code":"InvalidParameter","message":"<400> InternalError.Algo.DataInspectionFailed: Input image data may contain inappropriate content.","request_id":"abc"}`,
      true,
    ],
    [
      "inappropriate content",
      "Input image data may contain inappropriate content",
      true,
    ],
    ["content policy", "Your request was blocked by our content policy", true],
    ["content filter", "response rejected by content_filter", true],
    [
      "ordinary bad request",
      `API error 400: {"error":{"message":"invalid parameter: model"}}`,
      false,
    ],
    ["rate limited", "API error 429: rate limit exceeded", false],
    ["context overflow", "maximum context length is 8192 tokens", false],
  ];
  for (const [name, err, want] of cases) {
    const actual = err == null ? null : new Error(String(err));
    assert(isContentRejectionError(actual) === want, name);
  }
});

test("IsRetryableSkipsContentRejection", () => {
  const rejected = new Error(
    `API error 400: {"message":"Input image data may contain inappropriate content"}`,
  );
  assert(!isRetryable(rejected, 400));
  assert(
    isRetryable(
      new Error(`API error 400: {"error":{"message":"invalid parameter"}}`),
      400,
    ),
  );
});
