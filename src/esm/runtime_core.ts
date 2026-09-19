// Ported from internal/esm/runtime_core.go
//
// The front-end-neutral ESM supervisor extracted from the TUI implementation.
// TUI/WebUI/ACP hosts implement RuntimeAdapter to run one isolated role and
// project host events; all ESM policy and durable state transitions remain in
// this module and the Store.
//
// Deviations from Go: `context.Context` maps to an optional `AbortSignal`
// plus the `RoleScope` deadline policy; `context.Canceled`/`DeadlineExceeded`
// map to the exported sentinels below (and DOMException AbortError/TimeoutError
// from `AbortSignal.timeout`). Go's `(*Objective, error)` return is represented
// as `{ objective, error }` because TypeScript cannot return a tuple after a
// throw.

import { isRetryable } from "../provider/retry.ts";
import { formatGuidanceSuffix } from "./guidance.ts";
import {
  auditTaskPrompt,
  criticTaskPrompt,
  recoveryObserverTaskPrompt,
  workerTaskPrompt,
} from "./prompt.ts";
import {
  type ApplyResult,
  applyReviewResult,
  applyWorkerResult,
  formatItemDetail,
  type RoleResult,
  titleESMRole,
} from "./supervisor.ts";
import {
  type Objective,
  type Phase,
  phaseAudit,
  phaseCritic,
  phaseWorker,
  statusActive,
  statusBlocked,
  statusCompleteCandidate,
  statusPaused,
} from "./state.ts";
import { type Store } from "./store.ts";
import { parseRecoveryReport, recoveryDecisionBlocked } from "./report.ts";

/** The role in the ESM pipeline. */
export type Role = string;

export const roleWorker: Role = "worker";
export const roleCritic: Role = "critic";
export const roleAudit: Role = "audit";
export const roleRecovery: Role = "recovery";

/**
 * Deliberately leaves an ESM worker or reviewer unbounded. ESM owns
 * long-running objectives, so an arbitrary turn count must never turn ongoing
 * work into a completed-looking role result.
 */
export const longTaskMaxIterations = -1;

/** Sentinel: a role stopped before completing its assigned work. */
export const ErrRoleIncomplete = new Error("ESM role incomplete");

/** Sentinel mirroring `context.Canceled`. */
export const ErrCanceled = new Error("context canceled");
/** Sentinel mirroring `context.DeadlineExceeded`. */
export const ErrDeadlineExceeded = new Error("context deadline exceeded");

/** Identifies an ESM role that stopped before completing its work. */
export class RoleIncompleteError extends Error {
  readonly detail: string;

  constructor(detail: string, cause?: unknown) {
    super(`ESM role incomplete: ${detail}`, { cause });
    this.name = "RoleIncompleteError";
    this.detail = detail;
  }
}

/** Reports whether an error is the ESM role-incomplete classification. */
export function isRoleIncomplete(err: unknown): boolean {
  return err instanceof RoleIncompleteError;
}

/**
 * Preserves an adapter's terminal detail while giving the Supervisor one shared
 * classification independent of protocol projection.
 */
export function newRoleIncompleteError(
  role: Role,
  stopReason: string,
  cause?: unknown,
): RoleIncompleteError {
  let detail = stopReason.trim();
  if (detail === "") detail = "stopped before completing its work";
  if (role !== "") detail = role + " " + detail;
  return new RoleIncompleteError(detail, cause);
}

/**
 * RoleTimeout intentionally has no hard deadline. ESM is the long-task
 * execution mode, so it continues until its work finishes or an explicit
 * cancellation/ownership decision stops it.
 */
export const roleTimeout = 0;
export const recoveryObserverTimeout = 5 * 60 * 1000;

/** The resolved cancellation scope for one ESM role. */
export interface RoleScope {
  /** The combined parent + role-deadline signal handed to the role runner. */
  signal: AbortSignal;
  /** The role deadline in milliseconds; 0 means "no added deadline". */
  timeoutMs: number;
  /** Releases the role deadline timer. */
  cancel(): void;
}

/**
 * Applies the ESM-owned deadline policy once for every adapter. A zero timeout
 * preserves the parent signal rather than creating an already-expired scope.
 */
export function roleContext(
  parent: AbortSignal | undefined,
  role: Role,
): RoleScope {
  const timeout = role === roleRecovery ? recoveryObserverTimeout : roleTimeout;
  if (timeout <= 0) {
    const signal = parent ?? new AbortController().signal;
    return { signal, timeoutMs: 0, cancel: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
  }, timeout);
  const signals: AbortSignal[] = [controller.signal];
  if (parent) signals.push(parent);
  const combined = AbortSignal.any(signals);
  return {
    signal: combined,
    timeoutMs: timeout,
    cancel: () => clearTimeout(timer),
  };
}

