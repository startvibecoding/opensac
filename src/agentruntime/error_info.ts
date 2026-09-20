// Ported from internal/agentruntime/error_info.go.
//
// `ErrorInfo` is the durable, adapter-neutral description of an execution
// failure. It is written on the Run row and projected on terminal events, so
// adapters render the same failure category instead of guessing one from an
// English provider message.
//
// Deviation: Go's `errors.Is(err, context.Canceled)` / `context.DeadlineExceeded`
// map to `DOMException`/`Error` checks on `name === "AbortError"` /
// `"TimeoutError"` because Deno has no `context` package. `net.Error` has no
// direct equivalent, so the network branch relies on the message heuristics the
// Go branch already falls back to.

import {
  isContentRejectionError,
  isContextOverflowError,
  isRetryable,
} from "../provider/mod.ts";

/** Stable, adapter-neutral categories of a failed execution. */
export type FailureClass =
  | "validation"
  | "policy"
  | "transient"
  | "provider"
  | "tool"
  | "transport"
  | "canceled"
  | "incomplete"
  | "persistence"
  | "internal";

export const FailureValidation: FailureClass = "validation";
export const FailurePolicy: FailureClass = "policy";
export const FailureTransient: FailureClass = "transient";
export const FailureProvider: FailureClass = "provider";
export const FailureTool: FailureClass = "tool";
export const FailureTransport: FailureClass = "transport";
export const FailureCancelled: FailureClass = "canceled";
export const FailureIncomplete: FailureClass = "incomplete";
export const FailurePersistence: FailureClass = "persistence";
export const FailureInternal: FailureClass = "internal";

/** Indicates where a failure or retry occurred. */
export type RunPhase =
  | "admission"
  | "model"
  | "context"
  | "tool"
  | "approval"
  | "persistence"
  | "transport"
  | "terminalization";

export const PhaseAdmission: RunPhase = "admission";
export const PhaseModel: RunPhase = "model";
export const PhaseContext: RunPhase = "context";
export const PhaseTool: RunPhase = "tool";
export const PhaseApproval: RunPhase = "approval";
export const PhasePersistence: RunPhase = "persistence";
export const PhaseTransport: RunPhase = "transport";
export const PhaseTerminalization: RunPhase = "terminalization";

/**
 * States who may make progress after a failure. Automatic retry is owned by
 * Agent Core/Runtime; adapters only project its progress. Reconcile means the
 * caller must first discover whether a previous submission exists.
 */
export type RetryMode =
  | "none"
  | "automatic"
  | "reconcile"
  | "user"
  | "decision_required";

export const RetryNone: RetryMode = "none";
export const RetryAutomatic: RetryMode = "automatic";
export const RetryReconcile: RetryMode = "reconcile";
export const RetryUser: RetryMode = "user";
export const RetryDecisionRequired: RetryMode = "decision_required";

/**
 * Deliberately conservative. A runtime must not replay an execution with
 * unknown or mutating side effects without an explicit policy decision.
 */
export type SideEffectState = "none" | "read_only" | "mutating" | "unknown";

export const SideEffectNone: SideEffectState = "none";
export const SideEffectReadOnly: SideEffectState = "read_only";
export const SideEffectMutating: SideEffectState = "mutating";
export const SideEffectUnknown: SideEffectState = "unknown";

/**
 * The durable, adapter-neutral description of an execution failure. `message`
 * is the user-facing description and `detail` preserves the provider diagnostic
 * that caused it. `detail` is bounded and redacted before persistence so
 * failures remain useful without turning session history into a credentials
 * sink.
 */
export interface ErrorInfo {
  code?: string;
  type?: string;
  failureClass?: FailureClass;
  phase?: RunPhase;
  messageKey?: string;
  message?: string;
  detail?: string;
  retryMode?: RetryMode;
  retryable?: boolean;
  retryAfterMs?: number;
  attempt?: number;
  maxAttempts?: number;
  sideEffectState?: SideEffectState;
  partialOutput?: boolean;
  runId?: string;
  intentId?: string;
  requestId?: string;
}

/**
 * A non-terminal progress record. It is persisted as a run event so
 * reconnecting adapters can render the same automatic retry state.
 */
