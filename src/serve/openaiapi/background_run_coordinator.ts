// Ported from internal/serve/openaiapi/background_run_coordinator.go — the
// full durable coordinator for one remote Responses background task: the
// execute halves (executeResponsesBackgroundRun / …RunWithConfig), the
// function-call tool executor, the startup/reconnect recovery and reattach
// paths, the recovered-run monitor, and the result finalizer. The submit path
// dispatches through the `executeResponsesBackgroundRun` Server hook; the
// external submission entry point lives in background_external.ts.
//
// executeResponsesBackgroundRun deliberately coordinates durable run state
// instead of invoking Agent.Run: a remote response_id can outlive this
// process, whereas an Agent loop cannot.
//
// Deviations: Go's goroutine + defer chain maps to an async function whose
// finally blocks replay Go's LIFO defer order (durable finisher + FinalizeRun,
// then the complete callback, then the session unlock, then the runtime
// release); `context.Context` maps to an optional AbortSignal (30-second
// request/poll timeouts use `AbortSignal.timeout`); Go's `time.Timer` select
// maps to a sleep raced against the run-cancel signal; `session_json.RawMessage`
// fields arrive already decoded; `errors.Is` sentinels are matched by sentinel
// identity (`ErrResponsesRuntimeBusy`). The durable lifecycle stays
// ExecutionRuntime-owned.

import type { Agent } from "../../agent/agent.ts";
import {
  type Event as AgentEvent,
  EventTextDelta,
  EventToolApprovalRequest,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  EventToolResult,
} from "../../agent/events.ts";
import { newRunContext } from "../../agent/run_context.ts";
import { boundedParallel } from "../../agent/parallel.ts";
import { newToolLaunchOrder } from "../../agent/tool_launch.ts";
import { DefaultIterationBudgetWallClock } from "../../agent/iteration_budget.ts";
import type { AgentBuildOptions } from "../../agentruntime/session_runtime.ts";
import { RunStateRunning } from "../../agentruntime/run_state.ts";
import { updateDurableRun } from "../../agentruntime/durable_ops.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import {
  deliveryPendingData,
  newDeliveryPendingEvent,
} from "../../agentruntime/delivery_events.ts";
import {
  recoverOrphanedSessionRun,
  RecoveryFailLocal,
} from "../../agentruntime/run_recovery.ts";
import type { RunEvent } from "../../agentruntime/run_event.ts";
import type { SessionRun } from "../../session/run_store.ts";
import {
  acquireRecovery,
  getResponseTurn,
  listOrphanedSessionRuns,
  listResponseItems,
  listResponseRuns,
  type ResponseItemArchive,
  type ResponseRun,
  runUserEntryID,
} from "../../session/mod.ts";
import type {
  Attachment,
  ContentBlock,
  Message,
  Model,
  ToolCallBlock,
  Usage,
} from "../../provider/types.ts";
import {
  newAssistantMessage,
  newToolResultMessage,
} from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { webUIActiveRunState, webUIRunState } from "./runtime_run_state.ts";
import { runtimeRunEventSink } from "./runtime_run_events.ts";
import { finalizeRun } from "./run_manager.ts";
import {
  canonicalRunIdentity,
  recordSessionRunEvent,
  runEventTypeForStatus,
} from "./events.ts";
import {
  isTerminalResponsesRunState,
  publishSessionRuntimeForSession,
} from "./session_runtime_snapshot.ts";
import { publishToolEvent, publishTranscriptEvent } from "./session_stream.ts";
import {
  recoveredApprovalDecision,
  registerSessionApproval,
} from "./approval.ts";
import { buildAgentOptionsForSession } from "./session_patch.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { runRetriesPersistedMessage } from "./handler_run_submit.ts";
import {
  assistantAttachmentsTranscriptEvent,
  assistantDeltaTranscriptEvent,
  summarizeToolStatusResult,
} from "./chat_support.ts";
import type { ToolStatusEvent } from "./types.ts";
import type { Server } from "./server.ts";
import { type APISession, messageText } from "./session_mgr.ts";

export const responsesBackgroundPollIntervalMs = 1000; // time.Second

/** Go's ErrResponsesRuntimeBusy sentinel (matched by identity). */
export const ErrResponsesRuntimeBusy = new Error(
  "Responses background session runtime is busy",
);
ErrResponsesRuntimeBusy.name = "ErrResponsesRuntimeBusy";

/**
 * Providers that can execute a remote Responses background run implement this
 * capability (Go's anonymous interface assertions on s.provider).
 */
export interface ResponsesBackgroundCapableProvider extends Provider {
  responsesBackgroundEnabled(): boolean;
  /** Optional local hosted-tool deadline in milliseconds (0 = none). */
  responsesHostedTimeout?(): number;
}

export function responsesBackgroundEnabled(server: Server | null): boolean {
  if (!server) return false;
  const provider = server.provider;
  const manager = server.responsesRuns;
  const capable = provider as
    | Partial<ResponsesBackgroundCapableProvider>
    | undefined;
  return manager !== undefined &&
    capable?.responsesBackgroundEnabled !== undefined &&
    typeof capable.responsesBackgroundEnabled === "function" &&
    capable.responsesBackgroundEnabled();
}

/**
 * ExecuteResponsesBackgroundRunFn is the background-run coordinator hook
 * consumed by the submit path (Go's `go s.executeResponsesBackgroundRun(...)`).
 * The install helper below fills the Server hook.
 */
export type ExecuteResponsesBackgroundRunFn = (
  sess: APISession,
  runId: string,
  runtimeRelease: () => void,
  model: Model | undefined,
  mode: string,
  msg: Message,
  transcript: boolean,
) => void;

export type ResponsesBackgroundCompleteFn = (
  response: string,
  attachments: Attachment[],
  err: Error | null,
) => void;

/** executeResponsesBackgroundRun owns one remote Responses background task. */
export function executeResponsesBackgroundRun(
  server: Server,
  sess: APISession,
  runId: string,
  runtimeRelease: () => void,
  model: Model | undefined,
  mode: string,
  msg: Message,
  transcript: boolean,
): Promise<void> {
  return executeResponsesBackgroundRunWithConfig(
    server,
    sess,
    runId,
    runtimeRelease,
    model,
    mode,
    msg,
    transcript,
    undefined,
    [],
    undefined,
    undefined,
  );
}

/**
 * Binds the coordinator to a Server as the submit-path hook (Go's method
 * value `s.executeResponsesBackgroundRun`).
 */
export function executeResponsesBackgroundRunFn(
  server: Server,
): ExecuteResponsesBackgroundRunFn {
  return (sess, runId, runtimeRelease, model, mode, msg, transcript) => {
    void executeResponsesBackgroundRun(
      server,
      sess,
      runId,
      runtimeRelease,
      model,
      mode,
      msg,
      transcript,
    );
  };
}

/**
 * executeResponsesBackgroundRunWithConfig lets another serve entry point hand
 * the already-resolved request configuration to the shared durable runtime.
 */
