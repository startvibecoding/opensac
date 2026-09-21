// Ported from internal/serve/openaiapi/handler_run_submit.go — the full submit
// half: HandleSubmitRun (POST /api/sessions/{id}/runs), the retry/idempotency
// halves, executeBackgroundRun and its terminal projections, the title
// generator, the attachment-ingress helpers, and sessionToolOptionsFromNames.
// This module absorbs run_submit_policy.ts (the shared preflight cluster:
// submitErrorInfo, writeSubmitError, executionAdmissionError,
// marshalRunPolicySnapshot) which previously lived here under a placeholder
// name because the input_contract_guard reserves `handler_run_submit.ts` for
// the submit half.
//
// Deviations: net/http's ResponseWriter is the standard Request/Response pair;
// the response is returned instead of written. Go injects the retry identity
// and the force-agent-loop flag through the request context (HandleRunAPI
// re-enters this handler); the port passes them through an explicit options bag
// because Request objects are immutable. The remaining not-yet-ported
// collaborator (the Responses background execute half) stays a Server hook
// filled by its owning slice; while the hook is unset the submit path skips
// that step. The expert busy sentinel is owned by expert_api.ts and matched by
// error name across the hook boundary. Go's `go s.executeBackgroundRun(...)`
// maps to an unawaited async call; ownership of the session mutex, the runtime
// admission release, and the deferred finalizer transfers to that task exactly
// like Go's goroutine.

