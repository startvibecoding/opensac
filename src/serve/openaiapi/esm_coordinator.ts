// Ported from internal/serve/openaiapi/esm_coordinator.go — WebUI ESM
// execution is a host adapter around the single ESM Supervisor. Durable state
// transitions and recovery policy live in src/esm.
//
// Deviations: Go's goroutine-per-session coordinator maps to a tracked
// fire-and-forget async task (`context.Context`/`CancelFunc` map to an
// AbortController and its signal; the `done` channel maps to the worker
// promise); Go's `sync.Mutex` fields collapse because Deno is single-threaded;
// `context.WithTimeout(2*time.Second)` maps to racing the worker promise
// against an abort timer; the `(source, mode, error)` resolve return maps to a
// value object. The Server hooks (`startESM`, `stopESMForControl`,
// `esmCoordinatorRunning`) are filled by `wireESMCoordinator` like the other
// ported Server-bound slices.
import {
  applyReviewResult,
  applyWorkerResult,
  canAutoRun,
  EvidenceTracker,
  finalAssistantResponse,
  isCanceled,
  isDeadlineExceeded,
  newRoleIncompleteError,
  type Objective,
  roleContext,
  type RoleRequest,
  type RoleResult,
  roleWorker,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventSink,
  statusActive,
  statusCompleteCandidate,
  Supervisor,
} from "../../esm/mod.ts";
import type { AgentManager } from "../../agent/manager.ts";
import type { AgentOptions } from "../../agent/factory.ts";
import type { AgentAdapter } from "../../agent/bridge.ts";
import {
  type Event as PublicEvent,
  eventDone,
  eventError,
  eventRunFinished,
  eventTextDelta,
  eventToolCall,
  eventToolExecutionEnd,
  taskCanceled,
  taskFailed,
  taskIncomplete,
} from "../../../sdk/agent/mod.ts";
import {
  Event,
  EventAgentStart,
  EventRunFinished,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
  type TaskStatus as InternalTaskStatus,
  TaskSuccess,
} from "../../agent/events.ts";
import { acquireExecutionAdmission } from "../../agentruntime/execution_admission.ts";
import {
  ModeYolo,
  resolveUnattendedMode,
  SourceWebUI,
} from "../../agentruntime/source.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import type { ExecutionIntent } from "../../session/execution_intent.ts";
import { cloneModel } from "./chat_support.ts";
import { getWorkDir } from "./config.ts";
import {
  newExecutionIntentID,
  newRunID,
  rawEventData,
  requestFingerprint,
} from "./events.ts";
import {
  esmStore,
  getOrCreateSession,
  newAgentManagerForSession,
} from "./handler_chat_session.ts";
import { esmSnapshot, publishESM } from "./esm_api.ts";
import {
  marshalRunPolicySnapshot,
  type submitRunRequest,
} from "./handler_run_submit.ts";
import { publishExternalSubAgentEvent } from "./external_subagents.ts";
import { runtimeRunEventSink } from "./runtime_run_events.ts";
import { webUIRunState } from "./runtime_run_state.ts";
import type { APISession } from "./session_mgr.ts";
import type { Server } from "./server.ts";

/**
 * esmCoordinator owns the per-session WebUI ESM continuation workers. The map
 * values are the worker's cancel handle (Go's `context.CancelFunc`) and its
 * completion promise (Go's `done` channel).
 */
export class ESMCoordinator {
  running = new Map<string, () => void>();
  done = new Map<string, Promise<void>>();
  closed = false;

  /** Starts one continuation worker unless one is already running. */
  start(server: Server, sessionID: string): void {
    if (!server || sessionID === "") return;
    if (this.closed) return;
    if (this.running.has(sessionID)) return;
    const controller = new AbortController();
    const done = this.#runWorker(server, controller, sessionID);
    this.running.set(sessionID, () => controller.abort());
    this.done.set(sessionID, done);
  }