/** The complete host execution contract. */
export interface RoleRequest {
  sessionId: string;
  runId: string;
  role: Role;
  workDir: string;
  mode: string;
  tools: string[];
  maxIterations: number;
  prompt: string;
  objective: Objective;
}

/**
 * Implemented by TUI/WebUI/ACP agent hosts. ESM policy remains in the
 * Supervisor; adapters only execute roles and project host events.
 */
export interface RuntimeAdapter {
  runRole(
    signal: AbortSignal | undefined,
    req: RoleRequest,
  ): Promise<RoleResult>;
  runRecoveryObserver(
    signal: AbortSignal | undefined,
    req: RoleRequest,
    interruption: unknown,
  ): Promise<RoleResult>;
}

/** UI-neutral lifecycle output. It is informational only. */
export interface RuntimeEvent {
  sessionId: string;
  runId: string;
  role: Role;
  type: string;
  status: string;
  message: string;
}

export interface RuntimeEventSink {
  publishESMEvent(event: RuntimeEvent): Promise<void> | void;
}

/** The Go `(*Objective, error)` return, expressed as a value object. */
export interface SupervisorResult {
  objective: Objective | null;
  error: unknown;
}

/** The single ESM runtime extracted from the TUI implementation. */
export class Supervisor {
  store: Store | null;
  adapter: RuntimeAdapter | null;
  events: RuntimeEventSink | null;

  constructor(opts: {
    store: Store | null;
    adapter: RuntimeAdapter | null;
    events?: RuntimeEventSink | null;
  }) {
    this.store = opts.store;
    this.adapter = opts.adapter;
    this.events = opts.events ?? null;
  }

  /**
   * Executes one continuation using the TUI order: worker, then critic and
   * audit only for a completion candidate. A normal worker continue returns
   * active and is resumed by the next continuation.
   *
   * runID is the base continuation run ID. All durable state reporting inside
   * the continuation uses this base ID so finishRun and the per-run idempotency
   * checks line up; role sub-agents and events keep suffixed IDs derived from
   * it. The Supervisor owns the terminal finishRun call for both adapters.
   */
  async run(
    sessionID: string,
    runID: string,
    workDir: string,
    mode: string,
    signal?: AbortSignal,
  ): Promise<SupervisorResult> {
    try {
      return await this.runInner(sessionID, runID, workDir, mode, signal);
    } catch (err) {
      return { objective: null, error: err };
    }
  }

  private async runInner(
    sessionID: string,
    runID: string,
    workDir: string,
    mode: string,
    signal?: AbortSignal,
  ): Promise<SupervisorResult> {
    if (this.store === null) {
      return {
        objective: null,
        error: new Error("esm supervisor store is nil"),
      };
    }
    if (this.adapter === null) {
      return {
        objective: null,
        error: new Error("esm supervisor adapter is nil"),
      };
    }
    let obj: Objective;
    try {
      obj = this.store.get(sessionID);
    } catch (err) {
      return { objective: null, error: err };
    }
    if (!isAutoRun(obj)) return { objective: obj, error: null };
    if (obj.status === statusActive) {
      const r = await this.runRole(
        obj,
        roleWorker,
        runID,
        workDir,
        mode,
        signal,
      );
      if (r.error != null) return r;
      obj = r.objective as Objective;
      if (obj.status !== statusCompleteCandidate) {
        return { objective: obj, error: null };
      }
    }
    if (obj.status !== statusCompleteCandidate) {
      return {
        objective: this.finishContinuation(sessionID, runID, obj),
        error: null,
      };
    }
    {
      const r = await this.runRole(
        obj,
        roleCritic,
        runID,
        workDir,
        mode,
        signal,
      );
      if (r.error != null) return r;
      obj = r.objective as Objective;
      if (obj.status !== statusCompleteCandidate) {
        return { objective: obj, error: null };
      }
    }
    {
      const r = await this.runRole(
        obj,
        roleAudit,
        runID,
        workDir,
        mode,
        signal,
      );
      if (r.error != null) return r;
      obj = r.objective as Objective;
    }
    return {
      objective: this.finishContinuation(sessionID, runID, obj),
      error: null,
    };
  }

  private finishContinuation(
    sessionID: string,
    runID: string,
    obj: Objective | null,
  ): Objective | null {
    if (obj === null) return null;
    try {
      return this.store!.finishRun(sessionID, runID);
    } catch {
      // Preserve the objective on a failed finish write, matching Go.
      return obj;
    }
  }