export interface RetryInfo {
  attempt?: number;
  maxAttempts?: number;
  phase?: RunPhase;
  reasonCode?: string;
  retryAfterMs?: number;
  continue?: boolean;
  messageKey?: string;
  message?: string;
}

/**
 * Adds execution facts that cannot be derived from an error value alone. The
 * defaults are intentionally safe for callers that have not observed tools or
 * output yet.
 */
export interface ErrorClassificationOptions {
  code?: string;
  type?: string;
  phase?: RunPhase;
  message?: string;
  detail?: string;
  messageKey?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  attempt?: number;
  maxAttempts?: number;
  sideEffectState?: SideEffectState;
  partialOutput?: boolean;
  runId?: string;
  intentId?: string;
  requestId?: string;
}

/**
 * Converts a raw failure into the shared durable contract. It intentionally has
 * no adapter/UI dependencies, and only marks automatic retries safe before
 * output or side effects exist.
 */
export function classifyError(
  err: unknown,
  opts: ErrorClassificationOptions = {},
): ErrorInfo {
  const info: ErrorInfo = {
    code: trim(opts.code),
    type: trim(opts.type),
    phase: opts.phase,
    messageKey: trim(opts.messageKey),
    message: safeMessage(err, opts.message),
    detail: diagnosticMessage(err, opts.detail),
    retryAfterMs: opts.retryAfterMs,
    attempt: opts.attempt,
    maxAttempts: opts.maxAttempts,
    sideEffectState: opts.sideEffectState,
    partialOutput: opts.partialOutput,
    runId: opts.runId,
    intentId: opts.intentId,
    requestId: opts.requestId,
  };
  if (!info.sideEffectState) info.sideEffectState = SideEffectNone;
  if (!info.phase) info.phase = PhaseModel;

  if (isAbortError(err)) {
    return applyErrorDefaults(
      info,
      "run_cancelled",
      "canceled",
      FailureCancelled,
      RetryUser,
      false,
      "run.error.cancelled",
    );
  }
  if (isTimeoutError(err)) {
    return applyErrorDefaults(
      info,
      "run_timed_out",
      "timeout_error",
      FailureCancelled,
      retryModeForSafety(info),
      false,
      "run.error.timedOut",
    );
  }
  if (isContextOverflowError(err)) {
    info.phase = PhaseContext;
    return applyErrorDefaults(
      info,
      "context_overflow",
      "context_error",
      FailureProvider,
      retryModeForSafety(info),
      false,
      "run.error.contextOverflow",
    );
  }
  if (isContentRejectionError(err)) {
    // A permanent content-policy refusal. The Runtime strips the offending
    // content before reaching this classification; when it still surfaces, the
    // user must change the content (or accept that it cannot be sent).
    return applyErrorDefaults(
      info,
      "content_rejected",
      "content_error",
      FailurePolicy,
      RetryUser,
      false,
      "run.error.contentRejected",
    );
  }
  if (isRetryable(err, opts.httpStatus ?? 0)) {
    const [code, key] = retryableErrorCode(err, opts.httpStatus ?? 0);
    return applyErrorDefaults(
      info,
      code,
      "provider_error",
      FailureTransient,
      retryModeForSafety(info),
      true,
      key,
    );
  }

  if (!info.code) info.code = "run_failed";
  if (!info.type) info.type = "server_error";
  if (!info.messageKey) info.messageKey = "run.error.failed";
  if (!info.retryMode) info.retryMode = retryModeForSafety(info);
  if (info.retryMode === RetryAutomatic) info.retryMode = RetryUser;
  info.retryable = info.retryMode === RetryUser ||
    info.retryMode === RetryDecisionRequired;
  if (!info.failureClass) info.failureClass = FailureInternal;
  return info;
}

export function applyErrorDefaults(
  info: ErrorInfo,
  code: string,
  typ: string,
  cls: FailureClass,
  mode: RetryMode,
  retryable: boolean,
  key: string,
): ErrorInfo {
  if (!info.code) info.code = code;
  if (!info.type) info.type = typ;
  info.failureClass = cls;
  if (!info.messageKey) info.messageKey = key;
  info.retryMode = mode;
  info.retryable = retryable || mode === RetryAutomatic || mode === RetryUser ||
    mode === RetryDecisionRequired;
  return info;
}

