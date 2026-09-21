// Ported from internal/serve/openaiapi/run_api.go — the durable Run inspection,
// cancellation, and linked-retry API.
//
// Paths: GET /api/runs/{runID}, POST /api/runs/{runID}/cancel|retry.
//
// HandleRetryRun creates one new linked attempt from a terminal durable Run.
// The stored intent is authoritative; clients cannot replace its prompt or
// execution policy through this endpoint.
//
// Deviations: net/http's ResponseWriter is the standard Request/Response pair;
// handlers return the Response instead of writing it. Go injects the retry
// identity by re-entering HandleSubmitRun with a cloned request whose context
// carries retryRunContext; Request objects are immutable here, so the retry
// identity travels through the explicit SubmitRunOptions bag that
// handleSubmitRun already accepts. `errors.Is` sentinels
// (ErrSessionNotFound, ErrIdempotencyRunMissing, ErrIdempotencyKeyConflict)
// are matched by identity. `context.Canceled`/`context.DeadlineExceeded`
// fallbacks map to the AbortError/TimeoutError sentinels the shared
// classification recognizes.
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  FailurePersistence,
  FailurePolicy,
  FailureTransport,
  FailureValidation,
  PhaseAdmission,
  PhaseModel,
  PhasePersistence,
  RetryDecisionRequired,
  type RetryInfo,
  RetryNone,
  RetryReconcile,
  RetryUser,
  SideEffectUnknown,
} from "../../agentruntime/error_info.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import type { SessionRun } from "../../session/run_store.ts";
import { latestSessionRunForIntent } from "../../session/run_store.ts";
import type { ExecutionIntent } from "../../session/execution_intent.ts";
import { latestSessionRunEventSeq } from "../../session/session_events.ts";
import { writeErrorInfo, writeJSON } from "./auth.ts";
import {
  ErrIdempotencyKeyConflict,
  ErrIdempotencyRunMissing,
  findIdempotentRun,
  retryIdempotencyScope,
} from "./events.ts";
import { getRun } from "./run_manager.ts";
import {
  handleSubmitRun,
  type submitRunRequest,
} from "./handler_run_submit.ts";
import { requestSessionStop } from "./session_stop.ts";
import {
  SessionStopAccepted,
  SessionStopNoActiveRun,
  SessionStopOwnedElsewhere,
  SessionStopRecoveryStarted,
  SessionStopRemoteAccepted,
  SessionStopRemoteUnsupported,
  SessionStopReserved,
  SessionStopTargetChanged,
} from "../../agentruntime/execution_stop.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import type { Server } from "./server.ts";

const GET = "GET";
const POST = "POST";

/**
 * handleRunAPI exposes durable run inspection, cancellation, and linked retry.
 * Paths: GET /api/runs/{runID}, POST /api/runs/{runID}/cancel|retry
 */