  private async runRole(
    obj: Objective,
    role: Role,
    baseRunID: string,
    workDir: string,
    mode: string,
    signal?: AbortSignal,
  ): Promise<SupervisorResult> {
    const runID = baseRunID + "-" + role;
    const req: RoleRequest = {
      sessionId: obj.sessionId,
      runId: runID,
      role,
      workDir,
      mode,
      tools: [],
      maxIterations: 0,
      prompt: rolePrompt(obj, role),
      objective: obj,
    };
    let guidanceIDs: string[] = [];
    if (role !== roleRecovery && this.store !== null) {
      try {
        const guidance = this.store.pendingGuidance(obj.sessionId);
        if (guidance.length > 0) {
          req.prompt += formatGuidanceSuffix(guidance);
          guidanceIDs = guidance.map((item) => item.id);
        }
      } catch {
        // Guidance is best-effort; a read failure must not abort the role.
      }
    }
    let phase: Phase = phaseWorker;
    switch (role) {
      case roleWorker:
        req.maxIterations = longTaskMaxIterations;
        break;
      case roleCritic:
      case roleAudit:
        phase = role === roleAudit ? phaseAudit : phaseCritic;
        req.maxIterations = longTaskMaxIterations;
        req.tools = ["read", "grep", "find", "ls"];
        break;
      default:
        return {
          objective: obj,
          error: new Error(`unsupported ESM role ${JSON.stringify(role)}`),
        };
    }
    this.store!.setPhase(obj.sessionId, phase);
    await this.publish({
      sessionId: obj.sessionId,
      runId: runID,
      role,
      type: "role_started",
      status: "running",
      message: "",
    });

    const started = Date.now();
    let result: RoleResult;
    let runErr: unknown = null;
    try {
      result = await this.adapter!.runRole(signal, req);
    } catch (err) {
      runErr = err;
      result = emptyRoleResult();
    }
    if (result.durationMs <= 0) result.durationMs = Date.now() - started;
    obj = this.account(obj, result);
    if (runErr != null) {
      return this.handleRoleFailure(obj, req, baseRunID, runErr);
    }

    let applied: ApplyResult;
    if (role === roleWorker) {
      applied = applyWorkerResult(
        this.store!,
        obj.sessionId,
        baseRunID,
        result,
      );
    } else {
      applied = applyReviewResult(
        this.store!,
        obj.sessionId,
        baseRunID,
        role,
        result,
      );
    }
    if (!applied.ok) {
      return {
        objective: obj,
        error: new Error(`ESM ${role} result was not applied`),
      };
    }
    if (guidanceIDs.length > 0) {
      this.store!.consumeGuidance(obj.sessionId, guidanceIDs);
    }
    const outcome = applied.outcome;
    if (outcome.objective !== null) obj = outcome.objective;
    let message = outcome.message;
    if (outcome.rejected) {
      message = outcome.subject + " rejected: " + outcome.reason;
    }
    await this.publish({
      sessionId: obj.sessionId,
      runId: runID,
      role,
      type: "role_finished",
      status: obj.status,
      message,
    });
    return { objective: obj, error: null };
  }

  private account(obj: Objective, result: RoleResult): Objective {
    if (result.tokens === 0 && result.durationMs === 0) return obj;
    return this.store!.accountUsage(
      obj.sessionId,
      result.tokens,
      result.durationMs,
    );
  }

  private async handleRoleFailure(
    obj: Objective,
    req: RoleRequest,
    baseRunID: string,
    runErr: unknown,
  ): Promise<SupervisorResult> {
    const role = req.role;
    await this.publish({
      sessionId: obj.sessionId,
      runId: req.runId,
      role: req.role,
      type: "role_failed",
      status: "failed",
      message: compactESMError(runErr),
    });
    if (req.role !== roleWorker) {
      const review = titleESMRole(role) +
        " sub-agent failed; completion candidate rejected: " +
        compactESMError(runErr);
      try {
        obj = this.store!.rejectCompletionCandidateForRun(
          obj.sessionId,
          baseRunID,
          review,
          null,
        );
      } catch {
        // Preserve the original objective if the rejection write fails.
      }
    }
    if (isRoleIncomplete(runErr)) {
      return this.recordRecovery(
        obj,
        role + " stopped before completion: " + compactESMError(runErr),
        obj.remainingWork,
      );
    }
    if (isDeadlineExceeded(runErr)) {
      return await this.runRecoveryObserver(obj, req, baseRunID, runErr);
    }
    if (isRetryableTransportError(runErr)) {
      return this.recordRecovery(
        obj,
        role + " provider transport failure: " + compactESMError(runErr),
        obj.remainingWork,
      );
    }
    // A non-retryable role failure must require an explicit resume before the
    // objective can run again. Preserve the original execution error for the
    // caller even if the status write fails.
    try {
      const paused = this.store!.pause(obj.sessionId);
      if (paused !== null) obj = paused;
    } catch {
      // Preserve the original execution error even if the status write fails.
    }
    return { objective: obj, error: runErr };
  }