import { newAgentAdapter } from "../../agent/bridge.ts";
import type { Agent } from "../../agent/agent.ts";
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  type FailureClass,
  FailurePersistence,
  FailurePolicy,
  FailureTransient,
  PhaseAdmission,
  PhaseModel,
  type RetryMode,
  RetryNone,
  RetryReconcile,
  RetryUser,
  type RunPhase as Phase,
} from "../../agentruntime/error_info.ts";
import { acquireExecutionAdmission } from "../../agentruntime/execution_admission.ts";
import {
  inspectSessionExecution,
  SessionExecutionDetached,
  SessionExecutionExternal,
  SessionExecutionInconsistent,
  SessionExecutionOrphaned,
  SessionExecutionRecoveryFailed,
  SessionExecutionReserved,
  SessionExecutionUnknown,
} from "../../agentruntime/execution.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import type { RunEvent } from "../../agentruntime/run_event.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import { SourceWebUI } from "../../agentruntime/source.ts";
import {
  AttachmentFile,
  AttachmentImage,
  type AttachmentKind,
} from "../../agentruntime/attachment.ts";
import {
  type InputIngress,
  type PreparedInput,
  resourceIds,
  type RunInput,
} from "../../agentruntime/input_materializer.ts";
import { Generator } from "../../ai/title/title.ts";
import { latestSessionTitle } from "../../session/projects.ts";
import { runUserEntryID } from "../../session/mod.ts";
import {
  nextSessionRunAttempt,
  type SessionRun,
} from "../../session/run_store.ts";
import type { ExecutionIntent } from "../../session/execution_intent.ts";
import {
  createWithOptions,
  parseQualifiedModel,
} from "../../provider/factory/factory.ts";
import type { Message, Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { writeErrorInfo, writeJSON } from "./auth.ts";
import { cloneModel, sameWorkDir } from "./chat_support.ts";
import {
  capabilitySnapshotFromSession,
  capabilitySnapshotValues,
  ErrIdempotencyKeyConflict,
  ErrIdempotencyRunMissing,
  findIdempotentRun,
  idempotencyKeyFingerprint,
  newExecutionIntentID,
  newRunID,
  persistSessionCapabilitiesWithEvents,
  rawEventData,
  recordSessionRunEvent,
  requestFingerprint,
  retryIdempotencyScope,
  runEventTypeForStatus,
  usageEventData,
  withContextUsageEventData,
} from "./events.ts";
import {
  newRunExecutor,
  type RunExecutor,
  type RunResult,
} from "./run_executor.ts";
import { finalizeRun } from "./run_manager.ts";
import { webUIRunState } from "./runtime_run_state.ts";
import { runtimeRunEventSink } from "./runtime_run_events.ts";
import {
  applySessionToolOptions,
  esmSteeringMessages,
  getOrCreateSession,
  settingsForSession,
} from "./handler_chat_session.ts";
import { setActiveSkillsLocked } from "./skillhub_session.ts";
import {
  resolveSessionPolicy,
  validateCapabilityMode,
} from "./session_capabilities.ts";
import { responsesBackgroundEnabled } from "./background_run_coordinator.ts";
import type { Server } from "./server.ts";
import { APISession, PoolFullError } from "./session_mgr.ts";
import type { SessionToolOptions } from "./types.ts";
import { getWorkDir, validateWorkDir } from "./config.ts";

// ---------------------------------------------------------------------------
// Shared preflight cluster (absorbed from run_submit_policy.ts)
// ---------------------------------------------------------------------------

/** submitRunRequest is the WebUI run-submission transport envelope. */
export interface submitRunRequest {
  message: string;
  provider?: string;
  model: string;
  mode: string;
  /**
   * ExpertID is an optional identity choice made with a new WebUI chat. The
   * binding itself stays Runtime-owned and is applied only after the request
   * has resolved the session's authoritative work directory.
   */
  expertId?: string;
  tools?: string[];
  skills?: string[];
  /** legacy image-only WebUI payload */
  images?: string[];
  attachments?: submitRunAttachmentRequest[];
  transcript: boolean;
  workDir: string;
}

/**
 * submitRunAttachmentRequest is a thin WebUI/API transport envelope. dataUrl
 * is decoded only into an InputIngress; it must never be translated by
 * this adapter into provider content or persisted in the durable Run request.
 */
export interface submitRunAttachmentRequest {
  attachmentId?: string;
  kind: string;
  filename?: string;
  mediaType?: string;
  dataUrl?: string;
  size?: number;
}

/**
 * submitErrorInfo projects a preflight failure into the shared safe error
 * contract. The raw error is used only for classification/logical matching;
 * the explicit message is what crosses the HTTP boundary.
 */
export function submitErrorInfo(
  err: unknown,
  status: number,
  code: string,
  errType: string,
  failureClass: FailureClass,
  phase: Phase,
  messageKey: string,
  message: string,
  retryMode: RetryMode,
  retryable: boolean,
): ErrorInfo {
  const info = classifyError(toError(err), {
    code,
    type: errType,
    phase,
    messageKey,
    message,
    httpStatus: status,
  });
  // This is an adapter-facing preflight error with an explicit safe message.
  // Keep err available above for classification, but do not project its raw
  // parser/storage diagnostic through DisplayErrorMessage.
  info.detail = "";
  if (failureClass !== undefined && failureClass !== ("" as FailureClass)) {
    info.failureClass = failureClass;
  }
  if (retryMode !== undefined && retryMode !== ("" as RetryMode)) {
    info.retryMode = retryMode;
  }
  info.retryable = retryable;
  return info;
}

/** writeSubmitError projects preflight failures through writeErrorInfo. */
export function writeSubmitError(
  status: number,
  err: unknown,
  code: string,
  errType: string,
  failureClass: FailureClass,
  phase: Phase,
  messageKey: string,
  message: string,
  retryMode: RetryMode,
  retryable: boolean,
): Response {
  const info = submitErrorInfo(
    err,
    status,
    code,
    errType,
    failureClass,
    phase,
    messageKey,
    message,
    retryMode,
    retryable,
  );
  return writeErrorInfo(status, info);
}

/**
 * executionAdmissionError projects an admission failure from a fresh
 * Runtime-owned snapshot. The local RunManager is intentionally not consulted:
 * it cannot identify a Run owned by another process.
 */
export function executionAdmissionError(
  server: Server,
  sessionId: string,
  admissionErr: unknown,
): { status: number; info: ErrorInfo } {
  const status = 409; // http.StatusConflict
  const snapshot = inspectSessionExecution(
    server.sessionDir(),
    sessionId,
  );
  let runId = "";
  if (snapshot.activeRun) runId = snapshot.activeRun.id;
  switch (snapshot.state) {
    case SessionExecutionExternal:
      return {
        status,
        info: {
          code: "session_run_owned_elsewhere",
          type: "conflict_error",
          failureClass: FailurePolicy,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionRunOwnedElsewhere",
          message: "The session is executing in another process.",
          retryMode: RetryUser,
          retryable: true,
          runId,
        },
      };
    case SessionExecutionReserved:
      return {
        status,
        info: {
          code: "session_reserved",
          type: "conflict_error",
          failureClass: FailurePolicy,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionReserved",
          message: "The session is reserved for another operation.",
          retryMode: RetryUser,
          retryable: true,
          runId,
        },
      };
    case SessionExecutionOrphaned:
      return {
        status,
        info: {
          code: "session_recovery_in_progress",
          type: "conflict_error",
          failureClass: FailureTransient,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionRecoveryInProgress",
          message: "The previous session run is being recovered.",
          retryMode: RetryReconcile,
          retryable: true,
          runId,
        },
      };
    case SessionExecutionRecoveryFailed:
      return {
        status: 503,
        info: {
          code: "session_recovery_failed",
          type: "server_error",
          failureClass: FailurePersistence,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionRecoveryFailed",
          message: "The previous session run could not be recovered yet.",
          retryMode: RetryReconcile,
          retryable: true,
          runId,
          attempt: snapshot.recoveryAttempt,
        },
      };
    case SessionExecutionInconsistent:
    case SessionExecutionUnknown:
      return {
        status: 503,
        info: {
          code: "session_execution_state_unavailable",
          type: "server_error",
          failureClass: FailurePersistence,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionExecutionStateUnavailable",
          message: "The session execution state is temporarily unavailable.",
          retryMode: RetryReconcile,
          retryable: true,
          runId,
        },
      };
    case SessionExecutionDetached:
      return {
        status,
        info: {
          code: "session_run_owned_elsewhere",
          type: "conflict_error",
          failureClass: FailurePolicy,
          phase: PhaseAdmission,
          messageKey: "run.error.sessionRunOwnedElsewhere",
          message: "The session has an active remote run.",
          retryMode: RetryUser,
          retryable: true,
          runId,
        },
      };
  }
  // Preserve the legacy code only when the fresh snapshot cannot explain the
  // admission error (for example, a race that resolved while inspecting).
  return {
    status,
    info: submitErrorInfo(
      admissionErr,
      status,
      "session_run_active",
      "session_run_active",
      FailurePolicy,
      PhaseAdmission,
      "run.error.sessionRunActive",
      "session already has an active run",
      RetryUser,
      true,
    ),
  };
}

/**
 * marshalRunPolicySnapshot freezes the resolved source/mode plus the session's
 * tool, skill, capability, sandbox, and run-policy facts into the durable
 * ExecutionIntent policy snapshot.
 */
export function marshalRunPolicySnapshot(
  server: Server | undefined,
  sess: APISession | undefined,
  req: submitRunRequest,
  source: string,
  mode: string,
): string {
  const activeSkills: string[] = [];
  if (sess) {
    for (const [name, enabled] of Object.entries(sess.activeSkills)) {
      if (enabled) activeSkills.push(name);
    }
  }
  activeSkills.sort();
  const requestedTools = [...(req.tools ?? [])];
  requestedTools.sort();
  let effectiveTools = [...requestedTools];
  if (sess?.registry) {
    effectiveTools = [];
    for (const definition of sess.registry.definitions()) {
      if (definition.name !== "") effectiveTools.push(definition.name);
    }
    effectiveTools.sort();
  }
  const snapshot: Record<string, unknown> = {
    source,
    provider: (req.provider ?? "").trim(),
    mode,
    workDir: sess ? sess.workDir : "",
    tools: requestedTools,
    effectiveTools,
    skills: activeSkills,
    capabilities: capabilitySnapshotValues(capabilitySnapshotFromSession(sess)),
    approvalPolicy: "runtime",
    questionPolicy: "runtime",
    runPolicy: {},
  };
  if (server?.cfg) {
    snapshot.sandbox = {
      enabled: server.cfg.sandbox?.enabled,
      level: server.cfg.sandbox?.level,
    };
    snapshot.runPolicy = {
      requestTimeoutSeconds: server.cfg.requestTimeoutSecs,
      backgroundRunMaxSeconds: server.cfg.backgroundRunMaxSecs,
    };
  } else {
    snapshot.sandbox = { enabled: false, level: "" };
  }
  return JSON.stringify(snapshot);
}

/**
 * sameRunPolicySnapshot compares a retry intent's frozen policy with the fresh
 * snapshot. Intents written before the full policy snapshot was introduced
 * only have source/mode; that migration bridge stays readable but requires an
 * exact match once the intent carries any expanded policy fact.
 */
export function sameRunPolicySnapshot(
  previous: unknown,
  current: unknown,
): boolean {
  // Go compared raw json.RawMessage; the port's intent fields arrive decoded
  // (and the fresh snapshot is a JSON string), so normalize both sides.
  const previousValue = decodePolicySnapshot(previous);
  const currentValue = decodePolicySnapshot(current);
  if (previousValue === undefined || currentValue === undefined) return false;
  if (
    isPlainObject(previousValue) && isPlainObject(currentValue) &&
    Object.keys(previousValue).length <= 2
  ) {
    for (const [key, value] of Object.entries(previousValue)) {
      if (!deepEqual(currentValue[key], value)) return false;
    }
    return true;
  }
  return deepEqual(previousValue, currentValue);
}

function decodePolicySnapshot(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Retry/idempotency halves
// ---------------------------------------------------------------------------

/**
 * retryRunContext is injected only by the run API after it validates a
 * terminal attempt. Re-entering this handler keeps retry admission on the
 * same runtime path as a first submission.
 */
export interface RetryRunContext {
  intent: ExecutionIntent;
  retryOf: string;
  minimumAttempt: number;
}

/**
 * SubmitRunOptions carries what Go passes through the request context: the
 * retry identity injected by the run API and the trusted in-process
 * force-agent-loop flag (it never crosses the HTTP boundary and does not
 * change the accepted request or execution policy recorded for the new Run).
 */
export interface SubmitRunOptions {
  retry?: RetryRunContext;
  forceAgentLoop?: boolean;
}

/** The busy sentinel is owned by expert_api.ts (matched by name). */
import { isSessionExpertMutationBusy } from "./expert_api.ts";
export {
  ErrSessionExpertMutationBusyName,
  isSessionExpertMutationBusy as errIsSessionExpertMutationBusy,
} from "./expert_api.ts";

function errIsSentinel(err: unknown, sentinel: Error): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current === sentinel) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HandleSubmitRun
// ---------------------------------------------------------------------------

/**
 * handleSubmitRun creates a background run for a session and returns
 * immediately. POST /api/sessions/{sessionID}/runs
 */
export async function handleSubmitRun(
  server: Server,
  request: Request,
  opts: SubmitRunOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    // Go writes the bare status code.
    return new Response(null, { status: 405 });
  }
  if (!server.pool) {
    return writeSubmitError(
      503,
      null,
      "server_not_ready",
      "server_error",
      "internal",
      PhaseAdmission,
      "run.error.serverNotReady",
      "API server not ready",
      RetryReconcile,
      true,
    );
  }

  // Extract session ID from path: /api/sessions/{sessionID}/runs
  const id = extractSessionIDFromPath(new URL(request.url).pathname, "/runs");
  if (id === "") {
    return writeSubmitError(
      400,
      null,
      "session_id_required",
      "invalid_request_error",
      "validation",
      PhaseAdmission,
      "run.error.sessionIDRequired",
      "session ID required",
      RetryNone,
      false,
    );
  }

  // Parse request body.
  const idempotencyKey = (request.headers.get("Idempotency-Key") ?? "").trim();
  if (idempotencyKey.length > 256) {
    return writeSubmitError(
      400,
      null,
      "idempotency_key_too_long",
      "invalid_request_error",
      "validation",
      PhaseAdmission,
      "run.error.idempotencyKeyTooLong",
      "Idempotency-Key is too long",
      RetryNone,
      false,
    );
  }
  let req: submitRunRequest;
  try {
    req = decodeSubmitRunRequest(await request.text());
  } catch (err) {
    return writeSubmitError(
      400,
      err,
      "invalid_json",
      "invalid_request_error",
      "validation",
      PhaseAdmission,
      "run.error.invalidJSON",
      "The request body is not valid JSON.",
      RetryNone,
      false,
    );
  }
  if (
    req.message.trim() === "" && (req.images?.length ?? 0) === 0 &&
    (req.attachments?.length ?? 0) === 0
  ) {
    return writeSubmitError(
      400,
      null,
      "message_required",
      "invalid_request_error",
      "validation",
      PhaseAdmission,
      "run.error.messageRequired",
      "message is required",
      RetryNone,
      false,
    );
  }
  // A retry is a private re-entry from the run API. Read its identity
  // before idempotency lookup so one client key cannot accidentally reconcile
  // a retry that was requested for a different terminal Run.
  const retryContext = opts.retry;
  const isRetry = !!retryContext;
  let idempotencyScope = "submit";
  if (isRetry && retryContext) {
    idempotencyScope = retryIdempotencyScope(
      retryContext.intent.id,
      retryContext.retryOf,
    );
  }
  const requestFP = requestFingerprint({
    message: req.message,
    provider: req.provider,
    model: req.model,
    mode: req.mode,
    expertId: req.expertId,
    tools: req.tools,
    skills: req.skills,
    images: req.images,
    attachments: req.attachments,
    transcript: req.transcript,
    workDir: req.workDir,
  });

  // Resolve workDir. Sessions created client-side (e.g. by the Web UI)
  // are not persisted yet; fall back to the default workDir for those,
  // mirroring handleChatCompletions.
  const foundWorkDir = server.findSessionWorkDir(id);
  let workDir = foundWorkDir.workDir;
  if (!foundWorkDir.found) {
    // A brand-new client-created session; honor the workDir chosen in the
    // Web UI when provided, otherwise fall back to the default workDir.
    workDir = req.workDir.trim();
    if (workDir === "") {
      workDir = getWorkDir(server.cfg!);
    } else if (!sameWorkDir(workDir, getWorkDir(server.cfg!))) {
      try {
        await validateWorkDir(server.cfg!, workDir);
      } catch {
        return writeSubmitError(
          403,
          null,
          "workdir_not_allowed",
          "permission_error",
          "policy",
          PhaseAdmission,
          "run.error.workdirNotAllowed",
          "The selected work directory is not allowed.",
          RetryNone,
          false,
        );
      }
    }
  } else if (workDir !== "" && !sameWorkDir(workDir, getWorkDir(server.cfg!))) {
    try {
      await validateWorkDir(server.cfg!, workDir);
    } catch {
      return writeSubmitError(
        403,
        null,
        "workdir_not_allowed",
        "permission_error",
        "policy",
        PhaseAdmission,
        "run.error.workdirNotAllowed",
        "The selected work directory is not allowed.",
        RetryNone,
        false,
      );
    }
  }

  // Get or create session
  let sess: APISession;
  try {
    sess = await getOrCreateSession(server, id, workDir);
  } catch (err) {
    if (err instanceof PoolFullError) {
      return writeSubmitError(
        503,
        null,
        "session_pool_unavailable",
        "server_error",
        "transient",
        PhaseAdmission,
        "run.error.sessionPoolUnavailable",
        "session pool is at capacity",
        RetryReconcile,
        true,
      );
    }
    return writeSubmitError(
      500,
      err,
      "session_create_failed",
      "server_error",
      "persistence",
      PhaseAdmission,
      "run.error.sessionCreateFailed",
      "The session could not be created.",
      RetryReconcile,
      true,
    );
  }
  // Slash commands execute synchronously with TUI parity and never create a
  // durable Run; the client renders the result as a chat message.
  if (
    !isRetry && (req.images?.length ?? 0) === 0 &&
    (req.attachments?.length ?? 0) === 0
  ) {
    const result = await server.handleCommand?.(sess, req.message);
    if (result) {
      return writeJSON(200, {
        sessionId: sess.id,
        command: true,
        message: result.message,
        error: result.error,
      });
    }
  }
  if (
    isRetry && retryContext && retryContext.intent.workDir.trim() !== "" &&
    !sameWorkDir(retryContext.intent.workDir, sess.workDir)
  ) {
    return writeErrorInfo(409, {
      code: "retry_policy_conflict",
      type: "conflict_error",
      failureClass: "policy",
      phase: "admission",
      messageKey: "run.error.retryWorkDirConflict",
      message: "The original run workspace is no longer available for retry.",
      intentId: retryContext.intent.id,
    });
  }
  let existing: SessionRun | null = null;
  try {
    existing = findIdempotentRun(
      server.sessionDir(),
      sess.id,
      idempotencyKey,
      requestFP,
      idempotencyScope,
    );
  } catch (err) {
    if (errIsSentinel(err, ErrIdempotencyKeyConflict)) {
      return writeSubmitError(
        409,
        err,
        "idempotency_conflict",
        "idempotency_conflict",
        "policy",
        PhaseAdmission,
        "run.error.idempotencyConflict",
        "The idempotency key conflicts with an existing request.",
        RetryNone,
        false,
      );
    }
    if (errIsSentinel(err, ErrIdempotencyRunMissing)) {
      return writeErrorInfo(503, {
        code: "submission_unknown",
        type: "transport_error",
        failureClass: "transport",
        phase: "transport",
        messageKey: "run.error.submissionUnknown",
        message:
          "The request was accepted but its Run status is temporarily unavailable.",
        retryMode: "reconcile",
        retryable: true,
        intentId: retryContext?.intent.id ?? "",
      });
    }
    return writeSubmitError(
      500,
      err,
      "idempotency_lookup_failed",
      "server_error",
      "persistence",
      PhaseAdmission,
      "run.error.idempotencyLookupFailed",
      "The request could not be reconciled.",
      RetryReconcile,
      true,
    );
  }
  if (existing) {
    return writeJSON(202, {
      sessionId: existing.sessionId,
      runId: existing.id,
      status: existing.status,
      intentId: existing.intentId,
      attempt: existing.attempt,
      idempotent: true,
    });
  }
  // A composer may select a team before its first message. Apply that
  // identity after the durable session has been created with the requested
  // work directory, never as an adapter-owned pre-session mutation. This is
  // deliberately after the idempotency lookup so a retried accepted submit
  // remains a pure reconciliation while its original run is active.
  if (!isRetry && (req.expertId ?? "").trim() !== "") {
    if (!server.setSessionExpert) {
      return writeSubmitError(
        400,
        null,
        "expert_binding_failed",
        "invalid_request_error",
        "policy",
        PhaseAdmission,
        "run.error.expertBindingFailed",
        "The selected expert could not be bound to this session.",
        RetryNone,
        false,
      );
    }
    try {
      await server.setSessionExpert(
        request.signal,
        sess.id,
        req.expertId ?? "",
      );
    } catch (err) {
      const status = isSessionExpertMutationBusy(err) ? 409 : 400;
      return writeSubmitError(
        status,
        err,
        "expert_binding_failed",
        "invalid_request_error",
        "policy",
        PhaseAdmission,
        "run.error.expertBindingFailed",
        "The selected expert could not be bound to this session.",
        RetryNone,
        false,
      );
    }
  }
  if (!server.pool.pin(sess)) {
    return writeSubmitError(
      503,
      null,
      "session_pool_unavailable",
      "server_error",
      "transient",
      PhaseAdmission,
      "run.error.sessionPoolUnavailable",
      "session pool is at capacity",
      RetryReconcile,
      true,
    );
  }
  try {
    return await submitRunLocked(
      server,
      request,
      req,
      sess,
      {
        idempotencyKey,
        idempotencyScope,
        requestFP,
        retryContext,
        isRetry,
        forceAgentLoop: opts.forceAgentLoop ?? false,
      },
    );
  } finally {
    // Go defers pool.Unpin for the whole handler; the background task keeps
    // only the session mutex and the runtime admission, not the pool pin.
    server.pool.unpin(sess);
  }
}

