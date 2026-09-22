// Ported from internal/agentruntime/error_info_test.go.
//
// Deviation: Go's `context.Canceled` / `context.DeadlineExceeded` map to
// `AbortError` / `TimeoutError` named errors because Deno has no `context`
// package.

import { assert, assertEquals } from "@std/assert";
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  FailureCancelled,
  FailureTransient,
  PhaseModel,
  PhaseTool,
  RetryAutomatic,
  RetryDecisionRequired,
  RetryUser,
  SideEffectUnknown,
} from "./error_info.ts";

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

Deno.test("ClassifyErrorRetrySafety", () => {
  const base = classifyError(new Error("HTTP 503 upstream unavailable"), {});
  assert(base.code === "provider_unavailable");
  assert(base.retryMode === RetryAutomatic);
  assert(base.retryable === true);
  assert(base.message === "HTTP 503 upstream unavailable");
  assert(base.detail === base.message);

  const unsafe = classifyError(new Error("HTTP 503 upstream unavailable"), {
    sideEffectState: SideEffectUnknown,
  });
  assert(unsafe.retryMode === RetryDecisionRequired);
  assert(unsafe.retryable === true);
});

Deno.test("ClassifyErrorCancellationAndTimeout", () => {
  const cancelled = classifyError(namedError("AbortError", "cancelled"), {});
  assert(cancelled.code === "run_cancelled");
  assert(cancelled.retryMode === RetryUser);
  assert(cancelled.failureClass === FailureCancelled);

  const timedOut = classifyError(namedError("TimeoutError", "timed out"), {});
  assert(timedOut.code === "run_timed_out");
  assert(timedOut.retryMode === RetryAutomatic);
  assert(timedOut.retryable === true);

  const plain = classifyError(new Error("HTTP 400: invalid tool sequence"), {
    phase: PhaseTool,
  });
  assert(plain.code === "provider_request_failed");
  assert(plain.phase === PhaseTool);
  assert(plain.failureClass === FailureTransient);
  assert(plain.retryMode === RetryAutomatic);
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
        phase: PhaseModel,
        runId: "run-1",
        intentId: "intent-1",
        requestId: "req-1",
      },
    );
    assert(
      info.code === "provider_unavailable",
      `${name}: code ${info.code}`,
    );
    assert(info.failureClass === FailureTransient);
    assert(info.retryMode === RetryAutomatic);
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
