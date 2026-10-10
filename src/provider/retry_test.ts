import { assert, assertEquals } from "../compat/assert.ts";
import {
  formatRetryMessage,
  isRetryable,
  retryDelay,
  retryErrorDetail,
  truncateErr,
} from "./mod.ts";
import { test } from "#testing";

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function abortError(): Error {
  return new DOMException(
    "The operation was aborted.",
    "AbortError",
  ) as unknown as Error;
}

test("IsRetryable_NetworkErrors", () => {
  const tests: Array<[string, unknown, number, boolean]> = [
    ["nil error", null, 0, false],
    ["429", null, 429, true],
    ["502", null, 502, true],
    ["503", null, 503, true],
    ["504", null, 504, true],
    ["524", null, 524, true],
    ["500", null, 500, true],
    ["400 retryable", null, 400, true],
    ["401 authentication never retryable", null, 401, false],
    ["403 permission never retryable", null, 403, false],
    ["499 retryable", null, 499, true],
    ["599 retryable", null, 599, true],
    ["ECONNRESET", coded("read ECONNRESET", "ECONNRESET"), 0, true],
    [
      "stream read connection reset by peer",
      new Error(
        "stream read error: read tcp 192.168.1.143:44252->180.76.199.86:443: read: connection reset by peer",
      ),
      0,
      true,
    ],
    ["ECONNREFUSED", coded("connect ECONNREFUSED", "ECONNREFUSED"), 0, true],
    ["EPIPE", coded("write EPIPE", "EPIPE"), 0, true],
    ["ETIMEDOUT", coded("connect ETIMEDOUT", "ETIMEDOUT"), 0, true],
    [
      "HTTP/2 stream internal error",
      new Error(
        "stream error: stream ID 19; INTERNAL_ERROR; received from peer",
      ),
      0,
      true,
    ],
    [
      "Responses stream read error",
      new Error("responses error: stream_read_error"),
      0,
      true,
    ],
    [
      "Responses generic stream failure",
      new Error("responses stream failed"),
      0,
      true,
    ],
    [
      "Responses server error",
      new Error("responses error: server_error"),
      0,
      true,
    ],
    [
      "Responses rate limit",
      new Error("responses error: rate_limit_exceeded"),
      0,
      true,
    ],
    [
      "Responses context overflow not retryable",
      new Error("responses error: maximum context length exceeded"),
      0,
      false,
    ],
    [
      "Responses server overloaded",
      new Error(
        "responses error: Our servers are currently overloaded. Please try again later.",
      ),
      0,
      true,
    ],
    ["SSE HTTP 502 error", new Error("upstream returned HTTP 502"), 0, true],
    ["SSE HTTP 503 error", new Error("upstream returned HTTP 503"), 0, true],
    ["SSE HTTP 400 error", new Error("upstream returned HTTP 400"), 0, true],
    ["unexpected EOF", new Error("unexpected EOF"), 0, true],
    [
      "wrapped unexpected EOF",
      new Error("stream read error: unexpected EOF"),
      0,
      true,
    ],
    ["SSE HTTP 524 error", new Error("upstream returned HTTP 524"), 0, true],
    ["context canceled", abortError(), 0, false],
    // Retry is now the default: a fault no rule recognizes is treated as an
    // availability problem and retried within the caller's bounded budget rather
    // than terminalizing a live run. The genuine stops (cancellation, content
    // rejection, context overflow, authentication) are still `false` above.
    ["generic error", new Error("something"), 0, true],
  ];
  for (const [name, err, code, want] of tests) {
    assertEquals(isRetryable(err, code), want, name);
  }
});

test("RetryDelay_ExponentialBackoff", () => {
  assertEquals(retryDelay(0, 2000), 2000);
  assertEquals(retryDelay(1, 2000), 4000);
  assertEquals(retryDelay(2, 2000), 8000);
});

test("RetryDelay_CappedAt30s", () => {
  assert(retryDelay(10, 5000) <= 30000);
});

test("RetryDelay_DefaultBase", () => {
  assertEquals(retryDelay(0, 0), 2000);
});

test("FormatRetryMessage_Timeout", () => {
  assert(
    formatRetryMessage(0, 3, 2000, new Error("context deadline exceeded")) !==
      "",
  );
});

test("FormatRetryMessage_ServerOverloaded", () => {
  const msg = formatRetryMessage(
    0,
    3,
    2000,
    new Error("responses error: Our servers are currently overloaded"),
  );
  assert(msg.includes("server overloaded"), msg);
});

test("FormatRetryMessage_RateLimited", () => {
  assert(
    formatRetryMessage(1, 3, 4000, new Error("HTTP 429: rate limit")) !== "",
  );
});

test("FormatRetryMessage_ConnectionRefused", () => {
  assert(
    formatRetryMessage(2, 3, 8000, new Error("connection refused")) !== "",
  );
});

test("FormatRetryMessage_Generic", () => {
  assert(formatRetryMessage(0, 3, 2000, new Error("some random error")) !== "");
});