/**
 * submitRunLocked continues the submission after the session has been pinned.
 * The pool unpin happens in the caller's finally; the session mutex, runtime
 * admission, and every later failure path are owned here.
 */
async function submitRunLocked(
  server: Server,
  request: Request,
  req: submitRunRequest,
  sess: APISession,
  ctx: {
    idempotencyKey: string;
    idempotencyScope: string;
    requestFP: string;
    retryContext?: RetryRunContext;
    isRetry: boolean;
    forceAgentLoop: boolean;
  },
): Promise<Response> {
  const { idempotencyKey, idempotencyScope, requestFP } = ctx;
  const retryContext = ctx.retryContext;
  const isRetry = ctx.isRetry;

  let runtimeGuard: { release(): void } | undefined;
  let locked = false;
  try {
    try {
      runtimeGuard = await acquireExecutionAdmission(
        request.signal,
        server.sessionDir(),
        sess.id,
        {},
      );
    } catch (admissionErr) {
      const { status, info } = executionAdmissionError(
        server,
        sess.id,
        admissionErr,
      );
      return writeErrorInfo(status, info);
    }
    const runtimeRelease = () => runtimeGuard?.release();
    // Note: runtimeRelease is intentionally not tied to this function's error
    // handling below the handoff point; ownership transfers to the background
    // task exactly like Go's goroutine.

    // The runtime lock is the admission guard for concurrent runs. The session
    // mutex is also used by short-lived capability/SkillHub refreshes, so wait
    // for it after admission instead of turning that harmless overlap into a
    // false session_run_active conflict.
    await sess.mu.lock();
    locked = true;
    // Session lock is released in the background task after the agent finishes.
    try {
      sess.manager?.reload();
    } catch (err) {
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      return writeSubmitError(
        500,
        err,
        "session_reload_failed",
        "server_error",
        "persistence",
        PhaseAdmission,
        "run.error.sessionReloadFailed",
        "The session could not be reloaded.",
        RetryReconcile,
        true,
      );
    }
    // The first reconciliation happens before acquiring the session/runtime
    // admission locks for latency. Repeat it after the locks are held so two
    // concurrent submissions cannot both observe a missing key and create two
    // Runs. The durable started event remains the compatibility lookup until the
    // Runtime-owned submission table is introduced.
    let existing: SessionRun | null = null;
    try {
      existing = findIdempotentRun(
        server.sessionDir(),
        sess.id,
        idempotencyKey,
        requestFP,
        idempotencyScope,
      );
    } catch (err) {
      const response = submitIdempotencyLookupError(
        err,
        retryContext?.intent.id ?? "",
      );
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      return response;
    }
    if (existing) {
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      return writeJSON(202, {
        sessionId: existing.sessionId,
        runId: existing.id,
        status: existing.status,
        intentId: existing.intentId,
        attempt: existing.attempt,
        idempotent: true,
      });
    }

    // Resolve model. A retry is an internal re-entry after the run API has
    // validated the prior terminal Run; its persisted effective model is
    // authoritative over a request-body default, while the current provider
    // must still support it.
    const currentModelBase = server.model;
    const configuredProviderName = server.providerName;
    let currentProvider = server.provider;
    let providerName = server.providerName;
    const runtimeSettings = server.settings;

    const requestedProviderRaw = (req.provider ?? "").trim();
    const requestedModelRaw = (req.model ?? "").trim();
    let requestedProvider = requestedProviderRaw;
    let requestedModel = requestedModelRaw;
    if (
      isRetry && retryContext &&
      (requestedModel === "" || requestedModel === "default")
    ) {
      requestedModel = retryContext.intent.model.trim();
    }
    if (requestedModel.includes("/")) {
      const parsed = parseQualifiedModel(requestedModel);
      if (!parsed) {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeSubmitError(
          400,
          new Error("invalid qualified model"),
          "invalid_model",
          "invalid_request_error",
          "validation",
          PhaseAdmission,
          "run.error.providerUnavailable",
          "The requested model is invalid.",
          RetryNone,
          false,
        );
      }
      if (
        requestedProvider !== "" &&
        requestedProvider.toLowerCase() !== parsed.providerName.toLowerCase()
      ) {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeSubmitError(
          400,
          null,
          "provider_model_mismatch",
          "invalid_request_error",
          "validation",
          PhaseAdmission,
          "run.error.providerUnavailable",
          "The requested provider does not own the selected model.",
          RetryNone,
          false,
        );
      }
      requestedProvider = parsed.providerName;
      requestedModel = parsed.modelID;
    }
    if (requestedProvider === "") {
      requestedProvider = providerName;
    }
    let currentModel = currentModelBase;
    if (requestedProvider.toLowerCase() !== providerName.toLowerCase()) {
      if (!runtimeSettings) {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeSubmitError(
          503,
          null,
          "provider_unavailable",
          "server_error",
          "transient",
          PhaseAdmission,
          "run.error.providerUnavailable",
          "The requested provider is unavailable.",
          RetryReconcile,
          true,
        );
      }
      const modelID = requestedModel === "default" ? "" : requestedModel;
      let selected: { provider: Provider; model: Model };
      try {
        selected = createWithOptions(
          runtimeSettings,
          requestedProvider,
          modelID,
          { requireModel: true },
        );
        if (!selected.provider || !selected.model) {
          throw new Error(
            `provider "${requestedProvider}" has no usable model`,
          );
        }
      } catch (createErr) {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeSubmitError(
          400,
          createErr,
          "provider_model_unavailable",
          "invalid_request_error",
          "policy",
          PhaseAdmission,
          "run.error.providerUnavailable",
          "The requested provider or model is unavailable.",
          RetryNone,
          false,
        );
      }
      currentProvider = selected.provider;
      providerName = requestedProvider;
      currentModel = selected.model;
    } else if (requestedModel !== "" && requestedModel !== "default") {
      const m = currentProvider?.getModel(requestedModel);
      if (m) {
        currentModel = m;
      } else if (isRetry && retryContext) {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeErrorInfo(409, {
          code: "retry_policy_conflict",
          type: "conflict_error",
          failureClass: "policy",
          phase: "admission",
          messageKey: "run.error.retryPolicyConflict",
          message: "The model used by the original run is no longer available.",
          runId: retryContext.retryOf,
          intentId: retryContext.intent.id,
        });
      }
    }
    currentModel = cloneModel(currentModel);

    // Resolve mode once for the runtime, record, approval, and agent config.
    // A linked retry reuses the accepted effective mode, except when current
    // shared policy forces a stricter mode (for example a bound channel's yolo
    // requirement) during ResolveSessionPolicy.
    let requestedMode = (req.mode ?? "").trim();
    if (isRetry && retryContext && retryContext.intent.mode.trim() !== "") {
      requestedMode = retryContext.intent.mode.trim();
    }
    const modeErr = validateCapabilityMode(requestedMode);
    if (modeErr) {
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      return writeSubmitError(
        400,
        modeErr,
        "invalid_mode",
        "invalid_request_error",
        "validation",
        PhaseAdmission,
        "run.error.invalidMode",
        "The requested execution mode is invalid.",
        RetryNone,
        false,
      );
    }
    const policyResult = resolveSessionPolicy(server, sess, requestedMode);
    if (policyResult.err) {
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      return writeSubmitError(
        400,
        policyResult.err,
        "policy_resolution_failed",
        "invalid_request_error",
        "policy",
        PhaseAdmission,
        "run.error.policyResolutionFailed",
        "The execution policy could not be resolved.",
        RetryNone,
        false,
      );
    }
    const mode = policyResult.mode;
    let runSource = String(policyResult.resolution.source);
    if (runSource === "") {
      runSource = String(SourceWebUI);
    }
    const modeProvided = requestedMode !== "";

    // Run admission is started after capability validation so durable local
    // lifecycle creation cannot be followed by preflight failures.
    const runId = newRunID();
    const runStartedAt = new Date();
    // The durable intent snapshot is populated from Runtime-normalized
    // attachment IDs below. Never persist the WebUI data URLs themselves.
    let requestSnapshot: unknown = "{}";
    // The policy is completed after session tool/skill capability updates below.
    // Keep a valid placeholder here so the intent object can be assembled before
    // the common admission path; the initial intent is replaced with the full
    // snapshot before persistence.
    let policySnapshot: unknown = "{}";
    let intent: ExecutionIntent = {
      id: newExecutionIntentID(),
      sessionId: sess.id,
      source: runSource,
      model: currentModel?.id ?? "",
      mode,
      workDir: sess.workDir,
      requestFingerprint: requestFP,
      request: requestSnapshot,
      policy: policySnapshot,
      createdAt: runStartedAt,
    };
    let attempt = 1;
    let retryOf = "";
    if (isRetry && retryContext) {
      intent = retryContext.intent;
      retryOf = retryContext.retryOf;
      if (
        intent.id === "" || intent.sessionId !== sess.id || retryOf === ""
      ) {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeSubmitError(
          409,
          null,
          "retry_unavailable",
          "retry_unavailable",
          "policy",
          PhaseAdmission,
          "run.error.retryUnavailable",
          "retry request is no longer valid",
          RetryNone,
          false,
        );
      }
      // This code runs after the session/runtime admission locks have been
      // acquired. That makes the maximum attempt lookup and the following
      // BeginRetryDurable admission one serialized operation for this session.
      try {
        attempt = nextSessionRunAttempt(
          server.sessionDir(),
          sess.id,
          intent.id,
        );
      } catch {
        locked = false;
        sess.mu.unlock();
        runtimeRelease();
        return writeErrorInfo(500, {
          code: "run_persistence_failed",
          type: "server_error",
          failureClass: "persistence",
          phase: "admission",
          messageKey: "run.error.persistence",
          message: "The retry could not be prepared.",
          runId: retryOf,
          intentId: intent.id,
        });
      }
      if (attempt < retryContext.minimumAttempt) {
        attempt = retryContext.minimumAttempt;
      }
    }

    const failSubmit = (
      status: number,
      err: unknown,
      code: string,
      errType: string,
      failureClass: FailureClass,
      phase: Phase,
      messageKey: string,
      message: string,
      retryMode: RetryMode,
      retryable: boolean,
    ): Response => {
      sess.finishRun(runId);
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      const info = submitErrorInfo(
        err,
        status,
        code,
        errType,
        failureClass,
        phase,
        messageKey,
        message,
        retryMode,
        retryable,
      );
      return writeErrorInfo(status, info);
    };

    // Apply WebUI runtime intents (mode, tool toggles, skills) before the
    // agent is constructed, mirroring handleChatCompletions. An explicit mode
    // in the submit body is persisted so it sticks for subsequent runs.
    if (modeProvided) {
      const before = capabilitySnapshotFromSession(sess);
      sess.mode = mode;
      const persistErr = persistSessionCapabilitiesWithEvents(
        server,
        sess,
        before,
        "run_mode",
        "webui",
        runId,
        { source: "run_submit" },
      );
      if (persistErr) {
        return failSubmit(
          500,
          persistErr,
          "session_capabilities_persist_failed",
          "server_error",
          "persistence",
          "persistence" as Phase,
          "run.error.capabilitiesPersistFailed",
          "The session capabilities could not be saved.",
          RetryReconcile,
          true,
        );
      }
    }
    let toolOpts: SessionToolOptions | null;
    try {
      toolOpts = sessionToolOptionsFromNames(req.tools);
    } catch (err) {
      return failSubmit(
        400,
        err,
        "invalid_tool_option",
        "invalid_request_error",
        "validation",
        PhaseAdmission,
        "run.error.invalidToolOption",
        "The requested tool configuration is invalid.",
        RetryNone,
        false,
      );
    }
    // applySessionToolOptions always synchronizes the session tool registry,
    // even with null options, so tool registration stays owned by the session
    // runtime/capability layer rather than individual runs.
    try {
      await applySessionToolOptions(server, sess, toolOpts, runId);
    } catch (err) {
      return failSubmit(
        500,
        err,
        "session_tools_update_failed",
        "server_error",
        "persistence",
        "persistence" as Phase,
        "run.error.sessionToolsUpdateFailed",
        "The session tools could not be updated.",
        RetryReconcile,
        true,
      );
    }
    if (req.skills !== undefined) {
      try {
        await setActiveSkillsLocked(server, sess, req.skills);
      } catch (err) {
        return failSubmit(
          400,
          err,
          "invalid_skill_option",
          "invalid_request_error",
          "validation",
          PhaseAdmission,
          "run.error.invalidSkillOption",
          "The requested skill configuration is invalid.",
          RetryNone,
          false,
        );
      }
    }
    // Normalize every WebUI input through SessionRuntime before durable
    // admission. The adapter only decodes its transport envelope; Runtime owns
    // project materialization, metadata, and the path manifest.
    let input: RunInput;
    let msg: Message;
    try {
      if (isRetry) {
        if (
          (req.attachments?.length ?? 0) === 0 && (req.images?.length ?? 0) > 0
        ) {
          // Old intents may still contain data URLs. Re-materialize them through
          // the canonical Runtime path instead of recreating direct image blocks.
          const ingresses = submitRunAttachmentIngresses(req);
          setSubmitIngressEventID(ingresses, idempotencyKey);
          input = await sess.runtime!.acceptInput(
            request.signal,
            runId,
            req.message,
            ingresses,
          );
          msg = await sess.runtime!.buildUserMessage(request.signal, input);
        } else {
          input = storedSubmitRunInput(req);
          msg = await sess.runtime!.buildUserMessage(request.signal, input);
        }
      } else {
        const ingresses = submitRunAttachmentIngresses(req);
        setSubmitIngressEventID(ingresses, idempotencyKey);
        input = await sess.runtime!.acceptInput(
          request.signal,
          runId,
          req.message,
          ingresses,
        );
        msg = await sess.runtime!.buildUserMessage(request.signal, input);
      }
    } catch (ingressErr) {
      if (!isRetry && isAttachmentIngressError(ingressErr)) {
        return failSubmit(
          400,
          ingressErr,
          "invalid_attachment",
          "invalid_request_error",
          "validation",
          PhaseAdmission,
          "run.error.invalidMessage",
          "The submitted attachment is invalid.",
          RetryNone,
          false,
        );
      }
      return failSubmit(
        400,
        ingressErr,
        "invalid_message",
        "invalid_request_error",
        "validation",
        PhaseAdmission,
        "run.error.invalidMessage",
        "The submitted message or attachment is invalid.",
        RetryNone,
        false,
      );
    }
    if (!isRetry) {
      try {
        requestSnapshot = marshalNormalizedSubmitRunRequest(req, input);
      } catch (err) {
        return failSubmit(
          500,
          err,
          "run_request_snapshot_failed",
          "server_error",
          "persistence",
          PhaseAdmission,
          "run.error.requestSnapshotFailed",
          "The run request could not be prepared.",
          RetryReconcile,
          true,
        );
      }
      intent.request = requestSnapshot;
    }
    // Freeze the durable policy after Runtime input normalization so the recorded
    // request and effective tool set match Agent construction below.
    try {
      policySnapshot = marshalRunPolicySnapshot(
        server,
        sess,
        req,
        runSource,
        mode,
      );
    } catch (err) {
      return failSubmit(
        500,
        err,
        "run_policy_snapshot_failed",
        "server_error",
        "persistence",
        PhaseAdmission,
        "run.error.policySnapshotFailed",
        "The run policy could not be prepared.",
        RetryReconcile,
        true,
      );
    }
    if (isRetry && retryContext) {
      if (!sameRunPolicySnapshot(retryContext.intent.policy, policySnapshot)) {
        return failSubmit(
          409,
          null,
          "retry_policy_conflict",
          "conflict_error",
          "policy",
          PhaseAdmission,
          "run.error.retryPolicyConflict",
          "The execution policy has changed since the original run.",
          RetryNone,
          false,
        );
      }
    } else {
      intent.policy = policySnapshot;
    }

    // Responses background keeps its provider-specific remote driver, while the
    // canonical local Run lifecycle is owned by ExecutionRuntime like other runs.
    const execution = sess.ensureExecution();
    execution.setRunStore(new RunStore(server.sessionDir()));
    execution.setEventSink(runtimeRunEventSink(server, sess));
    sess.runtime?.setExecution(execution);
    const durableRun: DurableRun = {
      id: runId,
      sessionId: sess.id,
      intentId: intent.id,
      retryOf,
      attempt,
      workDir: sess.workDir,
      source: runSource,
      model: currentModel?.id ?? "",
      mode,
      status: "queued",
      startedAt: runStartedAt,
      finishedAt: null,
      error: "",
      errorInfo: {},
      progress: {},
      usage: null,
      contextUsage: null,
      inputResourceIds: resourceIds(input),
      submissionKeyHash: idempotencyKeyFingerprint(idempotencyKey),
      submissionScope: idempotencyScope,
      submissionFingerprint: requestFP,
      conversationTurnId: "turn-" + intent.id,
      conversationTurn: true,
      userEntryId: "",
      assistantEntryId: "",
    };
    if (!isRetry) {
      durableRun.userEntryId = runUserEntryID(runId);
      durableRun.userMessage = msg;
    }
    const startEvent: RunEvent = {
      sessionId: sess.id,
      runId,
      eventType: "started",
      source: runSource,
      status: "queued",
      model: currentModel?.id ?? "",
      mode,
      timestamp: runStartedAt,
      data: rawEventData({
        source: "webui",
        idempotencyKeyHash: idempotencyKeyFingerprint(idempotencyKey),
        idempotencyScope,
        requestFingerprint: requestFP,
        intentId: intent.id,
        attempt,
        retryOf,
      }),
    };
    sess.beginRunBookkeeping(runId);
    try {
      if (isRetry) {
        execution.beginRetryDurable(undefined, durableRun, startEvent);
      } else {
        execution.beginIntentDurable(undefined, intent, durableRun, startEvent);
      }
    } catch (beginErr) {
      sess.finishRun(runId);
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      const info = submitErrorInfo(
        beginErr,
        500,
        "run_persistence_failed",
        "server_error",
        "persistence",
        "persistence" as Phase,
        "run.error.persistence",
        "The run could not be started.",
        RetryReconcile,
        true,
      );
      info.runId = runId;
      info.intentId = intent.id;
      return writeErrorInfo(500, info);
    }
    // Durable admission atomically starts the conversation turn and appends
    // the run's user entry outside the in-memory Manager. Refresh while we
    // still hold the session/runtime locks so the background coordinator sees
    // the admitted user entry in its replay state and reuses it instead of
    // appending a duplicate.
    try {
      sess.manager?.reload();
    } catch (err) {
      sess.finishRun(runId);
      locked = false;
      sess.mu.unlock();
      runtimeRelease();
      const info = submitErrorInfo(
        err,
        500,
        "session_reload_failed",
        "server_error",
        "persistence",
        "persistence" as Phase,
        "run.error.sessionReloadFailed",
        "The session could not be reloaded.",
        RetryReconcile,
        true,
      );
      info.runId = runId;
      info.intentId = intent.id;
      return writeErrorInfo(500, info);
    }
    sess.markDurableRun(runId);
    if (server.runManager) {
      try {
        server.runManager.register(
          {
            id: runId,
            sessionId: sess.id,
            intentId: intent.id,
            retryOf,
            attempt,
            workDir: "",
            source: "",
            model: "",
            mode: "",
            status: "",
            startedAt: runStartedAt,
            updatedAt: runStartedAt,
            finishedAt: null,
            error: "",
            errorInfo: null,
            progress: null,
            usage: null,
            contextUsage: null,
            inputResourceIds: [],
            submissionKeyHash: "",
            submissionScope: "",
            submissionFingerprint: "",
            userEntryId: "",
            assistantEntryId: "",
          } satisfies SessionRun,
        );
      } catch {
        // Go ignores the register error (`_ =`).
      }
    }
    const providerMatchesConfigured = providerName.toLowerCase() ===
      configuredProviderName.toLowerCase();
    const responsesBackground = !ctx.forceAgentLoop &&
      resourceIds(input).length === 0 &&
      responsesBackgroundEnabled(server) &&
      providerMatchesConfigured;
    // Ownership transfers to the background task from here on.
    locked = false;
    if (responsesBackground && server.executeResponsesBackgroundRun) {
      // Deviation: until the background-run slice fills this hook the local
      // runner below is the fallback; the hook is the Go wire once present.
      void server.executeResponsesBackgroundRun(
        sess,
        runId,
        runtimeRelease,
        currentModel,
        mode,
        msg,
        req.transcript,
      );
    } else {
      void executeBackgroundRun(
        server,
        sess,
        runId,
        intent.id,
        runtimeRelease,
        currentProvider!,
        currentModel,
        providerName,
        runSource,
        mode,
        msg,
        req.transcript,
      );
    }

    return writeJSON(202, {
      sessionId: sess.id,
      runId,
      status: "queued",
      intentId: intent.id,
      attempt,
    });
  } finally {
    if (locked) sess.mu.unlock();
    // runtimeGuard is intentionally not released here: below the handoff its
    // ownership belongs to the background task, and every earlier return
    // already released it explicitly.
  }
}