export async function executeResponsesBackgroundRunWithConfig(
  server: Server,
  sess: APISession,
  runId: string,
  runtimeRelease: () => void,
  model: Model | undefined,
  mode: string,
  msg: Message,
  transcript: boolean,
  agentOpts?: AgentBuildOptions,
  initialHistory: Message[] = [],
  complete?: ResponsesBackgroundCompleteFn,
  progress?: (text: string) => void,
): Promise<void> {
  let terminalStatus = "failed";
  let conversationTurnId = "turn-" + runId;
  let runSource = "responses_background";
  const durableLifecycle = sess.isDurableRun(runId);

  try {
    const resolved = canonicalRunIdentity(server, sess, runSource, mode);
    const policyErr = resolved.err;
    if (policyErr === null) {
      runSource = resolved.source;
      mode = resolved.mode;
    }

    try {
      // -------------------------------------------------------------------
      // Coordinator body; every Go `return` below leaves through the finally
      // chain exactly like the deferred finalizers.
      // -------------------------------------------------------------------
      const manager = server.responsesRuns;
      if (policyErr !== null) {
        recordSessionRunEvent(
          server,
          sess,
          runId,
          "failed",
          "failed",
          runSource,
          model?.id ?? "",
          mode,
          { error: policyErr.message },
        );
        return;
      }
      if (!manager) return;

      let opts = agentOpts;
      if (!opts && model) {
        opts = buildAgentOptionsForSession(server, sess, model, mode);
      }
      if (opts) {
        if (opts.intentId) conversationTurnId = "turn-" + opts.intentId;
        opts = {
          ...opts,
          runId,
          conversationTurnId,
          conversationTurn: true,
          runtimeOwnsTurnEnd: true,
          providerName: server.providerName,
          provider: server.provider,
          model,
        };
      }
      let backgroundAgent: Agent;
      try {
        backgroundAgent = sess.runtime!.buildAgent(opts ?? {});
      } catch (err) {
        recordSessionRunEvent(
          server,
          sess,
          runId,
          "failed",
          "failed",
          "responses_background",
          model?.id ?? "",
          mode,
          { error: (err as Error).message },
        );
        return;
      }
      const replayState = sess.manager!.getReplayState();
      if (replayState.messages.length > 0) {
        backgroundAgent.loadHistoryState(
          replayState.messages,
          replayState.entryIDs,
        );
      } else if (initialHistory.length > 0) {
        backgroundAgent.loadHistoryMessages(initialHistory);
      }
      let reusePersistedMessage = runRetriesPersistedMessage(
        server,
        runId,
        sess,
        replayState.messages,
        msg,
      );
      if (
        !reusePersistedMessage &&
        replayStateContainsRunUserEntry(replayState, runId)
      ) {
        // Durable admission atomically appended the run's admitted user entry
        // before this coordinator started, and the manager reload surfaced it
        // in the replay state. Reuse it as the continuation message instead
        // of appending a duplicate to the transcript and the provider request.
        reusePersistedMessage = true;
      }
      let params;
      try {
        params = reusePersistedMessage
          ? backgroundAgent.buildBackgroundContinuationParams(runId)
          : backgroundAgent.buildBackgroundChatParams(runId, msg);
      } catch (err) {
        recordSessionRunEvent(
          server,
          sess,
          runId,
          "failed",
          "failed",
          "responses_background",
          model?.id ?? "",
          mode,
          { error: (err as Error).message },
        );
        return;
      }

      // Keep the local transcript authoritative before any remote request
      // exists. Runs whose user entry was already persisted by durable
      // admission or a previous attempt skip this append to keep the
      // transcript idempotent.
      if (!reusePersistedMessage) {
        try {
          sess.manager!.appendMessage(msg);
        } catch (err) {
          recordSessionRunEvent(
            server,
            sess,
            runId,
            "failed",
            "failed",
            "responses_background",
            model?.id ?? "",
            mode,
            { error: (err as Error).message },
          );
          return;
        }
      }

      let run: ResponseRun;
      try {
        run = await manager.start(
          sess.id,
          runId,
          params,
          AbortSignal.timeout(30_000),
        );
      } catch (err) {
        recordSessionRunEvent(
          server,
          sess,
          runId,
          "failed",
          "failed",
          "responses_background",
          model?.id ?? "",
          mode,
          { error: (err as Error).message },
        );
        return;
      }
      const runAbort = new AbortController();
      const cancelRun = () => runAbort.abort();
      if (
        !sess.attachRunAgent(runId, backgroundAgent, () => {
          cancelRun();
          backgroundAgent.abort();
        })
      ) {
        return;
      }
      if (server.runManager) {
        attachResponsesBackgroundCancel(
          server,
          runId,
          sess.id,
          run.localRunId,
          () => {
            cancelRun();
            backgroundAgent.abort();
          },
        );
      }
      const execution = sess.executionRuntime();
      if (durableLifecycle && execution) {
        execution.updateDurable(runId, RunStateRunning, "");
      } else {
        updateDurableRun(server.sessionDir(), runId, RunStateRunning, "");
      }
      recordSessionRunEvent(
        server,
        sess,
        runId,
        "remote_started",
        "running",
        "responses_background",
        model?.id ?? "",
        mode,
        {
          responseRunId: run.localRunId,
          responseId: run.responseId,
          state: run.state,
        },
      );
      publishSessionRuntimeForSession(server, sess);

      let replayAttempted = false;
      const hostedDeadline = responsesHostedDeadline(server.provider);
      const maxDeadline = Date.now() + backgroundRunMaxDuration(server);
      for (;;) {
        if (Date.now() >= maxDeadline) {
          try {
            await manager.cancel(
              sess.id,
              run.localRunId,
              AbortSignal.timeout(30_000),
            );
          } catch {
            // Go ignores the cancel error (`_ =`).
          }
          terminalStatus = "incomplete";
          recordSessionRunEvent(
            server,
            sess,
            runId,
            "finished",
            terminalStatus,
            "responses_background",
            model?.id ?? "",
            mode,
            {
              responseRunId: run.localRunId,
              responseId: run.responseId,
              incompleteReason: "mothx_background_run_max_duration",
            },
          );
          return;
        }
        if (hostedDeadline !== 0 && Date.now() >= hostedDeadline) {
          try {
            await manager.cancel(
              sess.id,
              run.localRunId,
              AbortSignal.timeout(30_000),
            );
          } catch {
            // Go ignores the cancel error (`_ =`).
          }
          terminalStatus = "incomplete";
          recordSessionRunEvent(
            server,
            sess,
            runId,
            "finished",
            terminalStatus,
            "responses_background",
            model?.id ?? "",
            mode,
            {
              responseRunId: run.localRunId,
              responseId: run.responseId,
              incompleteReason: "mothx_code_interpreter_timeout",
            },
          );
          return;
        }
        if (isTerminalResponsesRunState(run.state)) {
          if (
            run.state.trim().toLowerCase() === "expired" && !replayAttempted
          ) {
            const previousRunId = run.localRunId;
            try {
              const next = await startResponsesBackgroundReplay(
                server,
                sess.id,
                runId,
                run.localTurnId,
                backgroundAgent,
              );
              replayAttempted = true;
              run = next;
              recordSessionRunEvent(
                server,
                sess,
                runId,
                "remote_state_replay",
                "running",
                "responses_background",
                model?.id ?? "",
                mode,
                {
                  responseRunId: next.localRunId,
                  previousResponseRunId: previousRunId,
                  reason: "remote Responses state expired",
                },
              );
              continue;
            } catch {
              // Fall through to terminal handling below.
            }
          }
          let calls: ToolCallBlock[];
          try {
            calls = await responsesBackgroundFunctionCallsForRun(
              server.sessionDir(),
              sess.id,
              run.localTurnId,
            );
          } catch (err) {
            recordSessionRunEvent(
              server,
              sess,
              runId,
              "failed",
              "failed",
              "responses_background",
              model?.id ?? "",
              mode,
              { error: (err as Error).message },
            );
            return;
          }
          if (calls.length > 0) {
            const { outputs, ok } =
              await executeResponsesBackgroundToolsWithProgress(
                server,
                runAbort.signal,
                sess,
                backgroundAgent,
                runId,
                run.localTurnId,
                calls,
                false,
                progress,
              );
            if (!ok) return;
            const continuationTurnId = runId + ":" + run.localRunId;
            let next: ResponseRun;
            try {
              next = await manager.continue(
                sess.id,
                continuationTurnId,
                run,
                outputs ?? [],
                params,
                AbortSignal.timeout(30_000),
              );
            } catch (continueErr) {
              if (backgroundAgent.responsesStateFallbackError(continueErr)) {
                const previousRunId = run.localRunId;
                try {
                  const replayParams = backgroundAgent
                    .buildBackgroundReplayParams(
                      continuationTurnId,
                    );
                  try {
                    const replayed = await manager.start(
                      sess.id,
                      continuationTurnId + ":replay",
                      replayParams,
                      AbortSignal.timeout(30_000),
                    );
                    run = replayed;
                    recordSessionRunEvent(
                      server,
                      sess,
                      runId,
                      "remote_state_replay",
                      "running",
                      "responses_background",
                      model?.id ?? "",
                      mode,
                      {
                        responseRunId: replayed.localRunId,
                        previousResponseRunId: previousRunId,
                        reason: "remote Responses state unavailable",
                      },
                    );
                    continue;
                  } catch {
                    // Fall through to the failure projection.
                  }
                } catch {
                  // Fall through to the failure projection.
                }
              }
              recordSessionRunEvent(
                server,
                sess,
                runId,
                "failed",
                "failed",
                "responses_background",
                model?.id ?? "",
                mode,
                {
                  error: (continueErr as Error).message,
                  responseRunId: run.localRunId,
                },
              );
              return;
            }
            run = next;
            recordSessionRunEvent(
              server,
              sess,
              runId,
              "remote_continuation",
              "running",
              "responses_background",
              model?.id ?? "",
              mode,
              { responseRunId: run.localRunId, responseId: run.responseId },
            );
            continue;
          }
          terminalStatus = finalizeResponsesBackgroundResult(
            server,
            sess,
            runId,
            model?.id ?? "",
            mode,
            run,
            transcript,
          );
          return;
        }
        const cancelled = await sleepOrCancel(
          responsesBackgroundPollIntervalMs,
          runAbort.signal,
        );
        if (cancelled) {
          terminalStatus = "cancelled";
          return;
        }
        const currentRun = run;
        let refreshed: ResponseRun | null;
        try {
          refreshed = await manager.get(
            sess.id,
            currentRun.localRunId,
            AbortSignal.timeout(30_000),
          );
        } catch (err) {
          if (
            !replayAttempted && backgroundAgent.responsesStateFallbackError(err)
          ) {
            try {
              const next = await startResponsesBackgroundReplay(
                server,
                sess.id,
                runId,
                currentRun.localTurnId,
                backgroundAgent,
              );
              replayAttempted = true;
              const previousRunId = currentRun.localRunId;
              run = next;
              recordSessionRunEvent(
                server,
                sess,
                runId,
                "remote_state_replay",
                "running",
                "responses_background",
                model?.id ?? "",
                mode,
                {
                  responseRunId: next.localRunId,
                  previousResponseRunId: previousRunId,
                  reason:
                    "remote Responses state unavailable during background poll",
                },
              );
              continue;
            } catch {
              // Fall through to the failure projection.
            }
          }
          recordSessionRunEvent(
            server,
            sess,
            runId,
            "failed",
            "failed",
            "responses_background",
            model?.id ?? "",
            mode,
            { error: (err as Error).message },
          );
          return;
        }
        if (refreshed) run = refreshed;
        publishSessionRuntimeForSession(server, sess);
      }
    } finally {
      // Go's deferred durable finisher + FinalizeRun (LIFO slot 2/3).
      const execution = sess.executionRuntime();
      if (durableLifecycle && execution) {
        try {
          await execution.finishDurableWithRetry(
            undefined,
            runId,
            webUIRunState(terminalStatus, ""),
            "",
            {
              sessionId: sess.id,
              runId,
              eventType: runEventTypeForStatus(terminalStatus),
              source: runSource,
              status: terminalStatus,
              model: model?.id ?? "",
              mode,
              timestamp: new Date(),
            } satisfies RunEvent,
          );
        } catch (err) {
          // Cancellation may have terminalized the durable row concurrently.
          if (execution.active().active) {
            recordSessionRunEvent(
              server,
              sess,
              runId,
              "failed",
              "failed",
              runSource,
              model?.id ?? "",
              mode,
              { error: (err as Error).message },
            );
          }
        }
      }
      finalizeRun(server, sess, runId, terminalStatus, "");
    }
  } finally {
    // Go's deferred complete callback (LIFO slot 3), then sess.Unlock and
    // runtimeRelease (LIFO slots 4 and 5).
    if (complete) {
      let response = "";
      let attachments: Attachment[] = [];
      const messages = sess.manager?.getMessages() ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (
          messages[i].role === "assistant" &&
          (messageText(messages[i]).trim() !== "" ||
            (messages[i].attachments?.length ?? 0) > 0)
        ) {
          response = messageText(messages[i]);
          attachments = [...(messages[i].attachments ?? [])];
          break;
        }
      }
      if (terminalStatus === "completed" || terminalStatus === "incomplete") {
        complete(response, attachments, null);
      } else {
        complete(
          response,
          attachments,
          new Error(
            `background Responses run ended with status ${terminalStatus}`,
          ),
        );
      }
    }
    sess.mu.unlock();
    runtimeRelease();
  }
}