export async function handleRunAPI(
  server: Server,
  request: Request,
): Promise<Response> {
  // Parse path segments: /api/runs/<runID>[/cancel]
  const pathname = new URL(request.url).pathname;
  let path = pathname.startsWith("/api/runs/")
    ? pathname.slice("/api/runs/".length)
    : pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length < 1) {
    return writeErrorInfo(400, {
      code: "run_id_required",
      type: "invalid_request_error",
      failureClass: FailureValidation,
      phase: PhaseAdmission,
      messageKey: "run.error.idRequired",
      message: "A run ID is required.",
    });
  }
  const runId = segments[0];
  const isCancel = segments.length === 2 && segments[1] === "cancel";
  const isRetry = segments.length === 2 && segments[1] === "retry";

  if (request.method === GET) {
    if (isCancel || isRetry) {
      return new Response(null, { status: 405 });
    }
    let run: SessionRun;
    try {
      run = getRun(server, runId);
    } catch (err) {
      if (err === ErrSessionNotFound) {
        return writeErrorInfo(404, runNotFoundError(runId));
      }
      return writeErrorInfo(
        500,
        runAPIStorageError(
          "run_lookup_failed",
          "run.error.lookupFailed",
          "The run status could not be loaded.",
          runId,
        ),
      );
    }
    let view: runAPIView;
    try {
      view = runAPIResponse(server.sessionDir(), run);
    } catch {
      return writeErrorInfo(
        500,
        runAPIStorageError(
          "run_event_cursor_unavailable",
          "run.error.cursorUnavailable",
          "The run event position could not be loaded.",
          runId,
        ),
      );
    }
    return writeJSON(200, view);
  }
  if (request.method === POST && isCancel) {
    let run: SessionRun;
    try {
      run = getRun(server, runId);
    } catch (err) {
      if (err === ErrSessionNotFound) {
        return writeErrorInfo(404, runNotFoundError(runId));
      }
      return writeErrorInfo(
        500,
        runAPIStorageError(
          "run_lookup_failed",
          "run.error.lookupFailed",
          "The run status could not be loaded.",
          runId,
        ),
      );
    }
    const { result, err } = await requestSessionStop(
      server,
      run.sessionId,
      runId,
    );
    if (err) {
      return writeErrorInfo(
        500,
        runAPIStorageError(
          "run_cancellation_failed",
          "run.error.cancellationFailed",
          "The run could not be cancelled.",
          runId,
        ),
      );
    }
    switch (result.code) {
      case SessionStopAccepted:
      case SessionStopRemoteAccepted:
      case SessionStopRecoveryStarted:
        // Continue with the canonical Run projection below.
        break;
      case SessionStopOwnedElsewhere:
        return writeErrorInfo(409, {
          code: result.code,
          type: "conflict_error",
          failureClass: FailurePolicy,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionRunOwnedElsewhere",
          message: "The run is executing in another process.",
          retryMode: RetryUser,
          retryable: true,
          runId,
        });
      case SessionStopTargetChanged:
        return writeErrorInfo(409, {
          code: result.code,
          type: "conflict_error",
          failureClass: FailurePolicy,
          phase: PhaseAdmission,
          messageKey: "run.error.targetChanged",
          message: "The run is no longer the active run for this session.",
          retryMode: RetryUser,
          retryable: true,
          runId,
        });
      case SessionStopNoActiveRun:
        return writeErrorInfo(404, runNotFoundError(runId));
      case SessionStopReserved:
      case SessionStopRemoteUnsupported:
        return writeErrorInfo(409, {
          code: result.code,
          type: "conflict_error",
          failureClass: FailurePolicy,
          phase: PhaseAdmission,
          messageKey: "run.error.cancellationRejected",
          message:
            "The run cannot be cancelled from the current execution state.",
          retryMode: RetryUser,
          retryable: true,
          runId,
        });
      default:
        return writeErrorInfo(
          503,
          runAPIStorageError(
            "run_cancellation_unavailable",
            "run.error.cancellationFailed",
            "The run cancellation state is temporarily unavailable.",
            runId,
          ),
        );
    }
    let updated: SessionRun;
    try {
      updated = getRun(server, runId);
    } catch (err) {
      if (err === ErrSessionNotFound) {
        return writeErrorInfo(404, runNotFoundError(runId));
      }
      return writeErrorInfo(
        500,
        runAPIStorageError(
          "run_lookup_failed",
          "run.error.lookupFailed",
          "The run status could not be loaded.",
          runId,
        ),
      );
    }
    let view: runAPIView;
    try {
      view = runAPIResponse(server.sessionDir(), updated);
    } catch {
      return writeErrorInfo(
        500,
        runAPIStorageError(
          "run_event_cursor_unavailable",
          "run.error.cursorUnavailable",
          "The run event position could not be loaded.",
          runId,
        ),
      );
    }
    return writeJSON(202, view);
  }
  if (request.method === POST && isRetry) {
    return handleRetryRun(server, request, runId);
  }
  return new Response(null, { status: 405 });
}

export interface runAPIView {
  id: string;
  sessionId: string;
  intentId?: string;
  retryOf?: string;
  attempt: number;
  workDir?: string;
  source?: string;
  model?: string;
  mode?: string;
  status: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
  errorInfo?: ErrorInfo;
  progress?: RetryInfo;
  usage?: unknown;
  contextUsage?: unknown;
  lastEventSeq?: number;
}