  private async runRecoveryObserver(
    obj: Objective,
    req: RoleRequest,
    baseRunID: string,
    interruption: unknown,
  ): Promise<SupervisorResult> {
    const observer: RoleRequest = {
      ...req,
      role: roleRecovery,
      runId: baseRunID + "-recovery-observer",
      maxIterations: 40,
      tools: ["read", "grep", "find", "ls"],
      prompt: recoveryObserverTaskPrompt(
        obj,
        req.role,
        compactESMError(interruption),
      ),
    };
    const started = Date.now();
    let result: RoleResult;
    let err: unknown = null;
    try {
      result = await this.adapter!.runRecoveryObserver(
        undefined,
        observer,
        interruption,
      );
    } catch (e) {
      err = e;
      result = emptyRoleResult();
    }
    if (result.durationMs <= 0) result.durationMs = Date.now() - started;
    obj = this.account(obj, result);
    if (err != null) {
      return this.recordRecovery(
        obj,
        req.role + " observer failed: " + compactESMError(err),
        obj.remainingWork,
      );
    }
    if (result.toolCalls === 0 || result.toolError.size >= result.toolCalls) {
      return this.recordRecovery(
        obj,
        req.role + " observer inspection was not usable",
        obj.remainingWork,
      );
    }
    let report;
    try {
      report = parseRecoveryReport(result.response);
    } catch (parseErr) {
      return this.recordRecovery(
        obj,
        req.role + " observer report invalid: " + compactESMError(parseErr),
        obj.remainingWork,
      );
    }
    const next = this.store!.recordRecovery(
      obj.sessionId,
      req.role + " timed out: " + compactESMError(interruption),
      "Recovery observer: " + report.summary,
      report.remainingWork,
    );
    if (next.status === statusPaused) return { objective: next, error: null };
    if (report.decision === recoveryDecisionBlocked) {
      return {
        objective: this.store!.updateFromModelForRun(
          obj.sessionId,
          statusBlocked,
          formatItemDetail("recovery observer blockers", report.blockers),
          baseRunID,
        ),
        error: null,
      };
    }
    return { objective: next, error: null };
  }

  private recordRecovery(
    obj: Objective,
    reason: string,
    remaining: string[],
  ): SupervisorResult {
    try {
      const next = this.store!.recordRecovery(
        obj.sessionId,
        reason,
        "A fresh worker will retry from the persisted repository state.",
        remaining,
      );
      return { objective: next, error: null };
    } catch (err) {
      return { objective: obj, error: err };
    }
  }

  private async publish(event: RuntimeEvent): Promise<void> {
    if (this.events === null) return;
    try {
      await this.events.publishESMEvent(event);
    } catch {
      // Events are informational; publishing failures must not abort a run.
    }
  }
}

function emptyRoleResult(): RoleResult {
  return {
    response: "",
    tokens: 0,
    durationMs: 0,
    toolCalls: 0,
    toolNames: new Map(),
    toolError: new Map(),
  };
}

function isAutoRun(obj: Objective): boolean {
  return obj.status === statusActive || obj.status === statusCompleteCandidate;
}

function rolePrompt(obj: Objective, role: Role): string {
  switch (role) {
    case roleWorker:
      return workerTaskPrompt(obj);
    case roleCritic:
      return criticTaskPrompt(obj);
    case roleAudit:
      return auditTaskPrompt(obj);
    default:
      return "";
  }
}

/** Reports whether an error represents an explicit cancellation. */
export function isCanceled(err: unknown): boolean {
  if (err === ErrCanceled) return true;
  return err instanceof DOMException && err.name === "AbortError";
}

/** Reports whether an error represents a deadline/timeout. */
export function isDeadlineExceeded(err: unknown): boolean {
  if (err === ErrDeadlineExceeded) return true;
  return err instanceof DOMException && err.name === "TimeoutError";
}

function isRetryableTransportError(err: unknown): boolean {
  if (err == null) return false;
  if (isCanceled(err) || isDeadlineExceeded(err)) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (!message.toLowerCase().includes("send request:")) return false;
  return isRetryable(err, 0);
}

export function compactESMError(err: unknown): string {
  if (err == null) return "";
  const message = err instanceof Error ? err.message : String(err);
  return message.replaceAll("\n", "; ");
}
