// Unit tests for the shared cancellation/timeout classification.
//
// These functions decide whether a live run stops or keeps retrying, so the
// boundary cases matter more than the obvious ones: a transient socket fault
// must not be mistaken for a user cancel (it would wrongly stay off the retry
// path), and a real cancel buried under a provider's `fetch failed` rename must
// still be found (it would otherwise replay a stopped request).

import { assert, assertEquals } from "../compat/assert.ts";
import {
  isAbortError,
  isAbortLike,
  isTimeoutError,
  isTimeoutLike,
} from "./errors.ts";
import { test } from "#testing";

test("isAbortError matches by name only, anywhere in the chain", () => {
  assertEquals(isAbortError(new DOMException("x", "AbortError")), true);
  const named = new Error("renamed");
  named.name = "AbortError";
  assertEquals(isAbortError(named), true);

  // A wrapped abort survives one provider rename into `fetch failed`.
  assertEquals(
    isAbortError(new TypeError("fetch failed", { cause: named })),
    true,
  );

  // Message wording alone is never enough for the strict check.
  assertEquals(isAbortError(new Error("operation was aborted")), false);
  assertEquals(isAbortError(new Error("connection reset")), false);
});

test("isAbortLike finds a cancel through the whole cause chain", () => {
  // Node's default `signal.reason` and the provider sentinel both arrive below a
  // generic top-level message.
  const shapes = [
    new Error("aborted"),
    new Error("The operation was aborted."),
    new Error("The signal has been aborted"),
    new Error("request was aborted"),
    new Error("fetch was aborted"),
    new DOMException("Aborted", "AbortError"),
  ];
  for (const shape of shapes) {
    const wrapped = new TypeError("fetch failed", { cause: shape });
    assert(isAbortLike(wrapped), `nested: ${shape.message}`);
    assert(isAbortLike(shape), `bare: ${shape.message}`);
  }
});

test("isAbortLike does not mistake a transient socket fault for a cancel", () => {
  // The narrow wording is load-bearing: a bare "aborted" substring match would
  // pull these off the retry path and terminalize a recoverable run.
  for (const message of [
    "connection aborted",
    "aborted stream read",
    "upstream aborted the transfer",
    "send request: fetch failed",
    "connection reset by peer",
  ]) {
    assertEquals(isAbortLike(new Error(message)), false, message);
  }
});

test("isAbortLike tolerates a self-referencing cause chain", () => {
  const outer = new Error("outer");
  const inner = new Error("inner", { cause: outer });
  // Cycle: walking it must terminate rather than hang.
  (outer as { cause?: unknown }).cause = inner;
  assertEquals(isAbortLike(outer), false);

  const cancelled = new Error("aborted");
  (cancelled as { cause?: unknown }).cause = cancelled;
  assertEquals(isAbortLike(cancelled), true);
});

test("isTimeoutError matches the deadline names", () => {
  assertEquals(isTimeoutError(new DOMException("t", "TimeoutError")), true);
  const deadline = new Error("deadline");
  deadline.name = "DeadlineExceededError";
  assertEquals(isTimeoutError(deadline), true);
  assertEquals(isTimeoutError(new Error("timed out")), false);
});

test("isTimeoutLike reads wording through the chain", () => {
  for (const message of [
    "deadline exceeded",
    "request timed out",
    "idle timeout",
  ]) {
    assert(isTimeoutLike(new Error(message)), message);
    assert(
      isTimeoutLike(
        new TypeError("fetch failed", { cause: new Error(message) }),
      ),
      `nested: ${message}`,
    );
  }
  assertEquals(isTimeoutLike(new Error("connection refused")), false);
});