function rfc3339Nano(t: Date): string {
  // Go formats timestamps with RFC3339Nano (nanosecond precision). The port
  // persists ISO-8601 strings; project through the shared timestamp format.
  return t.toISOString();
}

export function runAPIResponse(
  sessionDir: string,
  run: SessionRun | null,
): runAPIView {
  if (run === null) {
    return {} as runAPIView;
  }
  const view: runAPIView = {
    id: run.id,
    sessionId: run.sessionId,
    intentId: run.intentId,
    retryOf: run.retryOf,
    attempt: run.attempt,
    workDir: run.workDir,
    source: run.source,
    model: run.model,
    mode: run.mode,
    status: run.status,
    startedAt: rfc3339Nano(run.startedAt),
    updatedAt: rfc3339Nano(run.updatedAt),
    usage: run.usage,
    contextUsage: run.contextUsage,
  };
  if (view.attempt <= 0) view.attempt = 1;
  if (run.finishedAt !== null) {
    view.finishedAt = rfc3339Nano(run.finishedAt);
  }
  const info = decodeErrorInfo(run.errorInfo);
  if (info !== null && info.code !== "") {
    view.errorInfo = info;
    view.error = displayErrorMessage(info);
  } else if (run.error !== "") {
    const fallback = retryErrorInfo(run);
    view.errorInfo = fallback;
    view.error = displayErrorMessage(fallback);
  }
  const progress = decodeRetryInfo(run.progress);
  if (progress !== null && (progress.attempt ?? 0) > 0) {
    view.progress = progress;
  }
  view.lastEventSeq = latestSessionRunEventSeq(sessionDir, run.id);
  return view;
}

function decodeErrorInfo(raw: unknown): ErrorInfo | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return decodeErrorInfo(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  return raw as ErrorInfo;
}

function decodeRetryInfo(raw: unknown): RetryInfo | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return decodeRetryInfo(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  return raw as RetryInfo;
}

interface retryRunRequest {
  confirmSideEffects?: boolean;
}

/**
 * handleRetryRun creates one new linked attempt from a terminal durable Run.
 * The stored intent is authoritative; clients cannot replace its prompt or
 * execution policy through this endpoint.
 */