  async #runWorker(
    server: Server,
    controller: AbortController,
    sessionID: string,
  ): Promise<void> {
    try {
      await runESMCoordinator(server, controller.signal, sessionID);
    } catch {
      // Go's goroutine drops the error on the floor; the Supervisor already
      // persisted the canonical terminal state.
    } finally {
      this.running.delete(sessionID);
      this.done.delete(sessionID);
    }
  }

  /**
   * stop cancels one worker and waits for it to release its session/runtime
   * references. A timeout throws the abort reason like Go's `ctx.Err()`.
   */
  async stop(
    signal: AbortSignal | undefined,
    sessionID: string,
  ): Promise<void> {
    if (sessionID === "") return;
    const cancel = this.running.get(sessionID);
    const done = this.done.get(sessionID);
    if (!cancel || !done) return;
    cancel();
    await awaitWorker(done, signal);
  }

  /**
   * stopAll cancels every ESM coordinator owned by this Serve process and
   * waits for each worker to release its session/runtime references. The
   * bounded signal keeps shutdown responsive if an adapter is already stuck in
   * a provider call; SessionRuntime.Shutdown remains the final resource
   * boundary.
   */
  async stopAll(signal: AbortSignal | undefined): Promise<void> {
    // Mark the coordinator closed before taking the snapshot so a concurrent
    // Create/Edit/Resume request cannot start a new worker while shutdown
    // waits.
    this.closed = true;
    const active: Array<() => void> = [];
    const workerPromises: Promise<void>[] = [];
    for (const [sessionID, cancel] of this.running) {
      active.push(cancel);
      const done = this.done.get(sessionID);
      if (done) workerPromises.push(done);
    }
    for (const cancel of active) cancel();
    await Promise.all(
      workerPromises.map((done) => awaitWorker(done, signal)),
    );
  }
}

/** newESMCoordinator ports Go's constructor. */
export function newESMCoordinator(): ESMCoordinator {
  return new ESMCoordinator();
}

/**
 * awaitWorker races a worker promise against a bounded abort signal; a
 * deadline expiry surfaces as a TimeoutError like Go's `ctx.Err()`.
 */
async function awaitWorker(
  done: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await done;
    return;
  }
  const deadline = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("context deadline exceeded", "TimeoutError"),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  await Promise.race([done, deadline]);
}

/** ensureESMCoordinator lazily creates the Server's coordinator. */
export function ensureESMCoordinator(server: Server): ESMCoordinator {
  if (!server.esmCoordinator) server.esmCoordinator = new ESMCoordinator();
  return server.esmCoordinator;
}

/** startESMFn binds Go's `s.startESM`. */
export function startESMFn(server: Server): (sessionId: string) => void {
  return (sessionId) => ensureESMCoordinator(server).start(server, sessionId);
}

/** stopESMForControlFn binds Go's `s.stopESMForControl` (2s bounded). */
export function stopESMForControlFn(
  server: Server,
): (sessionId: string) => Promise<void> {
  return async (sessionId) => {
    const coordinator = server.esmCoordinator;
    if (!coordinator) return;
    const timeout = AbortSignal.timeout(2000);
    await coordinator.stop(timeout, sessionId);
  };
}

/** esmCoordinatorRunningFn binds Go's `s.esmCoordinatorRunning`. */
export function esmCoordinatorRunningFn(
  server: Server,
): (sessionId: string) => boolean {
  return (sessionId) => {
    if (!server || sessionId === "") return false;
    const coordinator = server.esmCoordinator;
    if (!coordinator) return false;
    return coordinator.running.has(sessionId);
  };
}

