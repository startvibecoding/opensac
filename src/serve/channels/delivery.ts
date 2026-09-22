// Ported from internal/serve/channels/dispatcher.go — the message-delivery
// path: HandleMessage/HandleDelivery, the delivery projection and its durable
// outbox controller, session resolution/rotation, the per-run Agent build and
// the synchronous run loop, provider-attachment materialization, the A2A
// master tool, and the slash-command surface. The Go Dispatcher methods map to
// functions that take the Dispatcher first (a TS class cannot be spread across
// the Go package's files, mirroring the openaiapi projection).
//
// Deviations: Go's context.Context maps to an AbortSignal (`AbortError` ↔
// context.Canceled, `TimeoutError` ↔ context.DeadlineExceeded); Go's
// `incompleteRunError` maps to the `IncompleteRunError` marker class; the
// event channel maps to an async iteration; Go's sync mutex critical sections
// collapse (single-threaded event loop) while the session mutex maps to an
// async CountedMutex; Go's error wrapping maps to thrown errors and the
// `cause` chain.

import { createHash } from "node:crypto";
import {
  type Agent,
  EventAgentStart,
  EventBudgetPressure,
  EventCompactionEnd,
  EventCompactionStart,
  EventContextPressure,
  EventDone,
  EventError,
  EventHostedItem,
  EventQuestionRequest,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  EventTurnEnd,
  newAgentAdapter,
  registerDelegateSubAgentTool,
  registerSubAgentTools,
  subAgentToolNames,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../../agent/mod.ts";
import type {
  AfterToolCallContext,
  ToolCallResult,
} from "../../agent/agent.ts";
import {
  acquireExecutionAdmission,
  attachSessionResources,
  classifyError,
  createSession,
  DecisionQuestion,
  DeliveryCoordinator,
  deliveryOperationText,
  type DeliveryPlan,
  displayErrorMessage,
  type ErrorInfo,
  ExecutionRuntime,
  findIdempotentRun,
  getDurableRun,
  idempotencyKeyFingerprint,
  type InputSubmission,
  inspectSessionExecution,
  loadContextResources,
  openSession,
  PhaseContext,
  PhaseModel,
  PhasePersistence,
  PhaseTransport,
  planDelivery,
  type PlanDeliveryResult,
  resourceIds,
  type RunEvent,
  RunStore,
  type SessionAttachment,
  SessionExecutionIdle,
  SessionExecutionReserved,
  type SessionExecutionSnapshot,
  sessionHasTeamExpert,
  SessionRunEventSink,
  type SessionStopResult,
  sourceFromChannelType,
} from "../../agentruntime/mod.ts";
import { acquireSessionMutation } from "../../agentruntime/execution_admission.ts";
import {
  SessionStopAccepted,
  SessionStopNoActiveRun,
  SessionStopOwnedElsewhere,
  SessionStopRecoveryStarted,
  SessionStopRemoteAccepted,
  SessionStopRemoteUnsupported,
  SessionStopReserved,
} from "../../agentruntime/execution_stop.ts";
import { type ArtifactCollector } from "../../agentruntime/artifact.ts";
import { buildRegistry } from "../../agentruntime/registry.ts";
import { newRunContext } from "../../agent/run_context.ts";
import type { Registry, ToolContext } from "../../tools/tool.ts";
import {
  type A2ADispatcher,
  A2ADispatchTool,
  type AgentEntry,
} from "../../tools/mod.ts";
import { newA2AManager } from "../../a2a/master.ts";
import { newCronTool } from "../../cron/tool.ts";
import { newSessionScopedStoreWithWorkDir } from "../../cron/session_store.ts";
import { MemoryTool } from "../../memory/tool.ts";
import { Store as MemoryStore } from "../../memory/store.ts";
import { registerWorkflowTools } from "../../workflow/tools.ts";
import { Level, newManagerWithOptions } from "../../sandbox/sandbox.ts";
import { sandboxOptionsFromSettings } from "../../agentruntime/session_runtime.ts";
import {
  findBinding,
  generateID,
  getChannelToolGeneration,
  listChannelTools,
  type Manager as SessionManager,
  rotateBoundSession,
  runUserEntryID,
} from "../../session/mod.ts";
import {
  type DeliveryOperation,
  ErrDeliveryOperationBusy,
  getDeliveryOperation,
} from "../../session/delivery_store.ts";
import type { Attachment, Message } from "../../provider/mod.ts";
import {
  type InboundMessage,
  type MessageResponse,
  type OutboundAttachment,
  type OutboundText,
} from "../../messaging/platform.ts";
import { formatAttachmentSummary } from "../runtime/attachments.ts";
import {
  channelDeliveryCapability,
  channelFailureInfo,
  channelMessageIdempotencyKey,
  channelRunState,
  channelSafeSubAgentEvent,
  effectiveChannelMode,
  formatRetryProgress,
  formatToolProgress,
  IncompleteRunError,
  isIncompleteRunError,
  newChannelRunFailure,
} from "./run_helpers.ts";
import {
  type AgentApprovalHandler,
  channelAttachmentIngresses,
  channelRunSource,
  ChannelSession,
  type ChannelSessionLease,
  type ChannelToolDefinition,
  type Dispatcher,
  ErrSessionRunBusy,
  esmSteeringMessages,
  isMultiAgentToolName,
  loadA2AAgentList,
} from "./dispatcher.ts";
import { defaultConfig, withConfigMethods } from "./config.ts";
import { sessionKey } from "./session_paths.ts";
import { reconcileCompletedBackgroundRun } from "./background_recovery.ts";
import {
  clearChannelDecisions,
  messagingApprovalHandler,
  persistChannelDecision,
  persistChannelDecisionRequestWithDeadline,
  registerChannelDecision,
} from "./decision_persistence.ts";
import type {
  BackgroundRequest,
  BackgroundSubmitter,
} from "../runtime/background.ts";
/** ChannelRunResult carries the text/artifact projection of one channel run. */
export interface ChannelRunResult {
  text: string;
  artifacts: SessionAttachment[];
}

// --- Delivery controller -----------------------------------------------------

/**
 * ChannelDeliveryController bridges the Runtime delivery outbox and a platform
 * transport. Claims fence every state change; the platform sees only Prepare /
 * Progress / Complete closures over already-authorized content.
 */
export class ChannelDeliveryController {
  #coordinator: DeliveryCoordinator;
  #claims = new Map<string, DeliveryOperation>();

  constructor(sessionDir: string) {
    this.#coordinator = new DeliveryCoordinator(
      sessionDir,
      "channel-delivery-" + generateID(),
    );
  }

  get coordinatorOwner(): string {
    return this.#coordinator.owner;
  }

  claim(
    _signal: AbortSignal | undefined,
    operationID: string,
  ): Promise<DeliveryOperation | null> {
    if (operationID.trim() === "") return Promise.resolve(null);
    const existing = this.#claims.get(operationID);
    if (existing !== undefined) return Promise.resolve({ ...existing });
    let claimed: DeliveryOperation;
    try {
      claimed = this.#coordinator.claim(operationID, new Date());
    } catch (err) {
      if (err === ErrDeliveryOperationBusy) {
        try {
          const current = getDeliveryOperation(
            this.#coordinator.sessionDir,
            operationID,
          );
          if (
            current !== null &&
            (current.status === "delivered" || current.status === "unsupported")
          ) {
            return Promise.resolve(current);
          }
        } catch {
          // fall through to the original error
        }
      }
      throw err;
    }
    this.#claims.set(operationID, claimed);
    return Promise.resolve({ ...claimed });
  }

  complete(
    _signal: AbortSignal | undefined,
    operation: DeliveryOperation | null,
    status: string,
    providerMessageID: string,
    failureCode: string,
  ): void {
    if (
      operation === null || operation === undefined ||
      operation.leaseOwner !== this.#coordinator.owner ||
      operation.leaseEpoch <= 0
    ) {
      return;
    }
    try {
      this.#coordinator.complete(operation, {
        status,
        providerAssetId: operation.providerAssetId,
        providerMessageId: providerMessageID,
        providerState: operation.providerState,
        failureCode,
        nextAttemptAt: null,
      });
    } catch (err) {
      console.error(
        `[channels] update delivery operation ${operation.id}: ${err}`,
      );
    }
    this.#claims.delete(operation.id);
  }

  progress(
    _signal: AbortSignal | undefined,
    operation: DeliveryOperation | null,
    status: string,
    providerAssetID: string,
    providerMessageID: string,
    providerState: string,
    failureCode: string,
  ): void {
    if (
      operation === null || operation === undefined ||
      operation.leaseOwner !== this.#coordinator.owner ||
      operation.leaseEpoch <= 0
    ) {
      return;
    }
    try {
      this.#coordinator.progress(operation, {
        status,
        providerAssetId: providerAssetID,
        providerMessageId: providerMessageID,
        providerState,
        failureCode,
        nextAttemptAt: null,
      });
    } catch (err) {
      console.error(
        `[channels] checkpoint delivery operation ${operation.id}: ${err}`,
      );
    }
    operation.status = status;
    operation.providerAssetId = providerAssetID;
    operation.providerMessageId = providerMessageID;
    operation.providerState = providerState;
  }

  textProjection(
    operation: DeliveryOperation,
    intent: DeliveryPlan["intent"],
    text: string,
  ): OutboundText {
    const transport = decodeTransportContext(intent.transportContext);
    return {
      id: operation.id,
      runID: intent.runId,
      targetID: intent.targetId,
      replyMessageID: intent.replyMessageId,
      replyContext: transport.replyContext,
      text,
      prepare: (signal) => this.claim(signal, operation.id).then(() => {}),
      complete: (
        signal,
        status,
        providerMessageID,
        failureCode,
      ) => {
        void (async () => {
          let claimed: DeliveryOperation | null;
          try {
            claimed = await this.claim(signal, operation.id);
          } catch (err) {
            console.error(
              `[channels] claim text operation ${operation.id}: ${err}`,
            );
            return;
          }
          this.complete(
            signal,
            claimed,
            status,
            providerMessageID,
            failureCode,
          );
        })();
      },
    };
  }

  attachmentProjection(
    runtime: NonNullable<ChannelSession["runtime"]>,
    artifact: SessionAttachment,
    upload: DeliveryOperation,
    send: DeliveryOperation,
    intent: DeliveryPlan["intent"],
  ): OutboundAttachment {
    const transport = decodeTransportContext(intent.transportContext);
    let prepared = false;
    const prepare = (signal: AbortSignal): Promise<void> => {
      if (prepared) return Promise.resolve();
      return (async () => {
        if (upload.id !== "") {
          await this.claim(signal, upload.id);
        }
        prepared = true;
      })();
    };
    return {
      id: artifact.id,
      runID: intent.runId,
      targetID: intent.targetId,
      replyContext: transport.replyContext,
      uploadOperationID: upload.id,
      sendOperationID: send.id,
      providerAssetID: upload.providerAssetId,
      providerState: encodeProviderState(upload.providerState),
      kind: artifact.kind,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      prepare,
      progressUpload: (
        signal,
        status,
        providerAssetID,
        providerState,
        failureCode,
      ) => {
        void (async () => {
          try {
            const uploadClaim = await this.claim(signal, upload.id);
            if (uploadClaim !== null) {
              this.progress(
                signal,
                uploadClaim,
                status,
                providerAssetID,
                "",
                providerState,
                failureCode,
              );
            }
          } catch {
            // Go ignores the claim error in this projection too.
          }
        })();
      },
      completeUpload: (
        signal,
        status,
        providerAssetID,
        providerState,
        failureCode,
      ) => {
        void (async () => {
          try {
            const uploadClaim = await this.claim(signal, upload.id);
            if (uploadClaim !== null) {
              uploadClaim.providerAssetId = providerAssetID;
              uploadClaim.providerState = providerState;
              this.complete(signal, uploadClaim, status, "", failureCode);
            }
          } catch {
            // ignored
          }
        })();
      },
      prepareSend: (signal) => this.claim(signal, send.id).then(() => {}),
      completeSend: (
        signal,
        status,
        providerMessageID,
        providerState,
        failureCode,
      ) => {
        void (async () => {
          try {
            const sendClaim = await this.claim(signal, send.id);
            if (sendClaim !== null) {
              sendClaim.providerState = providerState;
              this.complete(
                signal,
                sendClaim,
                status,
                providerMessageID,
                failureCode,
              );
            }
          } catch {
            // ignored
          }
        })();
      },
      open: (signal) =>
        (async () => {
          const opened = await runtime.attachments!.Open(
            artifact.sessionId,
            artifact.id,
          );
          void signal;
          return opened.file.readable;
        })(),
      complete: (signal, status, providerMessageID, failureCode) => {
        void (async () => {
          try {
            const uploadClaim = await this.claim(signal, upload.id);
            if (uploadClaim !== null) {
              this.complete(signal, uploadClaim, status, "", failureCode);
            }
          } catch {
            // ignored
          }
          try {
            const sendClaim = await this.claim(signal, send.id);
            if (sendClaim !== null) {
              this.complete(
                signal,
                sendClaim,
                status,
                providerMessageID,
                failureCode,
              );
            }
          } catch {
            // ignored
          }
        })();
      },
    };
  }
}