/** responsesHostedDeadline resolves the optional hosted-tool deadline (ms). */
export function responsesHostedDeadline(
  active: Provider | undefined,
): number {
  if (!active) return 0;
  const reporter = active as Partial<ResponsesBackgroundCapableProvider>;
  if (
    !reporter.responsesHostedTimeout ||
    typeof reporter.responsesHostedTimeout !== "function"
  ) {
    return 0;
  }
  const timeout = reporter.responsesHostedTimeout();
  if (timeout <= 0) return 0;
  return Date.now() + timeout;
}

/**
 * defaultBackgroundRunMaxDurationMs caps how long the coordinator polls a
 * remote Responses run before declaring it incomplete. Without a cap a remote
 * run that never reaches a terminal state would hold the session runtime lock
 * forever, blocking channel /new and any other run for the session. It matches
 * the agent loop's wall-clock budget so a run the policy still allows is not
 * cut short by a shorter polling cap.
 */
export const defaultBackgroundRunMaxDurationMs =
  DefaultIterationBudgetWallClock;

/**
 * backgroundRunMaxDuration returns the configured hard cap for durable
 * background polling (api.backgroundRunMaxSeconds, default 16h), in
 * milliseconds.
 */
export function backgroundRunMaxDuration(server: Server | null): number {
  if (!server) return defaultBackgroundRunMaxDurationMs;
  const secs = server.cfg?.backgroundRunMaxSecs ?? 0;
  if (secs > 0) return secs * 1000;
  return defaultBackgroundRunMaxDurationMs;
}

