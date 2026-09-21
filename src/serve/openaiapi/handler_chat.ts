// Ported from internal/serve/openaiapi/handler_chat.go — the HTTP half:
// handleChatCompletions, the streaming/non-streaming projections (both the
// broker-mediated and direct event-stream variants), writeCommandResponse, and
// the small response helpers. The pure builders and the OpenAI-envelope →
// Runtime input contract live in chat_support.ts; the session-resource cluster
// lives in handler_chat_session.ts.
//
// Deviations: net/http's ResponseWriter is the standard Request/Response pair —
// validation and admission errors return JSON error Responses directly, and
// the streaming path returns an SSE Response whose ReadableStream start runs
// handleStreamingViaBroker. Everything up to RunWithUserMessage still happens
// before the Response is returned, so every Go error status is preserved; a
// failure after the SSE stream opened can only surface as an SSE error frame.
// Go's `(CompletionUsage, string, string)` triples become outcome objects and
// the non-streaming projections also carry the JSON Response they wrote.
// Go's `errors.Is(err, context.Canceled/DeadlineExceeded)` maps to the shared
// AbortError/TimeoutError convention, and Go's `defer` teardown order is
// reproduced by an idempotent `teardown` (the finalizer still runs after the
// stream is drained and before the session locks are released).

import type { Agent } from "../../agent/agent.ts";
import { newAgentAdapter } from "../../agent/bridge.ts";
import {
  type Event,
  EventDone,
  EventError,
  EventHostedItem,
  EventRetry,
  EventRunFinished,
  EventTextDelta,
  EventToolApprovalRequest,
  EventToolCall,
  EventToolExecutionEnd,
  EventUsage,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../../agent/events.ts";
import { resolveMaxTokens } from "../../agent/max_tokens.ts";
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  PhaseModel,
  PhaseTransport,
  SideEffectUnknown,
} from "../../agentruntime/error_info.ts";
import { acquireExecutionAdmission } from "../../agentruntime/execution_admission.ts";
import type { ExecutionIntent } from "../../session/execution_intent.ts";
import { runUserEntryID } from "../../session/mod.ts";
import type { SessionRun } from "../../session/run_store.ts";
import {
  type InputIngress,
  resourceIds,
  type RunInput,
} from "../../agentruntime/input_materializer.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import type { RunEvent } from "../../agentruntime/run_event.ts";
import { SourceUnknown, SourceWebUI } from "../../agentruntime/source.ts";
import { normalizeSamplingPtr } from "../../config/settings.ts";
import type { Attachment, Message } from "../../provider/types.ts";
import { totalInputTokens } from "../../provider/types.ts";
import { getToolDetail, getWorkDir } from "./config.ts";
import { writeError, writeErrorInfo, writeJSON } from "./auth.ts";
import {
  assistantDeltaTranscriptEvent,
  cloneModel,
  convertHistoryMessages,
  hostedItemEvent,
  isOutputTruncationStopReason,
  messageTranscriptEvent,
  modelIDs,
  parseMessages,
  requestRunInput,
  resolveToolEvent,
  safeAgentErrorMessage,
  subAgentStatusForTaskStatus,
  subAgentStatusTranscriptEvent,
  toolStatusSummary,
  transcriptToolCallEntry,
  transcriptToolResultEntry,
} from "./chat_support.ts";
import {
  newExecutionIntentID,
  newRunID,
  rawEventData,
  recordSessionRunEvent,
  requestFingerprint,
  runEventTypeForStatus,
  usageEventData,
  withContextUsageEventData,
} from "./events.ts";
import {
  newRunExecutor,
  type RunExecutor,
  type RunResult,
} from "./run_executor.ts";
import {
  executionAdmissionError,
  marshalRunPolicySnapshot,
  writeSubmitError,
} from "./handler_run_submit.ts";
import { responsesBackgroundEnabled } from "./background_run_coordinator.ts";
import { submitChatCompletionBackground } from "./chat_background.ts";
import {
  esmSteeringMessages,
  getOrCreateSession,
  settingsForSession,
} from "./handler_chat_session.ts";
import { resolveSessionPolicy } from "./session_capabilities.ts";
import { SSE_HEADERS, SSEWriter, type SSEWriterSink } from "./streaming.ts";
import { publishToolEvent, writeTranscriptEvent } from "./session_stream.ts";
import { registerSessionApproval } from "./approval.ts";
import {
  formatToolResult,
  formatToolRunning,
  type toolCallInfo,
} from "./tool_format.ts";
import { APISession, PoolFullError } from "./session_mgr.ts";
import { runtimeRunEventSink } from "./runtime_run_events.ts";
import type { BrokerEvent } from "./event_broker.ts";
import { webUIRunState } from "./runtime_run_state.ts";
import { finalizeRun } from "./run_manager.ts";
import type { Server } from "./server.ts";
import type { CommandResult } from "./commands.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  CompletionUsage,
  RequestMessage,
  ToolCallSummary,
  ToolStatusEvent,
  TranscriptStreamEvent,
} from "./types.ts";
import {
  decodeRequestMessage,
  newCommandCompletionID,
  newCompletionID,
} from "./types.ts";

/** 10MB request-body limit (Go io.LimitReader(r.Body, 10<<20)). */
const chatBodyLimit = 10 << 20;

/** Outcome triple returned by the streaming/non-streaming projections. */
export interface ChatOutcome {
  usage: CompletionUsage;
  status: string;
  errMsg: string;
}

/** Response-carrying outcome returned by the non-streaming projections. */
export interface NonStreamingOutcome extends ChatOutcome {
  /**
   * The JSON response to return. Go's legacy direct projections can return
   * without writing anything (the TaskCanceled path); those carry null.
   */
  response: Response | null;
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

function isContextCanceled(err: unknown): boolean {
  return isAbortError(err) || isTimeoutError(err);
}

/** Settled executor outcome (Go's execDone/execErr channel pair). */
type ExecSettled =
  | { kind: "done"; result: RunResult }
  | { kind: "error"; err: unknown };

// ---------------------------------------------------------------------------
// handleChatCompletions
// ---------------------------------------------------------------------------

export async function handleChatCompletions(
  server: Server,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return writeError(405, "method not allowed", "invalid_request_error");
  }