interface TransportContext {
  replyContext: string;
}

function decodeTransportContext(raw: unknown): TransportContext {
  const payload = raw as { replyContext?: unknown } | null | undefined;
  return {
    replyContext: typeof payload?.replyContext === "string"
      ? payload.replyContext
      : "",
  };
}

function encodeProviderState(state: unknown): Uint8Array {
  const value = state === undefined || state === null ? "" : state;
  return new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

// --- Route identity -----------------------------------------------------------

/**
 * channelRouteID returns the stable conversation identity used for channel
 * sessions and outbound delivery. Feishu provides both an open_id (sender) and
 * a chat_id (conversation); bindings must use the latter because the Feishu API
 * sends with receive_id_type=chat_id. WeChat currently uses the same value for
 * both fields, and other transports retain their user ID.
 */
export function channelRouteID(msg: InboundMessage): string {
  if (
    (msg.platform === "feishu" || msg.platform === "wechat") &&
    msg.chatID !== ""
  ) {
    return msg.chatID;
  }
  return msg.userID;
}

// --- HandleMessage / HandleDelivery --------------------------------------------

/** HandleMessage is the text-only projection of HandleDelivery. */
export async function handleMessage(
  d: Dispatcher,
  signal: AbortSignal,
  msg: InboundMessage,
): Promise<string> {
  const response = await handleDelivery(d, signal, msg);
  // Text-only embedding callers predate MessageResponse. They cannot execute
  // native media operations, so terminalize those pending records explicitly
  // instead of leaving a replayable delivery in limbo.
  if (response.attachments && response.attachments.length > 0) {
    let text = response.text;
    if (text !== "") text += "\n\n";
    text +=
      "Generated attachments are available in the OpenSAC WebUI session. This text-only caller cannot send media attachments.";
    response.text = text;
    for (const attachment of response.attachments) {
      attachment.complete?.(signal, "unsupported", "", "text_only_adapter");
    }
  }
  return response.text;
}

/** HandleDelivery processes an inbound message through the channel Runtime and
 * returns the transport projection of the canonical text/artifact result. */
export async function handleDelivery(
  d: Dispatcher,
  signal: AbortSignal,
  msg: InboundMessage,
): Promise<MessageResponse> {
  console.error(
    `[channels] HandleMessage: platform=${msg.platform} userID=${msg.userID} chatID=${msg.chatID} text=${
      JSON.stringify(truncateText(msg.text, 80))
    }`,
  );

  const runtime = d.runtimeSnapshot();
  // Feishu's open_id identifies the sender, while chat_id identifies the
  // conversation used for session binding and outbound delivery. Messaging
  // channels accept all users by default.
  msg.userID = channelRouteID(msg);

  // Check if command
  if (msg.text.startsWith("/")) {
    const text = await handleCommand(d, msg);
    return { text };
  }

  let sess: ChannelSession | null = null;
  let lease: ChannelSessionLease | null = null;
  let promoted = false;
  let releaseRuntime: (() => void) | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sess = await resolveSession(d, msg.platform, msg.userID);
    } catch (err) {
      throw new Error(`resolve session: ${errorMessage(err)}`);
    }
    const key = sessionKey(msg.platform, msg.userID);
    lease = d.acquireSessionLease(key, msg.platform, msg.userID, sess);
    if (lease === null) continue;
    // Admission below blocks until any in-flight run for this session
    // finishes. Tell the user their message is queued instead of leaving them
    // to guess whether the agent stopped.
    const queuedBehind = sess.runID;
    if (queuedBehind !== "" && msg.progressFunc !== undefined) {
      msg.progressFunc("⏳ 上一条消息仍在执行，本条消息将排队等待…");
    }
    let runtimeGuard;
    const sessionID0 = sess.manager?.getHeader()?.id ?? "";
    try {
      runtimeGuard = await acquireExecutionAdmission(
        signal,
        d.sessionDir,
        sessionID0,
        { wait: true },
      );
    } catch (admissionErr) {
      lease.release();
      lease = null;
      throw new Error(
        `acquire channel execution admission: ${errorMessage(admissionErr)}`,
      );
    }
    releaseRuntime = () => runtimeGuard.release();
    if (await lease.promoteAfterRuntimeLock()) {
      promoted = true;
      break;
    }
    releaseRuntime();
    releaseRuntime = null;
    lease.release();
    lease = null;
  }
  if (sess === null || releaseRuntime === null || !promoted || lease === null) {
    throw new Error(
      "session changed while message was waiting for runtime lock",
    );
  }
  // This is intentionally resolved at execution time as well as on creation
  // and /mode: old bindings, recovery, and external submissions must not
  // inherit a downgraded persisted mode.
  sess.mode = effectiveChannelMode(msg.platform, sess.mode);
  const runSource = channelRunSource(sess);
  // A process restart can outlive the progress callback that belonged to the
  // original inbound message. Reconcile completed durable background output
  // before accepting the next message for this session.
  reconcileCompletedBackgroundRun(d, sess, msg.progressFunc ?? null);

  const backgroundSubmitter: BackgroundSubmitter | null = d.backgroundSubmitter;
  if (backgroundSubmitter !== null && d.responsesBackgroundEnabled()) {
    const backgroundRunID = "channel_" + generateID();
    let input: InputSubmission;
    try {
      input = await sess.runtime!.acceptInput(
        signal,
        backgroundRunID,
        msg.text,
        channelAttachmentIngresses(msg),
      );
    } catch (err) {
      releaseRuntime();
      throw new Error(`accept channel input: ${errorMessage(err)}`);
    }
    const sessionID1 = sess.manager?.getHeader()?.id ?? "";
    const backgroundReq: BackgroundRequest = {
      signal,
      sessionId: sessionID1,
      workDir: sess.workDir,
      platform: msg.platform,
      userId: msg.userID,
      idempotencyKey: channelMessageIdempotencyKey(msg),
      idempotencyScope: "channel",
      modelId: runtime.model?.id ?? "",
      mode: sess.mode,
      runId: backgroundRunID,
      input,
      progress: msg.progressFunc,
    };
    releaseRuntime();
    let runID: string;
    try {
      runID = await backgroundSubmitter(backgroundReq);
    } catch (err) {
      sess.runtime!.discardInput(input);
      d.notifyRunObserver(sessionID1);
      throw err;
    }
    d.notifyRunObserver(sessionID1);
    return { text: `Responses background run queued: ${runID}` };
  }

  const sessionID = sess.manager?.getHeader()?.id ?? "";
  d.notifyRunObserver(sessionID);
  try {
    await sess.lock();
    try {
      sess.touch();
      try {
        sess.manager!.reload();
      } catch (err) {
        throw new Error(
          `reload session before channel run: ${errorMessage(err)}`,
        );
      }
      return await runDelivery(
        d,
        signal,
        sess,
        msg,
        runtime,
        runSource,
        sessionID,
      );
    } finally {
      sess.unlock();
    }
  } finally {
    // Go's two deferred lease releases collapse: release() is idempotent.
    lease?.release();
    releaseRuntime();
    d.notifyRunObserver(sessionID);
  }
}