/**
 * startResponsesBackgroundReplay creates one durable native-replay response
 * after the remote state is explicitly known to be unavailable. It is shared
 * by expiry and poll-error paths so availability behavior does not diverge by
 * entry point. Callers enforce the one-replay limit for each local run.
 */
export async function startResponsesBackgroundReplay(
  server: Server,
  sessionID: string,
  runID: string,
  localTurnID: string,
  backgroundAgent: Agent | null,
): Promise<ResponseRun> {
  const manager = server?.responsesRuns;
  if (!manager || !backgroundAgent) {
    throw new Error("Responses background replay is unavailable");
  }
  const params = backgroundAgent.buildBackgroundReplayParams(localTurnID);
  let replayID = runID + ":replay";
  if (localTurnID !== "" && localTurnID !== runID) {
    replayID = runID + ":" + localTurnID + ":replay";
  }
  return await manager.start(
    sessionID,
    replayID,
    params,
    AbortSignal.timeout(30_000),
  );
}

/** executeResponsesBackgroundTools ports the no-progress wrapper. */
export function executeResponsesBackgroundTools(
  server: Server,
  ctx: AbortSignal | undefined,
  sess: APISession,
  backgroundAgent: Agent | null,
  runID: string,
  localTurnID: string,
  calls: ToolCallBlock[],
): Promise<{ outputs: Message[] | null; ok: boolean }> {
  return executeResponsesBackgroundToolsWithProgress(
    server,
    ctx,
    sess,
    backgroundAgent,
    runID,
    localTurnID,
    calls,
    false,
    undefined,
  );
}

/** executeResponsesBackgroundToolsWithRecovery ports the recovery wrapper. */
export function executeResponsesBackgroundToolsWithRecovery(
  server: Server,
  ctx: AbortSignal | undefined,
  sess: APISession,
  backgroundAgent: Agent | null,
  runID: string,
  localTurnID: string,
  calls: ToolCallBlock[],
  recoverReadOnly: boolean,
): Promise<{ outputs: Message[] | null; ok: boolean }> {
  return executeResponsesBackgroundToolsWithProgress(
    server,
    ctx,
    sess,
    backgroundAgent,
    runID,
    localTurnID,
    calls,
    recoverReadOnly,
    undefined,
  );
}

/**
 * executeResponsesBackgroundToolsWithProgress executes the remote function
 * calls concurrently (independent calls do not serialize remote latency) while
 * collecting and persisting outputs by original call order for deterministic
 * continuation input and transcript replay. The shared ToolLaunchOrder handle
 * keeps each call's reported start in that same declared order.
 */
export async function executeResponsesBackgroundToolsWithProgress(
  server: Server,
  ctx: AbortSignal | undefined,
  sess: APISession,
  backgroundAgent: Agent | null,
  runID: string,
  localTurnID: string,
  calls: ToolCallBlock[],
  recoverReadOnly: boolean,
  progress?: (text: string) => void,
): Promise<{ outputs: Message[] | null; ok: boolean }> {
  if (!backgroundAgent) return { outputs: null, ok: false };
  const blocks: ContentBlock[] = calls.map((call) => ({
    type: "toolCall",
    toolCall: call,
  }));
  try {
    sess.manager!.appendMessage(newAssistantMessage(blocks));
  } catch {
    return { outputs: null, ok: false };
  }
  interface ToolOutcome {
    output: Message | null;
    interrupted: boolean;
  }
  let progressSeq: Promise<void> = Promise.resolve();
  const sendProgress = (text: string): void => {
    if (!progress || text.trim() === "") return;
    // Serialize progress emission so consumers see the declared start order.
    progressSeq = progressSeq.then(() => progress(text)).catch(() => {});
  };
  const launchOrder = newToolLaunchOrder(calls.length);
  const indexes = calls.map((_, index) => index);
  const outcomes = await boundedParallel<number, ToolOutcome>(
    backgroundAgent.maxToolConcurrency(),
    indexes,
    async (index): Promise<ToolOutcome> => {
      const call = calls[index];
      const stream = backgroundAgent!.executeBackgroundToolCallOrdered(
        newRunContext(ctx),
        call,
        localTurnID,
        recoverReadOnly,
        launchOrder ? launchOrder.handle(index) : null,
      );
      let output: Message | null = null;
      let interrupted = false;
      for await (const ev of stream) {
        publishResponsesBackgroundToolEvent(
          server,
          sess,
          backgroundAgent,
          runID,
          ev,
        );
        if (ev.type === EventToolExecutionStart) {
          sendProgress(`Tool ${ev.toolName} running`);
        }
        if (ev.type === EventToolExecutionEnd) {
          let status = "completed";
          if (ev.toolExecutionState === "interrupted") {
            status = "interrupted";
          } else if (ev.toolError) {
            status = "failed";
          }
          let summary = summarizeToolStatusResult(ev.toolResult ?? "");
          if (summary === "(empty result)") summary = "";
          let line = `Tool ${ev.toolName} ${status}`;
          if (summary !== "") line += ": " + summary;
          sendProgress(line);
        }
        if (ev.toolExecutionState === "interrupted") {
          interrupted = true;
        }
        if (ev.type === EventToolResult) {
          const result = newToolResultMessage(
            ev.toolCallId ?? "",
            ev.toolName ?? "",
            ev.toolResult ?? "",
            !!ev.toolError,
          );
          result.toolKind = call.kind;
          output = result;
        } else if (ev.type === EventToolExecutionEnd && output === null) {
          const result = newToolResultMessage(
            ev.toolCallId ?? "",
            ev.toolName ?? "",
            ev.toolResult ?? "",
            !!ev.toolError,
          );
          result.toolKind = call.kind;
          output = result;
        }
      }
      return { output, interrupted };
    },
  );
  const ordered: (Message | null)[] = [];
  let allSucceeded = true;
  for (const outcome of outcomes) {
    if (!outcome.output) {
      allSucceeded = false;
      ordered.push(null);
      continue;
    }
    if (outcome.interrupted) {
      allSucceeded = false;
    }
    ordered.push(outcome.output);
  }
  if (!allSucceeded) {
    return { outputs: null, ok: false };
  }
  const outputs: Message[] = [];
  for (const output of ordered) {
    if (output === null) return { outputs: null, ok: false };
    try {
      sess.manager!.appendMessage(output);
    } catch {
      return { outputs: null, ok: false };
    }
    outputs.push(output);
  }
  return { outputs, ok: true };
}

/** publishResponsesBackgroundToolEvent projects one tool event. */
export function publishResponsesBackgroundToolEvent(
  server: Server | null,
  sess: APISession | null,
  backgroundAgent: Agent | null,
  runID: string,
  ev: AgentEvent,
): void {
  if (!server || !sess) return;
  switch (ev.type) {
    case EventToolApprovalRequest:
      registerSessionApproval(server, sess, backgroundAgent, ev);
      break;
    case EventToolExecutionStart: {
      const toolEvent: ToolStatusEvent = {
        tool: ev.toolName ?? "",
        toolCallId: ev.toolCallId,
        status: "running",
        args: ev.toolArgs,
      };
      publishToolEvent(server, sess.id, toolEvent);
      persistResponsesBackgroundToolProgress(
        server,
        sess,
        runID,
        ev.toolName ?? "",
        ev.toolCallId ?? "",
        "running",
        "",
      );
      break;
    }
    case EventToolExecutionEnd: {
      let status = "completed";
      if (ev.toolExecutionState === "interrupted") {
        status = "interrupted";
      } else if (ev.toolError) {
        status = "failed";
      }
      let summary = summarizeToolStatusResult(ev.toolResult ?? "");
      if (
        status === "interrupted" &&
        (summary === "" || summary === "(empty result)")
      ) {
        summary =
          "Execution interrupted; recovery requires explicit confirmation.";
      }
      const toolEvent: ToolStatusEvent = {
        tool: ev.toolName ?? "",
        toolCallId: ev.toolCallId,
        status,
        args: ev.toolArgs,
        summary,
        isError: !!ev.toolError,
        hasDetail: !!ev.toolCallId,
      };
      publishToolEvent(server, sess.id, toolEvent);
      persistResponsesBackgroundToolProgress(
        server,
        sess,
        runID,
        ev.toolName ?? "",
        ev.toolCallId ?? "",
        status,
        summary,
      );
      break;
    }
    default:
      break;
  }
  if (server.runManager) {
    server.runManager.publish(runID, ev);
  }
}

