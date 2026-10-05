// Regression tests for provider transport-failure classification.
//
// The bug: Deno reports every fetch-level network fault as `TypeError: "fetch
// failed"` and puts the real reason only on `cause`, while each provider's
// private `wrapError` flattened the error and dropped the chain. The agent then
// saw only "send request: fetch failed", which no rule matched, so a plain
// connection blip terminalized a live run instead of reporting and retrying.

import { assert, assertEquals } from "@std/assert";
import { isAbortLike } from "../util/errors.ts";
import { errorChainText, wrapError } from "./errors.ts";
import { isRetryable, retryErrorDetail } from "./retry.ts";

/** Builds one error in the exact shape Deno's `fetch` produces. */
function denoFetchFailure(causeMessage: string): Error {
  const cause = new Error(causeMessage);
  const failure = new TypeError("fetch failed", { cause });
  return failure;
}

Deno.test("wrapError keeps the cause chain and names the real reason", () => {
  const raw = denoFetchFailure(
    "error sending request for url (http://127.0.0.1:45999/v1): client error (Connect): tcp connect error: Connection refused (os error 111)",
  );
  const wrapped = wrapError("send request", raw);

  // The chain survives, so classification can still reach the socket reason.
  assert(wrapped.cause === raw, "wrapError must preserve the original error");
  assert(
    errorChainText(wrapped).toLowerCase().includes("connection refused"),
    "the cause chain has to be readable through the wrapper",
  );
  // And the user sees why, not just "fetch failed".
  assert(
    wrapped.message.includes("Connection refused (os error 111)"),
    `expected an actionable message, got ${JSON.stringify(wrapped.message)}`,
  );
});

Deno.test("a fetch failure the provider wrapped is retryable and reported", () => {
  const wrapped = wrapError(
    "send request",
    denoFetchFailure(
      "error sending request for url (https://api.example.invalid/v1): client error (Connect): tcp connect error: Connection refused (os error 111)",
    ),
  );

  assert(isRetryable(wrapped, 0), "a refused connection must retry");
  assertEquals(retryErrorDetail(wrapped), "connection refused");
});

Deno.test("the legacy flattened message still classifies as retryable", () => {
  // An error that already lost its chain (a persisted run record, an older
  // provider path) must not fall back to "unclassifiable, fail the run".
  const flattened = new Error("send request: fetch failed");
  assert(isRetryable(flattened, 0));
  assertEquals(retryErrorDetail(flattened), "network request failed");
});

Deno.test("a DNS failure through the wrapper is retryable", () => {
  const wrapped = wrapError(
    "send request",
    denoFetchFailure(
      "error sending request for url (https://api.example.invalid/v1): client error (Connect): dns error: failed to lookup address information: Name or service not known",
    ),
  );
  assert(isRetryable(wrapped, 0), "a transient lookup failure must retry");
  assertEquals(retryErrorDetail(wrapped), "dns lookup failed");
});

Deno.test("a fetch failure that may never succeed is still retried but named", () => {
  // Under the retry-by-default policy these configuration faults are retried
  // within the caller's bounded budget instead of terminalizing a live run; the
  // distinction that still matters is that the printed reason names the real
  // problem, so the user can see the original fault and fix the configuration.
  const blocked = new Error("Fetch failed: Requests to port 1 are blocked");
  assert(isRetryable(wrapError("send request", blocked), 0));
  assertEquals(retryErrorDetail(blocked), "blocked reserved port");

  const badURL = new Error("Invalid URL: 'ht!tp://x.invalid'");
  assert(isRetryable(wrapError("send request", badURL), 0));
  assertEquals(retryErrorDetail(badURL), "invalid request URL");

  const tls = new Error(
    "fetch failed",
    { cause: new Error("certificate has expired") },
  );
  assert(isRetryable(wrapError("send request", tls), 0));
  assertEquals(retryErrorDetail(tls), "TLS certificate verification failed");
});

Deno.test("a wrapped authentication failure stays permanent", () => {
  // Classification walks the chain, so a wrapped 401 cannot be smuggled into
  // the retry path by the provider prefix.
  const wrapped = wrapError(
    "send request",
    new Error("HTTP 401: invalid api key"),
  );
  assertEquals(isRetryable(wrapped, 0), false);
});

Deno.test("an explicit cancellation is still never retried", () => {
  const aborted = new DOMException("The operation was aborted.", "AbortError");
  assertEquals(isRetryable(wrapError("send request", aborted), 0), false);
});