/** Shared error projection for the post-lock idempotency lookup. */
function submitIdempotencyLookupError(
  err: unknown,
  intentId: string,
): Response {
  if (errIsSentinel(err, ErrIdempotencyKeyConflict)) {
    return writeSubmitError(
      409,
      err,
      "idempotency_conflict",
      "idempotency_conflict",
      "policy",
      PhaseAdmission,
      "run.error.idempotencyConflict",
      "The idempotency key conflicts with an existing request.",
      RetryNone,
      false,
    );
  }
  if (errIsSentinel(err, ErrIdempotencyRunMissing)) {
    return writeErrorInfo(503, {
      code: "submission_unknown",
      type: "transport_error",
      failureClass: "transport",
      phase: "transport",
      messageKey: "run.error.submissionUnknown",
      message:
        "The request was accepted but its Run status is temporarily unavailable.",
      retryMode: "reconcile",
      retryable: true,
      intentId,
    });
  }
  return writeSubmitError(
    500,
    err,
    "idempotency_lookup_failed",
    "server_error",
    "persistence",
    PhaseAdmission,
    "run.error.idempotencyLookupFailed",
    "The request could not be reconciled.",
    RetryReconcile,
    true,
  );
}

/** Marks the transport errors raised by submitRunAttachmentIngresses. */
function isAttachmentIngressError(err: unknown): boolean {
  return err instanceof Error && err.name === "SubmitRunAttachmentError";
}