function persistResponsesBackgroundToolProgress(
  server: Server | null,
  sess: APISession | null,
  runID: string,
  toolName: string,
  toolCallID: string,
  status: string,
  summary: string,
): void {
  if (!server || !server.settings || !sess || runID === "") return;
  let source = "responses_background";
  const run = getDurableRun(server.sessionDir(), runID);
  if (run && run.source.trim().toLowerCase().startsWith("channel:")) {
    source = run.source;
  }
  recordSessionRunEvent(
    server,
    sess,
    runID,
    "tool_progress",
    status,
    source,
    "",
    "",
    { tool: toolName, toolCallId: toolCallID, status, summary },
  );
}

/** attachResponsesBackgroundCancel wires run-manager cancel to remote cancel. */
export function attachResponsesBackgroundCancel(
  server: Server | null,
  runID: string,
  sessionID: string,
  localRunID: string,
  localCancel: (() => void) | null,
): void {
  if (
    !server || !server.runManager || runID === "" || sessionID === "" ||
    localRunID === ""
  ) {
    return;
  }
  const manager = server.responsesRuns;
  if (!manager) return;
  server.runManager.attach(runID, sessionID, () => {
    localCancel?.();
    manager.cancel(sessionID, localRunID, AbortSignal.timeout(30_000)).catch(
      () => {},
    );
  });
}

/**
 * recoverResponsesBackgroundRuns reattaches pending remote Responses tasks
 * after server startup. It deliberately requires the local SessionRun and
 * ResponseRun linkage to agree before it polls a remote response.
 */
export async function recoverResponsesBackgroundRuns(
  server: Server,
): Promise<Error | null> {
  if (
    !server || !server.runManager || !server.responsesRuns || !server.settings
  ) {
    return null;
  }
  let orphans;
  try {
    orphans = listOrphanedSessionRuns(server.sessionDir());
  } catch (err) {
    return err as Error;
  }
  for (const localRun of orphans) {
    if (localRun.source !== "responses_background") continue;
    let responseRuns;
    try {
      responseRuns = listResponseRuns(
        server.sessionDir(),
        localRun.sessionId,
        100,
      );
    } catch (err) {
      return err as Error;
    }
    let responseRun: ResponseRun | null = null;
    for (const candidate of responseRuns) {
      if (
        candidate.localTurnId === localRun.id ||
        candidate.localTurnId.startsWith(localRun.id + ":")
      ) {
        if (
          responseRun === null || candidate.updatedAt > responseRun.updatedAt
        ) {
          responseRun = candidate;
        }
      }
    }
    if (!responseRun) {
      try {
        await recoverOrphanedSessionRun(
          server.sessionDir(),
          localRun.sessionId,
          () => RecoveryFailLocal,
          null,
        );
      } catch {
        // Go ignores the recovery error (`_, _ =`).
      }
      continue;
    }
    const [ok, err] = await reattachResponsesBackgroundRun(
      server,
      localRun,
      responseRun,
    );
    if (!ok && err !== ErrResponsesRuntimeBusy) {
      try {
        await recoverOrphanedSessionRun(
          server.sessionDir(),
          localRun.sessionId,
          () => RecoveryFailLocal,
          null,
        );
      } catch {
        // Go ignores the recovery error (`_, _ =`).
      }
    }
  }
  return null;
}

/**
 * reattachResponsesBackgroundRun resumes exactly one durable background run.
 * It is shared by startup recovery and the authenticated reconnect endpoint so
 * both paths acquire the same runtime/session locks and construct the same
 * tool/approval-aware monitor.
 */
export async function reattachResponsesBackgroundRun(
  server: Server,
  localRun: SessionRun,
  responseRun: ResponseRun | null,
): Promise<[boolean, Error | null]> {
  if (
    !server || !server.runManager || !server.responsesRuns || !server.settings
  ) {
    return [false, new Error("Responses background runtime is unavailable")];
  }
  if (
    localRun.id === "" || localRun.sessionId === "" || !responseRun ||
    responseRun.sessionId !== localRun.sessionId
  ) {
    return [false, new Error("invalid Responses background run linkage")];
  }
  if (isTerminalSessionRunState(localRun.status)) {
    return [false, null];
  }
  let sess: APISession;
  try {
    sess = await getOrCreateSession(
      server,
      localRun.sessionId,
      localRun.workDir,
    );
  } catch {
    return [
      false,
      new Error("unable to restore session for Responses background run"),
    ];
  }
  let recoveryGuard;
  try {
    recoveryGuard = acquireRecovery(server.sessionDir(), sess.id, localRun.id);
  } catch {
    return [false, ErrResponsesRuntimeBusy];
  }
  const runtimeRelease = () => recoveryGuard.release();
  if (!sess.mu.tryLock()) {
    runtimeRelease();
    return [false, ErrResponsesRuntimeBusy];
  }
  try {
    try {
      sess.manager!.reload();
    } catch (err) {
      sess.mu.unlock();
      return [
        false,
        new Error(
          `reload session before Responses recovery: ${(err as Error).message}`,
        ),
      ];
    }
    let model = server.provider?.getModel(localRun.model);
    if (!model) model = server.model;
    if (!model) {
      sess.mu.unlock();
      return [
        false,
        new Error("model for Responses background run is unavailable"),
      ];
    }
    const fallbackSource = localRun.source || "responses_background";
    const identity = canonicalRunIdentity(
      server,
      sess,
      fallbackSource,
      localRun.mode,
    );
    if (identity.err) {
      sess.mu.unlock();
      return [
        false,
        new Error(
          `resolve mode for Responses recovery: ${identity.err.message}`,
        ),
      ];
    }
    localRun.source = identity.source;
    localRun.mode = identity.mode;
    const execution = sess.ensureExecution();
    execution.setRunStore(new RunStore(server.sessionDir()));
    execution.setEventSink(runtimeRunEventSink(server, sess));
    if (sess.runtime) sess.runtime.setExecution(execution);
    const durableRun: DurableRun = {
      id: localRun.id,
      sessionId: localRun.sessionId,
      intentId: localRun.intentId,
      retryOf: localRun.retryOf,
      attempt: localRun.attempt,
      workDir: localRun.workDir,
      source: localRun.source,
      model: localRun.model,
      mode: localRun.mode,
      status: localRun.status,
      startedAt: localRun.startedAt,
      finishedAt: null,
      error: "",
      errorInfo: {},
      progress: {},
      usage: null,
      contextUsage: null,
      inputResourceIds: [],
      submissionKeyHash: "",
      submissionScope: "",
      submissionFingerprint: "",
      userEntryId: "",
      assistantEntryId: "",
      conversationTurnId: responseRun.localTurnId,
      conversationTurn: responseRun.localTurnId !== "",
    };
    try {
      execution.reattachDurableRun(
        undefined,
        durableRun,
        webUIActiveRunState(localRun.status),
        {
          sessionId: localRun.sessionId,
          runId: localRun.id,
          eventType: "reattached",
          source: localRun.source,
          status: localRun.status,
          model: localRun.model,
          mode: localRun.mode,
          timestamp: new Date(),
        } satisfies RunEvent,
      );
    } catch (err) {
      sess.mu.unlock();
      return [
        false,
        new Error(`reattach durable Responses run: ${(err as Error).message}`),
      ];
    }
    sess.beginRunBookkeeping(localRun.id);
    sess.markDurableRun(localRun.id);
    if (server.runManager) {
      server.runManager.register(localRun);
    }
    // Lock and recovery-guard ownership transfer to the monitor task.
    void monitorRecoveredResponsesBackgroundRun(
      server,
      sess,
      localRun,
      responseRun,
      model,
      runtimeRelease,
    );
    return [true, null];
  } catch (err) {
    sess.mu.unlock();
    runtimeRelease();
    throw err;
  }
}

