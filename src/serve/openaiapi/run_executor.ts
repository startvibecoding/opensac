// Ported from internal/serve/openaiapi/run_executor.go: the RunExecutor owns
// the lifecycle of a single agent execution. It consumes agent events,
// normalizes them, persists through the shared Runtime, and publishes via the
// EventBroker. It is independent of HTTP/SSE/WebSocket.
//
// Deviations: Go's `<-chan agent.Event` is an `AsyncIterable<Event>` (the
// Agent's run stream); `context.Context` is an `AbortSignal` and cancellation
// drains the retired stream in a detached async task instead of a goroutine;
// Go's `(result, error)` pair throws typed errors; the Go struct's unused
// `store RunStore` field is omitted (RunStore was never wired in Go either);
// the recording `context.Canceled`/`DeadlineExceeded` checks map to the
// AbortError/TimeoutError convention shared with agentruntime.error_info.

import {
  type Event,
  EventDone,
  EventError,
  EventHostedItem,
  EventQuestionRequest,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventToolApprovalRequest,
  EventToolCall,
  EventToolExecutionEnd,
  EventUsage,
  TaskCanceled,
  TaskIncomplete,
  type TaskStatus,
  TaskSuccess,
} from "../../agent/events.ts";
import type { Agent } from "../../agent/agent.ts";
import type { ContextUsage } from "../../context/context.ts";
import type { Attachment } from "../../provider/types.ts";
import { totalInputTokens } from "../../provider/types.ts";
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  FailurePersistence,
  FailureTransport,
  PhaseModel,
  PhasePersistence,
  PhaseTerminalization,
  PhaseTransport,
  RetryUser,
} from "../../agentruntime/error_info.ts";
import {
  RunStateCancelled,
  RunStateCompleted,
  RunStateFailed,
  RunStateTimedOut,
} from "../../agentruntime/run_state.ts";
import type { SessionRun } from "../../session/run_store.ts";
import { getToolDetail } from "./config.ts";
import {
  assistantAttachmentsTranscriptEvent,
  assistantDeltaTranscriptEvent,
  hostedItemEvent,
  resolveToolEvent,
  safeHostedItemRunData,
  toolStatusSummary,
} from "./chat_support.ts";
import { recordSessionRunEvent } from "./events.ts";
import type { EventBroker } from "./event_broker.ts";
import {
  publishSessionStreamDone,
  publishToolEvent,
  publishTranscriptEvent,
} from "./session_stream.ts";
import { publishSessionRuntimeForSession } from "./session_runtime_snapshot.ts";
import {
  registerSessionApproval,
  registerSessionQuestion,
} from "./approval.ts";
import type { APISession } from "./session_mgr.ts";
import type { CompletionUsage, ToolCallSummary } from "./types.ts";
import type { toolCallInfo } from "./tool_format.ts";
import type { Server } from "./server.ts";

/**
 * RunResult captures the outcome of a single run execution.
 */
export interface RunResult {
  runId: string;
  sessionId: string;
  /** "completed", "failed", "canceled" */
  status: string;
  /** non-empty if failed/canceled */
  error: string;
  /** structured safe failure, when non-successful */
  errorInfo?: ErrorInfo;
  /** final token usage */
  usage?: CompletionUsage;
  /** final request-context footprint */
  contextUsage?: ContextUsage;
  /** tool calls made during the run */
  toolCalls: ToolCallSummary[];
  /** citations, files, images, and artifacts */
  attachments: Attachment[];
  modelId: string;
  startTime: Date;
}

/** NewRunExecutor creates a new RunExecutor for the given run. */
export function newRunExecutor(
  server: Server | undefined,
  broker: EventBroker | undefined,
  run: SessionRun,
): RunExecutor {
  return new RunExecutor(server, broker, run);
}

export class RunExecutor {
  readonly #broker: EventBroker | undefined;
  readonly #run: SessionRun;
  readonly #server: Server | undefined;
  #finalized = false;
  #donePromise: Promise<void>;
  #resolveDone!: () => void;