// ---------------------------------------------------------------------------
// executeBackgroundRun
// ---------------------------------------------------------------------------

/**
 * executeBackgroundRun runs the agent in a background task and publishes
 * all events via the EventBroker. It is responsible for releasing the session
 * lock and runtime lock when done.
 */
export async function executeBackgroundRun(
  server: Server,
  sess: APISession,
  runId: string,
  intentId: string,
  runtimeRelease: () => void,
  runProvider: Provider,
  model: Model | undefined,
  providerName: string,
  source: string,
  mode: string,
  msg: Message,
  transcript: boolean,
): Promise<void> {
  let terminalStatus = "failed";
  let terminalErrMsg = "";
  const firstTurn = (sess.manager?.getMessages().length ?? 0) === 0;

  // Run completion always finalizes the run, releases the session lock and
  // releases the runtime pin, even on panic paths. The explicit success path
  // below performs these steps itself and sets finalized to skip this fallback.
  const durableLifecycle = sess.isDurableRun(runId);
  let finalized = false;
  let artifacts: { close(): void } | undefined;
  let agentMgrFinish: (() => void) | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Generated files are declared through the Runtime-owned publication tool.
    // Register it before BuildAgent freezes the canonical tool definition set,
    // matching channel execution rather than giving the Web UI a separate file
    // delivery path.
    try {
      artifacts = sess.runtime!.beginArtifactCollection(runId) ?? undefined;
    } catch (err) {
      terminalErrMsg = `begin runtime artifact collection: ${
        (err as Error).message
      }`;
      return;
    }

    // Build the local Agent through the shared SessionRuntime. Responses
    // background runs use a separate remote driver and do not enter here.
    let a: Agent;
    try {
      a = sess.runtime!.buildAgent({
        provider: runProvider,
        providerName,
        model,
        settings: settingsForSession(server, sess) ?? undefined,
        allow: server.getAllow(),
        mode,
        conversationTurnId: "turn-" + intentId,
        intentId,
        runId,
        conversationTurn: true,
        runtimeOwnsTurnEnd: true,
        thinkingLevel: server.cfg?.defaultThinkingLevel ?? "",
        multiAgent: sess.multiAgent,
        delegateMode: sess.delegateMode,
        workflows: sess.workflows,
        getSteeringMessages: esmSteeringMessages(server, sess.id),
      });
    } catch (err) {
      terminalErrMsg = (err as Error).message;
      return;
    }

    // Replay persisted session history into the fresh agent so background
    // runs keep the conversation context (mirrors handleChatCompletions).
    const replayState = sess.manager!.getReplayState();
    if (replayState.messages.length > 0) {
      a.loadHistoryState(replayState.messages, replayState.entryIDs);
    }

    // Run agent with the shared request timeout.
    const timeoutMs = (server.cfg?.requestTimeoutSecs ?? 0) * 1000;
    const abort = new AbortController();
    timeoutTimer = setTimeout(() => {
      abort.abort(new DOMException("deadline exceeded", "TimeoutError"));
    }, timeoutMs);
    if (!sess.attachRunAgent(runId, a, () => abort.abort())) {
      a.abort();
      return;
    }
    if (
      (sess.multiAgent || sess.delegateMode || sess.workflows) &&
      sess.agentMgr
    ) {
      sess.agentMgr.register(newAgentAdapter(a));
      // Go defers AgentMgr.Finish with ctx.Err(); it runs before the other
      // defers (LIFO) once this function exits.
      agentMgrFinish = () => {
        const signal = abort.signal;
        const cause = signal.aborted && signal.reason instanceof Error
          ? signal.reason
          : undefined;
        try {
          sess.agentMgr!.finish(a.id(), cause);
        } catch {
          // Go ignores the finish error.
        }
      };
    }

    const rawEventCh = runRetriesPersistedMessage(
        server,
        runId,
        sess,
        replayState.messages,
        msg,
      )
      // Use RunWithLoadedHistory for a linked retry so the user request stored
      // by its first attempt remains a single transcript entry.
      ? a.runWithLoadedHistory(abort.signal)
      : a.runWithUserMessage(msg, abort.signal);

    // Use RunExecutor to process events and publish via EventBroker
    const executor = newRunExecutor(
      server,
      server.getEventBroker(),
      {
        id: runId,
        sessionId: sess.id,
        intentId,
        retryOf: "",
        attempt: 1,
        workDir: sess.workDir,
        source,
        model: model?.id ?? "",
        mode,
        status: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
        error: "",
        errorInfo: null,
        progress: null,
        usage: null,
        contextUsage: null,
        inputResourceIds: [],
        submissionKeyHash: "",
        submissionScope: "",
        submissionFingerprint: "",
        userEntryId: "",
        assistantEntryId: "",
      } satisfies SessionRun,
    );

    let result: RunResult | null = null;
    try {
      result = await executor.execute(
        abort.signal,
        sess,
        a,
        rawEventCh,
        model?.id ?? "",
        mode,
        transcript,
      );
    } catch (err) {
      terminalStatus = "failed";
      terminalErrMsg = (err as Error).message;
    }
    if (result) {
      terminalStatus = result.status;
      terminalErrMsg = result.error;
    }

    await finishExecutedBackgroundRun(
      server,
      sess,
      runId,
      source,
      model,
      mode,
      transcript,
      executor,
      result,
      terminalStatus,
      terminalErrMsg,
      durableLifecycle,
    );
    finalized = true;

    // Session title generation is best-effort and must not delay the run
    // completion events published above.
    if (firstTurn && terminalStatus === "completed") {
      if (!server.pool) {
        // A server without a session pool is only used by small embedded
        // adapters/tests; preserve the best-effort behavior there.
        await generateSessionTitle(server, sess, model);
      } else {
        // If shutdown won the race with the execution task, skip this
        // optional write rather than starting untracked work after the pool
        // has stopped accepting background tasks.
        server.pool.go(() => generateSessionTitle(server, sess, model));
      }
    }
  } finally {
    // Go's LIFO defers at function exit: AgentMgr.Finish, artifacts.Close,
    // then the failure-backstop finalizer, then the runtime release.
    agentMgrFinish?.();
    agentMgrFinish = undefined;
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
    try {
      artifacts?.close();
    } catch {
      // Go ignores the close error.
    }
    if (!finalized) {
      const terminalData: Record<string, unknown> = {};
      if (terminalStatus !== "completed") {
        const failure = new Error(
          terminalErrMsg === ""
            ? "background run ended before it could start"
            : terminalErrMsg,
        );
        let info = classifyError(failure, { phase: PhaseModel });
        const execution = sess.executionRuntime();
        if (execution) {
          try {
            info = execution.recordFailure(failure, { phase: PhaseModel });
          } catch {
            // Go ignores the RecordFailure error.
          }
        }
        terminalErrMsg = displayErrorMessage(info);
        terminalData.error = info;
        terminalData.errorInfo = info;
        terminalData.errorMessage = terminalErrMsg;
      }
      const execution = sess.executionRuntime();
      if (durableLifecycle && execution) {
        try {
          await execution.finishDurableWithRetry(
            undefined,
            runId,
            webUIRunState(terminalStatus, terminalErrMsg),
            terminalErrMsg,
            {
              sessionId: sess.id,
              runId,
              eventType: runEventTypeForStatus(terminalStatus),
              source,
              status: terminalStatus,
              model: model?.id ?? "",
              mode,
              timestamp: new Date(),
              data: rawEventData(terminalData),
            } satisfies RunEvent,
          );
        } catch {
          // Go ignores the finish error (`_ =`).
        }
      } else {
        recordSessionRunEvent(
          server,
          sess,
          runId,
          runEventTypeForStatus(terminalStatus),
          terminalStatus,
          source,
          model?.id ?? "",
          mode,
          terminalData,
        );
      }
      finalizeRun(server, sess, runId, terminalStatus, terminalErrMsg);
      sess.mu.unlock();
    }
    runtimeRelease();
  }
}