Deno.test("a cancellation wrapped as a fetch failure is never retried", () => {
  // An explicit abort must win over the generic transport rule, or a cancelled
  // run would be replayed against the user's intent.
  const aborted = new TypeError("fetch failed", {
    cause: new DOMException("The operation was aborted.", "AbortError"),
  });
  assertEquals(isRetryable(wrapError("send request", aborted), 0), false);

  const canceled = new TypeError("fetch failed", {
    cause: new Error("context canceled"),
  });
  assertEquals(isRetryable(wrapError("send request", canceled), 0), false);
});

Deno.test("every Deno abort shape is never retried, bare or wrapped", () => {
  // The shapes Deno actually produces for a cancelled fetch. Each one names the
  // cancellation without using the "The operation was aborted." wording, so a
  // check that reads only the top message or one exact phrase lets a user abort
  // be replayed as a transport blip.
  const signal = new AbortController();
  signal.abort();
  const shapes: Array<[string, unknown]> = [
    ["DOMException(AbortError)", new DOMException("Aborted", "AbortError")],
    ["default signal.reason", signal.signal.reason],
  ];
  for (const [name, abort] of shapes) {
    assertEquals(
      isAbortLike(abort),
      true,
      `${name} must read as a cancellation`,
    );
    assertEquals(
      isRetryable(abort, 0),
      false,
      `a bare ${name} must not be retried`,
    );
    const wrapped = wrapError(
      "send request",
      new TypeError("fetch failed", { cause: abort }),
    );
    assertEquals(
      isRetryable(wrapped, 0),
      false,
      `a wrapped ${name} must not be retried`,
    );
  }
});

Deno.test("a permanent transport failure is retried but still named clearly", () => {
  // The reason shown to the user must name the configuration problem rather than
  // hide it behind "request timed out" or the generic "network request failed",
  // even though the run now retries it within its bounded budget. A TLS/blocked-
  // port/URL rejection routinely arrives with timeout wording in the same chain,
  // and the message has to surface the real cause so the user knows what to fix.
  const cases: Array<[string, unknown, string]> = [
    [
      "blocked reserved port",
      new Error("Fetch failed: Requests to port 8080 are blocked"),
      "blocked reserved port",
    ],
    [
      "blocked port with timeout framing",
      new Error("Requests to port 8080 are blocked: read timed out"),
      "blocked reserved port",
    ],
    [
      "expired certificate with timeout framing",
      new TypeError("fetch failed", {
        cause: new Error(
          "invalid peer certificate: certificate has expired; handshake timed out",
        ),
      }),
      "TLS certificate verification failed",
    ],
    [
      "unknown issuer (self-signed chain)",
      new TypeError("fetch failed", {
        cause: new Error(
          "client error (Connect): invalid peer certificate: Unknown issuer",
        ),
      }),
      "TLS certificate verification failed",
    ],
    [
      "unsupported scheme",
      new Error("Url scheme 'ftp' not supported"),
      "unsupported URL scheme",
    ],
    [
      "malformed URL",
      new Error("Invalid URL: 'ht!tp://x'"),
      "invalid request URL",
    ],
  ];
  for (const [label, err, want] of cases) {
    // Retried now, but the classification still names the real fault first.
    assertEquals(isRetryable(err, 0), true, `${label} must be retried`);
    assertEquals(retryErrorDetail(err), want, label);
  }
});

Deno.test("a genuine timeout stays retryable after the permanence check", () => {
  // The reorder must not swallow the failures long-task continuity does retry.
  assertEquals(isRetryable(new Error("read timed out"), 0), true);
  assertEquals(isRetryable(new Error("context deadline exceeded"), 0), true);
  assertEquals(
    isRetryable(Object.assign(new Error("socket"), { code: "ETIMEDOUT" }), 0),
    true,
  );
  // And both spellings report the same bounded reason, because `isTimeoutLike`
  // matches the two-word form that Deno actually emits.
  assertEquals(
    retryErrorDetail(new Error("read timed out")),
    "request timed out",
  );
  assertEquals(
    retryErrorDetail(new Error("response timeout")),
    "request timed out",
  );
});

Deno.test("wrapError names the reason through a doubly-wrapped chain", () => {
  // Providers wrap at more than one stage (`stream read error: send request:
  // fetch failed: ...`), so reading only the first link would surface the
  // intermediate "fetch failed" instead of the socket reason further down.
  const raw = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (http://127.0.0.1:1/v1): client error (Connect): tcp connect error: Connection refused (os error 111)",
    ),
  });
  const twice = wrapError("stream read error", wrapError("send request", raw));
  assert(
    twice.message.endsWith("Connection refused (os error 111)"),
    `expected the deepest reason, got ${JSON.stringify(twice.message)}`,
  );
  assertEquals(isRetryable(twice, 0), true);
  assertEquals(retryErrorDetail(twice), "connection refused");
});