export async function handleRetryRun(
  server: Server,
  request: Request,
  runId: string,
): Promise<Response> {
  if (!server || !server.settings) {
    return writeErrorInfo(503, {
      code: "server_unavailable",
      type: "server_error",
      failureClass: FailurePersistence,
      phase: PhaseAdmission,
      messageKey: "run.error.serverUnavailable",
      message: "The run service is not ready.",
      retryMode: RetryReconcile,
      retryable: true,
    });
  }
  const key = (request.headers.get("Idempotency-Key") ?? "").trim();
  if (key === "") {
    return writeErrorInfo(400, {
      code: "idempotency_key_required",
      type: "invalid_request_error",
      failureClass: FailureValidation,
      phase: PhaseAdmission,
      messageKey: "run.error.idempotencyKeyRequired",
      message: "An idempotency key is required to retry a run.",
    });
  }
  let req: retryRunRequest = {};
  const bodyText = await request.text();
  if (bodyText !== "") {
    try {
      req = JSON.parse(bodyText) as retryRunRequest;
    } catch {
      return writeErrorInfo(400, {
        code: "invalid_retry_request",
        type: "invalid_request_error",
        failureClass: FailureValidation,
        phase: PhaseAdmission,
        messageKey: "run.error.invalidRetryRequest",
        message: "The retry request is invalid.",
      });
    }
  }
  let run: SessionRun;
  try {
    run = getRun(server, runId);
  } catch (err) {
    if (err === ErrSessionNotFound) {
      return writeErrorInfo(404, runNotFoundError(runId));
    }
    return writeErrorInfo(
      500,
      runAPIStorageError(
        "run_lookup_failed",
        "run.error.lookupFailed",
        "The run status could not be loaded.",
        runId,
      ),
    );
  }
  if (!retryableRunStatus(run.status)) {
    return writeErrorInfo(409, {
      code: "run_not_retryable",
      type: "conflict_error",
      failureClass: FailurePolicy,
      phase: PhaseAdmission,
      messageKey: "run.error.notRetryable",
      message: "Only a finished unsuccessful run can be retried.",
      runId: run.id,
      intentId: run.intentId,
    });
  }
  if (run.intentId === "") {
    return writeErrorInfo(409, {
      code: "retry_unavailable",
      type: "conflict_error",
      failureClass: FailurePersistence,
      phase: PhaseAdmission,
      messageKey: "run.error.retryUnavailable",
      message: "This older run does not have a recoverable request.",
      runId: run.id,
    });
  }
  // Repeated retry commands must reconcile their scoped idempotency key before
  // the stale-attempt guard. Once the first retry exists, latest will point at
  // that newer Run; returning it is correct, while creating another attempt is
  // not.
  let existing: SessionRun | null;
  try {
    existing = findIdempotentRun(
      server.sessionDir(),
      run.sessionId,
      key,
      "",
      retryIdempotencyScope(run.intentId, run.id),
    );
  } catch (err) {
    if (err === ErrIdempotencyRunMissing) {
      return writeErrorInfo(503, {
        code: "submission_unknown",
        type: "transport_error",
        failureClass: FailureTransport,
        phase: PhaseAdmission,
        messageKey: "run.error.submissionUnknown",
        message:
          "The retry was accepted but its Run status is temporarily unavailable.",
        retryMode: RetryReconcile,
        retryable: true,
        runId: run.id,
        intentId: run.intentId,
      });
    }
    if (err === ErrIdempotencyKeyConflict) {
      return writeErrorInfo(409, {
        code: "idempotency_conflict",
        type: "idempotency_conflict",
        failureClass: FailurePolicy,
        phase: PhaseAdmission,
        messageKey: "run.error.idempotencyConflict",
        message: "The idempotency key conflicts with an existing retry.",
        retryMode: RetryNone,
        runId: run.id,
        intentId: run.intentId,
      });
    }
    return writeErrorInfo(
      500,
      runAPIStorageError(
        "run_retry_lookup_failed",
        "run.error.lookupFailed",
        "The retry history could not be loaded.",
        run.id,
      ),
    );
  }
  if (existing !== null) {
    return writeJSON(202, {
      sessionId: existing.sessionId,
      runId: existing.id,
      status: existing.status,
      intentId: existing.intentId,
      attempt: existing.attempt,
      idempotent: true,
    });
  }
  let latest: SessionRun | null;
  try {
    latest = latestSessionRunForIntent(
      server.sessionDir(),
      run.sessionId,
      run.intentId,
    );
  } catch {
    return writeErrorInfo(
      500,
      runAPIStorageError(
        "run_retry_lookup_failed",
        "run.error.lookupFailed",
        "The retry history could not be loaded.",
        run.id,
      ),
    );
  }
  if (latest !== null && latest.id !== run.id) {
    return writeErrorInfo(409, {
      code: "run_retry_stale",
      type: "conflict_error",
      failureClass: FailurePolicy,
      phase: PhaseAdmission,
      messageKey: "run.error.retryStale",
      message: "A newer attempt already exists for this request.",
      retryMode: RetryUser,
      retryable: retryableRunStatus(latest.status),
      runId: run.id,
      intentId: run.intentId,
    });
  }
  const info = retryErrorInfo(run);
  if (!info.retryable) {
    return writeErrorInfo(409, info);
  }
  if (info.retryMode === RetryDecisionRequired && !req.confirmSideEffects) {
    const confirmation: ErrorInfo = { ...info };
    confirmation.code = "retry_confirmation_required";
    confirmation.type = "conflict_error";
    confirmation.messageKey = "run.error.retryConfirmationRequired";
    confirmation.message =
      "This run may have changed external state. Confirm before retrying.";
    confirmation.retryable = true;
    return writeErrorInfo(409, confirmation);
  }
  const intentStore = new RunStore(server.sessionDir());
  let intent: ExecutionIntent | null;
  try {
    intent = intentStore.getIntent(run.intentId);
  } catch {
    intent = null;
  }
  if (intent === null || intent.sessionId !== run.sessionId) {
    return writeErrorInfo(409, {
      code: "retry_unavailable",
      type: "conflict_error",
      failureClass: FailurePersistence,
      phase: PhaseAdmission,
      messageKey: "run.error.retryUnavailable",
      message: "The original request is no longer available for retry.",
      runId: run.id,
      intentId: run.intentId,
    });
  }
  let stored: submitRunRequest;
  try {
    stored = decodeSubmitRunRequest(intent.request);
  } catch {
    return writeErrorInfo(409, {
      code: "retry_unavailable",
      type: "conflict_error",
      failureClass: FailurePersistence,
      phase: PhaseAdmission,
      messageKey: "run.error.retryUnavailable",
      message: "The original request could not be restored.",
      runId: run.id,
      intentId: run.intentId,
    });
  }

  const payload = JSON.stringify(stored);
  // Re-enter the normal submit handler with a private retry context. This is
  // deliberately a linked admission, not a terminal-to-active transition.
  const retryURL = new URL(request.url);
  retryURL.pathname = "/api/sessions/" + run.sessionId + "/runs";
  retryURL.search = "";
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return handleSubmitRun(
    server,
    new Request(retryURL, {
      method: POST,
      body: payload,
      headers,
    }),
    {
      retry: {
        intent,
        retryOf: run.id,
        minimumAttempt: Math.max(run.attempt + 1, 2),
      },
    },
  );
}

