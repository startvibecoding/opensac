//
// Deviation: Go's `context.Canceled` / `context.DeadlineExceeded` map to
// `AbortError` / `TimeoutError` named errors because Deno has no `context`
// package.

import { assert, assertEquals } from "@opensac/assert";
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  FAILURE_CANCELLED,
  FAILURE_TRANSIENT,
  PHASE_MODEL,
  PHASE_TOOL,
  RETRY_AUTOMATIC,
  RETRY_DECISION_REQUIRED,
  RETRY_USER,
  SIDE_EFFECT_UNKNOWN,
} from "./error_info.ts";

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

Deno.test("ClassifyErrorRetrySafety", () => {
  const base = classifyError(new Error("HTTP 503 upstream unavailable"), {});
  assert(base.code === "provider_unavailable");
  assert(base.retryMode === RETRY_AUTOMATIC);
  assert(base.retryable === true);
  assert(base.message === "HTTP 503 upstream unavailable");
  assert(base.detail === base.message);

  const unsafe = classifyError(new Error("HTTP 503 upstream unavailable"), {
    sideEffectState: SIDE_EFFECT_UNKNOWN,
  });
  assert(unsafe.retryMode === RETRY_DECISION_REQUIRED);
  assert(unsafe.retryable === true);
});

Deno.test("ClassifyErrorCancellationAndTimeout", () => {
  const cancelled = classifyError(namedError("AbortError", "cancelled"), {});
  assert(cancelled.code === "run_cancelled");
  assert(cancelled.retryMode === RETRY_USER);
  assert(cancelled.failureClass === FAILURE_CANCELLED);

  const timedOut = classifyError(namedError("TimeoutError", "timed out"), {});
  assert(timedOut.code === "run_timed_out");
  assert(timedOut.retryMode === RETRY_AUTOMATIC);
  assert(timedOut.retryable === true);

  const plain = classifyError(new Error("HTTP 400: invalid tool sequence"), {
    phase: PHASE_TOOL,
  });
  assert(plain.code === "provider_request_failed");
  assert(plain.phase === PHASE_TOOL);
  assert(plain.failureClass === FAILURE_TRANSIENT);
  assert(plain.retryMode === RETRY_AUTOMATIC);
  assert(plain.message === "HTTP 400: invalid tool sequence");
  assert(plain.detail === plain.message);
});

Deno.test("SharedFailureContractAcrossAdapters", () => {
  // The adapters intentionally have different wire formats, but the runtime
  // classification is the contract they must all project.
  const entries = ["tui", "acp", "cli"];
  for (const name of entries) {
    const info = classifyError(
      new Error("HTTP 503 provider secret=should-not-leak"),
      {
        phase: PHASE_MODEL,
        runId: "run-1",
        intentId: "intent-1",
        requestId: "req-1",
      },
    );
    assert(
      info.code === "provider_unavailable",
      `${name}: code ${info.code}`,
    );
    assert(info.failureClass === FAILURE_TRANSIENT);
    assert(info.retryMode === RETRY_AUTOMATIC);
    assert(info.retryable === true);
    assert(info.message !== "");
    assert((info.message ?? "").includes("503"));
    const payload = JSON.stringify(info);
    assert(payload.includes("detail"));
    assert(!payload.includes("should-not-leak"));
  }
});

Deno.test("DisplayErrorMessageIncludesProviderDetail", () => {
  const info: ErrorInfo = {
    message: "The model service is temporarily unavailable.",
    detail: "API error 503: upstream overloaded",
  };
  assertEquals(
    displayErrorMessage(info),
    "The model service is temporarily unavailable.: API error 503: upstream overloaded",
  );
});