/**
 * finishExecutedBackgroundRun publishes the terminal events and persists the
 * terminal lifecycle run event while the session lock is still held, so the
 * WebUI sees completion promptly and a refresh reconstructs the status from
 * durable run events.
 */
async function finishExecutedBackgroundRun(
  server: Server,
  sess: APISession,
  runId: string,
  source: string,
  model: Model | undefined,
  mode: string,
  _transcript: boolean,
  executor: RunExecutor | null,
  result: RunResult | null,
  terminalStatus: string,
  terminalErrMsg: string,
  durableLifecycle: boolean,
): Promise<void> {
  if (executor && result) {
    executor.finalize(sess, result);
  }
  let terminalData: Record<string, unknown> = {};
  if (result?.usage) {
    terminalData = usageEventData(result.usage, result.error);
  }
  let errMsg = terminalErrMsg;
  if (result?.errorInfo) {
    terminalData.error = result.errorInfo;
    terminalData.errorInfo = result.errorInfo;
    errMsg = displayErrorMessage(result.errorInfo);
    terminalData.errorMessage = errMsg;
  } else if (errMsg !== "") {
    const info = classifyError(new Error(errMsg), { phase: PhaseModel });
    terminalData.error = info;
    terminalData.errorInfo = info;
    errMsg = displayErrorMessage(info);
    terminalData.errorMessage = errMsg;
  }
  if (result) {
    terminalData = withContextUsageEventData(terminalData, result.contextUsage);
  }
  const execution = sess.executionRuntime();
  if (durableLifecycle && execution) {
    try {
      execution.recordUsage(
        runId,
        result?.usage ?? null,
        result?.contextUsage ?? null,
      );
    } catch {
      // Go ignores the RecordUsage error (`_ =`).
    }
    try {
      await execution.finishDurableWithRetry(
        undefined,
        runId,
        webUIRunState(terminalStatus, errMsg),
        errMsg,
        {
          sessionId: sess.id,
          runId,
          eventType: runEventTypeForStatus(terminalStatus),
          source,
          status: terminalStatus,
          model: model?.id ?? "",
          mode,
          timestamp: new Date(),
          data: rawEventData(terminalData),
        } satisfies RunEvent,
      );
    } catch (err) {
      // A concurrent cancel/recovery may have terminalized this run first.
      // Only log failures that still leave the run active and actionable.
      if (execution.active().active) {
        console.error(`[serve] finish durable run ${runId}: ${err}`);
      }
    }
  } else {
    recordSessionRunEvent(
      server,
      sess,
      runId,
      runEventTypeForStatus(terminalStatus),
      terminalStatus,
      source,
      model?.id ?? "",
      mode,
      terminalData,
    );
  }

  // Release the session lock before the title generation provider call so the
  // session is not blocked by it for up to 20 seconds.
  finalizeRun(server, sess, runId, terminalStatus, errMsg);
  sess.mu.unlock();
}

