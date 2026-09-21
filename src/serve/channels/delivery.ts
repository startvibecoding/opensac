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
  type Event,
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
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
  type Agent,
} from "../../agent/mod.ts";
import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  ToolCallBlockResult,
} from "../../agent/agent.ts";
import { newAgentManager } from "../../agentruntime/agent_manager.ts";
import {
  acquireExecutionAdmission,
  attachSessionResources,
  classifyError,
  createSession,
  type DeliveryCapability,
  DeliveryCoordinator,
  deliveryOperationText,
  displayErrorMessage,
  type DeliveryPlan,
  ExecutionRuntime,
  findIdempotentRun,
  getDurableRun,
  idempotencyKeyFingerprint,
  inspectSessionExecution,
  type InputIngress,
  type InputStream,
  type InputSubmission,
  loadContextResources,
  ModeYolo,
  openSession,
  PhaseContext,
  PhaseModel,
  PhasePersistence,
  PhaseTransport,
  type PlanDeliveryResult,
  planDelivery,
  resourceIds,
  type RunEvent,
  type RunState,
  RunStore,
  SessionExecutionIdle,
  SessionExecutionReserved,
  SessionRunEventSink,
  sessionHasTeamExpert,
  type SessionAttachment,
  type SessionStopResult,
  sourceFromChannelType,
  SourceUnknown,
  type ThinkingLevel,
} from "../../agentruntime/mod.ts";
import type { Registry } from "../../tools/tool.ts";
import { A2ADispatchTool, type A2ADispatcher } from "../../tools/mod.ts";
import { newA2AManager } from "../../a2a/master.ts";
import { newCronTool } from "../../cron/tool.ts";
import { newSessionScopedStoreWithWorkDir } from "../../cron/session_store.ts";
import { MemoryTool } from "../../memory/tool.ts";
import { Store as MemoryStore } from "../../memory/store.ts";
import { registerWorkflowTools } from "../../workflow/tools.ts";
import { Level, newManagerWithOptions } from "../../sandbox/sandbox.ts";
import { sandboxOptionsFromSettings } from "../../agentruntime/session_runtime.ts";
import {
  generateID,
  runUserEntryID,
  findBinding,
  rotateBoundSession,
  type Manager as SessionManager,
} from "../../session/mod.ts";
import {
  type DeliveryOperation,
  ErrDeliveryOperationBusy,
  getDeliveryOperation,
} from "../../session/delivery_store.ts";
import type {
  Attachment,
  Message,
  Provider,
} from "../../provider/mod.ts";
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
  effectiveChannelMode,
  formatRetryProgress,
  formatToolProgress,
  channelSafeSubAgentEvent,
  isIncompleteRunError,
  newChannelRunFailure,
} from "./run_helpers.ts";
import {
  channelRunSource,
  channelAttachmentIngresses,
} from "./dispatcher.ts";
import type {
  AgentApprovalHandler,
  ChannelSession,
  ChannelSessionLease,
  Dispatcher,
} from "./dispatcher.ts";
import { ErrSessionRunBusy, loadA2AAgentList } from "./dispatcher.ts";
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

  async claim(
    _signal: AbortSignal | undefined,
    operationID: string,
  ): Promise<DeliveryOperation | null> {
    if (operationID.trim() === "") return null;
    const existing = this.#claims.get(operationID);
    if (existing !== undefined) return { ...existing };
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
            return current;
          }
        } catch {
          // fall through to the original error
        }
      }
      throw err;
    }
    this.#claims.set(operationID, claimed);
    return { ...claimed };
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
          this.complete(signal, claimed, status, providerMessageID, failureCode);
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
    const self = this;
    let prepared = false;
    const prepare = (signal: AbortSignal): Promise<void> => {
      if (prepared) return Promise.resolve();
      return (async () => {
        if (upload.id !== "") {
          await self.claim(signal, upload.id);
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
            const uploadClaim = await self.claim(signal, upload.id);
            if (uploadClaim !== null) {
              self.progress(
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
            const uploadClaim = await self.claim(signal, upload.id);
            if (uploadClaim !== null) {
              uploadClaim.providerAssetId = providerAssetID;
              uploadClaim.providerState = providerState;
              self.complete(signal, uploadClaim, status, "", failureCode);
            }
          } catch {
            // ignored
          }
        })();
      },
      prepareSend: (signal) =>
        this.claim(signal, send.id).then(() => {}),
      completeSend: (
        signal,
        status,
        providerMessageID,
        providerState,
        failureCode,
      ) => {
        void (async () => {
          try {
            const sendClaim = await self.claim(signal, send.id);
            if (sendClaim !== null) {
              sendClaim.providerState = providerState;
              self.complete(
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
            const uploadClaim = await self.claim(signal, upload.id);
            if (uploadClaim !== null) {
              self.complete(signal, uploadClaim, status, "", failureCode);
            }
          } catch {
            // ignored
          }
          try {
            const sendClaim = await self.claim(signal, send.id);
            if (sendClaim !== null) {
              self.complete(
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
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
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
  if ((msg.platform === "feishu" || msg.platform === "wechat") && msg.chatID !== "") {
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
      "Generated attachments are available in the MothX WebUI session. This text-only caller cannot send media attachments.";
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
    throw new Error("session changed while message was waiting for runtime lock");
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
    return {};
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
      result = await runAgent(d, runSignal, sess, userMessage, msg.progressFunc ?? null);
    } catch (err) {
      const finishErr = await finishRun(d, execution, runID, runSource, modelID, sess, err, null);
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
      });
    } catch (planErr) {
      const finishErr = await finishRun(d, execution, runID, runSource, modelID, sess, planErr, null);
      if (finishErr !== null) {
        console.error(`[channels] finish failed Run ${runID}: ${finishErr}`);
      }
      throw planErr;
    }
    let plan = planned.plan;
    const fallbackText = planned.fallbackText;
    if (fallbackText !== "") {
      const frozen = decodeTransportContext(plan.intent.transportContext);
      const frozenRecord = (plan.intent.transportContext ?? {}) as Record<string, unknown>;
      frozenRecord["fallback"] = fallbackText;
      void frozen;
      plan = { ...plan, intent: { ...plan.intent, transportContext: frozenRecord } };
    }
    const planPtr = plan.operations.length > 0 ? plan : null;
    const finishErr = await finishRun(d, execution, runID, runSource, modelID, sess, null, planPtr);
    if (finishErr !== null) throw new Error(finishErr);
    return await projectDelivery(d, signal, sess, msg, result, plan, fallbackText);
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
      rotateBoundSession(workDir, d.sessionDir, platform, userID, current.sessionId);
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
export async function projectDelivery(
  d: Dispatcher,
  signal: AbortSignal,
  sess: ChannelSession | null,
  _inbound: InboundMessage,
  result: ChannelRunResult,
  plan: DeliveryPlan,
  fallbackText: string,
): Promise<MessageResponse> {
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
    if (operation.operationKind !== "send_artifact" || operation.artifactId === "") {
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
          `resolve delivery artifact ${operation.artifactId}: ${errorMessage(err)}`,
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
    sandboxOptionsFromSettings(d.settings),
  );
  if (sandboxEnabled) {
    try {
      sbMgr.setLevel(Level.Standard);
    } catch (err) {
      throw new Error(`enable sandbox: ${errorMessage(err)}`);
    }
    const fallback = sbMgr.fallbackError();
    if (fallback !== undefined) {
      console.error(`[channels] sandbox unavailable; using direct execution: ${fallback}`);
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
          if (isMultiAgentToolName(name) && toolEnabled(name, multiAgentEnabled)) {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