/** stopESMFn binds Go's `s.stopESM` (control stop with a warning on failure). */
export function stopESMFn(server: Server): (sessionId: string) => void {
  return (sessionId) => {
    stopESMForControlFn(server)(sessionId).catch((err) => {
      console.error(
        `Warning: ESM coordinator for session ${sessionId} did not stop cleanly: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  };
}

/** stopAllESMFn binds Go's `s.stopAllESM`. */
export function stopAllESMFn(
  server: Server,
): (signal?: AbortSignal) => Promise<void> {
  return (signal) => {
    const coordinator = server.esmCoordinator;
    if (!coordinator) return Promise.resolve();
    return coordinator.stopAll(signal);
  };
}

/** shutdownESMFn binds Go's `s.shutdownESM` (2s bounded, warning on failure). */
export function shutdownESMFn(server: Server): () => Promise<void> {
  return async () => {
    try {
      await stopAllESMFn(server)(AbortSignal.timeout(2000));
    } catch (err) {
      console.error(
        `Warning: ESM coordinators did not stop cleanly: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}

/**
 * wireESMCoordinator fills the Server's ESM coordinator hooks. Go declares
 * these as Server methods; the port binds them explicitly so tests and the
 * serve assembly slice opt in.
 */
export function wireESMCoordinator(server: Server): void {
  ensureESMCoordinator(server);
  server.startESM ??= startESMFn(server);
  server.stopESMForControl ??= stopESMForControlFn(server);
  server.esmCoordinatorRunning ??= esmCoordinatorRunningFn(server);
}

/**
 * runESMCoordinator drives the continuation loop for one session: wait for the
 * canonical execution admission, resolve the unattended policy, and keep
 * running Supervisor continuations while the objective can auto-run.
 */
export async function runESMCoordinator(
  server: Server,
  signal: AbortSignal | undefined,
  sessionID: string,
): Promise<void> {
  const store = esmStore(server);
  if (!store) return;
  const resolved = server.findSessionWorkDir(sessionID);
  let workDir = resolved.workDir;
  if (!resolved.found) workDir = getWorkDir(server.cfg!);
  let sess: APISession;
  try {
    sess = await getOrCreateSession(server, sessionID, workDir);
  } catch {
    return;
  }
  if (!sess || !server.pool || !server.pool.pin(sess)) return;
  try {
    // A user can create or edit an objective while a foreground run owns this
    // session. Wait for that canonical run to finish instead of treating the
    // temporary lease conflict as a reason to drop the requested continuation.
    // Its run-scoped SteeringSource still receives the updated objective at its
    // next loop boundary, so waiting here never creates a concurrent run.
    const runtimeGuard = await acquireExecutionAdmission(
      signal,
      server.sessionDir(),
      sessionID,
      { wait: true },
    );
    const release = () => runtimeGuard.release();
    await sess.mu.lock();
    try {
      try {
        sess.manager?.reload();
      } catch {
        return;
      }
      let effective: { source: string; mode: string };
      try {
        effective = resolveESMRuntimePolicy(server, sess);
      } catch {
        return;
      }
      for (;;) {
        if (signal?.aborted) return;
        let obj: Objective;
        try {
          obj = store.get(sessionID);
        } catch {
          return;
        }
        if (!obj || !canAutoRun(obj)) return;
        const runID = newRunID();
        const adapter = new WebESMRuntimeAdapter(
          server,
          sess,
          workDir,
          effective.source,
          effective.mode,
        );
        const runtime = new Supervisor({
          store,
          adapter,
          events: adapter,
        });
        const { error } = await runtime.run(
          sessionID,
          runID,
          workDir,
          effective.mode,
          signal,
        );
        if (error) return;
        try {
          obj = store.get(sessionID);
        } catch {
          return;
        }
        if (
          !obj ||
          (obj.status !== statusActive &&
            obj.status !== statusCompleteCandidate)
        ) {
          return;
        }
      }
    } finally {
      sess.mu.unlock();
      release();
    }
  } finally {
    server.pool.unpin(sess);
  }
}

/**
 * resolveESMRuntimePolicy resolves one unattended source/mode pair through the
 * shared Runtime policy. ESM role runs are unattended: never gate them on
 * interactive approval. os is inherited; plan/agent fall back to yolo.
 */
export function resolveESMRuntimePolicy(
  server: Server,
  sess: APISession,
): { source: string; mode: string } {
  if (!sess || !sess.runtime) {
    throw new Error("webui ESM session runtime is unavailable");
  }
  const defaultMode = server?.cfg?.defaultMode || ModeYolo;
  const { resolution, mode } = sess.runtime.resolvePolicy(
    sess.mode,
    "",
    defaultMode,
  );
  let source = String(resolution.source ?? "");
  if (source === "") source = SourceWebUI;
  return { source, mode: resolveUnattendedMode(mode) };
}

/**
 * WebESMRuntimeAdapter owns WebUI-specific execution and presentation only.
 * It implements the shared RuntimeAdapter contract plus the ESM event sink.
 */
export class WebESMRuntimeAdapter implements RuntimeAdapter, RuntimeEventSink {
  #server: Server;
  #sess: APISession;
  #workDir: string;
  #source: string;
  #mode: string;

  constructor(
    server: Server,
    sess: APISession,
    workDir: string,
    source: string,
    mode: string,
  ) {
    this.#server = server;
    this.#sess = sess;
    this.#workDir = workDir;
    this.#source = source;
    this.#mode = mode;
  }

  /** RunRole executes one ESM role as a canonical durable sub-agent run. */
  async runRole(
    signal: AbortSignal | undefined,
    req: RoleRequest,
  ): Promise<RoleResult> {
    const scope = roleContext(signal, req.role);
    try {
      return await this.#runRoleBody(scope.signal, req);
    } finally {
      scope.cancel();
    }
  }

  async #runRoleBody(
    parentSignal: AbortSignal,
    req: RoleRequest,
  ): Promise<RoleResult> {
    const server = this.#server;
    const sess = this.#sess;
    if (!server || !sess) {
      throw new Error("webui ESM adapter is unavailable");
    }
    const model = this.#currentModel();
    if (!model) throw new Error("webui ESM model is unavailable");

    const runID = req.runId;
    const effectiveMode = this.#mode !== "" ? this.#mode : req.mode;
    const effectiveSource = this.#source !== "" ? this.#source : SourceWebUI;
    const started = new Date();
    let finalStatus = "failed";
    let finalError = "";
    const execution = sess.ensureExecution();
    execution.setRunStore(new RunStore(server.sessionDir()));
    execution.setEventSink(runtimeRunEventSink(server, sess));
    if (sess.runtime) sess.runtime.setExecution(execution);
    const requestSnapshot = JSON.stringify(req);
    const policySnapshot = marshalRunPolicySnapshot(
      server,
      sess,
      {
        message: req.prompt,
        model: model.id,
        mode: effectiveMode,
        tools: req.tools,
        workDir: this.#workDir,
        transcript: false,
      } satisfies submitRunRequest,
      effectiveSource,
      effectiveMode,
    );
    const intent: ExecutionIntent = {
      id: newExecutionIntentID(),
      sessionId: req.sessionId,
      source: effectiveSource,
      model: model.id,
      mode: effectiveMode,
      workDir: this.#workDir,
      requestFingerprint: requestFingerprint(req),
      request: requestSnapshot,
      policy: policySnapshot,
      createdAt: started,
    };
    const durableRun: DurableRun = {
      id: runID,
      sessionId: req.sessionId,
      intentId: intent.id,
      retryOf: "",
      attempt: 1,
      workDir: this.#workDir,
      source: effectiveSource,
      model: model.id,
      mode: effectiveMode,
      status: "running",
      startedAt: started,
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
      conversationTurnId: "",
      conversationTurn: false,
    };
    const startEvent = {
      sessionId: req.sessionId,
      runId: runID,
      eventType: "esm.role_started",
      source: effectiveSource,
      status: "running",
      model: model.id,
      mode: effectiveMode,
      timestamp: started,
      data: rawEventData({
        role: req.role,
        intentId: intent.id,
        attempt: 1,
      }),
    };
    const runSignal = execution.beginIntentDurable(
      parentSignal,
      intent,
      durableRun,
      startEvent,
    );
    sess.markDurableRun(runID);
    if (server.runManager) {
      server.runManager.register({
        id: runID,
        sessionId: req.sessionId,
        intentId: intent.id,
        retryOf: "",
        attempt: 1,
        workDir: "",
        source: "",
        model: "",
        mode: "",
        status: "",
        startedAt: started,
        updatedAt: started,
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
      });
    }
    try {
      const result = await this.#driveRole(runSignal, req, runID, started);
      if (result.runErr !== undefined && result.runErr !== null) {
        finalError = result.runErr instanceof Error
          ? result.runErr.message
          : String(result.runErr);
        if (
          isCanceled(result.runErr) || isDeadlineExceeded(result.runErr)
        ) {
          finalStatus = "canceled";
        }
        throw result.runErr;
      }
      finalStatus = "completed";
      publishExternalSubAgentEvent(server, req.sessionId, {
        agentId: result.childId,
        type: EventRunFinished,
        status: TaskSuccess,
      });
      return result.value;
    } finally {
      try {
        await execution.finishDurableWithRetry(
          undefined,
          runID,
          webUIRunState(finalStatus, finalError),
          finalError,
          {
            sessionId: req.sessionId,
            runId: runID,
            eventType: "esm.role_finished",
            source: effectiveSource,
            status: finalStatus,
            model: model.id,
            mode: effectiveMode,
            timestamp: new Date(),
            data: rawEventData({ role: req.role, error: finalError }),
          },
        );
      } catch {
        // Go ignores the finish error (`_ =`).
      }
      sess.clearDurableRun(runID);
    }
  }

  /**
   * #driveRole runs the child agent and maps its events onto the manager
   * lifecycle and the external sub-agent projection. Go returns
   * `(result, runErr)`; the port folds both into one record so the deferred
   * finish still sees the terminal status.
   */
  async #driveRole(
    runSignal: AbortSignal,
    req: RoleRequest,
    runID: string,
    started: Date,
  ): Promise<{
    value: RoleResult;
    runErr?: unknown;
    childId: string;
  }> {
    const server = this.#server;
    const sess = this.#sess;
    const mgr: AgentManager | undefined = await newAgentManagerForSession(
      server,
      sess,
    );
    if (!mgr) {
      // Session shutdown can race with an already-started ESM coordinator.
      // Treat an unavailable runtime as a failed role so the coordinator can
      // terminalize its durable run instead of dereferencing a nil manager.
      throw new Error("webui ESM agent manager is unavailable");
    }
    const teamWorker = req.role === roleWorker && sess.runtime !== undefined &&
      sess.runtime.teamExpertActive();
    const opts: AgentOptions = {
      id: runID,
      isSubAgent: true,
      mode: this.#mode !== "" ? this.#mode : req.mode,
      workDir: this.#workDir,
      tools: req.tools,
      maxIterations: req.maxIterations,
      multiAgent: teamWorker,
      delegateMode: false,
      workflows: false,
      ownsSessionMailbox: teamWorker,
    };
    const child: AgentAdapter = mgr.create(opts);
    try {
      // Go's defer order (publish latest, then destroy) is reproduced here.
      try {
        mgr.markRunning(child.id());
        publishExternalSubAgentEvent(server, req.sessionId, {
          agentId: child.id(),
          type: EventAgentStart,
        });

        const result: RoleResult = {
          response: "",
          tokens: 0,
          durationMs: 0,
          toolCalls: 0,
          toolNames: new Map<string, number>(),
          toolError: new Map<string, boolean>(),
        };
        const tracker = new EvidenceTracker();
        let completed = false;
        let runErr: unknown = undefined;
        for await (const ev of child.run(req.prompt, runSignal)) {
          this.#publishRoleEvent(req.sessionId, child.id(), ev);
          if (ev.usage) {
            let n = ev.usage.totalTokens;
            if (n <= 0) n = ev.usage.inputTokens + ev.usage.outputTokens;
            result.tokens += n;
          }
          tracker.observe(ev);
          switch (ev.type) {
            case eventRunFinished:
              completed = true;
              if (ev.status === taskIncomplete) {
                runErr = newRoleIncompleteError(
                  req.role,
                  ev.stopReason ?? "",
                  ev.error,
                );
                mgr.markIncomplete(child.id(), runErr as Error);
              } else if (
                ev.status === taskFailed || ev.status === taskCanceled
              ) {
                runErr = ev.error;
                mgr.markError(child.id(), ev.error);
              } else {
                mgr.markDone(
                  child.id(),
                  finalAssistantResponse(child.getMessages()),
                );
              }
              break;
            case eventDone:
              if (!completed) {
                completed = true;
                mgr.markDone(
                  child.id(),
                  finalAssistantResponse(child.getMessages()),
                );
              }
              break;
            case eventError:
              if (!completed) {
                completed = true;
                runErr = ev.error;
                mgr.markError(child.id(), ev.error);
              }
              break;
            default:
              break;
          }
        }
        if (!completed) {
          runErr = runSignal.reason ?? null;
          mgr.markError(child.id(), (runErr as Error | undefined) ?? undefined);
        }
        result.durationMs = Date.now() - started.getTime();
        result.response = finalAssistantResponse(child.getMessages());
        const summary = tracker.summary();
        result.toolCalls = summary.toolCalls;
        result.toolNames = summary.toolNames;
        result.toolError = summary.toolError;
        return {
          value: result,
          runErr: runErr ?? undefined,
          childId: child.id(),
        };
      } finally {
        try {
          const latest = esmStore(server)?.get(req.sessionId) ?? null;
          publishESM(server, req.sessionId, esmSnapshot(latest));
        } catch {
          // Go skips the publish when the store read fails.
        }
        mgr.destroy(child.id());
      }
    } catch (err) {
      return {
        value: {
          response: "",
          tokens: 0,
          durationMs: 0,
          toolCalls: 0,
          toolNames: new Map<string, number>(),
          toolError: new Map<string, boolean>(),
        },
        runErr: err,
        childId: "",
      };
    }
  }

  /** PublishESMEvent projects a Supervisor lifecycle event to the WebUI. */
  publishESMEvent(event: RuntimeEvent): void {
    const server = this.#server;
    if (!server || event.sessionId === "") return;
    try {
      const obj = esmStore(server)?.get(event.sessionId) ?? null;
      publishESM(server, event.sessionId, esmSnapshot(obj));
    } catch {
      // Go publishes only when the store read succeeds.
    }
  }

  /** RunRecoveryObserver reuses the ordinary role execution. */
  async runRecoveryObserver(
    signal: AbortSignal | undefined,
    req: RoleRequest,
    _interruption: unknown,
  ): Promise<RoleResult> {
    return await this.runRole(signal, req);
  }

  #currentModel() {
    return cloneModel(this.#server.model);
  }

  #publishRoleEvent(sessionId: string, childId: string, ev: PublicEvent): void {
    let out: Event;
    switch (ev.type) {
      case eventTextDelta:
        out = {
          type: EventTextDelta,
          agentId: childId,
          textDelta: ev.textDelta,
        };
        break;
      case eventToolCall:
        out = {
          type: EventToolCall,
          agentId: childId,
          toolName: ev.toolName,
          toolCallId: ev.toolCallId,
          toolArgs: ev.toolArgs,
        };
        break;
      case eventToolExecutionEnd:
        out = {
          type: EventToolExecutionEnd,
          agentId: childId,
          toolName: ev.toolName,
          toolCallId: ev.toolCallId,
          toolArgs: ev.toolArgs,
          toolResult: ev.toolResult,
          toolError: ev.toolError,
        };
        break;
      case eventRunFinished:
        out = {
          type: EventRunFinished,
          agentId: childId,
          status: ev.status as InternalTaskStatus | undefined,
          error: ev.error,
        };
        break;
      default:
        return;
    }
    publishExternalSubAgentEvent(this.#server, sessionId, out);
  }
}

/** applyESMWorker applies one worker report to the persisted objective. */
export function applyESMWorker(
  _server: Server,
  store: NonNullable<ReturnType<typeof esmStore>>,
  obj: Objective | null,
  runID: string,
  result: RoleResult,
): boolean {
  if (!obj) return false;
  try {
    const { ok } = applyWorkerResult(store, obj.sessionId, runID, result);
    return ok;
  } catch {
    return false;
  }
}

/** applyESMReview applies one critic/audit report to the objective. */
export function applyESMReview(
  _server: Server,
  store: NonNullable<ReturnType<typeof esmStore>>,
  obj: Objective | null,
  role: string,
  runID: string,
  result: RoleResult,
): boolean {
  if (!obj) return false;
  try {
    const { ok } = applyReviewResult(store, obj.sessionId, runID, role, result);
    return ok;
  } catch {
    return false;
  }
}