/** isTerminalSessionRunState reports states that must not be reattached. */
export function isTerminalSessionRunState(state: string): boolean {
  switch (state.trim().toLowerCase()) {
    case "completed":
    case "incomplete":
    case "expired":
    case "failed":
    case "cancelled":
    case "canceled":
    case "cancelling":
    case "terminalizing":
      return true;
    default:
      return false;
  }
}

export async function monitorRecoveredResponsesBackgroundRun(
  server: Server,
  sess: APISession,
  localRun: SessionRun,
  responseRun: ResponseRun | null,
  model: Model | undefined,
  runtimeRelease: () => void,
): Promise<void> {
  let terminalStatus = "failed";
  try {
    try {
      await monitorBody();
    } finally {
      const execution = sess.executionRuntime();
      if (execution && sess.isDurableRun(localRun.id)) {
        try {
          await execution.finishDurableWithRetry(
            undefined,
            localRun.id,
            webUIRunState(terminalStatus, ""),
            "",
            {
              sessionId: sess.id,
              runId: localRun.id,
              eventType: runEventTypeForStatus(terminalStatus),
              source: localRun.source,
              status: terminalStatus,
              model: model?.id ?? "",
              mode: localRun.mode,
              timestamp: new Date(),
            } satisfies RunEvent,
          );
        } catch (err) {
          if (execution.active().active) {
            recordSessionRunEvent(
              server,
              sess,
              localRun.id,
              "failed",
              "failed",
              "responses_background",
              model?.id ?? "",
              localRun.mode,
              { error: (err as Error).message },
            );
          }
        }
      }
      finalizeRun(server, sess, localRun.id, terminalStatus, "");
    }
  } finally {
    sess.mu.unlock();
    runtimeRelease();
  }

  async function monitorBody(): Promise<void> {
    if (!responseRun || !model) return;
    const backgroundOpts = buildAgentOptionsForSession(
      server,
      sess,
      model,
      localRun.mode,
    );
    if (localRun.intentId) backgroundOpts.intentId = localRun.intentId;
    backgroundOpts.runId = localRun.id;
    backgroundOpts.conversationTurnId = responseRun.localTurnId;
    backgroundOpts.conversationTurn = responseRun.localTurnId !== "";
    backgroundOpts.runtimeOwnsTurnEnd = backgroundOpts.conversationTurn;
    backgroundOpts.approvalDecisionLookup = (
      toolCallID: string,
      toolName: string,
      args: Record<string, unknown>,
    ): [boolean, boolean] => {
      const decision = recoveredApprovalDecision(
        server,
        sess.id,
        localRun.id,
        toolCallID,
        toolName,
        args,
      );
      return [decision.approved, decision.found];
    };
    backgroundOpts.providerName = server.providerName;
    backgroundOpts.provider = server.provider;
    backgroundOpts.model = model;
    let backgroundAgent: Agent;
    try {
      backgroundAgent = sess.runtime!.buildAgent(backgroundOpts);
    } catch (err) {
      recordSessionRunEvent(
        server,
        sess,
        localRun.id,
        "failed",
        "failed",
        "responses_background",
        model.id,
        localRun.mode,
        { error: (err as Error).message },
      );
      return;
    }
    const replayState = sess.manager!.getReplayState();
    if (replayState.messages.length > 0) {
      backgroundAgent.loadHistoryState(
        replayState.messages,
        replayState.entryIDs,
      );
    }
    let params;
    try {
      params = backgroundAgent.buildBackgroundContinuationParams(
        responseRun.localTurnId,
      );
    } catch (err) {
      recordSessionRunEvent(
        server,
        sess,
        localRun.id,
        "failed",
        "failed",
        "responses_background",
        model.id,
        localRun.mode,
        { error: (err as Error).message },
      );
      return;
    }
    const runAbort = new AbortController();
    if (
      !sess.attachRunAgent(localRun.id, backgroundAgent, () => {
        runAbort.abort();
        backgroundAgent.abort();
      })
    ) {
      return;
    }
    attachResponsesBackgroundCancel(
      server,
      localRun.id,
      sess.id,
      responseRun.localRunId,
      () => {
        runAbort.abort();
        backgroundAgent.abort();
      },
    );
    let replayAttempted = false;
    const hostedDeadline = responsesHostedDeadline(server.provider);
    const maxDeadline = Date.now() + backgroundRunMaxDuration(server);
    for (;;) {
      if (Date.now() >= maxDeadline) {
        try {
          await server.responsesRuns!.cancel(
            sess.id,
            responseRun.localRunId,
            AbortSignal.timeout(30_000),
          );
        } catch {
          // Go ignores the cancel error (`_ =`).
        }
        terminalStatus = "incomplete";
        recordSessionRunEvent(
          server,
          sess,
          localRun.id,
          "finished",
          terminalStatus,
          "responses_background",
          model.id,
          localRun.mode,
          {
            responseRunId: responseRun.localRunId,
            responseId: responseRun.responseId,
            incompleteReason: "mothx_background_run_max_duration",
          },
        );
        return;
      }
      if (hostedDeadline !== 0 && Date.now() >= hostedDeadline) {
        try {
          await server.responsesRuns!.cancel(
            sess.id,
            responseRun.localRunId,
            AbortSignal.timeout(30_000),
          );
        } catch {
          // Go ignores the cancel error (`_ =`).
        }
        terminalStatus = "incomplete";
        recordSessionRunEvent(
          server,
          sess,
          localRun.id,
          "finished",
          terminalStatus,
          "responses_background",
          model.id,
          localRun.mode,
          {
            responseRunId: responseRun.localRunId,
            responseId: responseRun.responseId,
            incompleteReason: "mothx_code_interpreter_timeout",
          },
        );
        return;
      }
      let refreshed: ResponseRun | null;
      try {
        refreshed = await server.responsesRuns!.get(
          sess.id,
          responseRun.localRunId,
          AbortSignal.timeout(30_000),
        );
      } catch (err) {
        if (
          !replayAttempted && backgroundAgent.responsesStateFallbackError(err)
        ) {
          try {
            const next = await startResponsesBackgroundReplay(
              server,
              sess.id,
              localRun.id,
              responseRun.localTurnId,
              backgroundAgent,
            );
            replayAttempted = true;
            const previousRunId = responseRun.localRunId;
            responseRun = next;
            recordSessionRunEvent(
              server,
              sess,
              localRun.id,
              "remote_state_replay",
              "running",
              "responses_background",
              model.id,
              localRun.mode,
              {
                responseRunId: next.localRunId,
                previousResponseRunId: previousRunId,
                reason:
                  "remote Responses state unavailable during recovery poll",
              },
            );
            continue;
          } catch {
            // Fall through to the failure projection.
          }
        }
        recordSessionRunEvent(
          server,
          sess,
          localRun.id,
          "failed",
          "failed",
          "responses_background",
          model.id,
          localRun.mode,
          { error: (err as Error).message },
        );
        return;
      }
      if (refreshed) responseRun = refreshed;
      if (isTerminalResponsesRunState(responseRun.state)) {
        if (
          responseRun.state.trim().toLowerCase() === "expired" &&
          !replayAttempted
        ) {
          const previousRunId = responseRun.localRunId;
          try {
            const next = await startResponsesBackgroundReplay(
              server,
              sess.id,
              localRun.id,
              responseRun.localTurnId,
              backgroundAgent,
            );
            replayAttempted = true;
            responseRun = next;
            recordSessionRunEvent(
              server,
              sess,
              localRun.id,
              "remote_state_replay",
              "running",
              "responses_background",
              model.id,
              localRun.mode,
              {
                responseRunId: next.localRunId,
                previousResponseRunId: previousRunId,
                reason: "remote Responses state expired during recovery",
              },
            );
            continue;
          } catch {
            // Fall through to terminal handling below.
          }
        }
        let calls: ToolCallBlock[];
        try {
          calls = await responsesBackgroundFunctionCallsForRun(
            server.sessionDir(),
            sess.id,
            responseRun.localTurnId,
          );
        } catch (callErr) {
          recordSessionRunEvent(
            server,
            sess,
            localRun.id,
            "failed",
            "failed",
            "responses_background",
            model.id,
            localRun.mode,
            { error: (callErr as Error).message },
          );
          return;
        }
        if (calls.length > 0) {
          const { outputs, ok } =
            await executeResponsesBackgroundToolsWithProgress(
              server,
              runAbort.signal,
              sess,
              backgroundAgent,
              localRun.id,
              responseRun.localTurnId,
              calls,
              true,
              undefined,
            );
          if (!ok) return;
          params.responseOptions = {
            ...(params.responseOptions ?? {}),
            previousResponseId: responseRun.responseId,
          };
          const continuationId = localRun.id + ":" + responseRun.localRunId;
          let next: ResponseRun;
          try {
            next = await server.responsesRuns!.continue(
              sess.id,
              continuationId,
              responseRun,
              outputs ?? [],
              params,
              AbortSignal.timeout(30_000),
            );
          } catch (continueErr) {
            if (backgroundAgent.responsesStateFallbackError(continueErr)) {
              try {
                const replayParams = backgroundAgent
                  .buildBackgroundReplayParams(
                    continuationId,
                  );
                try {
                  const replayed = await server.responsesRuns!.start(
                    sess.id,
                    continuationId + ":replay",
                    replayParams,
                    AbortSignal.timeout(30_000),
                  );
                  const previousRunId = responseRun.localRunId;
                  responseRun = replayed;
                  recordSessionRunEvent(
                    server,
                    sess,
                    localRun.id,
                    "remote_state_replay",
                    "running",
                    "responses_background",
                    model.id,
                    localRun.mode,
                    {
                      responseRunId: replayed.localRunId,
                      previousResponseRunId: previousRunId,
                      reason: "remote Responses state unavailable",
                    },
                  );
                  continue;
                } catch {
                  // Fall through to the failure projection.
                }
              } catch {
                // Fall through to the failure projection.
              }
            }
            recordSessionRunEvent(
              server,
              sess,
              localRun.id,
              "failed",
              "failed",
              "responses_background",
              model.id,
              localRun.mode,
              {
                error: (continueErr as Error).message,
                responseRunId: responseRun.localRunId,
              },
            );
            return;
          }
          responseRun = next;
          recordSessionRunEvent(
            server,
            sess,
            localRun.id,
            "remote_continuation",
            "running",
            "responses_background",
            model.id,
            localRun.mode,
            { responseRunId: next.localRunId, responseId: next.responseId },
          );
          continue;
        }
        terminalStatus = finalizeResponsesBackgroundResult(
          server,
          sess,
          localRun.id,
          model.id,
          localRun.mode,
          responseRun,
          false,
        );
        return;
      }
      const cancelled = await sleepOrCancel(
        responsesBackgroundPollIntervalMs,
        runAbort.signal,
      );
      if (cancelled) {
        recordSessionRunEvent(
          server,
          sess,
          localRun.id,
          "canceled",
          "cancelled",
          "responses_background",
          model.id,
          localRun.mode,
          { reason: "local run context cancelled" },
        );
        return;
      }
    }
  }
}