function decodeSubmitRunRequest(raw: unknown): submitRunRequest {
  const value = (typeof raw === "string" ? JSON.parse(raw) : raw) ?? null;
  if (value === null || typeof value !== "object") {
    throw new Error("retry intent request is not an object");
  }
  return value as submitRunRequest;
}

export function runNotFoundError(runId: string): ErrorInfo {
  return {
    code: "run_not_found",
    type: "not_found",
    failureClass: FailureValidation,
    phase: PhaseAdmission,
    messageKey: "run.error.notFound",
    message: "The requested run was not found.",
    retryMode: RetryNone,
    runId,
  };
}

export function runAPIStorageError(
  code: string,
  messageKey: string,
  message: string,
  runId: string,
): ErrorInfo {
  return {
    code,
    type: "server_error",
    failureClass: FailurePersistence,
    phase: PhasePersistence,
    messageKey,
    message,
    retryMode: RetryReconcile,
    retryable: true,
    runId,
  };
}

export function retryableRunStatus(status: string): boolean {
  switch ((status ?? "").trim().toLowerCase()) {
    case "failed":
    case "incomplete":
    case "timed_out":
    case "expired":
    case "cancelled":
    case "canceled":
      return true;
    default:
      return false;
  }
}

export function retryErrorInfo(run: SessionRun | null): ErrorInfo {
  if (run === null) {
    return {
      code: "retry_unavailable",
      type: "conflict_error",
      retryMode: RetryNone,
    };
  }
  const stored = decodeErrorInfo(run.errorInfo);
  if (stored !== null && stored.code !== "") {
    if (!stored.runId) stored.runId = run.id;
    if (!stored.intentId) stored.intentId = run.intentId;
    return stored;
  }
  let fallbackErr: unknown;
  switch ((run.status ?? "").trim().toLowerCase()) {
    case "cancelled":
    case "canceled":
      fallbackErr = new DOMException("context canceled", "AbortError");
      break;
    case "timed_out":
      fallbackErr = new DOMException(
        "context deadline exceeded",
        "TimeoutError",
      );
      break;
    default:
      fallbackErr = new Error(run.error);
  }
  const info = classifyError(fallbackErr, {
    phase: PhaseModel,
    runId: run.id,
    intentId: run.intentId,
    sideEffectState: SideEffectUnknown,
  });
  return info;
}