/** runDelivery holds the lease/run bookkeeping half of HandleDelivery that Go
 * keeps inline after the session lock is acquired. */
async function runDelivery(
  d: Dispatcher,
  signal: AbortSignal,
  sess: ChannelSession,
  msg: InboundMessage,
  runtime: ReturnType<Dispatcher["runtimeSnapshot"]>,
  runSource: string,
  sessionID: string,
): Promise<MessageResponse> {
  const runID = "channel_" + generateID();
  const runBase = d.runRootSignal ?? undefined;
  if (sess.execution === null || sess.execution === undefined) {
    sess.execution = new ExecutionRuntime();
  }
  if (sess.runtime === null || sess.runtime === undefined) {
    throw new Error("channel session runtime is unavailable");
  }
  const execution = sess.execution;
  const input = await sess.runtime.acceptInput(
    signal,
    runID,
    msg.text,
    channelAttachmentIngresses(msg),
  ).catch((err: unknown) => {
    throw new Error(`accept channel attachments: ${errorMessage(err)}`);
  });
  const requestSnapshot = JSON.stringify({
    platform: msg.platform,
    userId: msg.userID,
    chatId: msg.chatID,
    message: input.text,
    resources: input.resources,
  });
  const requestFP = "sha256:" + sha256Hex(requestSnapshot);
  const submissionKey = channelMessageIdempotencyKey(msg);
  const existing = findIdempotentRun(
    d.sessionDir,
    sessionID,
    submissionKey,
    requestFP,
    "channel",
  );
  if (existing !== null) {
    // The original inbound event already has a canonical Run. A retry is
    // acknowledged without sending a second channel response.
    return { text: "" };
  }
  execution.setRunStore(new RunStore(d.sessionDir));
  execution.setEventSink(new SessionRunEventSink(d.sessionDir));
  const runStartedAt = new Date();
  const modelID = runtime.model?.id ?? "";
  const toolNames: string[] = [];
  if (sess.registry !== null && sess.registry !== undefined) {
    for (const definition of sess.registry.definitions()) {
      if (definition.name !== "") toolNames.push(definition.name);
    }
  }
  toolNames.sort();
  const policySnapshot = JSON.stringify({
    source: runSource,
    mode: sess.mode,
    workDir: sess.workDir,
    tools: toolNames,
    skills: [],
    capabilities: {
      multiAgent: runtime.multiAgent,
      browser: runtime.browser,
      a2aMaster: runtime.a2aMaster,
    },
    sandbox: { enabled: d.sandbox },
    approvalPolicy: "runtime",
    questionPolicy: "runtime",
  });
  const intent = {
    id: "intent_" + generateID(),
    sessionId: sessionID,
    source: runSource,
    model: modelID,
    mode: sess.mode,
    workDir: sess.workDir,
    requestFingerprint: requestFP,
    request: requestSnapshot,
    policy: policySnapshot,
    createdAt: runStartedAt,
  };
  const userMessage = sess.runtime.buildUserMessage(runBase, input);
  const startData = JSON.stringify({
    intentId: intent.id,
    attempt: 1,
    idempotencyKeyHash: idempotencyKeyFingerprint(submissionKey),
    idempotencyScope: "channel",
    requestFingerprint: requestFP,
  });
  let runSignal: AbortSignal;
  try {
    runSignal = execution.beginIntentDurable(
      runBase,
      intent,
      {
        id: runID,
        sessionId: sessionID,
        intentId: intent.id,
        retryOf: "",
        attempt: 1,
        workDir: sess.workDir,
        source: runSource,
        model: modelID,
        mode: sess.mode,
        status: "running",
        startedAt: runStartedAt,
        finishedAt: null,
        error: "",
        errorInfo: {},
        progress: {},
        usage: null,
        contextUsage: null,
        inputResourceIds: resourceIds(input),
        submissionKeyHash: idempotencyKeyFingerprint(submissionKey),
        submissionScope: "channel",
        submissionFingerprint: requestFP,
        userEntryId: runUserEntryID(runID),
        userMessage,
        assistantEntryId: "",
        conversationTurnId: "turn-" + intent.id,
        conversationTurn: true,
      },
      {
        sessionId: sessionID,
        runId: runID,
        eventType: "started",
        source: runSource,
        status: "running",
        model: modelID,
        mode: sess.mode,
        timestamp: runStartedAt,
        data: startData,
      } satisfies RunEvent,
    );
  } catch (err) {
    throw new Error(errorMessage(err));
  }
  sess.runID = runID;
  sess.runCancel = () => execution.cancel();
  sess.runAgent = null;
  sess.runStartedAt = runStartedAt;
  sess.lastEventAt = runStartedAt;
  try {
    let result: ChannelRunResult;
    try {
      result = await runAgent(
        d,
        runSignal,
        sess,
        userMessage,
        msg.progressFunc ?? null,
      );
    } catch (err) {
      const finishErr = await finishRun(
        d,
        execution,
        runID,
        runSource,
        modelID,
        sess,
        err,
        null,
      );
      if (finishErr !== null) {
        console.error(`[channels] finish failed Run ${runID}: ${finishErr}`);
      }
      throw err;
    }
    const capability = channelDeliveryCapability(msg.platform);
    const transportContext = JSON.stringify({
      replyMessageId: msg.messageID.trim(),
      replyContext: msg.replyContext,
      // Captions are retained in the frozen Runtime projection so a process
      // restart can replay a text operation without reconstructing provider
      // content from adapter-local state. The value is still opaque to the
      // provider and is never included in prompts.
      caption: result.text,
    });
    let planned: PlanDeliveryResult;
    try {
      planned = planDelivery({
        sessionId: sessionID,
        runId: runID,
        platform: msg.platform,
        targetId: msg.chatID,
        replyMessageId: msg.messageID,
        transportContext,
        caption: result.text,
        attachments: result.artifacts,
        capability,
        createdAt: runStartedAt,
      });
    } catch (planErr) {
      const finishErr = await finishRun(
        d,
        execution,
        runID,
        runSource,
        modelID,
        sess,
        planErr,
        null,
      );
      if (finishErr !== null) {
        console.error(`[channels] finish failed Run ${runID}: ${finishErr}`);
      }
      throw planErr;
    }
    let plan = planned.plan;
    const fallbackText = planned.fallbackText;
    if (fallbackText !== "") {
      const frozen = decodeTransportContext(plan.intent.transportContext);
      const frozenRecord = (plan.intent.transportContext ?? {}) as Record<
        string,
        unknown
      >;
      frozenRecord["fallback"] = fallbackText;
      void frozen;
      plan = {
        ...plan,
        intent: { ...plan.intent, transportContext: frozenRecord },
      };
    }
    const planPtr = plan.operations.length > 0 ? plan : null;
    const finishErr = await finishRun(
      d,
      execution,
      runID,
      runSource,
      modelID,
      sess,
      null,
      planPtr,
    );
    if (finishErr !== null) throw new Error(finishErr);
    return projectDelivery(d, signal, sess, msg, result, plan, fallbackText);
  } finally {
    if (sess.runID === runID) {
      sess.runID = "";
      sess.runCancel = null;
      sess.runAgent = null;
    }
  }
}