/** finalizeResponsesBackgroundResult projects the remote terminal state. */
export function finalizeResponsesBackgroundResult(
  server: Server,
  sess: APISession,
  runID: string,
  modelID: string,
  mode: string,
  run: ResponseRun | null,
  transcript: boolean,
): string {
  if (!run) return "failed";
  const state = run.state.trim().toLowerCase();
  if (state !== "completed" && state !== "incomplete") {
    let status = "failed";
    if (state === "cancelled" || state === "canceled") status = "cancelled";
    recordSessionRunEvent(
      server,
      sess,
      runID,
      runEventTypeForStatus(status),
      status,
      "responses_background",
      modelID,
      mode,
      {
        responseRunId: run.localRunId,
        responseId: run.responseId,
        state: run.state,
      },
    );
    return status;
  }

  let items: ResponseItemArchive[];
  try {
    items = listResponseItems(server.sessionDir(), sess.id, run.localTurnId);
  } catch (err) {
    recordSessionRunEvent(
      server,
      sess,
      runID,
      "failed",
      "failed",
      "responses_background",
      modelID,
      mode,
      { error: (err as Error).message },
    );
    return "failed";
  }
  let usage: Usage | undefined;
  let attachments: Attachment[] = [];
  try {
    const details = responsesBackgroundDetails(
      server.sessionDir(),
      sess.id,
      run.localTurnId,
    );
    usage = details.usage;
    attachments = details.attachments;
  } catch (err) {
    recordSessionRunEvent(
      server,
      sess,
      runID,
      "failed",
      "failed",
      "responses_background",
      modelID,
      mode,
      { error: (err as Error).message },
    );
    return "failed";
  }
  let text = "";
  let requiresLocalContinuation = false;
  try {
    const parsed = responsesBackgroundText(items);
    text = parsed.text;
    requiresLocalContinuation = parsed.requiresLocalContinuation;
  } catch (err) {
    recordSessionRunEvent(
      server,
      sess,
      runID,
      "failed",
      "failed",
      "responses_background",
      modelID,
      mode,
      { error: (err as Error).message },
    );
    return "failed";
  }
  if (requiresLocalContinuation) {
    const message =
      "background Responses response reached finalization with an unhandled local tool call";
    recordSessionRunEvent(
      server,
      sess,
      runID,
      "failed",
      "failed",
      "responses_background",
      modelID,
      mode,
      {
        responseRunId: run.localRunId,
        responseId: run.responseId,
        error: message,
      },
    );
    return "failed";
  }
  const localRun = getDurableRun(server.sessionDir(), runID);
  const channelRun = !!localRun &&
    localRun.source.trim().toLowerCase().startsWith("channel:");
  let assistantEntryID = "";
  if (text !== "" || attachments.length > 0) {
    const contents: ContentBlock[] = text !== ""
      ? [{ type: "text", text }]
      : [];
    const message = newAssistantMessage(contents);
    message.attachments = [...attachments];
    let entryID: string;
    try {
      entryID = sess.manager!.appendMessage(message);
    } catch (err) {
      recordSessionRunEvent(
        server,
        sess,
        runID,
        "failed",
        "failed",
        "responses_background",
        modelID,
        mode,
        { error: (err as Error).message },
      );
      return "failed";
    }
    assistantEntryID = entryID;
    if (text !== "") {
      const event: AgentEvent = { type: EventTextDelta, textDelta: text };
      if (server.runManager) {
        server.runManager.publish(runID, event);
      }
      if (transcript) {
        publishTranscriptEvent(
          server,
          sess.id,
          assistantDeltaTranscriptEvent(text, ""),
        );
      } else {
        const broker = server.getEventBroker();
        if (broker) {
          broker.publishTranscriptEvent(
            sess.id,
            runID,
            assistantDeltaTranscriptEvent(text, ""),
          );
        }
      }
    }
  }
  if (attachments.length > 0) {
    const event = assistantAttachmentsTranscriptEvent(attachments, "");
    if (transcript) {
      publishTranscriptEvent(server, sess.id, event);
    } else {
      const broker = server.getEventBroker();
      if (broker) {
        broker.publishTranscriptEvent(sess.id, runID, event);
      }
    }
  }
  let eventData: Record<string, unknown> = {
    responseRunId: run.localRunId,
    responseId: run.responseId,
    state: run.state,
  };
  if (channelRun) {
    eventData = deliveryPendingData(
      run.localRunId,
      run.responseId,
      run.state,
      assistantEntryID,
      undefined,
    );
  }
  if (usage) eventData["usage"] = usage;
  if (state === "incomplete") {
    try {
      const turn = getResponseTurn(
        server.sessionDir(),
        sess.id,
        run.localTurnId,
      );
      if (turn && turn.incompleteReason !== "") {
        eventData["incompleteReason"] = turn.incompleteReason;
      }
    } catch {
      // Go ignores the turn lookup error.
    }
  }
  if (attachments.length > 0) {
    eventData["attachments"] = attachments;
  }
  let eventSource = "responses_background";
  if (channelRun) eventSource = localRun!.source;
  let localStatus = "completed";
  if (state === "incomplete") {
    localStatus = "incomplete";
    eventData["incomplete"] = true;
  }
  if (channelRun) {
    const deliveryEvent = newDeliveryPendingEvent(
      sess.id,
      runID,
      eventSource,
      localStatus,
      modelID,
      mode,
      eventData,
    );
    // Go unmarshals the delivery data back into a map so the recorded event
    // data matches the wire payload; the port already builds a plain object.
    const data = deliveryEvent.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      eventData = data as Record<string, unknown>;
    }
  }
  recordSessionRunEvent(
    server,
    sess,
    runID,
    "finished",
    localStatus,
    eventSource,
    modelID,
    mode,
    eventData,
  );
  return localStatus;
}