  constructor(
    server: Server | undefined,
    broker: EventBroker | undefined,
    run: SessionRun,
  ) {
    this.#server = server;
    this.#broker = broker;
    this.#run = run;
    this.#donePromise = new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  /** done resolves when the run finishes (Go's closed `done` channel). */
  get done(): Promise<void> {
    return this.#donePromise;
  }

  /**
   * execute consumes agent events from the stream and processes them.
   * It runs until the agent finishes, errors, or the caller's signal fires,
   * and resolves the `done` promise when the stream ends.
   * The caller is responsible for creating the agent and starting
   * runWithUserMessage.
   */
  async execute(
    ctx: AbortSignal | undefined,
    sess: APISession,
    a: Agent | null,
    eventCh: AsyncIterable<Event>,
    modelId: string,
    _mode: string,
    transcript: boolean,
  ): Promise<RunResult> {
    const result: RunResult = {
      runId: this.#run.id,
      sessionId: this.#run.sessionId,
      status: "completed",
      error: "",
      toolCalls: [],
      attachments: [],
      modelId,
      startTime: new Date(),
    };
    let latestContextUsage: ContextUsage | undefined;

    const toolMode = this.#server?.cfg?.toolVisibility?.mode ?? "";
    const toolDetail = this.#server?.cfg ? getToolDetail(this.#server.cfg) : "";
    void toolMode;
    void toolDetail;

    const pendingTools = new Map<string, toolCallInfo>();
    const totalUsage: CompletionUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const iterator = eventCh[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Cancellation is checked between events, exactly like Go's select on
        // ctx.Done() at the top of the receive loop.
        if (ctx?.aborted) {
          result.status = "canceled";
          result.error = abortReasonMessage(ctx);
          // Terminal events are sent unconditionally by the Agent loop, so a
          // buffer that filled up before the cancellation could still park the
          // aborted run on its next send and it could never finish its terminal
          // bookkeeping. Keep consuming the retired stream in the background.
          void drainStream(iterator);
          return result;
        }
        const next = await iterator.next();
        if (next.done) break;
        const ev = next.value;
        if (ctx?.aborted) {
          result.status = "canceled";
          result.error = abortReasonMessage(ctx);
          void drainStream(iterator);
          return result;
        }

        if (ev.contextUsage) {
          latestContextUsage = { ...ev.contextUsage };
        }
        // Error, retry, partial-output, and tool side-effect semantics are owned
        // by the shared Runtime. Serve only projects the returned contract.
        const execution = sess.executionRuntime();
        if (
          execution &&
          ((ev.type !== EventRunFinished && ev.type !== EventError) ||
            (ev.agentId ?? "") === "")
        ) {
          let observation;
          try {
            observation = execution.observeAgentEvent(ev);
          } catch {
            result.status = "failed";
            result.error = "The run state could not be saved.";
            result.errorInfo = {
              code: "run_state_persistence_failed",
              type: "server_error",
              failureClass: FailurePersistence,
              phase: PhasePersistence,
              messageKey: "run.error.persistence",
              message: result.error,
              retryMode: RetryUser,
              retryable: true,
            };
            return result;
          }
          if (observation.error) {
            result.errorInfo = { ...observation.error };
          }
        }

        switch (ev.type) {
          case EventHostedItem: {
            if (ev.hostedItem && this.#server) {
              if (this.#run) {
                recordSessionRunEvent(
                  this.#server,
                  sess,
                  this.#run.id,
                  "hosted_item",
                  ev.hostedItem.status ?? "",
                  this.#run.source,
                  modelId,
                  this.#run.mode,
                  { hostedItem: safeHostedItemRunData(ev.hostedItem) },
                );
              }
              const evt = {
                type: "hosted_item",
                hostedItem: hostedItemEvent(ev.hostedItem) ?? undefined,
              };
              if (transcript) {
                publishTranscriptEvent(this.#server, sess.id, evt);
              } else if (this.#broker) {
                this.#broker.publishTranscriptEvent(
                  sess.id,
                  this.#run ? this.#run.id : "",
                  evt,
                );
              }
            }
            break;
          }
          case EventStatus: {
            if (ev.responseStateFailureClass && this.#server && this.#run) {
              recordSessionRunEvent(
                this.#server,
                sess,
                this.#run.id,
                "responses_state_transition",
                "retrying",
                this.#run.source,
                modelId,
                this.#run.mode,
                { failureClass: ev.responseStateFailureClass },
              );
            }
            break;
          }
          case EventTextDelta: {
            if (this.#server) {
              const evt = assistantDeltaTranscriptEvent(
                ev.textDelta ?? "",
                ev.agentId ?? "",
                ev,
              );
              if (transcript) {
                publishTranscriptEvent(this.#server, sess.id, evt);
              } else {
                // Always publish to the EventBroker for SSE subscribers.
                const broker = this.#broker;
                if (broker) {
                  const runId = this.#run ? this.#run.id : "";
                  broker.publishTranscriptEvent(sess.id, runId, evt);
                }
              }
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
            if (callID !== "") {
              pendingTools.set(callID, tc);
            }
            result.toolCalls.push({
              name,
              args: ev.toolArgs,
              status: "running",
            });
            if (this.#server) {
              publishToolEvent(this.#server, sess.id, {
                tool: name,
                toolCallId: callID,
                agentId: String(ev.agentId ?? ""),
                status: "running",
                args: ev.toolArgs,
              });
            }
            break;
          }
          case EventToolExecutionEnd: {
            const status = ev.toolError ? "failed" : "completed";
            for (let i = result.toolCalls.length - 1; i >= 0; i--) {
              if (
                result.toolCalls[i].name === ev.toolName &&
                result.toolCalls[i].status === "running"
              ) {
                result.toolCalls[i].status = status;
                break;
              }
            }
            let tc = ev.toolCallId
              ? pendingTools.get(ev.toolCallId)
              : undefined;
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
            void toolMode;
            void toolDetail;
            if (this.#server) {
              publishToolEvent(this.#server, sess.id, {
                tool: name,
                toolCallId: ev.toolCallId,
                agentId: String(ev.agentId ?? ""),
                status,
                args: tc.args ?? undefined,
                summary: toolStatusSummary(ev.toolResult ?? "", ev.toolError),
                isError: !!ev.toolError,
                hasDetail: ev.toolCallId !== "",
              });
            }
            break;
          }
          case EventToolApprovalRequest: {
            if (this.#server) {
              const execution = sess.executionRuntime();
              if (execution && this.#run) {
                // Go ignores the wait error (`_ =`): an already terminal run
                // must not fail the projection of the approval request.
                try {
                  execution.waitForApproval(this.#run.id);
                } catch {
                  // ignored
                }
              }
              registerSessionApproval(this.#server, sess, a, ev);
            }
            break;
          }
          case EventQuestionRequest: {
            if (this.#server && this.#run) {
              registerSessionQuestion(this.#server, sess, a, this.#run.id, ev);
            }
            break;
          }
          case EventUsage: {
            if (ev.usage) {
              totalUsage.prompt_tokens += totalInputTokens(ev.usage);
              totalUsage.completion_tokens += ev.usage.output;
              totalUsage.cache_read_tokens =
                (totalUsage.cache_read_tokens ?? 0) + ev.usage.cacheRead;
              totalUsage.cache_write_tokens =
                (totalUsage.cache_write_tokens ?? 0) + ev.usage.cacheWrite;
              totalUsage.total_tokens = totalUsage.prompt_tokens +
                totalUsage.completion_tokens;
            }
            break;
          }
          case EventRetry:
            // ObserveAgentEvent has already persisted the canonical retrying event.
            break;
          case EventRunFinished: {
            if ((ev.agentId ?? "") !== "") {
              break; // sub-agent terminal, not the main run
            }
            result.usage = { ...totalUsage };
            result.attachments = ev.attachments ? [...ev.attachments] : [];
            if (result.attachments.length > 0 && this.#server) {
              const evt = assistantAttachmentsTranscriptEvent(
                result.attachments,
                ev.agentId ?? "",
              );
              if (transcript) {
                publishTranscriptEvent(this.#server, sess.id, evt);
              } else if (this.#broker) {
                const runId = this.#run ? this.#run.id : "";
                this.#broker.publishTranscriptEvent(sess.id, runId, evt);
              }
            }
            result.status = runStatusForTaskStatus(ev.status);
            if (result.errorInfo) {
              result.error = displayErrorMessage(result.errorInfo);
            } else if (ev.error) {
              const info = classifyError(ev.error, { phase: PhaseModel });
              result.errorInfo = info;
              result.error = displayErrorMessage(info);
            } else if (result.status === "failed") {
              const info = classifyError(null, {
                phase: PhaseTerminalization,
              });
              result.errorInfo = info;
              result.error = displayErrorMessage(info);
            }
            return result;
          }
          case EventDone: {
            if ((ev.agentId ?? "") !== "") {
              break; // sub-agent done, not the main run
            }
            result.usage = { ...totalUsage };
            result.attachments = ev.attachments ? [...ev.attachments] : [];
            if (result.attachments.length > 0 && this.#server) {
              const evt = assistantAttachmentsTranscriptEvent(
                result.attachments,
                ev.agentId ?? "",
              );
              if (transcript) {
                publishTranscriptEvent(this.#server, sess.id, evt);
              } else if (this.#broker) {
                const runId = this.#run ? this.#run.id : "";
                this.#broker.publishTranscriptEvent(sess.id, runId, evt);
              }
            }
            result.status = "completed";
            return result;
          }
          case EventError: {
            if ((ev.agentId ?? "") !== "") {
              break; // sub-agent error, not the main run
            }
            if (ev.responseStateFailureClass && this.#server && this.#run) {
              recordSessionRunEvent(
                this.#server,
                sess,
                this.#run.id,
                "responses_state_transition",
                "failed",
                this.#run.source,
                modelId,
                this.#run.mode,
                { failureClass: ev.responseStateFailureClass },
              );
            }
            result.usage = { ...totalUsage };
            if (result.errorInfo) {
              result.error = displayErrorMessage(result.errorInfo);
              result.status = "failed";
            } else if (ev.error) {
              if (
                isAbortError(ev.error) || isTimeoutError(ev.error)
              ) {
                result.status = "canceled";
              } else {
                result.status = "failed";
              }
              const info = classifyError(ev.error, { phase: PhaseModel });
              result.errorInfo = info;
              result.error = displayErrorMessage(info);
            } else {
              // An error event without an error payload is a protocol violation,
              // never a successful completion.
              result.status = "failed";
              const info = classifyError(null, {
                phase: PhaseTerminalization,
              });
              result.errorInfo = info;
              result.error = displayErrorMessage(info);
            }
            return result;
          }
          default:
            break;
        }
      }
    } finally {
      // Go assigns the latest context usage in a deferred func before returning.
      result.contextUsage = latestContextUsage;
      this.#resolveDone();
    }
    // Stream closed without any terminal event. This is a protocol failure and
    // must never be reported as a successful completion.
    result.usage = { ...totalUsage };
    result.status = "failed";
    result.error = "The run stopped before it could finish.";
    result.errorInfo = {
      code: "event_stream_interrupted",
      type: "transport_error",
      failureClass: FailureTransport,
      phase: PhaseTransport,
      messageKey: "run.error.streamInterrupted",
      message: result.error,
      retryMode: RetryUser,
      retryable: true,
    };
    finalizeExecutionRuntime(sess, this.#run, result);
    return result;
  }

  /**
   * finalize is called exactly once to clean up the run after execution.
   * It is idempotent.
   */
  finalize(sess: APISession | null, result: RunResult | null): void {
    if (this.#finalized) return;
    this.#finalized = true;
    // Durable conversation turns stage the final assistant message during
    // execute and commit it in the caller's FinishDurable path. Do not publish
    // a stream terminal event here: the WebUI handles `done` by reloading the
    // transcript, so emitting it before that commit would make the reload race
    // the database write and overwrite the live assistant text with an older
    // history snapshot. FinalizeRun publishes the terminal snapshot and `done`
    // after durable persistence (and remains the single terminal publisher).
    // Legacy/non-durable executions have no later FinishDurable owner, so keep
    // their historical projection behavior.
    if (
      !this.#server || !sess || !this.#run || sess.isDurableRun(this.#run.id)
    ) {
      return;
    }
    const status = result ? result.status : "failed";
    publishSessionRuntimeForSession(this.#server, sess);
    publishSessionStreamDone(this.#server, sess.id, this.#run.id, status);
  }
}

/** Keeps consuming a retired event stream so a stalled producer never parks. */
async function drainStream(iterator: AsyncIterator<Event>): Promise<void> {
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
    }
  } catch {
    // The producer may fail while tearing down; the run is already canceled.
  }
}

function abortReasonMessage(ctx: AbortSignal): string {
  const reason = ctx.reason;
  if (reason instanceof Error && reason.message !== "") return reason.message;
  return "context canceled";
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

/** finalizeExecutionRuntime terminalizes a legacy non-durable execution. */
function finalizeExecutionRuntime(
  sess: APISession | null,
  run: SessionRun | null,
  result: RunResult | null,
): void {
  if (!sess || !run || !result || sess.isDurableRun(run.id)) return;
  const execution = sess.executionRuntime();
  if (!execution) return;
  let state = RunStateCompleted;
  if (
    result.status === "canceled" &&
    result.error.toLowerCase().includes("deadline")
  ) {
    state = RunStateTimedOut;
  } else if (result.status === "canceled") {
    state = RunStateCancelled;
  } else if (result.status === "failed") {
    state = RunStateFailed;
  }
  try {
    execution.finishWithState(run.id, state);
  } catch {
    // Go ignores the finish error (`_ =`).
  }
}

/**
 * runStatusForTaskStatus maps the canonical agent TaskStatus to the run status
 * vocabulary persisted for session runs.
 */
export function runStatusForTaskStatus(status: TaskStatus | undefined): string {
  switch (status) {
    case TaskSuccess:
      return "completed";
    case TaskIncomplete:
      return "incomplete";
    case TaskCanceled:
      return "canceled";
    default:
      return "failed";
  }
}