/** finishRun terminalizes the durable run; mirrors the Go `finish` closure. */
async function finishRun(
  _d: Dispatcher,
  execution: import("../../agentruntime/execution.ts").ExecutionRuntime,
  runID: string,
  runSource: string,
  modelID: string,
  sess: ChannelSession,
  runErr: unknown,
  plan: DeliveryPlan | null,
): Promise<string | null> {
  try {
    if (plan !== null) {
      execution.setDeliveryPlan(runID, plan);
    }
  } catch (err) {
    return errorMessage(err);
  }
  let status = "completed";
  let messageText = "";
  let errorInfo: ErrorInfo | undefined;
  if (isIncompleteRunError(runErr)) {
    status = "incomplete";
  } else if (runErr !== null && runErr !== undefined) {
    if (runErr instanceof Error && runErr.name === "AbortError") {
      status = "canceled";
    } else if (runErr instanceof Error && runErr.name === "TimeoutError") {
      status = "canceled";
    } else {
      status = "failed";
    }
    errorInfo = channelFailureInfo(runErr, undefined, PhaseModel);
    messageText = errorInfo.message ?? "";
  }
  let eventType = "finished";
  if (status === "failed") eventType = "failed";
  else if (status === "incomplete") eventType = "incomplete";
  else if (status === "canceled") eventType = "canceled";
  let eventData: string | undefined;
  if (messageText !== "") {
    eventData = JSON.stringify({ error: messageText, errorInfo });
  }
  try {
    await execution.finishDurableWithRetry(
      undefined,
      runID,
      channelRunState(runErr),
      messageText,
      {
        sessionId: sess.id,
        runId: runID,
        eventType,
        source: runSource,
        status,
        model: modelID,
        mode: sess.mode,
        timestamp: new Date(),
        data: eventData,
      } satisfies RunEvent,
    );
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function truncateText(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// --- Rotation -------------------------------------------------------------------

/** RotateSession archives the current session and creates a new one.
 * Called when a user sends /new. force requests cancellation of the active run
 * and allows rotating past a run that ignored cancellation. */
export async function rotateSession(
  d: Dispatcher,
  platform: string,
  userID: string,
  force: boolean,
): Promise<void> {
  const key = sessionKey(platform, userID);
  console.error(`[channels] rotating session: ${key} (force=${force})`);
  if (platform !== "wechat" && platform !== "feishu") {
    d.sessions.delete(key);
    return;
  }
  for (;;) {
    let bound;
    try {
      bound = findBinding(d.sessionDir, platform, userID);
    } catch (err) {
      throw new Error(`find channel binding: ${errorMessage(err)}`);
    }
    if (bound === null) return;
    const releaseRuntime = await d.acquireRuntimeForRotate(
      undefined,
      d.sessionDir,
      bound.sessionId,
      force,
    );
    let releaseIdentity = (): void => {};
    if (d.identityLocks !== null && d.identityLocks !== undefined) {
      releaseIdentity = await d.identityLocks.lock(platform, userID);
    }
    let current;
    try {
      current = findBinding(d.sessionDir, platform, userID);
    } catch (err) {
      releaseIdentity();
      releaseRuntime();
      throw new Error(`recheck channel binding: ${errorMessage(err)}`);
    }
    if (current === null) {
      releaseIdentity();
      releaseRuntime();
      return;
    }
    if (current.sessionId !== bound.sessionId) {
      releaseIdentity();
      releaseRuntime();
      continue;
    }
    const workDir = d.platformWorkDir(platform);
    try {
      rotateBoundSession(
        workDir,
        d.sessionDir,
        platform,
        userID,
        current.sessionId,
      );
    } catch (err) {
      releaseIdentity();
      releaseRuntime();
      throw new Error(`rotate bound session: ${errorMessage(err)}`);
    }
    const sess = d.sessions.get(key);
    if (sess !== undefined) {
      d.invalidateSessionLocked(key, sess);
    }
    releaseIdentity();
    releaseRuntime();
    return;
  }
}

// --- Delivery projection -------------------------------------------------------

/** projectDelivery maps the durable plan onto the transport response. */
export function projectDelivery(
  d: Dispatcher,
  signal: AbortSignal,
  sess: ChannelSession | null,
  _inbound: InboundMessage,
  result: ChannelRunResult,
  plan: DeliveryPlan,
  fallbackText: string,
): MessageResponse {
  const response: MessageResponse = { text: result.text };
  if (fallbackText !== "") {
    response.text = response.text !== ""
      ? response.text + "\n\n" + fallbackText
      : fallbackText;
  }
  if (
    sess === null || sess === undefined || sess.runtime === null ||
    sess.runtime === undefined || sess.runtime.attachments === null ||
    sess.runtime.attachments === undefined || plan.operations.length === 0
  ) {
    return response;
  }
  const controller = new ChannelDeliveryController(d.sessionDir);
  const textOperations: DeliveryOperation[] = [];
  for (const operation of plan.operations) {
    if (
      operation.operationKind === "send_text" ||
      operation.operationKind === "send_fallback_text"
    ) {
      textOperations.push(toDeliveryOperation(operation, plan));
    }
  }
  for (const operation of textOperations) {
    const projection = controller.textProjection(
      operation,
      plan.intent,
      deliveryOperationText(
        plan.intent.transportContext,
        operation.operationKind,
      ),
    );
    if (response.textDeliveries === undefined) response.textDeliveries = [];
    response.textDeliveries.push(projection);
  }
  if (
    response.textDeliveries !== undefined && response.textDeliveries.length > 0
  ) {
    response.textDelivery = response.textDeliveries[0];
  }
  const artifacts = new Map<string, SessionAttachment>();
  for (const artifact of result.artifacts) {
    artifacts.set(artifact.id, artifact);
  }
  for (const operation of plan.operations) {
    if (
      operation.operationKind !== "send_artifact" || operation.artifactId === ""
    ) {
      continue;
    }
    let artifact = artifacts.get(operation.artifactId);
    if (artifact === undefined) {
      try {
        artifact = sess.runtime.attachments.Get(
          plan.intent.sessionId,
          operation.artifactId,
        );
      } catch (err) {
        throw new Error(
          `resolve delivery artifact ${operation.artifactId}: ${
            errorMessage(err)
          }`,
        );
      }
    }
    const uploadID = operation.dependsOn;
    let uploadOperation = toUploadPlaceholder(uploadID, plan.intent.id);
    for (const candidate of plan.operations) {
      if (candidate.id === uploadID) {
        uploadOperation = toDeliveryOperation(candidate, plan);
        break;
      }
    }
    const sendOperation = toDeliveryOperation(operation, plan);
    if (response.attachments === undefined) response.attachments = [];
    response.attachments.push(
      controller.attachmentProjection(
        sess.runtime,
        artifact,
        uploadOperation,
        sendOperation,
        plan.intent,
      ),
    );
  }
  void signal;
  return response;
}

function toDeliveryOperation(
  operation: DeliveryPlan["operations"][number],
  plan: DeliveryPlan,
): DeliveryOperation {
  return {
    id: operation.id,
    intentId: plan.intent.id,
    operationKey: operation.operationKey,
    artifactId: operation.artifactId,
    operationKind: operation.operationKind,
    sequence: operation.sequence,
    dependsOn: operation.dependsOn,
    idempotencyKey: operation.idempotencyKey,
    payloadDigest: operation.payloadDigest,
    status: operation.status,
    providerAssetId: "",
    providerMessageId: "",
    providerState: undefined,
    attemptCount: 0,
    nextAttemptAt: null,
    failureCode: "",
    retryWindowStartedAt: null,
    leaseOwner: "",
    leaseEpoch: 0,
    createdAt: operation.createdAt,
    updatedAt: operation.createdAt,
  };
}

function toUploadPlaceholder(
  uploadID: string,
  intentID: string,
): DeliveryOperation {
  return {
    id: uploadID,
    intentId: intentID,
    operationKey: "",
    artifactId: "",
    operationKind: "upload_artifact",
    sequence: 0,
    dependsOn: "",
    idempotencyKey: "",
    payloadDigest: "",
    status: "pending",
    providerAssetId: "",
    providerMessageId: "",
    providerState: undefined,
    attemptCount: 0,
    nextAttemptAt: null,
    failureCode: "",
    retryWindowStartedAt: null,
    leaseOwner: "",
    leaseEpoch: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

// --- Session resolution ---------------------------------------------------------

/** resolveSession finds or creates the active session for a platform user. */
export async function resolveSession(
  d: Dispatcher,
  platform: string,
  userID: string,
): Promise<ChannelSession> {
  const key = sessionKey(platform, userID);

  const cached = d.sessions.get(key);
  if (cached !== undefined) {
    console.error(`[channels] session reused: ${key}`);
    return cached;
  }

  console.error(`[channels] session not found in cache, creating: ${key}`);

  // Create or load session. Go double-checks under the write lock; the
  // single-threaded event loop makes the second check unobservable, so the
  // cache hit above is authoritative.
  const cfg = d.cfg;
  const security = d.security;
  const sandboxEnabled = d.sandbox;
  const browserEnabled = d.browser;
  const artifactEnabled = d.artifact;
  const a2aEnabled = d.a2aMaster;
  const multiAgentEnabled = d.multiAgent;
  const cronStore = d.cronStore;
  const scheduler = d.scheduler;
  const workDir = cfg !== null ? cfg.getPlatformWorkDir(platform) : "";
  if (security !== null && security !== undefined) {
    const denied = await security.checkWorkDirAllowed(workDir);
    if (denied !== null) {
      throw new Error(denied);
    }
  }
  let mgr: SessionManager;
  let bound = null;
  if (platform === "wechat" || platform === "feishu") {
    try {
      bound = findBinding(d.sessionDir, platform, userID);
    } catch (err) {
      throw new Error(`find channel binding: ${errorMessage(err)}`);
    }
  }
  if (bound !== null) {
    try {
      mgr = openSession(d.sessionDir, bound.sessionId);
    } catch (err) {
      throw new Error(`open bound session: ${errorMessage(err)}`);
    }
  } else if (platform === "wechat" || platform === "feishu") {
    try {
      mgr = createSession({
        workDir,
        sessionDir: d.sessionDir,
        channelType: platform,
        channelId: userID,
      });
    } catch (err) {
      throw new Error(`create bound session: ${errorMessage(err)}`);
    }
  } else {
    try {
      mgr = createSession({ workDir, sessionDir: d.sessionDir });
    } catch (err) {
      throw new Error(`create session: ${errorMessage(err)}`);
    }
  }

  const sbMgr = newManagerWithOptions(
    workDir,
    sandboxOptionsFromSettings(d.settings?.sandbox),
  );
  if (sandboxEnabled) {
    try {
      sbMgr.setLevel(Level.Standard);
    } catch (err) {
      throw new Error(`enable sandbox: ${errorMessage(err)}`);
    }
    const fallback = sbMgr.fallbackError();
    if (fallback !== undefined) {
      console.error(
        `[channels] sandbox unavailable; using direct execution: ${fallback}`,
      );
    }
  } else {
    try {
      sbMgr.setLevel(Level.None);
    } catch {
      // ignore
    }
  }
  const sessionID = mgr.getHeader()?.id ?? "";
  let configured;
  try {
    configured = listChannelTools(d.sessionDir, sessionID);
  } catch (err) {
    throw new Error(`load channel tools: ${errorMessage(err)}`);
  }
  const enabled = new Map<string, boolean>();
  for (const item of configured) enabled.set(item.toolName, item.enabled);
  const hasToolConfig = configured.length > 0;
  const definitions = new Map<string, ChannelToolDefinition>();
  for (const definition of d.channelToolDefinitionsLocked(platform)) {
    definitions.set(definition.name, definition);
  }
  const toolEnabled = (name: string, defaultEnabled: boolean): boolean => {
    const definition = definitions.get(name);
    if (definition !== undefined) {
      if (!definition.available) return false;
      defaultEnabled = definition.default;
    }
    const value = enabled.get(name);
    if (value !== undefined) return value;
    return !hasToolConfig && defaultEnabled;
  };
  // Resolve the browser capability once from the channel session selection.
  // The same value must drive both the initial registry and the Runtime
  // resource attachment; otherwise AttachSessionResources rehydrates with the
  // process default and can remove an explicitly selected browser tool.
  const selectedBrowser = toolEnabled("browser", browserEnabled);

  let resources;
  try {
    resources = await loadContextResources(
      d.settings,
      workDir,
      false,
      selectedBrowser,
    );
  } catch (err) {
    throw new Error(`load channel context resources: ${errorMessage(err)}`);
  }
  let reg: Registry;
  try {
    reg = buildRegistry(workDir, sbMgr, d.settings, {
      registerDefaults: true,
      browser: selectedBrowser,
      mutators: [(registry: Registry) => {
        for (const item of registry.all()) {
          if (!toolEnabled(item.name(), true)) {
            registry.remove(item.name());
          }
        }
        if (toolEnabled("a2a_dispatch", a2aEnabled)) {
          registerA2AMasterTool(d, registry);
        }
        if (toolEnabled("memory", true)) {
          registry.register(
            new MemoryTool(new MemoryStore(cfg?.memory.path ?? "", workDir)),
          );
        }
        let registerMultiAgent = false;
        for (const name of definitions.keys()) {
          if (
            isMultiAgentToolName(name) && toolEnabled(name, multiAgentEnabled)
          ) {
            registerMultiAgent = true;
            break;
          }
        }
        if (registerMultiAgent || sessionHasTeamExpert(d.sessionDir, mgr)) {
          const manager = d.ensureAgentManager();
          if (manager !== null) {
            registerSubAgentTools(registry, manager);
            registerDelegateSubAgentTool(registry, manager);
            registerWorkflowTools(registry, { manager });
          }
        }
        if (cronStore !== null && toolEnabled("cron", true)) {
          registry.register(
            newCronTool(
              newSessionScopedStoreWithWorkDir(cronStore, sessionID, workDir),
              scheduler,
            ),
          );
        }
      }],
    });
  } catch (err) {
    throw new Error(`build channel registry: ${errorMessage(err)}`);
  }

  let sessionRuntime;
  try {
    sessionRuntime = await attachSessionResources({
      source: sourceFromChannelType(platform),
      workDir,
      manager: mgr,
      registry: reg,
      sandboxMgr: sbMgr,
      skillsMgr: resources.skillsMgr,
      extraContext: resources.extraContext,
      ruleContent: resources.ruleContent,
      settings: d.settings,
      browser: selectedBrowser,
      artifactEnabled: artifactEnabled,
    });
  } catch (err) {
    throw new Error(`attach channel session runtime: ${errorMessage(err)}`);
  }
  const sessionAgentMgr = d.newSessionAgentManager(
    sessionRuntime,
    d.runtimeSnapshot(),
  );
  try {
    await sessionRuntime.connectConfiguredMCP(undefined, {
      servers: [],
      optional: true,
      onError: (err: unknown) => {
        console.error(`[channels] connect MCP servers: ${err}`);
      },
    });
  } catch (err) {
    throw new Error(`connect channel MCP servers: ${errorMessage(err)}`);
  }
  sessionRuntime.setExecution(undefined);
  const mcpClients = sessionRuntime.mcpClients;
  if (mcpClients.length > 0) {
    console.error(
      `[channels] connected ${mcpClients.length} MCP server(s) for ${platform}/${userID}`,
    );
  }

  if (platform === "wechat" || platform === "feishu") {
    for (const item of reg.all()) {
      const value = enabled.get(item.name());
      if (value === false) reg.remove(item.name());
    }
  }
  if (sessionAgentMgr !== null) {
    // The session-scoped manager owns this session's member mailbox, so member
    // questions and completions reach this session's lead (and subagent_wait
    // observes the same mailbox). Re-register after channel-specific removals so
    // the sub-agent tools never stay attached to the dispatcher-wide manager,
    // which is shared across sessions and has no session mailbox.
    //
    // A team binding is a Runtime policy capability (not an adapter-local
    // toggle), so its full toolset is authoritative. An ordinary multi-agent
    // selection is re-pointed one by one instead: RegisterSubAgentTools replaces
    // the whole canonical set, and resurrecting a tool the user switched off
    // would override an explicit per-tool choice.
    if (sessionRuntime.teamExpertActive()) {
      registerSubAgentTools(reg, sessionAgentMgr);
    } else {
      const selected = d.selectedSubAgentTools(reg);
      if (selected.size > 0) {
        registerSubAgentTools(reg, sessionAgentMgr);
        for (const name of subAgentToolNames()) {
          if (!selected.has(name)) reg.remove(name);
        }
      }
    }
  }
  const sess = new ChannelSession();
  sess.runtime = sessionRuntime;
  sess.execution = new ExecutionRuntime();
  sess.decisions = null;
  sess.id = sessionID;
  sess.platform = platform;
  sess.userID = userID;
  sess.workDir = workDir;
  sess.manager = mgr;
  sess.sandboxMgr = sbMgr;
  sess.registry = reg;
  sess.agentMgr = sessionAgentMgr;
  sess.mcpClients = mcpClients;
  sess.mode = "yolo";
  sessionRuntime.setExecution(sess.execution);
  sess.execution!.setRunStore(new RunStore(d.sessionDir));
  sess.execution!.setEventSink(new SessionRunEventSink(d.sessionDir));
  try {
    sess.generation = getChannelToolGeneration(d.sessionDir, sessionID);
  } catch (err) {
    console.error(`[channels] load tool generation for ${key}: ${err}`);
  }

  d.sessions.set(key, sess);
  console.error(`[channels] session created: ${key} (workDir=${workDir})`);
  return sess;
}

// --- Command handling -----------------------------------------------------------

const channelCommandHelp = `可用聊天命令：
/new [force]            - 创建新的会话（force 强制中断正在执行的任务）
/clear [force]          - 清空当前会话并创建新会话
/stop                   - 停止当前正在执行的任务
/status                 - 查看当前会话状态
/sessions               - 查看当前活跃会话
/mode [plan|agent|yolo|os] - 查看或切换会话模式
/compact                - 压缩当前会话上下文
/help                   - 显示此帮助
/more                   - 继续接收微信未发送完的消息`;

function channelStopReply(result: SessionStopResult): string {
  if (
    result.code === SessionStopAccepted ||
    result.code === SessionStopRemoteAccepted
  ) {
    return "🛑 Stop requested.";
  }
  if (result.code === SessionStopRecoveryStarted) {
    return "🛑 Stale execution recovery requested.";
  }
  if (result.code === SessionStopOwnedElsewhere) {
    return "⏳ This session is running in another OpenSAC process and cannot be stopped here.";
  }
  if (result.code === SessionStopRemoteUnsupported) {
    return "⏳ The detached provider run cannot be stopped from this channel.";
  }
  if (result.code === SessionStopReserved) {
    return "⏳ This session is currently reserved by another operation.";
  }
  if (result.code === SessionStopNoActiveRun) {
    return "No active run to stop.";
  }
  return "❌ Unable to confirm the current execution state.";
}

function channelCommandFailureMessage(err: unknown): string {
  const info = channelFailureInfo(err, undefined, PhasePersistence);
  const message = displayErrorMessage(info).trim();
  if (message !== "") return message;
  return "The operation could not be completed.";
}

function rotateHandlerForCommand(
  d: Dispatcher,
): (platform: string, userID: string, force: boolean) => Promise<void> {
  if (d.rotateHandler !== null && d.rotateHandler !== undefined) {
    return d.rotateHandler;
  }
  return (platform, userID, force) => rotateSession(d, platform, userID, force);
}

/** acquireCommandSession resolves the session and holds its runtime mutation
 * lease so /mode and /compact mutate a stable execution. */
async function acquireCommandSession(
  d: Dispatcher,
  platform: string,
  userID: string,
): Promise<{ sess: ChannelSession; release: () => void } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let sess: ChannelSession;
    try {
      sess = await resolveSession(d, platform, userID);
    } catch {
      return null;
    }
    const lease = d.acquireSessionLease(
      sessionKey(platform, userID),
      platform,
      userID,
      sess,
    );
    if (lease === null) continue;
    const sessionID = sess.manager?.getHeader()?.id ?? "";
    let runtimeGuard;
    try {
      runtimeGuard = await acquireSessionMutation(
        undefined,
        d.sessionDir,
        sessionID,
        { wait: true },
      );
    } catch (err) {
      lease.release();
      throw err;
    }
    const releaseRuntime = () => runtimeGuard.release();
    if (await lease.promoteAfterRuntimeLock()) {
      return {
        sess,
        release: () => {
          releaseRuntime();
          lease.release();
        },
      };
    }
    releaseRuntime();
    lease.release();
  }
  throw new Error("session changed while waiting for runtime lock");
}

/** compactSession forces one compaction pass over the session context. */
async function compactSession(
  d: Dispatcher,
  signal: AbortSignal,
  sess: ChannelSession,
): Promise<void> {
  const built = await buildAgent(d, signal, sess, null);
  if (built === null) {
    throw new Error("build channel agent failed");
  }
  const a = built.agent;
  try {
    const replayState = sess.manager?.getReplayState();
    if (replayState !== undefined && replayState.messages.length > 0) {
      a.loadHistoryState(replayState.messages, replayState.entryIDs);
    }
    // Go drains a buffered event channel; the events are collected and dropped
    // the same way here.
    const events: unknown[] = [];
    const err = await a.compact(
      newRunContext(signal),
      () => (events.push(null), true),
      true,
    );
    if (err !== undefined) throw err;
  } finally {
    built.cleanup(undefined);
  }
}

/** handleCommand processes slash commands from messaging platforms. Every
 * failure is projected into the reply text; nothing throws to the transport. */
export async function handleCommand(
  d: Dispatcher,
  msg: InboundMessage,
): Promise<string> {
  const parts = msg.text.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) return "";

  const cmd = parts[0].toLowerCase();
  const force = parts.length > 1 && parts[1].toLowerCase() === "force";
  const findBoundSessionID = (): string => {
    if (msg.platform !== "wechat" && msg.platform !== "feishu") return "";
    try {
      return findBinding(d.sessionDir, msg.platform, msg.userID)?.sessionId ??
        "";
    } catch {
      return "";
    }
  };
  switch (cmd) {
    case "/help":
      return channelCommandHelp;
    case "/new":
    case "/clear": {
      const handler = rotateHandlerForCommand(d);
      try {
        await handler(msg.platform, msg.userID, force);
      } catch (err) {
        if (err === ErrSessionRunBusy) {
          return "⏳ 上一个任务仍在执行。可先发送 /stop，或使用 /new force 强制创建新会话。";
        }
        return `❌ Failed to ${
          cmd === "/new" ? "create new session" : "clear session"
        }: ${channelCommandFailureMessage(err)}`;
      }
      return cmd === "/new" ? "✅ New session created." : "✅ Session cleared.";
    }
    case "/stop": {
      let sessionID = d.getSession(sessionKey(msg.platform, msg.userID))?.id ??
        "";
      if (sessionID === "") sessionID = findBoundSessionID();
      if (sessionID === "") return "No active session.";
      let result: SessionStopResult;
      try {
        result = await d.requestSessionStop(undefined, sessionID);
      } catch (err) {
        return `❌ Unable to stop the current run: ${
          channelCommandFailureMessage(err)
        }`;
      }
      return channelStopReply(result);
    }
    case "/status": {
      const sess = d.getSession(sessionKey(msg.platform, msg.userID));
      let sessionID = sess?.id ?? "";
      if (sessionID === "") sessionID = findBoundSessionID();
      if (sessionID === "") return "No active session.";
      let mode = "";
      let workDir = "";
      let messageCount = 0;
      if (sess !== null && sess !== undefined) {
        mode = sess.mode;
        workDir = sess.workDir;
        messageCount = sess.manager?.getMessages().length ?? 0;
      }
      let reply =
        `Session: ${sessionID}\nMode: ${mode}\nMessages: ${messageCount}\nWorkDir: ${workDir}`;
      let inspection: SessionExecutionSnapshot;
      try {
        inspection = inspectSessionExecution(d.sessionDir, sessionID);
      } catch {
        return reply + "\nRun: state unavailable (retryable)";
      }
      const localRunID = sess?.runID ?? "";
      const startedAt = sess?.runStartedAt;
      const lastEventAt = sess?.lastEventAt;
      if (inspection.activeRun !== undefined && inspection.activeRun !== null) {
        const runID = inspection.activeRun.id;
        const status = inspection.running ? "running" : inspection.state;
        reply +=
          `\nRun: ${runID} (${status}, owner=${inspection.displayOwnerScope}`;
        if (
          sess !== null && sess !== undefined && localRunID === runID &&
          startedAt !== undefined && !Number.isNaN(startedAt.getTime())
        ) {
          const now = Date.now();
          reply += `, running ${
            formatElapsed(now - startedAt.getTime())
          }, last event ${
            formatElapsed(now - (lastEventAt?.getTime() ?? now))
          } ago`;
        }
        reply += ")";
      } else if (inspection.state === SessionExecutionReserved) {
        reply += `\nRun: reserved (owner=${inspection.displayOwnerScope})`;
      } else if (inspection.state === SessionExecutionIdle) {
        // A hand-built embedded ChannelSession can have no matching durable
        // Session row. Preserve its legacy local status until it is persisted;
        // production sessions always take the canonical branch above.
        if (
          !inspection.sessionExists && localRunID !== "" &&
          startedAt !== undefined && !Number.isNaN(startedAt.getTime())
        ) {
          const now = Date.now();
          reply += `\nRun: ${localRunID} (running ${
            formatElapsed(now - startedAt.getTime())
          }, last event ${
            formatElapsed(now - (lastEventAt?.getTime() ?? now))
          } ago)`;
        } else {
          reply += "\nRun: idle";
        }
      } else if (!inspection.sessionExists) {
        if (localRunID !== "") {
          const now = Date.now();
          reply += `\nRun: ${localRunID} (running ${
            formatElapsed(now - (startedAt?.getTime() ?? now))
          }, last event ${
            formatElapsed(now - (lastEventAt?.getTime() ?? now))
          } ago)`;
        } else {
          reply += "\nRun: idle";
        }
      } else {
        reply += `\nRun: ${inspection.state}`;
      }
      return reply;
    }
    case "/sessions": {
      const sessions = d.listSessions();
      if (sessions.length === 0) return "No active sessions.";
      const lines = sessions.map((s) =>
        `  • ${s.id} (${
          s.manager?.getMessages().length ?? 0
        } msgs, ${s.workDir})`
      );
      return `Active sessions (${sessions.length}):\n${lines.join("\n")}`;
    }
    case "/mode": {
      if (parts.length < 2) {
        const sess = d.getSession(sessionKey(msg.platform, msg.userID));
        if (sess !== null && sess !== undefined) {
          return `Current mode: ${
            effectiveChannelMode(sess.platform, sess.mode)
          }`;
        }
        return "No active session.";
      }
      const requested = parts[1].toLowerCase();
      if (
        requested === "plan" || requested === "agent" ||
        requested === "yolo" || requested === "os"
      ) {
        let acquired;
        try {
          acquired = await acquireCommandSession(d, msg.platform, msg.userID);
        } catch {
          return "❌ No active session.";
        }
        if (acquired === null) return "❌ No active session.";
        try {
          await acquired.sess.lock();
          try {
            const resolved = effectiveChannelMode(
              acquired.sess.platform,
              requested,
            );
            acquired.sess.mode = resolved;
            if (resolved !== requested) {
              return "Channel sessions always run in yolo mode.";
            }
            return `✅ Mode set to ${resolved}.`;
          } finally {
            acquired.sess.unlock();
          }
        } finally {
          acquired.release();
        }
      }
      return "Invalid mode. Use: plan, agent, yolo, os";
    }
    case "/compact": {
      let acquired;
      try {
        acquired = await acquireCommandSession(d, msg.platform, msg.userID);
      } catch {
        return "❌ No active session.";
      }
      if (acquired === null) return "❌ No active session.";
      try {
        await acquired.sess.lock();
        try {
          try {
            acquired.sess.manager?.reload();
          } catch (err) {
            return `Session reload failed: ${errorMessage(err)}`;
          }
          try {
            await compactSession(
              d,
              new AbortController().signal,
              acquired.sess,
            );
          } catch (err) {
            return `Context compaction failed: ${errorMessage(err)}`;
          }
        } finally {
          acquired.sess.unlock();
        }
      } finally {
        acquired.release();
      }
      return "✅ Context compacted.";
    }
    default:
      return `Unknown command: ${cmd}\n${channelCommandHelp}`;
  }
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSecs = seconds % 60;
  if (minutes < 60) {
    return remSecs > 0 ? `${minutes}m${remSecs}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMins = minutes % 60;
  return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

// --- Agent build -----------------------------------------------------------------

function channelAgentHasTool(sess: ChannelSession, name: string): boolean {
  if (sess.registry === null || sess.registry === undefined) return false;
  return sess.registry.get(name).ok;
}

/** buildAgent constructs the per-run Agent through the SessionRuntime and
 * returns the cleanup that finishes the manager registration. */
export async function buildAgent(
  d: Dispatcher,
  signal: AbortSignal,
  sess: ChannelSession,
  approvalHandler: AgentApprovalHandler | null,
): Promise<{ agent: Agent; cleanup: (err: unknown) => void } | null> {
  const runtime = d.runtimeSnapshot();
  let cfg = runtime.cfg;
  const settings = runtime.settings;
  if (cfg === null) cfg = withConfigMethods(defaultConfig());
  if (sess.runtime === null || sess.runtime === undefined) {
    // Compatibility for adapter-owned test fixtures during the transition.
    let resources;
    try {
      resources = await loadContextResources(
        settings,
        sess.workDir,
        false,
        runtime.browser,
      );
    } catch (err) {
      console.error(`[channels] load channel fixture resources: ${err}`);
      return null;
    }
    try {
      sess.runtime = await attachSessionResources({
        source: sourceFromChannelType(sess.platform),
        workDir: sess.workDir,
        manager: sess.manager!,
        registry: sess.registry!,
        sandboxMgr: sess.sandboxMgr!,
        skillsMgr: resources.skillsMgr,
        extraContext: resources.extraContext,
        ruleContent: resources.ruleContent,
        settings,
        browser: runtime.browser,
        artifactEnabled: runtime.artifact,
      });
    } catch (err) {
      console.error(`[channels] attach channel fixture runtime: ${err}`);
      return null;
    }
  }

  // Prompt gating flags must reflect the tools actually present in the
  // session registry. Per-session tool config can enable or disable
  // sub-agent/delegate/workflow tools individually (and wechat/feishu
  // sessions drop explicitly disabled tools), so derive the flags from the
  // registry instead of the dispatcher-level multiAgent flag alone.
  const hasTool = (name: string): boolean => channelAgentHasTool(sess, name);

  const activeRunID = sess.runID;
  let intentID = "";
  if (activeRunID !== "") {
    try {
      const run = getDurableRun(d.sessionDir, activeRunID);
      if (run !== null) intentID = run.intentId;
    } catch {
      // Go ignores the durable lookup failure.
    }
  }
  let a: Agent;
  try {
    a = sess.runtime.buildAgent({
      provider: runtime.provider ?? undefined,
      providerName: runtime.providerName,
      model: runtime.model ?? undefined,
      settings,
      allow: runtime.allow,
      mode: sess.mode,
      thinkingLevel: settings.defaultThinkingLevel,
      multiAgent: hasTool("subagent_spawn"),
      delegateMode: hasTool("delegate_subagent"),
      workflows: hasTool("workflow_run"),
      approvalHandler: approvalHandler ?? undefined,
      getSteeringMessages: esmSteeringMessages(d, sess) ?? undefined,
      conversationTurnId: "turn-" + intentID,
      intentId: intentID,
      runId: activeRunID,
      conversationTurn: true,
      runtimeOwnsTurnEnd: true,
      maxIterations: cfg.agent.maxTurns,
      contextPressure: cfg.agent.contextPressureThreshold,
      budgetPressure: cfg.agent.budgetPressureThreshold,
      // Deviation: Go's blocking pre-tool hook needs an async admission hook,
      // which the Agent build options do not offer yet (the TS hook script
      // runner is async). The post-tool hook stays fire-and-forget like Go.
      afterToolCall: (
        ctx: AfterToolCallContext,
      ): ToolCallResult | undefined => {
        const current = d.runtimeSnapshot();
        if (
          current.hooksMgr !== null && current.hooksMgr !== undefined &&
          current.hooksMgr.hasPostHook()
        ) {
          const argsMap = (ctx.args ?? {}) as Record<string, unknown>;
          const errMsg = ctx.isError ? ctx.result.content : "";
          void current.hooksMgr.postToolCall(
            signal,
            ctx.toolCall.name,
            argsMap,
            ctx.result.content,
            errMsg,
            sess.platform,
            sess.userID,
          );
        }
        return undefined;
      },
    });
  } catch (err) {
    console.error(`[channels] build channel agent: ${err}`);
    return null;
  }

  const agentMgr = sess.agentMgr ?? runtime.agentMgr;
  if (agentMgr !== null && agentMgr !== undefined) {
    agentMgr.register(newAgentAdapter(a));
    d.agentSessions.set(String(a.id()), sess.id);
  }
  const cleanup = (_err: unknown): void => {
    if (agentMgr !== null && agentMgr !== undefined) {
      // Finish first: terminal child transitions fired from it must still
      // resolve this root agent to its session.
      agentMgr.finish(a.id(), _err instanceof Error ? _err : undefined);
      d.releaseAgentSession(agentMgr, a.id());
    }
  };

  if (sess.forceCompact) {
    a.setForceCompact();
    sess.forceCompact = false;
  }

  const replayState = sess.manager?.getReplayState();
  if (replayState !== undefined && replayState.messages.length > 0) {
    a.loadHistoryState(replayState.messages, replayState.entryIDs);
  }

  return { agent: a, cleanup };
}

// --- Run loop ---------------------------------------------------------------------

function nonDeliverableAttachments(items: Attachment[]): Attachment[] {
  return items.filter((item) => item.kind !== "image" && item.kind !== "file");
}

/** materializeChannelArtifacts accepts provider-native attachments into the
 * Runtime-owned attachment store; failures never fail the run. */
async function materializeChannelArtifacts(
  d: Dispatcher,
  sess: ChannelSession,
  items: Attachment[],
): Promise<SessionAttachment[]> {
  if (
    sess.runtime === null || sess.runtime === undefined ||
    !sess.runtime.artifactCapabilitySnapshot() || sess.runID === "" ||
    items.length === 0
  ) {
    return [];
  }
  const runtime = d.runtimeSnapshot();
  if (runtime.provider === null) return [];
  const seen = new Set<string>();
  const artifacts: SessionAttachment[] = [];
  for (const item of items) {
    if (item.kind !== "image" && item.kind !== "file") continue;
    if (item.providerRef === "") continue;
    const key = item.kind + ":" + item.providerRef;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const record = await sess.runtime.acceptProviderAttachment(
        undefined,
        sess.runID,
        runtime.provider,
        item,
      );
      artifacts.push(record);
    } catch (err) {
      // Keep the model response successful: an optional artifact delivery
      // must not retroactively fail the canonical Agent run. The raw
      // provider reference is deliberately not exposed to the user.
      console.error(
        `[channels] materialize provider attachment ${item.kind}: ${err}`,
      );
    }
  }
  return artifacts;
}

async function collectChannelArtifacts(
  d: Dispatcher,
  sess: ChannelSession,
  collector: ArtifactCollector | null,
  items: Attachment[],
): Promise<SessionAttachment[]> {
  if (
    sess.runtime === null || sess.runtime === undefined ||
    !sess.runtime.artifactCapabilitySnapshot()
  ) {
    return [];
  }
  const artifacts = collector?.artifacts() ?? [];
  return [...artifacts, ...await materializeChannelArtifacts(d, sess, items)];
}

/** runAgent executes the agent loop synchronously (for messaging platforms). */
async function runAgent(
  d: Dispatcher,
  signal: AbortSignal,
  sess: ChannelSession,
  userMessage: Message,
  progress: ((text: string) => void) | null,
): Promise<ChannelRunResult> {
  if (sess.runtime === null || sess.runtime === undefined) {
    throw new Error("channel session runtime is unavailable");
  }
  const artifacts = sess.runtime.beginArtifactCollection(sess.runID);
  try {
    const built = await buildAgent(
      d,
      signal,
      sess,
      messagingApprovalHandler(d, sess, progress),
    );
    if (built === null) {
      throw new Error("build channel agent failed");
    }
    const a = built.agent;
    try {
      try {
        if (sess.execution !== null && sess.execution !== undefined) {
          sess.execution.setAgent(a);
        }
        // Publish the agent handle so cancellation and the watchdog can abort
        // waits that do not observe the run signal.
        if (sess.runID !== "" && sess.runAgent === null) {
          sess.runAgent = a;
        }

        const eventCh = a.runWithUserMessage(userMessage, signal);

        const response: string[] = [];
        let thinkBuf = "";
        let eventCount = 0;
        let toolCount = 0;
        const attachments: Attachment[] = [];
        let terminalSeen = false;
        let terminalInfo: ErrorInfo | undefined;
        const pendingToolArgs = new Map<string, Record<string, unknown>>();
        const flushThink = () => {
          if (progress !== null && thinkBuf !== "") {
            let text = thinkBuf;
            if (text.length > 500) text = text.slice(0, 500) + "...";
            progress("💭 " + text);
            thinkBuf = "";
          }
        };
        for await (const ev of eventCh) {
          eventCount++;
          sess.lastEventAt = new Date();
          // Child-agent events are progress notifications, not events from the
          // channel's main agent. Never append child text to the main response
          // or treat a child timeout as a failure of the parent run.
          if (ev.agentId !== undefined && ev.agentId !== "") {
            const sessionID = sess.manager?.getHeader()?.id ?? "";
            if (
              ev.error !== undefined && ev.error !== null &&
              (ev.type === EventError || ev.type === EventRunFinished)
            ) {
              console.error(
                `[channels] Sub-agent ${ev.agentId} for ${sess.platform}/${sess.userID} failed: ${ev.error}`,
              );
            }
            d.notifySubAgentObserver(sessionID, channelSafeSubAgentEvent(ev));
            d.notifyRunObserver(sessionID);
            if (
              ev.type === EventError && progress !== null &&
              ev.error !== undefined && ev.error !== null
            ) {
              const info = channelFailureInfo(ev.error, undefined, PhaseModel);
              progress(
                `⚠️ Sub-agent ${ev.agentId}: ${displayErrorMessage(info)}`,
              );
            }
            continue;
          }
          if (sess.execution !== null && sess.execution !== undefined) {
            let observation;
            try {
              observation = sess.execution.observeAgentEvent(ev);
            } catch (observeErr) {
              console.error(
                `[channels] observe agent event for ${sess.runID}: ${observeErr}`,
              );
            }
            if (observation?.error !== undefined) {
              terminalInfo = observation.error;
            }
          }
          switch (ev.type) {
            case EventAgentStart:
              // RunWithUserMessage persists the inbound message before entering
              // the loop, so this is the first safe point to sync it to WebUI.
              d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
              break;
            case EventThinkDelta:
              thinkBuf += ev.thinkDelta ?? "";
              break;
            case EventTextDelta:
              flushThink();
              response.push(ev.textDelta ?? "");
              break;
            case EventHostedItem: {
              if (progress !== null && ev.hostedItem !== undefined) {
                const typeName = (ev.hostedItem.type ?? "").trim();
                const status = (ev.hostedItem.status ?? "").trim();
                if (typeName !== "" || status !== "") {
                  progress(`Hosted tool ${typeName}: ${status}`);
                }
              }
              break;
            }
            case EventTurnEnd:
              // The assistant turn has been appended to SQLite before this
              // event is emitted. Publish here so WebUI subscribers see each
              // channel turn, including tool-call turns, instead of waiting
              // for EventDone.
              d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
              break;
            case EventQuestionRequest: {
              const questionID = ev.questionId ?? "";
              registerChannelDecision(d, sess, questionID, DecisionQuestion);
              persistChannelDecisionRequestWithDeadline(
                d,
                sess,
                questionID,
                DecisionQuestion,
                {
                  question: ev.questionText ?? "",
                  options: ev.questionOptions ?? [],
                  context: ev.questionContext ?? "",
                },
                new Date(),
              );
              sess.execution?.waitForQuestion(sess.runID);
              sess.decisions?.bind(questionID, (answer: string) => {
                a.handleQuestionResponse(questionID, answer);
              });
              d.notifyQuestionObserver(sess.manager?.getHeader()?.id ?? "", ev);
              try {
                sess.decisions?.resolveWith(
                  {
                    id: questionID,
                    kind: DecisionQuestion,
                    status: "cancelled",
                    value: "",
                  },
                  () => {
                    persistChannelDecision(
                      d,
                      sess,
                      questionID,
                      DecisionQuestion,
                      "cancelled",
                      "",
                      null,
                    );
                  },
                );
              } catch (err) {
                console.error(
                  `[channels] resolve question ${questionID}: ${err}`,
                );
              }
              sess.execution?.resume(sess.runID);
              break;
            }
            case EventToolExecutionStart:
              if (
                ev.toolCallId !== undefined && ev.toolCallId !== "" &&
                ev.toolArgs !== undefined
              ) {
                pendingToolArgs.set(ev.toolCallId, ev.toolArgs);
              }
              break;
            case EventToolExecutionEnd: {
              flushThink();
              toolCount++;
              if (progress !== null) {
                const args = pendingToolArgs.get(ev.toolCallId ?? "");
                if (ev.toolCallId !== undefined) {
                  pendingToolArgs.delete(ev.toolCallId);
                }
                const line = formatToolProgress(ev, args ?? {});
                if (line !== "") progress(line);
              }
              break;
            }
            case EventContextPressure:
            case EventBudgetPressure:
              // Forward pressure warnings to messaging platform
              if (
                progress !== null && ev.pressureMessage !== undefined &&
                ev.pressureMessage !== ""
              ) {
                progress("\n" + ev.pressureMessage);
              }
              console.error(
                `[channels] ${ev.pressureType} pressure event for ${sess.platform}/${sess.userID}: ${ev.pressureMessage}`,
              );
              break;
            case EventCompactionStart:
              if (progress !== null) {
                progress("🗜️ Compacting context...");
              }
              break;
            case EventCompactionEnd:
              if (progress !== null) {
                if (ev.error !== undefined && ev.error !== null) {
                  const info = channelFailureInfo(
                    ev.error,
                    undefined,
                    PhaseContext,
                  );
                  console.error(
                    `[channels] Context compaction for ${sess.platform}/${sess.userID} failed: ${ev.error}`,
                  );
                  progress(
                    `⚠️ Context compaction failed: ${
                      displayErrorMessage(info)
                    }`,
                  );
                } else if (
                  ev.statusMessage !== undefined && ev.statusMessage !== ""
                ) {
                  progress("🗜️ " + ev.statusMessage);
                }
              }
              break;
            case EventStatus:
              // Surface context-recovery notices (overflow
              // compaction/truncation) so unattended channel users can see why
              // a reply was delayed. Retry state is emitted separately as
              // EventRetry with stable metadata.
              if (ev.retryStatus === true) break;
              if (progress !== null && ev.statusMessage !== undefined) {
                if (ev.statusMessage.startsWith("Context recovery:")) {
                  progress("🗜️ " + ev.statusMessage);
                } else if (ev.statusMessage.startsWith("⚠️")) {
                  progress(ev.statusMessage);
                }
              }
              break;
            case EventRetry:
              if (progress !== null) {
                progress(formatRetryProgress(ev));
              }
              break;
            case EventRunFinished: {
              terminalSeen = true;
              if (ev.status === TaskFailed || ev.status === TaskCanceled) {
                flushThink();
                let runErr: unknown;
                if (ev.error !== undefined && ev.error !== null) {
                  runErr = ev.error;
                } else if (ev.status === TaskCanceled) {
                  runErr = new DOMException("context canceled", "AbortError");
                } else {
                  runErr = new Error("agent run failed");
                }
                d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
                console.error(
                  `[channels] Agent run ${ev.status} for ${sess.platform}/${sess.userID}: ${
                    String(runErr)
                  }`,
                );
                throw newChannelRunFailure(runErr, terminalInfo, PhaseModel);
              }
              if (ev.status === TaskIncomplete) {
                d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
                attachments.push(...(ev.attachments ?? []));
                await collectChannelArtifacts(d, sess, artifacts, attachments);
                throw new IncompleteRunError();
              }
              if (ev.status === TaskSuccess) {
                d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
                attachments.push(...(ev.attachments ?? []));
              }
              break;
            }
            case EventError: {
              if (terminalSeen) break;
              flushThink();
              if (ev.error !== undefined && ev.error !== null) {
                d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
                console.error(
                  `[channels] Agent error for ${sess.platform}/${sess.userID}: ${ev.error}`,
                );
                throw newChannelRunFailure(ev.error, terminalInfo, PhaseModel);
              }
              // An error event without an error payload is a protocol
              // violation, never a successful completion.
              d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
              console.error(
                `[channels] Agent error event without detail for ${sess.platform}/${sess.userID}`,
              );
              throw newChannelRunFailure(
                new Error("error event without error detail"),
                terminalInfo,
                PhaseTransport,
              );
            }
            case EventDone:
              if (terminalSeen) break;
              d.notifyRunObserver(sess.manager?.getHeader()?.id ?? "");
              attachments.push(...(ev.attachments ?? []));
              break;
            default:
              break;
          }
        }

        if (!terminalSeen) {
          // Channel closed without a terminal event — protocol failure, never
          // success.
          console.error(
            `[channels] Agent event stream closed without terminal result for ${sess.platform}/${sess.userID}`,
          );
          const runErr = new Error(
            "event stream closed without terminal result",
          );
          const classification = {
            code: "event_stream_interrupted",
            type: "transport_error",
            phase: PhaseTransport,
            messageKey: "run.error.streamInterrupted",
            message: "The run stopped before it could finish.",
          };
          let info = classifyError(runErr, classification);
          try {
            info = sess.execution?.recordFailure(runErr, classification) ??
              info;
          } catch (recordErr) {
            console.error(
              `[channels] record interrupted stream for ${sess.runID}: ${recordErr}`,
            );
          }
          terminalInfo = info;
          throw newChannelRunFailure(runErr, terminalInfo, PhaseTransport);
        }

        let result = response.join("");
        console.error(
          `[channels] Agent completed for ${sess.platform}/${sess.userID}: events=${eventCount}, tools=${toolCount}, response_len=${result.length}`,
        );

        // If agent produced no text but executed tools, provide a fallback
        // summary
        if (result === "" && toolCount > 0) {
          result = `✅ Done (${toolCount} tool calls completed)`;
        }
        const attachmentText = formatAttachmentSummary(
          nonDeliverableAttachments(attachments),
        );
        if (attachmentText !== "") {
          if (result !== "") result += "\n\n";
          result += attachmentText;
        }

        return {
          text: result,
          artifacts: await collectChannelArtifacts(
            d,
            sess,
            artifacts,
            attachments,
          ),
        };
      } finally {
        // Go's deferred pair: clearChannelDecisions runs before cleanup.
        clearChannelDecisions(d, sess);
        built.cleanup(undefined);
      }
    } finally {
      if (sess.runAgent === a) {
        sess.runAgent = null;
      }
    }
  } finally {
    artifacts?.close();
  }
}

// --- A2A master tool ---------------------------------------------------------------

/** registerA2AMasterTool installs the A2A dispatch tool when the master flag
 * is enabled for the channel session. */
function registerA2AMasterTool(d: Dispatcher, registry: Registry): void {
  if (!d.a2aMaster) return;
  let a2aListCfg;
  try {
    a2aListCfg = loadA2AAgentList();
  } catch (err) {
    throw new Error(`load a2a-list.json: ${errorMessage(err)}`);
  }
  const a2aMgr = newA2AManager(a2aListCfg);
  registry.register(new A2ADispatchTool(new A2ADispatcherAdapter(a2aMgr)));
}

class A2ADispatcherAdapter implements A2ADispatcher {
  #mgr: ReturnType<typeof newA2AManager>;

  constructor(mgr: ReturnType<typeof newA2AManager>) {
    this.#mgr = mgr;
  }

  list(): AgentEntry[] {
    return this.#mgr.list().map((e) => ({ name: e.name, url: e.url }));
  }

  dispatch(ctx: ToolContext, name: string, message: string): Promise<string> {
    return this.#mgr.dispatch(
      ctx.signal ?? new AbortController().signal,
      name,
      message,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