/** responsesBackgroundDetails reads the archived turn summary. */
export function responsesBackgroundDetails(
  sessionDir: string,
  sessionID: string,
  localTurnID: string,
): { usage: Usage | undefined; attachments: Attachment[] } {
  const turn = getResponseTurn(sessionDir, sessionID, localTurnID);
  if (
    !turn || turn.responseSummary === null || turn.responseSummary === undefined
  ) {
    throw new Error("response turn summary is missing");
  }
  // Deviation: `session_json.RawMessage` arrives already decoded in the port.
  const summary = turn.responseSummary as {
    usage?: Usage;
    attachments?: Attachment[];
  };
  if (typeof summary !== "object") {
    throw new Error("decode Responses background summary: invalid shape");
  }
  return {
    usage: summary.usage ?? undefined,
    attachments: summary.attachments ?? [],
  };
}

/**
 * responsesBackgroundText extracts the archived output text. Deviation: the
 * archived item JSON arrives already decoded (`sanitizedJson`), so this reads
 * the value instead of unmarshaling raw bytes.
 */
export function responsesBackgroundText(
  items: ResponseItemArchive[],
): { text: string; requiresLocalContinuation: boolean } {
  let text = "";
  for (const item of items) {
    const raw = item.sanitizedJson as {
      type?: string;
      content?: { type?: string; text?: string }[];
    } | null;
    if (raw === null || typeof raw !== "object") {
      throw new Error(
        `decode archived Responses item ${
          JSON.stringify(item.itemId)
        }: invalid shape`,
      );
    }
    switch (raw.type) {
      case "function_call":
      case "custom_tool_call":
        return { text: "", requiresLocalContinuation: true };
      case "computer_call":
      case "computer_call_output":
        throw new Error(
          "Responses computer use is not supported by this version",
        );
      case "message": {
        for (const part of raw.content ?? []) {
          if (part.type === "output_text" || part.type === "text") {
            text += part.text ?? "";
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return { text, requiresLocalContinuation: false };
}

/** responsesBackgroundFunctionCallsForRun loads archived tool calls. */
export function responsesBackgroundFunctionCallsForRun(
  sessionDir: string,
  sessionID: string,
  localTurnID: string,
): ToolCallBlock[] {
  const items = listResponseItems(sessionDir, sessionID, localTurnID);
  const calls: ToolCallBlock[] = [];
  for (const item of items) {
    const raw = item.sanitizedJson as {
      type?: string;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      input?: string;
    } | null;
    if (raw === null || typeof raw !== "object") {
      throw new Error(
        `decode archived Responses item ${
          JSON.stringify(item.itemId)
        }: invalid shape`,
      );
    }
    switch (raw.type) {
      case "function_call": {
        const callID = raw.call_id || raw.id || "";
        if (callID === "" || !raw.name) {
          throw new Error(
            `archived function call ${
              JSON.stringify(item.itemId)
            } is missing call_id or name`,
          );
        }
        calls.push({
          id: callID,
          name: raw.name,
          arguments: raw.arguments,
        });
        break;
      }
      case "custom_tool_call": {
        const callID = raw.call_id || raw.id || "";
        if (callID === "" || !raw.name) {
          throw new Error(
            `archived custom tool call ${
              JSON.stringify(item.itemId)
            } is missing call_id or name`,
          );
        }
        const input = raw.input ?? "";
        calls.push({
          id: callID,
          name: raw.name,
          kind: "custom",
          input,
          arguments: JSON.stringify({ input }),
        });
        break;
      }
      default:
        break;
    }
  }
  return calls;
}

/**
 * replayStateContainsRunUserEntry reports whether the shared transcript
 * already carries the user entry that durable admission atomically appends
 * for this run. The deterministic entry identity keeps the check idempotent
 * across retries, recovery, and process restarts.
 */
export function replayStateContainsRunUserEntry(
  state: { entryIDs: string[] },
  runID: string,
): boolean {
  const entryID = runUserEntryID(runID);
  if (entryID === "") return false;
  return state.entryIDs.includes(entryID);
}

/** Sleeps for the poll interval; resolves true when the signal fired first. */
function sleepOrCancel(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