/**
 * runRetriesPersistedMessage reports whether a linked retry would duplicate
 * the user entry its first attempt already persisted.
 */
export function runRetriesPersistedMessage(
  server: Server,
  runId: string,
  sess: APISession,
  messages: Message[],
  msg: Message,
): boolean {
  if (!server || !server.settings || !sess || runId === "") return false;
  let run: SessionRun | null = null;
  try {
    run = getDurableRun(server.sessionDir(), runId);
  } catch {
    return false;
  }
  if (!run || run.retryOf === "") return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate.role !== "user" || candidate.systemInjected) continue;
    if (
      candidate.content === msg.content &&
      deepEqual(candidate.contents ?? null, msg.contents ?? null)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * generateSessionTitle generates and persists a session title on the first
 * completed turn. Best-effort: every failure is logged and swallowed.
 */
export async function generateSessionTitle(
  server: Server,
  sess: APISession,
  model: Model | undefined,
): Promise<void> {
  if (!server) {
    console.error("[serve] session title generation skipped: server is nil");
    return;
  }
  if (!sess) {
    console.error("[serve] session title generation skipped: session is nil");
    return;
  }
  if (!sess.manager) {
    console.error(
      `[serve] session title generation skipped: session=${sess.id} manager is nil`,
    );
    return;
  }
  if (!model) {
    console.error(
      `[serve] session title generation skipped: session=${sess.id} model is nil`,
    );
    return;
  }
  let persisted: { name: string; source: string };
  try {
    persisted = latestSessionTitle(server.sessionDir(), sess.id);
  } catch {
    return;
  }
  if (persisted.name.trim() !== "") return;
  // Capture the provider under the server lock: provider is swapped while
  // holding the server mutex (e.g. when the default model changes) and this
  // function runs in a background task after the session lock has been
  // released.
  const provider = server.provider;
  if (!provider) {
    console.error(
      `[serve] session title generation skipped: session=${sess.id} provider is nil`,
    );
    return;
  }

  console.error(
    `[serve] generating session title: session=${sess.id} provider=${provider.name()} api=${provider.api()} model=${model.id}`,
  );
  // Deviation: Go bounds the generator with a 20s context; the ported title
  // Generator takes no signal, so the bound is dropped.
  let name = "";
  try {
    name = await new Generator({ provider, model }).generate(
      sess.manager.getMessages(),
    );
  } catch (err) {
    console.error(
      `[serve] session title generation failed: session=${sess.id} provider=${provider.name()} model=${model.id}: ${
        (err as Error).message
      }`,
    );
    return;
  }
  if (name === "") {
    console.error(
      `[serve] session title generation returned empty title: session=${sess.id} provider=${provider.name()} model=${model.id}`,
    );
    return;
  }
  try {
    const again = latestSessionTitle(server.sessionDir(), sess.id);
    if (again.name.trim() !== "") return;
  } catch {
    return;
  }
  try {
    sess.manager.appendSessionTitle(name, "auto");
  } catch (err) {
    console.error(
      `[serve] persist session title failed: session=${sess.id} title=${
        JSON.stringify(name)
      }: ${(err as Error).message}`,
    );
    return;
  }
  console.error(
    `[serve] session title generated: session=${sess.id} title=${
      JSON.stringify(name)
    }`,
  );
  const broker = server.getEventBroker();
  if (broker) {
    broker.publishRawJSON(sess.id, "", "title_updated", { title: name });
  }
}

// ---------------------------------------------------------------------------
// Attachment ingress + request normalization helpers
// ---------------------------------------------------------------------------

export function submitRunAttachmentIngresses(
  req: submitRunRequest,
): InputIngress[] {
  const items: submitRunAttachmentRequest[] = [...(req.attachments ?? [])];
  (req.images ?? []).forEach((dataURL, index) => {
    items.push({
      kind: "image",
      filename: `image-${index + 1}`,
      dataUrl: dataURL,
    });
  });
  const ingresses: InputIngress[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const kind = (item.kind ?? "").trim().toLowerCase() as AttachmentKind;
    if (kind !== AttachmentImage && kind !== AttachmentFile) {
      const err = new Error(`unsupported attachment kind "${item.kind}"`);
      err.name = "SubmitRunAttachmentError";
      throw err;
    }
    let mediaType: string;
    let data: Uint8Array;
    try {
      const decoded = decodeSubmitRunDataURL(item.dataUrl ?? "");
      data = decoded.data;
      mediaType = decoded.mediaType;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.name = "SubmitRunAttachmentError";
      throw wrapped;
    }
    if (item.mediaType !== undefined && item.mediaType !== "") {
      mediaType = item.mediaType;
    }
    const filename = item.filename !== undefined && item.filename !== ""
      ? item.filename
      : "attachment";
    const attachmentData = new Uint8Array(data);
    ingresses.push({
      origin: "webui",
      eventId: "",
      itemIndex: index,
      reference: "webui-upload",
      kind,
      filenameHint: filename,
      mediaTypeHint: mediaType,
      sizeHint: attachmentData.byteLength,
      open: () => ({
        bytes: attachmentData,
        filename,
        mediaType,
        contentSize: attachmentData.byteLength,
      }),
    });
  }
  return ingresses;
}

export function setSubmitIngressEventID(
  ingresses: InputIngress[],
  idempotencyKey: string,
): void {
  const key = idempotencyKey.trim();
  if (key === "") return;
  for (let index = 0; index < ingresses.length; index++) {
    ingresses[index].eventId = "webui-submit:" + key;
    ingresses[index].itemIndex = index;
  }
}

export function decodeSubmitRunDataURL(
  value: string,
): { data: Uint8Array; mediaType: string } {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(",");
  const parts = comma < 0
    ? []
    : [trimmed.slice(0, comma), trimmed.slice(comma + 1)];
  if (
    parts.length !== 2 ||
    !parts[0].toLowerCase().startsWith("data:") ||
    !parts[0].toLowerCase().includes(";base64")
  ) {
    throw new Error("attachment must be a base64 data URL");
  }
  const mediaType = parts[0].slice("data:".length).split(";")[0].trim();
  let data: Uint8Array;
  try {
    const binary = atob(parts[1]);
    data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  } catch (err) {
    throw new Error(`decode attachment data URL: ${(err as Error).message}`);
  }
  if (data.length === 0) {
    throw new Error("decode attachment data URL: attachment is empty");
  }
  return { data, mediaType };
}

export function storedSubmitRunInput(req: submitRunRequest): RunInput {
  const resources: PreparedInput[] = [];
  for (const item of req.attachments ?? []) {
    const kind = (item.kind ?? "").trim().toLowerCase() as AttachmentKind;
    if (
      item.attachmentId === undefined || item.attachmentId === "" ||
      (kind !== AttachmentImage && kind !== AttachmentFile)
    ) {
      continue;
    }
    resources.push({
      resourceId: item.attachmentId,
      kind,
      relativePath: "",
      filename: item.filename ?? "",
      mediaType: item.mediaType ?? "",
      bytes: item.size ?? 0,
    });
  }
  return {
    text: req.message,
    resources,
    knowledgeBaseReferences: [],
    knowledgeCapsules: [],
    idempotencyKey: "",
  };
}

export function marshalNormalizedSubmitRunRequest(
  req: submitRunRequest,
  input: RunInput,
): string {
  const stored: submitRunRequest = {
    ...req,
    images: undefined,
    attachments: [],
  };
  for (const item of input.resources) {
    stored.attachments!.push({
      attachmentId: item.resourceId,
      kind: item.kind,
      filename: item.filename,
      mediaType: item.mediaType,
      size: item.bytes,
    });
  }
  return JSON.stringify(stored);
}

/**
 * sessionToolOptionsFromNames maps the WebUI submit body `tools` array to
 * local-tool capability toggles. Hosted/provider tools are intentionally
 * excluded because their configuration is owned by provider/settings.
 * A null value means the client did not send tool intent and leaves session
 * state untouched; a non-null value enables listed capabilities and disables
 * the rest. `webSearch` is accepted for backward compatibility but ignored;
 * unknown names are rejected.
 */
export function sessionToolOptionsFromNames(
  names: string[] | undefined,
): SessionToolOptions | null {
  if (names === undefined) return null;
  const enabled = new Map<string, boolean>();
  for (const raw of names) {
    const name = raw.trim();
    switch (name) {
      case "webSearch":
        // Hosted tools must not be changed by the WebUI local tool list.
        break;
      case "browser":
      case "a2aMaster":
      case "delegate":
      case "multiAgent":
      case "workflows":
        enabled.set(name, true);
        break;
      case "":
        break;
      default:
        throw new Error(`unknown tool option "${raw}"`);
    }
  }
  const boolPtr = (key: string): boolean => enabled.get(key) ?? false;
  return {
    // WebSearch is intentionally undefined; hosted configuration is preserved.
    browser: boolPtr("browser"),
    a2aMaster: boolPtr("a2aMaster"),
    delegate: boolPtr("delegate"),
    multiAgent: boolPtr("multiAgent"),
    workflows: boolPtr("workflows"),
  };
}

/**
 * extractSessionIDFromPath extracts the session ID from a path like
 * /api/sessions/{sessionID}/runs or /api/sessions/{sessionID}/stop.
 */
export function extractSessionIDFromPath(
  path: string,
  suffix: string,
): string {
  const prefix = "/api/sessions/";
  if (!path.startsWith(prefix)) return "";
  const rest = path.slice(prefix.length);
  if (!rest.endsWith(suffix)) return "";
  return rest.slice(0, rest.length - suffix.length);
}

/** decodeSubmitRunRequest ports Go's struct unmarshal semantics. */
function decodeSubmitRunRequest(body: string): submitRunRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("json: cannot unmarshal value into Go value of struct");
  }
  const record = raw as Record<string, unknown>;
  const stringOr = (key: string): string =>
    typeof record[key] === "string" ? record[key] as string : "";
  const boolOr = (key: string): boolean => record[key] === true;
  const stringsOrUndefined = (key: string): string[] | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      throw new Error(
        `json: cannot unmarshal ${key} into Go value of []string`,
      );
    }
    return value.map((item) => {
      if (typeof item !== "string") {
        throw new Error(
          `json: cannot unmarshal ${key} into Go value of []string`,
        );
      }
      return item;
    });
  };
  const attachmentsOrUndefined = ():
    | submitRunAttachmentRequest[]
    | undefined => {
    const value = record.attachments;
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      throw new Error(
        "json: cannot unmarshal attachments into Go value of []submitRunAttachmentRequest",
      );
    }
    return value.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(
          "json: cannot unmarshal attachments into Go value of []submitRunAttachmentRequest",
        );
      }
      const entry = item as Record<string, unknown>;
      const str = (key: string): string | undefined =>
        typeof entry[key] === "string" ? entry[key] as string : undefined;
      return {
        attachmentId: str("attachmentId"),
        kind: str("kind") ?? "",
        filename: str("filename"),
        mediaType: str("mediaType"),
        dataUrl: str("dataUrl"),
        size: typeof entry.size === "number" ? entry.size : undefined,
      };
    });
  };
  return {
    message: stringOr("message"),
    provider: stringOr("provider"),
    model: stringOr("model"),
    mode: stringOr("mode"),
    expertId: stringOr("expertId"),
    tools: stringsOrUndefined("tools"),
    skills: stringsOrUndefined("skills"),
    images: stringsOrUndefined("images"),
    attachments: attachmentsOrUndefined(),
    transcript: boolOr("transcript"),
    workDir: stringOr("workDir"),
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** deepEqual ports the reflect.DeepEqual comparisons of the Go module. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date &&
      a.getTime() === b.getTime();
  }
  if (typeof a === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left).filter((k) => left[k] !== undefined);
    const rightKeys = Object.keys(right).filter((k) => right[k] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}