export function retryModeForSafety(info: ErrorInfo): RetryMode {
  if (
    info.partialOutput === true ||
    info.sideEffectState === SideEffectMutating ||
    info.sideEffectState === SideEffectUnknown
  ) {
    return RetryDecisionRequired;
  }
  return RetryAutomatic;
}

function retryableErrorCode(
  err: unknown,
  status: number,
): [string, string] {
  if (status === 429 || containsError(err, "429", "rate limit", "rate_limit")) {
    return ["rate_limited", "run.error.rateLimited"];
  }
  if (
    status >= 500 || containsStatus(err, 500, 599) ||
    containsError(err, "overloaded", "server_error")
  ) {
    return ["provider_unavailable", "run.error.providerUnavailable"];
  }
  if (
    (status >= 400 && status < 500) || containsStatus(err, 400, 499)
  ) {
    return ["provider_request_failed", "run.error.providerRequestFailed"];
  }
  if (containsError(err, "connection", "dns", "eof")) {
    return ["network_unavailable", "run.error.networkUnavailable"];
  }
  if (containsError(err, "timeout", "deadline")) {
    return ["provider_timeout", "run.error.providerTimeout"];
  }
  return ["provider_interrupted", "run.error.providerInterrupted"];
}

function containsStatus(err: unknown, min: number, max: number): boolean {
  if (err === null || err === undefined) return false;
  const message = errorText(err).toLowerCase();
  for (let status = min; status <= max; status++) {
    const code = `${status}`;
    if (
      message.includes(`http ${code}`) ||
      message.includes(`api error ${code}`) ||
      message.includes(`status ${code}`)
    ) {
      return true;
    }
  }
  return false;
}

function containsError(err: unknown, ...parts: string[]): boolean {
  if (err === null || err === undefined) return false;
  const message = errorText(err).toLowerCase();
  for (const part of parts) {
    if (message.includes(part.toLowerCase())) return true;
  }
  return false;
}

function safeMessage(err: unknown, override?: string): string {
  const message = trim(override);
  if (message !== "") return diagnosticMessage(undefined, message);
  if (err === null || err === undefined) {
    return "The run could not be completed.";
  }
  // Raw provider errors can include provider-specific details. The adapters
  // should localize MessageKey first; this fallback stays intentionally broad.
  if (isAbortError(err)) return "The run was cancelled.";
  if (isTimeoutError(err)) return "The run timed out.";
  const diagnostic = diagnosticMessage(err, "");
  if (diagnostic !== "") return diagnostic;
  return "The run could not be completed.";
}

const maxDiagnosticLength = 4096;

const sensitiveDiagnosticPattern =
  /(api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|password|secret)\s*([:=])\s*([^\s,;]+)/gi;

/**
 * Returns the actionable part of a provider error while bounding and redacting
 * it before it enters durable run/session records. Provider responses are not
 * trusted to omit credentials or unbounded bodies.
 */
export function diagnosticMessage(
  err: unknown,
  override?: string,
): string {
  let diagnostic = trim(override);
  if (diagnostic === "" && err !== null && err !== undefined) {
    diagnostic = errorText(err).trim();
  }
  if (diagnostic === "") return "";
  diagnostic = diagnostic.replace(
    sensitiveDiagnosticPattern,
    "$1$2[redacted]",
  );
  if (diagnostic.length > maxDiagnosticLength) {
    diagnostic = diagnostic.slice(0, maxDiagnosticLength - 3) + "...";
  }
  return diagnostic;
}

/**
 * Returns a truthful, concise message for adapters. It keeps an explicit
 * category message when present, but never drops the provider detail that
 * explains what actually failed.
 */
export function displayErrorMessage(info: ErrorInfo): string {
  const message = trim(info.message);
  const detail = trim(info.detail);
  if (detail === "" || message.toLowerCase() === detail.toLowerCase()) {
    if (message !== "") return message;
    return detail;
  }
  if (message === "") return detail;
  return `${message}: ${detail}`;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return false;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}