test("FormatRetryMessage_StreamReadError", () => {
  const msg = formatRetryMessage(
    0,
    3,
    1000,
    new Error("responses error: stream_read_error"),
  );
  assert(msg.includes("upstream stream read error"), msg);
});

test("FormatRetryMessage_OriginTimeout", () => {
  const msg = formatRetryMessage(
    0,
    3,
    1000,
    new Error("HTTP 524: origin timeout"),
  );
  assert(msg.includes("origin timeout (HTTP 524)"), msg);
});

test("FormatRetryMessage_JSONErrorMessage", () => {
  const openAIError = new Error(
    `HTTP 400: {"object":"error","message":"\\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError","param":null,"code":400}`,
  );
  const msg = formatRetryMessage(0, 3, 1000, openAIError);
  assert(
    msg.includes(`"auto" tool choice requires --enable-auto-tool-choice`),
    msg,
  );
  assert(msg.includes("Retrying (1/3)"), msg);
});

test("FormatRetryMessage_JSONErrorNested", () => {
  const nestedError = new Error(
    `HTTP 400: {"error":{"message":"Invalid API key provided"},"code":400}`,
  );
  const msg = formatRetryMessage(0, 3, 1000, nestedError);
  assert(msg.includes("Invalid API key provided"), msg);
});

test("FormatRetryMessage_JSONErrorInvalid", () => {
  const invalidJSON = new Error("HTTP 400: not valid json {");
  const msg = formatRetryMessage(0, 3, 1000, invalidJSON);
  assert(msg.includes("error:"), msg);
});

test("RetryErrorDetailDoesNotFabricateHttpStatusFromUnrelatedNumber", () => {
  // A bare `includes("500")` used to relabel any error whose text happened to
  // contain those digits as an HTTP status, hiding the original fault behind a
  // wrong category and pointing the user at the wrong fix. A number embedded in
  // an unrelated value must fall through to the raw original text instead.
  const tokens = new Error("used 1500 tokens in this request");
  const detail = retryErrorDetail(tokens);
  assert(!detail.includes("HTTP 500"), detail);
  assert(detail.includes("1500 tokens"), detail);

  const latency = new Error("request latency 4429ms exceeded budget");
  assert(
    !retryErrorDetail(latency).includes("HTTP 429"),
    retryErrorDetail(latency),
  );

  // A real status token still classifies correctly at the word boundary.
  assertEquals(
    retryErrorDetail(new Error("HTTP 500 upstream")),
    "internal server error (HTTP 500)",
  );
});

test("RetryErrorDetailNeverThrowsOnHostileInput", () => {
  // Classification runs inside the provider retry loop, so it must degrade to a
  // best-effort line rather than throw and abort a live run that would otherwise
  // keep retrying. Here `message` is a throwing getter, so the cause-chain walk
  // itself raises: the classifier must catch it and still return a string.
  const hostile = new Error("ok");
  Object.defineProperty(hostile, "message", {
    configurable: true,
    get(): string {
      throw new Error("boom");
    },
  });
  const got = retryErrorDetail(hostile);
  assert(typeof got === "string", "must return a string, not throw");
});

test("RetryErrorDetail", () => {
  assertEquals(retryErrorDetail(null), "");

  const openAIError = new Error(
    `HTTP 400: {"error":{"message":"\\"auto\\" tool choice requires --enable-auto-tool-choice"},"code":400}`,
  );
  assertEquals(
    retryErrorDetail(openAIError),
    `"auto" tool choice requires --enable-auto-tool-choice`,
  );

  assertEquals(
    retryErrorDetail(new Error("HTTP 503 from upstream")),
    "service unavailable (HTTP 503)",
  );

  const got = retryErrorDetail(new Error("boom\n\tat layer 1\r\n at layer 2"));
  assert(!/[\n\r\t]/.test(got), got);
  assert(got.includes("boom at layer 1 at layer 2"), got);
});

test("TruncateErrRuneSafe", () => {
  const s = "错".repeat(100);
  const got = truncateErr(s, 50);
  assert(new TextEncoder().encode(got).length <= 50, `${got.length}`);
  assert(got.endsWith("..."), got);
  const body = got.slice(0, -3);
  for (const r of body) assert(r === "错", `broken rune ${r}`);
});

test("IsRetryable_AuthenticationFailures", () => {
  const tests: Array<[string, unknown, number, boolean]> = [
    [
      "invalid api key message",
      new Error(
        "Authentication Fails, Your api key: ****KEY} is invalid (request_id: f8f3)",
      ),
      0,
      false,
    ],
    ["401 unauthorized message", new Error("401 Unauthorized"), 0, false],
    ["403 forbidden message", new Error("api error 403: forbidden"), 0, false],
    ["invalid_api_key code", new Error("invalid_api_key"), 0, false],
    ["unauthorized token", new Error("unauthorized: token expired"), 0, false],
    ["quota still retryable", new Error("quota exceeded"), 429, true],
    ["server error still retryable", new Error("server_error"), 500, true],
    [
      "auth failure with 401 status",
      new Error("Authentication Fails"),
      401,
      false,
    ],
  ];
  for (const [name, err, code, want] of tests) {
    assertEquals(isRetryable(err, code), want, name);
  }
});