  let bodyText: string;
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    // io.LimitReader silently truncates; the truncated JSON then fails to
    // decode below exactly like Go.
    const limited = body.byteLength > chatBodyLimit
      ? body.slice(0, chatBodyLimit)
      : body;
    bodyText = new TextDecoder().decode(limited);
  } catch {
    return writeError(
      400,
      "failed to read request body",
      "invalid_request_error",
    );
  }

  let rawFields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("json: cannot unmarshal value into Go value of struct");
    }
    rawFields = parsed as Record<string, unknown>;
  } catch (err) {
    return writeError(
      400,
      `invalid JSON: ${(err as Error).message}`,
      "invalid_request_error",
    );
  }
  for (const field of Object.keys(rawFields)) {
    const lower = field.toLowerCase();
    if (lower.startsWith("x_") && lower !== "x_background") {
      return writeError(
        400,
        `unsupported extension field "${field}"`,
        "invalid_request_error",
      );
    }
  }

  let req: ChatCompletionRequest;
  try {
    req = decodeChatCompletionRequest(rawFields);
  } catch (err) {
    return writeError(
      400,
      `invalid JSON: ${(err as Error).message}`,
      "invalid_request_error",
    );
  }

  if (req.messages.length === 0) {
    return writeError(
      400,
      "messages array is required and must not be empty",
      "invalid_request_error",
    );
  }
  // Session state is kept internal and uses the configured default working
  // directory. x_background is the sole supported extension and is handled
  // above before the ordinary synchronous chat path.
  const workDir = getWorkDir(server.cfg!);

  // Resolve model
  let currentModel = server.model;
  const currentProvider = server.provider;

  if (req.model !== undefined && req.model !== "") {
    const m = currentProvider?.getModel(req.model);
    if (m) {
      currentModel = m;
    } else {
      return writeError(
        400,
        `model "${req.model}" not found — available: ${
          modelIDs(currentProvider?.models() ?? [])
        }`,
        "invalid_request_error",
      );
    }
  }
  currentModel = cloneModel(currentModel);

  // Extract last user message
  const { lastUser, systemMsgs, history: historyMsgs } = parseMessages(
    req.messages,
  );
  if (
    lastUser.content.trim() === "" &&
    (lastUser.contentParts?.length ?? 0) === 0
  ) {
    return writeError(400, "no user message found", "invalid_request_error");
  }
  let lastUserInput: RunInput;
  let lastUserIngresses: InputIngress[];
  try {
    const decoded = requestRunInput(lastUser);
    lastUserInput = decoded.input;
    lastUserIngresses = decoded.ingresses;
  } catch (err) {
    return writeError(400, (err as Error).message, "invalid_request_error");
  }
  if (req.x_background) {
    if (req.stream) {
      return writeError(
        400,
        "x_background is only supported for non-streaming chat completions",
        "invalid_request_error",
      );
    }
    if (!responsesBackgroundEnabled(server)) {
      return writeError(
        501,
        "x_background requires an available Responses background runtime",
        "capability_error",
      );
    }
    return submitChatCompletionBackground(
      server,
      request,
      req,
      workDir,
      currentModel,
      lastUserInput,
      lastUserIngresses,
      systemMsgs,
      historyMsgs,
    );
  }

  // Get or create the server-owned default session.
  const sessionID = server.defaultSessionIDs.get(workDir) ?? "";
  let sess: APISession | null = null;
  for (;;) {
    try {
      sess = await getOrCreateSession(server, sessionID, workDir);
    } catch (err) {
      if (err instanceof PoolFullError) {
        return writeError(503, "session pool is at capacity", "server_error");
      }
      return writeError(500, (err as Error).message, "server_error");
    }
    if (server.pool?.pin(sess)) break;
  }

  // Mutable state shared with the deferred finalizer (Go's closure defer).
  let terminalStatus = "failed";
  let terminalErrMsg = "";
  let mode = "";
  let runSource = String(SourceWebUI);
  let durableFinished = false;
  let tornDown = false;
  let deferTeardownToStream = false;
  let sessionLocked = false;
  let cancelSubscription: (() => void) | undefined;
  let runAbort: AbortController | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let agentMgrRegistered = false;
  let slotAcquired = false;
  let runtimeGuard: { release(): void } | undefined;
  let artifacts: { close(): void } | undefined;

  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    // Go defers run LIFO: cancelSubscription, agentMgr Finish, cancel(ctx),
    // the finalizer, artifacts.Close, the run-slot drain, sess.Unlock,
    // runtimeRelease, pool.Unpin.
    cancelSubscription?.();
    cancelSubscription = undefined;
    if (agentMgrRegistered && sess!.agentMgr) {
      const signal = runAbort?.signal;
      const cause = signal?.aborted && signal.reason instanceof Error
        ? signal.reason
        : undefined;
      try {
        sess!.agentMgr.finish(runAgentId, cause);
      } catch {
        // Go ignores the finish error.
      }
    }
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
    const execution = sess!.executionRuntime();
    if (!durableFinished && sess!.isDurableRun(runIdRef.id) && execution) {
      try {
        await execution.finishDurableWithRetry(
          undefined,
          runIdRef.id,
          webUIRunState(terminalStatus, terminalErrMsg),
          terminalErrMsg,
          {
            sessionId: sess!.id,
            runId: runIdRef.id,
            eventType: runEventTypeForStatus(terminalStatus),
            source: runSource,
            status: terminalStatus,
            model: runIdRef.model,
            mode,
            timestamp: new Date(),
          } satisfies RunEvent,
        );
      } catch {
        // Go ignores the finish error (`_ =`).
      }
    }
    finalizeRun(server, sess!, runIdRef.id, terminalStatus, terminalErrMsg);
    try {
      artifacts?.close();
    } catch {
      // Go ignores the close error.
    }
    if (slotAcquired) server.runSlots?.release();
    if (sessionLocked) sess!.mu.unlock();
    runtimeGuard?.release();
    server.pool?.unpin(sess!);
  };

  // Go stores runID/model as locals captured by the defer closure; the port
  // uses a mutable holder because teardown can run before runIdRef is set.
  const runIdRef = { id: "", model: currentModel?.id ?? "" };
  let runAgentId = "";

  try {
    let runtimeGuardAttempt;
    try {
      runtimeGuardAttempt = await acquireExecutionAdmission(
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
    runtimeGuard = runtimeGuardAttempt;

    // The durable admission lease already serializes executions across
    // processes. A short-lived in-process session mutex is a reservation, not an
    // active Run; keep this non-blocking and expose the narrower state.
    if (!sess.mu.tryLock()) {
      const info: ErrorInfo = {
        code: "session_reserved",
        type: "conflict_error",
        failureClass: "policy",
        phase: "admission",
        messageKey: "run.error.sessionReserved",
        message: "The session is reserved for another operation.",
        retryMode: "user",
        retryable: true,
      };
      return writeErrorInfo(409, info);
    }
    sessionLocked = true;

    try {
      sess.manager?.reload();
    } catch (err) {
      return writeError(
        500,
        `reload session before run: ${(err as Error).message}`,
        "server_error",
      );
    }
    const hadPersistedHistory =
      (sess.manager?.getReplayState().messages.length ?? 0) > 0;
    if (server.runSlots) {
      slotAcquired = server.runSlots.tryAcquire();
      if (!slotAcquired) {
        return writeError(
          429,
          "maximum concurrent requests reached",
          "concurrency_limit_reached",
        );
      }
    }
    sess.touch();
    const runId = newRunID();
    runIdRef.id = runId;
    let runInput: RunInput;
    try {
      runInput = await sess.runtime!.acceptInput(
        request.signal,
        runId,
        lastUserInput.text,
        lastUserIngresses,
      );
    } catch (err) {
      return writeError(400, (err as Error).message, "invalid_request_error");
    }
    try {
      artifacts = sess.runtime!.beginArtifactCollection(runId) ?? undefined;
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    let lastUserMessage: Message;
    try {
      lastUserMessage = await sess.runtime!.buildUserMessage(
        request.signal,
        runInput,
      );
    } catch (err) {
      return writeError(400, (err as Error).message, "invalid_request_error");
    }
    const runStartedAt = new Date();

    // ---- resolveSessionPolicy -------------------------------------------------
    const policyResult = resolveSessionPolicy(server, sess, "");
    if (policyResult.err) {
      return writeError(400, policyResult.err.message, "invalid_request_error");
    }
    mode = policyResult.mode;
    if (policyResult.resolution.source !== SourceUnknown) {
      runSource = String(policyResult.resolution.source);
    }
    // Canonical local Chat Run lifecycle is owned by ExecutionRuntime. The
    // RunManager only registers the in-memory event fan-out entry.
    const runStatus = "running";
    let chatRequestSnapshot: string;
    try {
      chatRequestSnapshot = JSON.stringify({
        model: req.model ?? "",
        stream: !!req.stream,
        input: runInput,
        systemMessageCount: systemMsgs.length,
        historyMessageCount: historyMsgs.length,
        maxTokens: req.max_tokens ?? 0,
        temperature: req.temperature ?? null,
        topP: req.top_p ?? null,
      });
    } catch (snapshotErr) {
      return writeSubmitError(
        500,
        snapshotErr,
        "run_request_snapshot_failed",
        "server_error",
        "persistence",
        "admission",
        "run.error.requestSnapshotFailed",
        "The run request could not be prepared.",
        "reconcile",
        true,
      );
    }
    let chatPolicySnapshot: string;
    try {
      chatPolicySnapshot = marshalRunPolicySnapshot(
        server,
        sess,
        {
          message: lastUser.content,
          model: req.model ?? "",
          transcript: !!req.stream,
          workDir,
          mode: "",
          tools: [],
          skills: [],
          images: [],
          attachments: [],
        },
        runSource,
        mode,
      );
    } catch (snapshotErr) {
      return writeSubmitError(
        500,
        snapshotErr,
        "run_policy_snapshot_failed",
        "server_error",
        "persistence",
        "admission",
        "run.error.policySnapshotFailed",
        "The run policy could not be prepared.",
        "reconcile",
        true,
      );
    }
    const chatIntent: ExecutionIntent = {
      id: newExecutionIntentID(),
      sessionId: sess.id,
      source: runSource,
      model: currentModel?.id ?? "",
      mode,
      workDir: sess.workDir,
      requestFingerprint: requestFingerprint(req),
      request: chatRequestSnapshot,
      policy: chatPolicySnapshot,
      createdAt: runStartedAt,
    };
    const execution = sess.ensureExecution();
    execution.setRunStore(new RunStore(server.sessionDir()));
    execution.setEventSink(runtimeRunEventSink(server, sess));
    try {
      execution.beginIntentDurable(
        undefined,
        chatIntent,
        {
          id: runId,
          sessionId: sess.id,
          intentId: chatIntent.id,
          retryOf: "",
          attempt: 0,
          workDir: sess.workDir,
          source: runSource,
          model: currentModel?.id ?? "",
          mode,
          status: runStatus,
          startedAt: runStartedAt,
          finishedAt: null,
          error: "",
          errorInfo: {},
          progress: {},
          usage: null,
          contextUsage: null,
          inputResourceIds: resourceIds(runInput),
          submissionKeyHash: "",
          submissionScope: "",
          submissionFingerprint: "",
          userEntryId: runUserEntryID(runId),
          userMessage: lastUserMessage,
          assistantEntryId: "",
          conversationTurnId: "turn-" + runId,
          conversationTurn: true,
        } satisfies DurableRun,
        {
          sessionId: sess.id,
          runId,
          eventType: "started",
          source: runSource,
          status: runStatus,
          model: currentModel?.id ?? "",
          mode,
          timestamp: runStartedAt,
          data: rawEventData({
            stream: !!req.stream,
            workDir: sess.workDir,
            provider: server.providerName,
            messageCount: req.messages.length,
            intentId: chatIntent.id,
            attempt: 1,
          }),
        } satisfies RunEvent,
      );
    } catch (err) {
      return writeSubmitError(
        500,
        err,
        "run_persistence_failed",
        "server_error",
        "persistence",
        "persistence",
        "run.error.persistence",
        "The run could not be started.",
        "reconcile",
        true,
      );
    }
    try {
      sess.manager?.reload();
    } catch (err) {
      return writeSubmitError(
        500,
        err,
        "session_reload_failed",
        "server_error",
        "persistence",
        "persistence",
        "run.error.sessionReloadFailed",
        "The session could not be reloaded.",
        "reconcile",
        true,
      );
    }
    sess.markDurableRun(runId);
    sess.beginRunBookkeeping(runId);
    if (server.runManager) {
      try {
        server.runManager.register(
          {
            id: runId,
            sessionId: sess.id,
            intentId: chatIntent.id,
            retryOf: "",
            attempt: 1,
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

    // Build extra context: system prompt handling
    let extraContext = sess.extraContext;
    if (extraContext === "") extraContext = server.extraContext;
    if (server.cfg?.systemPromptMode === "append" && systemMsgs.length > 0) {
      extraContext += "\n## Client Instructions\n" + systemMsgs.join("\n") +
        "\n";
    }

    const runtimeSettings = settingsForSession(server, sess);

    // Build request-specific agent inputs.
    let thinkingLevel = server.cfg?.defaultThinkingLevel ?? "";
    if (thinkingLevel === "") {
      thinkingLevel = server.settings?.defaultThinkingLevel ?? "";
    }

    let maxTokens = req.max_tokens ?? 0;
    if (maxTokens < 0) maxTokens = 0;
    if (
      maxTokens === 0 &&
      !(
        currentModel && currentModel.maxTokensSet &&
        currentModel.maxTokens === 0
      )
    ) {
      maxTokens = resolveMaxTokens(currentModel);
    }

    // Per-request temperature/top_p override (from OpenAI-compatible client)
    if (req.temperature !== undefined && currentModel) {
      currentModel.temperature = normalizeSamplingPtr(req.temperature);
    }
    if (req.top_p !== undefined && currentModel) {
      currentModel.topP = normalizeSamplingPtr(req.top_p);
    }

    // applySessionToolOptions calls syncSessionTools before this point. Tool
    // registration is therefore owned by the session runtime/capability layer,
    // not by mode selection or individual requests. The shared Runtime snapshots
    // the already-synchronized registry below.
    // Build the Agent through the shared SessionRuntime. Request-specific system
    // instructions and token limits remain per-run inputs; resource and sandbox
    // assembly stay Runtime-owned.
    let a: Agent;
    try {
      a = sess.runtime!.buildAgent({
        provider: currentProvider,
        providerName: server.providerName,
        model: currentModel,
        settings: runtimeSettings ?? undefined,
        allow: server.getAllow(),
        mode,
        extraContext,
        thinkingLevel,
        maxTokens,
        maxTokensSet: true,
        multiAgent: sess.multiAgent,
        delegateMode: sess.delegateMode,
        workflows: sess.workflows,
        getSteeringMessages: esmSteeringMessages(server, sess.id),
        intentId: chatIntent.id,
        runId,
        conversationTurnId: "turn-" + runId,
        conversationTurn: true,
        runtimeOwnsTurnEnd: true,
      });
    } catch (err) {
      return writeError(500, (err as Error).message, "server_error");
    }
    runAgentId = String(a.id());

    // Apply force compact flag from /compact command
    if (sess.forceCompact) {
      a.setForceCompact();
      sess.forceCompact = false;
    }

    const replayState = sess.manager!.getReplayState();
    if (!hadPersistedHistory && historyMsgs.length > 0) {
      // Seed brand-new sessions from client-provided history.
      const internalMsgs = convertHistoryMessages(historyMsgs);
      a.loadHistoryMessages(internalMsgs);
    }
    if (replayState.messages.length > 0) {
      a.loadHistoryState(replayState.messages, replayState.entryIDs);
    }

    // Setup request timeout
    const timeoutMs = (server.cfg?.requestTimeoutSecs ?? 0) * 1000;
    runAbort = new AbortController();
    timeoutTimer = setTimeout(() => {
      runAbort!.abort(new DOMException("deadline exceeded", "TimeoutError"));
    }, timeoutMs);
    if (!sess.attachRunAgent(runId, a, () => runAbort!.abort())) {
      a.abort();
      return writeError(
        409,
        "session run is being cancelled",
        "session_run_cancelling",
      );
    }
    if (
      (sess.multiAgent || sess.delegateMode || sess.workflows) &&
      sess.agentMgr
    ) {
      sess.agentMgr.register(newAgentAdapter(a));
      agentMgrRegistered = true;
    }

    // Run agent
    const rawEventCh = a.runWithUserMessage(lastUserMessage, runAbort.signal);
    let eventCh: AsyncIterable<Event> = rawEventCh;
    if (server.runManager) {
      try {
        server.runManager.setHook(runId, (ev: Event) => {
          if (ev.type === EventError && ev.error) {
            const info = classifyError(ev.error, { phase: PhaseModel });
            recordSessionRunEvent(
              server,
              sess,
              runId,
              "event_error",
              "failed",
              "agent",
              currentModel?.id ?? "",
              mode,
              { error: info, errorInfo: info },
            );
          }
        });
      } catch {
        // Go ignores the SetHook error (`_ =`).
      }
      let subscription: { events: AsyncIterable<Event>; cancel: () => void };
      try {
        subscription = server.runManager.subscribe(runId);
      } catch (err) {
        return writeError(500, (err as Error).message, "server_error");
      }
      eventCh = subscription.events;
      cancelSubscription = subscription.cancel;
      try {
        server.runManager.start(runId, rawEventCh);
      } catch (err) {
        return writeError(500, (err as Error).message, "server_error");
      }
    }

    // Use RunExecutor to process events and publish via EventBroker.
    // This replaces the old handleStreamingResponseWithAgent/handleNonStreamingResponseWithAgent
    // event loop with a unified executor that publishes to EventBroker.
    const executor = newRunExecutor(
      server,
      server.getEventBroker(),
      {
        id: runId,
        sessionId: sess.id,
        intentId: chatIntent.id,
        retryOf: "",
        attempt: 1,
        workDir: sess.workDir,
        source: runSource,
        model: currentModel?.id ?? "",
        mode,
        status: "running",
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

    if (req.stream) {
      // The SSE response is returned immediately; the ReadableStream start
      // replays Go's handleStreamingViaBroker ordering and the deferred
      // teardown runs when the stream is drained.
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const sink: SSEWriterSink = {
            write: (chunk) => {
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                // The client disconnected; keep draining the run.
              }
            },
          };
          try {
            const outcome = await handleStreamingViaBroker(
              server,
              sink,
              sess!,
              runId,
              currentModel?.id ?? "",
              executor,
              a,
              eventCh!,
              false,
            );
            terminalStatus = outcome.status;
            terminalErrMsg = outcome.errMsg;
            await finishChatRunOutcome(
              server,
              sess!,
              runId,
              outcome,
              a.getContextUsage(),
              runSource,
              mode,
              currentModel?.id ?? "",
              (ok) => {
                durableFinished = ok;
              },
            );
          } finally {
            await teardown();
            try {
              controller.close();
            } catch {
              // already closed by the platform after a client disconnect
            }
          }
        },
      });
      // Teardown ownership moves to the stream body's finally.
      deferTeardownToStream = true;
      return new Response(stream, { status: 200, headers: SSE_HEADERS });
    }

    const outcome = await handleNonStreamingViaBroker(
      server,
      sess,
      runId,
      currentModel?.id ?? "",
      executor,
      a,
      eventCh,
    );
    terminalStatus = outcome.status;
    terminalErrMsg = outcome.errMsg;
    await finishChatRunOutcome(
      server,
      sess,
      runId,
      outcome,
      a.getContextUsage(),
      runSource,
      mode,
      currentModel?.id ?? "",
      (ok) => {
        durableFinished = ok;
      },
    );
    return outcome.response ??
      writeError(500, "The run could not be completed.", "server_error");
  } finally {
    if (!deferTeardownToStream) await teardown();
  }
}

/**
 * Applies the shared terminal durable/event projection for one chat run (the
 * tail of Go's handleChatCompletions, identical for both stream modes).
 */
async function finishChatRunOutcome(
  server: Server,
  sess: APISession,
  runId: string,
  outcome: ChatOutcome,
  contextUsage: ReturnType<Agent["getContextUsage"]>,
  runSource: string,
  mode: string,
  modelId: string,
  setDurableFinished: (ok: boolean) => void,
): Promise<void> {
  const { usage, status, errMsg } = outcome;
  const eventData = withContextUsageEventData(
    usageEventData(usage, errMsg),
    contextUsage,
  );
  const execution = sess.executionRuntime();
  if (execution && sess.isDurableRun(runId)) {
    try {
      execution.recordUsage(runId, usage, contextUsage);
    } catch {
      // Go ignores the RecordUsage error (`_ =`).
    }
    try {
      await execution.finishDurableWithRetry(
        undefined,
        runId,
        webUIRunState(status, errMsg),
        errMsg,
        {
          sessionId: sess.id,
          runId,
          eventType: runEventTypeForStatus(status),
          source: runSource,
          status,
          model: modelId,
          mode,
          timestamp: new Date(),
          data: rawEventData(eventData),
        } satisfies RunEvent,
      );
      setDurableFinished(true);
    } catch {
      // Go treats a failed finish as "not durably finished".
    }
  } else {
    recordSessionRunEvent(
      server,
      sess,
      runId,
      runEventTypeForStatus(status),
      status,
      "chat_completion",
      modelId,
      mode,
      eventData,
    );
  }
}

/** decodeChatCompletionRequest ports Go's struct unmarshal + custom message decoding. */
function decodeChatCompletionRequest(
  raw: Record<string, unknown>,
): ChatCompletionRequest {
  const messagesRaw = raw.messages;
  if (messagesRaw !== undefined && !Array.isArray(messagesRaw)) {
    throw new Error(
      "json: cannot unmarshal messages into Go value of []RequestMessage",
    );
  }
  const messages: RequestMessage[] = Array.isArray(messagesRaw)
    ? messagesRaw.map(decodeRequestMessage)
    : [];
  return {
    model: typeof raw.model === "string" ? raw.model : undefined,
    messages,
    stream: typeof raw.stream === "boolean" ? raw.stream : undefined,
    temperature: typeof raw.temperature === "number"
      ? raw.temperature
      : undefined,
    top_p: typeof raw.top_p === "number" ? raw.top_p : undefined,
    max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
    x_background: typeof raw.x_background === "boolean"
      ? raw.x_background
      : undefined,
  };
}

export { cloneModel } from "./chat_support.ts";

/** safeRunResultMessage projects a RunResult into a client-safe message. */
export function safeRunResultMessage(result: RunResult | null): string {
  if (!result) return "The run could not be completed.";
  if (result.errorInfo) {
    const message = displayErrorMessage(result.errorInfo).trim();
    if (message !== "") return message;
  }
  if (result.status === "canceled" || result.status === "cancelled") {
    const lowered = result.error.toLowerCase();
    if (lowered.includes("deadline") || lowered.includes("timeout")) {
      return "The run timed out.";
    }
    return "The run was cancelled.";
  }
  const info = classifyError(
    result.error === "" ? null : new Error(result.error),
    { phase: PhaseModel, sideEffectState: SideEffectUnknown },
  );
  return displayErrorMessage(info);
}

// ---------------------------------------------------------------------------
// handleStreamingViaBroker
// ---------------------------------------------------------------------------

/**
 * handleStreamingViaBroker consumes agent events via RunExecutor and writes SSE
 * by subscribing to the EventBroker. The RunExecutor processes events (publishing
 * to EventBroker) while this function only converts BrokerEvent to SSE output.
 */
export async function handleStreamingViaBroker(
  server: Server,
  sink: SSEWriterSink,
  sess: APISession,
  _runId: string,
  modelId: string,
  executor: RunExecutor,
  a: Agent | null,
  rawEventCh: AsyncIterable<Event>,
  transcript: boolean,
): Promise<ChatOutcome> {
  const sessionId = sess.id;
  const sse = new SSEWriter(sink, modelId, sessionId);
  sse.writeRoleDelta();

  const toolDetail = server.cfg ? getToolDetail(server.cfg) : "";
  const totalUsage: CompletionUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const pendingTools = new Map<string, toolCallInfo>();

  // Subscribe to the EventBroker to receive processed events.
  const broker = server.getEventBroker();
  const { events: brokerEvents, cancel: brokerCancel } = broker.subscribe(
    sessionId,
  );
  try {
    // Run the executor concurrently so it processes events and publishes to the
    // broker (Go's goroutine).
    const execPromise = executor.execute(
      undefined,
      sess,
      a,
      rawEventCh,
      modelId,
      "",
      transcript,
    ).then(
      (result) => ({ kind: "done" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );

    // Consume broker events and convert to SSE until the executor finishes.
    let brokerNext: Promise<BrokerEvent | undefined> | null = null;
    for (;;) {
      const races: Promise<
        | { source: "exec"; value: ExecSettled }
        | { source: "broker"; value: BrokerEvent | undefined }
      >[] = [execPromise.then((value) => ({ source: "exec" as const, value }))];
      if (brokerNext === null) brokerNext = brokerEvents.next();
      races.push(
        brokerNext.then((value) => ({ source: "broker" as const, value })),
      );
      const winner = await Promise.race(races);
      if (winner.source === "exec") {
        if (winner.value.kind === "done") {
          const result = winner.value.result;
          // Executor finished; map the canonical run status to SSE output.
          executor.finalize(sess, result);
          if (result.usage) {
            Object.assign(totalUsage, result.usage);
          }
          switch (result.status) {
            case "failed": {
              const errMsg = safeRunResultMessage(result);
              sse.writeError(errMsg);
              break;
            }
            case "canceled":
              sse.writeDone(totalUsage);
              break;
            default:
              sse.writeDoneReason(totalUsage, "stop");
              break;
          }
          return {
            usage: totalUsage,
            status: result.status,
            errMsg: result.error,
          };
        }
        executor.finalize(sess, null);
        const info = classifyError(winner.value.err, {
          phase: PhaseTransport,
          sideEffectState: SideEffectUnknown,
        });
        const message = displayErrorMessage(info);
        sse.writeError(message);
        return { usage: totalUsage, status: "failed", errMsg: message };
      }
      brokerNext = null;
      const ev = winner.value;
      if (ev === undefined) {
        // Broker channel closed, executor may have finished.
        continue;
      }
      switch (ev.event) {
        case "transcript": {
          const tsEv = ev.data as TranscriptStreamEvent | undefined;
          if (
            tsEv && tsEv.type === "hosted_item" && tsEv.hostedItem
          ) {
            sse.writeHostedItem(tsEv.hostedItem);
          } else if (
            tsEv?.message &&
            (tsEv.message as { agentId?: string }).agentId === ""
          ) {
            sse.writeContentDelta(
              (tsEv.message as { content?: string }).content ?? "",
            );
          }
          break;
        }
        case "tool_event": {
          const toolEv = ev.data as ToolStatusEvent | undefined;
          if (!toolEv) break;
          if (toolEv.status === "running") {
            pendingTools.set(toolEv.toolCallId ?? "", {
              name: toolEv.tool,
              args: toolEv.args ?? null,
              result: "",
              diff: null,
              error: null,
              status: "running",
            });
            sse.writeContentDelta(
              formatToolRunning(toolEv.tool, toolEv.args ?? null),
            );
            break;
          }
          const callId = toolEv.toolCallId ?? "";
          let tc = pendingTools.get(callId);
          if (!tc) {
            tc = {
              name: toolEv.tool,
              args: toolEv.args ?? null,
              result: "",
              diff: null,
              error: null,
              status: "",
            };
          }
          tc.status = toolEv.status;
          tc.result = toolEv.summary ?? "";
          if (toolEv.isError) {
            tc.error = new Error("tool failed");
          }
          pendingTools.delete(callId);
          sse.writeToolResult(tc, toolDetail);
          break;
        }
        case "approval_request":
          // Approval requests are handled by registerSessionApproval in the RunExecutor.
          // The SSE writer can emit an approval request event if needed.
          break;
        case "run_event":
          // Run lifecycle events (started, finished, etc.) are for observers.
          break;
        case "done":
          // Stream done signal from the executor.
          // The actual termination is handled by the execDone/execErr channels.
          break;
      }
    }
  } finally {
    brokerCancel();
  }
}

// ---------------------------------------------------------------------------
// Direct event-stream projections (handleStreamingResponse*)
// ---------------------------------------------------------------------------

export function handleStreamingResponse(
  server: Server,
  sink: SSEWriterSink,
  signal: AbortSignal | undefined,
  eventCh: AsyncIterable<Event>,
  modelId: string,
  sessionId: string,
  transcript: boolean,
): Promise<ChatOutcome> {
  const sess = new APISession();
  sess.id = sessionId;
  return handleStreamingResponseWithAgent(
    server,
    sink,
    signal,
    eventCh,
    modelId,
    sess,
    null,
    transcript,
  );
}

export async function handleStreamingResponseWithAgent(
  server: Server,
  sink: SSEWriterSink,
  _signal: AbortSignal | undefined,
  eventCh: AsyncIterable<Event>,
  modelId: string,
  sess: APISession,
  runningAgent: Agent | null,
  transcript: boolean,
): Promise<ChatOutcome> {
  const sessionId = sess.id;
  const sse = new SSEWriter(sink, modelId, sessionId);
  sse.writeRoleDelta();

  const toolMode = server.cfg?.toolVisibility?.mode ?? "";
  const toolDetail = server.cfg ? getToolDetail(server.cfg) : "";
  const totalUsage: CompletionUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const xToolCalls: ToolCallSummary[] = [];
  let attachments: Attachment[] = [];
  // Track in-flight tool calls by callID so we can attach result/diff on end.
  const pendingTools = new Map<string, toolCallInfo>();

  for await (const ev of eventCh) {
    switch (ev.type) {
      case EventHostedItem: {
        if (ev.hostedItem) {
          const item = hostedItemEvent(ev.hostedItem);
          if (transcript) {
            writeTranscriptEvent(server, sse, sessionId, {
              type: "hosted_item",
              hostedItem: item ?? undefined,
            });
          } else {
            sse.writeHostedItem(item);
          }
        }
        break;
      }
      case EventTextDelta: {
        if (transcript) {
          writeTranscriptEvent(
            server,
            sse,
            sessionId,
            assistantDeltaTranscriptEvent(
              ev.textDelta ?? "",
              ev.agentId ?? "",
              ev,
            ),
          );
        }
        if ((ev.agentId ?? "") === "") {
          sse.writeContentDelta(ev.textDelta ?? "");
        }
        break;
      }
      case EventToolCall: {
        const { name, callID } = resolveToolEvent(ev);
        const tc: toolCallInfo = {
          name,
          args: ev.toolArgs ?? null,
          result: "",
          diff: null,
          error: null,
          status: "running",
        };
        if (callID !== "") pendingTools.set(callID, tc);
        xToolCalls.push({ name, args: ev.toolArgs, status: "running" });
        publishToolEvent(server, sessionId, {
          tool: name,
          toolCallId: callID,
          agentId: String(ev.agentId ?? ""),
          status: "running",
          args: ev.toolArgs,
        });
        if (transcript) {
          writeTranscriptEvent(
            server,
            sse,
            sessionId,
            messageTranscriptEvent(transcriptToolCallEntry(name, callID, ev)),
          );
        } else {
          switch (toolMode) {
            case "content":
              sse.writeContentDelta(
                formatToolRunning(name, ev.toolArgs ?? null),
              );
              break;
            case "sse_event":
              sse.writeToolStatusEvent({
                tool: name,
                toolCallId: callID,
                agentId: String(ev.agentId ?? ""),
                status: "running",
                args: ev.toolArgs,
              });
              break;
          }
        }
        break;
      }
      case EventToolExecutionEnd: {
        const status = ev.toolError ? "failed" : "completed";
        // Update xToolCalls status
        for (let i = xToolCalls.length - 1; i >= 0; i--) {
          if (
            xToolCalls[i].name === ev.toolName &&
            xToolCalls[i].status === "running"
          ) {
            xToolCalls[i].status = status;
            break;
          }
        }
        // Build expanded output
        let tc = ev.toolCallId ? pendingTools.get(ev.toolCallId) : undefined;
        if (!tc) {
          tc = {
            name: ev.toolName ?? "",
            args: ev.toolArgs ?? null,
            result: "",
            diff: null,
            error: null,
            status: "",
          };
        }
        tc.status = status;
        tc.result = ev.toolResult ?? "";
        tc.diff = ev.toolDiff ?? null;
        tc.error = ev.toolError ?? null;
        if (ev.toolCallId) pendingTools.delete(ev.toolCallId);
        const name = ev.toolName || tc.name;
        publishToolEvent(server, sessionId, {
          tool: name,
          toolCallId: ev.toolCallId,
          agentId: String(ev.agentId ?? ""),
          status,
          args: tc.args ?? undefined,
          summary: toolStatusSummary(ev.toolResult ?? "", ev.toolError),
          isError: !!ev.toolError,
          hasDetail: ev.toolCallId !== "",
        });
        if (transcript) {
          writeTranscriptEvent(
            server,
            sse,
            sessionId,
            messageTranscriptEvent(transcriptToolResultEntry(name, ev, status)),
          );
        } else {
          switch (toolMode) {
            case "content":
              sse.writeToolResult(tc, toolDetail);
              break;
            case "sse_event":
              sse.writeToolStatusEvent({
                tool: name,
                toolCallId: ev.toolCallId,
                agentId: String(ev.agentId ?? ""),
                status,
                args: tc.args ?? undefined,
                summary: toolStatusSummary(ev.toolResult ?? "", ev.toolError),
                isError: !!ev.toolError,
                hasDetail: ev.toolCallId !== "",
              });
              break;
          }
        }
        break;
      }
      case EventToolApprovalRequest: {
        const request = registerSessionApproval(server, sess, runningAgent, ev);
        if (request) sse.writeApprovalRequest(request);
        break;
      }
      case EventUsage: {
        if (ev.usage) {
          totalUsage.prompt_tokens += totalInputTokens(ev.usage);
          totalUsage.completion_tokens += ev.usage.output;
          totalUsage.cache_read_tokens = (totalUsage.cache_read_tokens ?? 0) +
            ev.usage.cacheRead;
          totalUsage.cache_write_tokens = (totalUsage.cache_write_tokens ?? 0) +
            ev.usage.cacheWrite;
          totalUsage.total_tokens = totalUsage.prompt_tokens +
            totalUsage.completion_tokens;
        }
        break;
      }
      case EventRetry: {
        if ((ev.retryMaxTokens ?? 0) > 0) {
          const message =
            `Output limit reached; retrying with ${ev.retryMaxTokens} max tokens`;
          if (transcript) {
            writeTranscriptEvent(
              server,
              sse,
              sessionId,
              assistantDeltaTranscriptEvent("\n\n[Retry: " + message + "]", ""),
            );
          }
          sse.writeStatusEvent(message);
        }
        break;
      }
      case EventRunFinished: {
        if ((ev.agentId ?? "") !== "") {
          if (transcript) {
            writeTranscriptEvent(
              server,
              sse,
              sessionId,
              subAgentStatusTranscriptEvent(
                ev.agentId ?? "",
                subAgentStatusForTaskStatus(ev.status ?? "done"),
                safeAgentErrorMessage(ev.error),
                ev,
              ),
            );
          }
          continue;
        }
        switch (ev.status) {
          case TaskFailed: {
            const errMsg = safeAgentErrorMessage(ev.error);
            if (transcript) {
              writeTranscriptEvent(
                server,
                sse,
                sessionId,
                assistantDeltaTranscriptEvent(
                  "\n\n[Error: " + errMsg + "]",
                  "",
                ),
              );
            }
            sse.writeError(errMsg);
            return { usage: totalUsage, status: "failed", errMsg };
          }
          case TaskCanceled: {
            const errMsg = safeAgentErrorMessage(ev.error);
            sse.writeDone(totalUsage);
            return { usage: totalUsage, status: "canceled", errMsg };
          }
          case TaskIncomplete:
          case TaskSuccess: {
            attachments = ev.attachments ? [...ev.attachments] : [];
            sse.writeAttachments(attachments);
            const finishReason =
              isOutputTruncationStopReason(ev.stopReason ?? "")
                ? "length"
                : "stop";
            sse.writeDoneReason(totalUsage, finishReason);
            if (ev.status === TaskIncomplete) {
              return { usage: totalUsage, status: "incomplete", errMsg: "" };
            }
            return { usage: totalUsage, status: "completed", errMsg: "" };
          }
        }
        break;
      }
      case EventDone: {
        if ((ev.agentId ?? "") !== "") {
          if (transcript) {
            writeTranscriptEvent(
              server,
              sse,
              sessionId,
              subAgentStatusTranscriptEvent(ev.agentId ?? "", "done", "", ev),
            );
          }
          continue;
        }
        attachments = ev.attachments ? [...ev.attachments] : [];
        sse.writeAttachments(attachments);
        const finishReason = isOutputTruncationStopReason(ev.stopReason ?? "")
          ? "length"
          : "stop";
        sse.writeDoneReason(totalUsage, finishReason);
        return { usage: totalUsage, status: "completed", errMsg: "" };
      }
      case EventError: {
        if ((ev.agentId ?? "") !== "") {
          if (transcript) {
            writeTranscriptEvent(
              server,
              sse,
              sessionId,
              subAgentStatusTranscriptEvent(
                ev.agentId ?? "",
                "error",
                safeAgentErrorMessage(ev.error),
                ev,
              ),
            );
          }
          continue;
        }
        if (ev.error && isContextCanceled(ev.error)) {
          sse.writeDone(totalUsage);
          return {
            usage: totalUsage,
            status: "canceled",
            errMsg: safeAgentErrorMessage(ev.error),
          };
        }
        // An error event without an error payload is a protocol violation,
        // never a successful completion.
        const errMsg = safeAgentErrorMessage(ev.error);
        if (transcript) {
          writeTranscriptEvent(
            server,
            sse,
            sessionId,
            assistantDeltaTranscriptEvent("\n\n[Error: " + errMsg + "]", ""),
          );
        }
        sse.writeError(errMsg);
        return { usage: totalUsage, status: "failed", errMsg };
      }
      default:
        break;
    }
  }
  // Channel closed without a terminal event — protocol failure, never success.
  sse.writeError("event stream closed without terminal result");
  return {
    usage: totalUsage,
    status: "failed",
    errMsg: "event stream closed without terminal result",
  };
}

// ---------------------------------------------------------------------------
// handleNonStreamingViaBroker
// ---------------------------------------------------------------------------

/**
 * handleNonStreamingViaBroker runs the executor, waits for completion, and writes
 * a single JSON response. No SSE streaming is needed.
 */
export async function handleNonStreamingViaBroker(
  server: Server,
  sess: APISession,
  _runId: string,
  modelId: string,
  executor: RunExecutor,
  a: Agent | null,
  rawEventCh: AsyncIterable<Event>,
): Promise<NonStreamingOutcome> {
  const sessionId = sess.id;
  const totalUsage: CompletionUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const toolMode = server.cfg?.toolVisibility?.mode ?? "";
  const toolDetail = server.cfg ? getToolDetail(server.cfg) : "";

  // Subscribe to the EventBroker to accumulate content and tool calls.
  const broker = server.getEventBroker();
  const { events: brokerEvents, cancel: brokerCancel } = broker.subscribe(
    sessionId,
  );

  const sb: string[] = [];
  const xToolCalls: ToolCallSummary[] = [];
  const pendingTools = new Map<string, toolCallInfo>();

  try {
    // Run the executor concurrently (Go's goroutine).
    const execPromise = executor.execute(
      undefined,
      sess,
      a,
      rawEventCh,
      modelId,
      "",
      true,
    ).then(
      (result) => ({ kind: "done" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );

    let brokerNext: Promise<BrokerEvent | undefined> | null = null;
    for (;;) {
      const races: Promise<
        | { source: "exec"; value: ExecSettled }
        | { source: "broker"; value: BrokerEvent | undefined }
      >[] = [execPromise.then((value) => ({ source: "exec" as const, value }))];
      if (brokerNext === null) brokerNext = brokerEvents.next();
      races.push(
        brokerNext.then((value) => ({ source: "broker" as const, value })),
      );
      const winner = await Promise.race(races);
      if (winner.source === "exec") {
        if (winner.value.kind === "done") {
          const result = winner.value.result;
          executor.finalize(sess, result);
          if (result.usage) {
            Object.assign(totalUsage, result.usage);
          }
          switch (result.status) {
            case "failed": {
              const msg = result.error === "" ? "run failed" : result.error;
              return {
                response: writeError(500, msg, "server_error"),
                usage: totalUsage,
                status: result.status,
                errMsg: msg,
              };
            }
            case "canceled": {
              const msg = result.error === "" ? "run canceled" : result.error;
              return {
                response: writeError(409, msg, "request_canceled"),
                usage: totalUsage,
                status: result.status,
                errMsg: msg,
              };
            }
            case "incomplete": {
              xToolCalls.length = 0;
              xToolCalls.push(...result.toolCalls);
              return {
                response: writeJSON(
                  200,
                  completionResponse(
                    newCompletionID(),
                    sb.join(""),
                    modelId,
                    totalUsage,
                    "length",
                  ),
                ),
                usage: totalUsage,
                status: result.status,
                errMsg: result.error,
              };
            }
          }
          xToolCalls.length = 0;
          xToolCalls.push(...result.toolCalls);
          return {
            response: writeJSON(
              200,
              completionResponse(
                newCompletionID(),
                sb.join(""),
                modelId,
                totalUsage,
                "stop",
              ),
            ),
            usage: totalUsage,
            status: result.status,
            errMsg: result.error,
          };
        }
        executor.finalize(sess, null);
        const errMsg = safeAgentErrorMessage(winner.value.err);
        return {
          response: writeError(500, errMsg, "server_error"),
          usage: totalUsage,
          status: "failed",
          errMsg,
        };
      }
      brokerNext = null;
      const ev = winner.value;
      if (ev === undefined) continue;
      switch (ev.event) {
        case "transcript": {
          const tsEv = ev.data as TranscriptStreamEvent | undefined;
          if (
            tsEv?.message &&
            (tsEv.message as { agentId?: string }).agentId === ""
          ) {
            sb.push((tsEv.message as { content?: string }).content ?? "");
          }
          break;
        }
        case "tool_event": {
          const toolEv = ev.data as ToolStatusEvent | undefined;
          if (!toolEv) break;
          if (toolEv.status === "running") {
            const tc: toolCallInfo = {
              name: toolEv.tool,
              args: toolEv.args ?? null,
              result: "",
              diff: null,
              error: null,
              status: "running",
            };
            if (toolEv.toolCallId) pendingTools.set(toolEv.toolCallId, tc);
            xToolCalls.push({
              name: toolEv.tool,
              args: toolEv.args,
              status: "running",
            });
          } else {
            const callId = toolEv.toolCallId ?? "";
            let tc = pendingTools.get(callId);
            if (!tc) {
              tc = {
                name: toolEv.tool,
                args: toolEv.args ?? null,
                result: "",
                diff: null,
                error: null,
                status: "",
              };
            }
            tc.status = toolEv.status;
            pendingTools.delete(callId);
            for (let i = xToolCalls.length - 1; i >= 0; i--) {
              if (
                xToolCalls[i].name === toolEv.tool &&
                xToolCalls[i].status === "running"
              ) {
                xToolCalls[i].status = toolEv.status;
                break;
              }
            }
            if (toolMode === "content" && toolEv.agentId === "") {
              sb.push(formatToolResult(tc, toolDetail));
            }
          }
          break;
        }
        case "done":
          // Handled by the executor outcome.
          break;
      }
    }
  } finally {
    brokerCancel();
  }
}

// ---------------------------------------------------------------------------
// Direct event-stream projections (handleNonStreamingResponse*)
// ---------------------------------------------------------------------------

export function handleNonStreamingResponse(
  server: Server,
  eventCh: AsyncIterable<Event>,
  modelId: string,
  sessionId: string,
): Promise<NonStreamingOutcome> {
  const sess = new APISession();
  sess.id = sessionId;
  return handleNonStreamingResponseWithAgent(
    server,
    eventCh,
    modelId,
    sess,
    null,
  );
}

export async function handleNonStreamingResponseWithAgent(
  server: Server,
  eventCh: AsyncIterable<Event>,
  modelId: string,
  sess: APISession,
  runningAgent: Agent | null,
): Promise<NonStreamingOutcome> {
  const sessionId = sess.id;
  const sb: string[] = [];
  const totalUsage: CompletionUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const xToolCalls: ToolCallSummary[] = [];
  const toolMode = server.cfg?.toolVisibility?.mode ?? "";
  const toolDetail = server.cfg ? getToolDetail(server.cfg) : "";
  const pendingTools = new Map<string, toolCallInfo>();
  let sawTerminal = false;

  for await (const ev of eventCh) {
    switch (ev.type) {
      case EventTextDelta: {
        if ((ev.agentId ?? "") === "") sb.push(ev.textDelta ?? "");
        break;
      }
      case EventToolCall: {
        const { name, callID } = resolveToolEvent(ev);
        const tc: toolCallInfo = {
          name,
          args: ev.toolArgs ?? null,
          result: "",
          diff: null,
          error: null,
          status: "running",
        };
        if (callID !== "") pendingTools.set(callID, tc);
        xToolCalls.push({ name, args: ev.toolArgs, status: "running" });
        publishToolEvent(server, sessionId, {
          tool: name,
          toolCallId: callID,
          agentId: String(ev.agentId ?? ""),
          status: "running",
          args: ev.toolArgs,
        });
        break;
      }
      case EventToolExecutionEnd: {
        const status = ev.toolError ? "failed" : "completed";
        for (let i = xToolCalls.length - 1; i >= 0; i--) {
          if (
            xToolCalls[i].name === ev.toolName &&
            xToolCalls[i].status === "running"
          ) {
            xToolCalls[i].status = status;
            break;
          }
        }
        // Build expanded output for content/none mode
        let tc = ev.toolCallId ? pendingTools.get(ev.toolCallId) : undefined;
        if (!tc) {
          tc = {
            name: ev.toolName ?? "",
            args: ev.toolArgs ?? null,
            result: "",
            diff: null,
            error: null,
            status: "",
          };
        }
        tc.status = status;
        tc.result = ev.toolResult ?? "";
        tc.diff = ev.toolDiff ?? null;
        tc.error = ev.toolError ?? null;
        if (ev.toolCallId) pendingTools.delete(ev.toolCallId);
        const name = ev.toolName || tc.name;
        publishToolEvent(server, sessionId, {
          tool: name,
          toolCallId: ev.toolCallId,
          agentId: String(ev.agentId ?? ""),
          status,
          args: tc.args ?? undefined,
          summary: toolStatusSummary(ev.toolResult ?? "", ev.toolError),
          isError: !!ev.toolError,
          hasDetail: ev.toolCallId !== "",
        });
        if (toolMode === "content" && (ev.agentId ?? "") === "") {
          sb.push(formatToolResult(tc, toolDetail));
        }
        break;
      }
      case EventToolApprovalRequest:
        registerSessionApproval(server, sess, runningAgent, ev);
        break;
      case EventUsage: {
        if (ev.usage) {
          totalUsage.prompt_tokens += totalInputTokens(ev.usage);
          totalUsage.completion_tokens += ev.usage.output;
          totalUsage.cache_read_tokens = (totalUsage.cache_read_tokens ?? 0) +
            ev.usage.cacheRead;
          totalUsage.cache_write_tokens = (totalUsage.cache_write_tokens ?? 0) +
            ev.usage.cacheWrite;
          totalUsage.total_tokens = totalUsage.prompt_tokens +
            totalUsage.completion_tokens;
        }
        break;
      }
      case EventRunFinished: {
        if ((ev.agentId ?? "") !== "") continue;
        sawTerminal = true;
        switch (ev.status) {
          case TaskFailed: {
            const msg = safeAgentErrorMessage(ev.error);
            return {
              response: writeError(500, msg, "server_error"),
              usage: totalUsage,
              status: "failed",
              errMsg: msg,
            };
          }
          case TaskCanceled: {
            const msg = safeAgentErrorMessage(ev.error);
            // Go returns without writing a response on this legacy path.
            return {
              response: null,
              usage: totalUsage,
              status: "canceled",
              errMsg: msg,
            };
          }
        }
        // success/incomplete: keep consuming; the completion response is built
        // after the stream closes.
        break;
      }
      case EventDone: {
        if ((ev.agentId ?? "") === "") sawTerminal = true;
        break;
      }
      case EventError: {
        if ((ev.agentId ?? "") !== "") continue;
        sawTerminal = true;
        if (ev.error) {
          if (isContextCanceled(ev.error)) {
            return {
              response: null,
              usage: totalUsage,
              status: "canceled",
              errMsg: safeAgentErrorMessage(ev.error),
            };
          }
          const errMsg = safeAgentErrorMessage(ev.error);
          return {
            response: writeError(500, errMsg, "server_error"),
            usage: totalUsage,
            status: "failed",
            errMsg,
          };
        }
        // An error event without an error payload is a protocol violation,
        // never a successful completion.
        return {
          response: writeError(
            500,
            "error event without error detail",
            "server_error",
          ),
          usage: totalUsage,
          status: "failed",
          errMsg: "error event without error detail",
        };
      }
      default:
        break;
    }
  }

  if (!sawTerminal) {
    // Channel closed without a terminal event — protocol failure, never success.
    return {
      response: writeError(
        500,
        "event stream closed without terminal result",
        "server_error",
      ),
      usage: totalUsage,
      status: "failed",
      errMsg: "event stream closed without terminal result",
    };
  }

  return {
    response: writeJSON(
      200,
      completionResponse(
        newCompletionID(),
        sb.join(""),
        modelId,
        totalUsage,
        "stop",
      ),
    ),
    usage: totalUsage,
    status: "completed",
    errMsg: "",
  };
}

function completionResponse(
  id: string,
  content: string,
  modelId: string,
  usage: CompletionUsage,
  finishReason: string,
): ChatCompletionResponse {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

/** Zero usage for command responses (Go's &CompletionUsage{}). */
function zeroUsage(): CompletionUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

// ---------------------------------------------------------------------------
// Command responses
// ---------------------------------------------------------------------------

export function writeCommandResponse(
  _server: Server,
  result: CommandResult,
  modelId: string,
  _sessionId: string,
  _cmd: string,
): Response {
  return writeJSON(
    200,
    completionResponse(
      newCommandCompletionID(),
      result.message,
      modelId,
      zeroUsage(),
      "stop",
    ),
  );
}

export function writeCommandResponseStreaming(
  server: Server,
  sink: SSEWriterSink,
  result: CommandResult,
  modelId: string,
  sessionId: string,
  _cmd: string,
  transcript: boolean,
): void {
  const sse = new SSEWriter(sink, modelId, sessionId);
  sse.writeRoleDelta();
  if (transcript) {
    writeTranscriptEvent(
      server,
      sse,
      sessionId,
      assistantDeltaTranscriptEvent(result.message, ""),
    );
  }
  sse.writeContentDelta(result.message);
  sse.writeDone({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}
