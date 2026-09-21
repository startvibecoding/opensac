// Ported from internal/serve/openaiapi/session_mgr.go — the Server-bound
// runtime-snapshot cluster: GetSessionCapabilities, GetSessionRuntime,
// runtimeSnapshotFromCapabilities, runtimeCapabilityAvailable,
// isTerminalResponsesRunState, recoveredPendingQuestions,
// resolveOrphanedDecisions/resolveOrphanedQuestions,
// recordSessionQuestionResolutionForRun, and the publish trio
// (publishRuntimeSnapshot, PublishSessionRuntime, publishSessionRuntime(sess)).
// The Server-bound methods become exported functions taking the `Server` as
// their first argument, matching the other openaiapi modules.
//
// Deviations: Go's `(value, error)` pairs return `{ value, err }` objects;
// the `s.GetESM(caps.ID)` projection is added by the ESM API slice (Go only
// sets snapshot.ESM when that call succeeds, so the absent call leaves the
// field unset exactly like a failing GetESM).
import {
  DecisionApproval,
  DecisionQuestion,
  type DecisionRequest,
  type DecisionResolution,
} from "../../agentruntime/decision.ts";
import {
  decisionEventEnvelope,
  loadRunDecisionRecords,
} from "../../agentruntime/decision_events.ts";
import { newDecisionResolutionRecord } from "../../agentruntime/decision_record.ts";
import { replayDecisions } from "../../agentruntime/decision_replay.ts";
import {
  inspectSessionExecution,
  type SessionExecutionSnapshot,
} from "../../agentruntime/execution.ts";
import { RunEvent, SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { getSessionDir } from "../../config/settings.ts";
import { listResponseRuns } from "../../session/response_store.ts";
import { type SessionRun } from "../../session/mod.ts";
import { openByIDExact } from "../../session/manager.ts";
import type { Server } from "./server.ts";
import { APISession, ErrSessionNotFound } from "./session_mgr.ts";
import {
  applyStoredCapabilitiesToResponse,
  capabilitiesFromSession,
  defaultSessionCapabilities,
  loadStoredCapabilities,
  normalizedDisplayMode,
  resolveSessionMode,
} from "./session_capabilities.ts";
import { publishSessionStreamEvent } from "./session_stream.ts";
import { pendingDecisionIDsForRun } from "./decision_projection.ts";
import {
  type SessionActiveRun,
  type SessionCapabilities,
  type SessionQuestionRequest,
  type SessionQuestionResolution,
  type SessionRuntimeSnapshot,
} from "./types.ts";

/** isTerminalResponsesRunState reports whether a Responses run state is terminal. */
export function isTerminalResponsesRunState(state: string): boolean {
  switch (state.trim().toLowerCase()) {
    case "completed":
    case "failed":
    case "incomplete":
    case "cancelled":
    case "canceled":
    case "expired":
      return true;
    default:
      return false;
  }
}

/** runtimeCapabilityAvailable reports serve-config availability for one capability. */
export function runtimeCapabilityAvailable(
  server: Server,
  name: string,
): boolean {
  if (!server.cfg) return false;
  switch (name) {
    case "delegate":
      return server.cfg.enableDelegate ?? false;
    case "multiAgent":
      return server.cfg.enableSubAgents ?? false;
    case "workflows":
      return server.cfg.enableWorkflows ?? false;
    case "webSearch":
      return server.isWebSearchAvailable();
    case "browser":
      return server.cfg.enableBrowser ?? false;
    case "a2aMaster":
      return server.cfg.enableA2AMaster ?? false;
    default:
      return false;
  }
}

/**
 * recoveredPendingQuestions returns the durable pending question set for one
 * run so a restarted server can re-project questions whose local run ended.
 */
export function recoveredPendingQuestions(
  server: Server,
  sessionId: string,
  runId: string,
): SessionQuestionRequest[] {
  if (!server.settings || sessionId === "" || runId === "") return [];
  let records;
  try {
    records = loadRunDecisionRecords(
      getSessionDir(server.settings),
      sessionId,
      runId,
    );
  } catch {
    return [];
  }
  const questions = new Map<string, SessionQuestionRequest>();
  for (const record of records) {
    if (record.kind !== DecisionQuestion || record.payload === undefined) {
      continue;
    }
    const request = record.payload as SessionQuestionRequest;
    if (!request || request.questionId === "") continue;
    questions.set(record.id, request);
  }
  const pending = replayDecisions(records);
  const result: SessionQuestionRequest[] = [];
  for (const [id, record] of pending) {
    if (record.kind !== DecisionQuestion) continue;
    const request = questions.get(id);
    if (request) result.push(request);
  }
  return result;
}

/**
 * recordSessionQuestionResolutionForRun records a question resolution against
 * a run that may have no live APISession (recovery paths).
 */
export function recordSessionQuestionResolutionForRun(
  server: Server,
  run: SessionRun,
  request: SessionQuestionRequest,
  resolution: SessionQuestionResolution | null,
): Error | null {
  if (!server.settings || !resolution) return null;
  const decision: DecisionRequest = {
    id: request.questionId,
    sessionId: request.sessionId,
    runId: request.runId ?? "",
    kind: DecisionQuestion,
  };
  const result: DecisionResolution = {
    id: request.questionId,
    kind: DecisionQuestion,
    status: resolution.status,
    value: resolution.answer,
  };
  const record = newDecisionResolutionRecord(
    decision,
    result,
    { question: request, resolution },
  );
  const fields = decisionEventEnvelope(record);
  fields.question = request;
  fields.resolution = resolution;
  try {
    new SessionRunEventSink(getSessionDir(server.settings)).record({
      sessionId: run.sessionId,
      runId: run.id,
      eventType: "question_resolved",
      status: resolution.status,
      source: run.source,
      model: run.model,
      mode: run.mode,
      timestamp: new Date(),
      data: fields,
    } as RunEvent);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}

/**
 * resolveOrphanedDecisions records cancellation resolutions for decisions
 * whose local Agent run cannot survive a process restart. This keeps durable
 * decision state consistent with the orphan recovery policy.
 */
export function resolveOrphanedDecisions(
  server: Server,
  run: SessionRun,
): Error | null {
  if (!server.settings || run.id === "" || run.sessionId === "") return null;
  let records;
  try {
    records = loadRunDecisionRecords(
      getSessionDir(server.settings),
      run.sessionId,
      run.id,
    );
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const approvals = new Map<string, unknown>();
  const questions = new Map<string, unknown>();
  for (const record of records) {
    switch (record.kind) {
      case DecisionApproval: {
        const request = record.payload as {
          approvalId?: string;
        } | undefined;
        if (
          record.payload === undefined || !request ||
          request.approvalId === ""
        ) {
          continue;
        }
        approvals.set(record.id, record.payload);
        break;
      }
      case DecisionQuestion: {
        const request = record.payload as {
          questionId?: string;
        } | undefined;
        if (
          record.payload === undefined || !request ||
          request.questionId === ""
        ) {
          continue;
        }
        questions.set(record.id, record.payload);
        break;
      }
    }
  }
  for (const [id, record] of replayDecisions(records)) {
    switch (record.kind) {
      case DecisionApproval: {
        const request = approvals.get(id) as {
          approvalId?: string;
        } | undefined;
        if (!request || request.approvalId === "") continue;
        const resolution = {
          approvalId: id,
          sessionId: run.sessionId,
          action: "deny_once",
          status: "cancelled",
          message: "run ended when the server restarted",
        };
        const decision: DecisionRequest = {
          id,
          sessionId: run.sessionId,
          runId: run.id,
          kind: DecisionApproval,
        };
        const result: DecisionResolution = {
          id,
          kind: DecisionApproval,
          status: resolution.status,
          value: resolution.action,
        };
        const decisionRecord = newDecisionResolutionRecord(
          decision,
          result,
          { approval: request, resolution },
        );
        const fields = decisionEventEnvelope(decisionRecord);
        fields.approval = request;
        fields.resolution = resolution;
        try {
          new SessionRunEventSink(getSessionDir(server.settings)).record({
            sessionId: run.sessionId,
            runId: run.id,
            eventType: "approval_resolved",
            status: resolution.status,
            source: run.source,
            model: run.model,
            mode: run.mode,
            timestamp: new Date(),
            data: fields,
          } as RunEvent);
        } catch (err) {
          return err instanceof Error ? err : new Error(String(err));
        }
        break;
      }
      case DecisionQuestion: {
        const request = questions.get(id) as {
          questionId?: string;
        } | undefined;
        if (!request || request.questionId === "") continue;
        const resolution: SessionQuestionResolution = {
          questionId: id,
          sessionId: run.sessionId,
          runId: run.id,
          status: "cancelled",
          message: "run ended when the server restarted",
        };
        const err = recordSessionQuestionResolutionForRun(
          server,
          run,
          request as SessionQuestionRequest,
          resolution,
        );
        if (err) return err;
        break;
      }
    }
  }
  return null;
}

/** resolveOrphanedQuestions is retained for focused compatibility tests. */
export function resolveOrphanedQuestions(
  server: Server,
  run: SessionRun,
): Error | null {
  return resolveOrphanedDecisions(server, run);
}

/**
 * getSessionCapabilities returns runtime capabilities for an active or
 * persisted session.
 */
export function getSessionCapabilities(
  server: Server,
  id: string,
): { caps: SessionCapabilities | null; err: Error | null } {
  if (id === "") return { caps: null, err: ErrSessionNotFound };
  if (server.pool) {
    const sess = server.pool.getExact(id);
    if (sess) {
      const caps = capabilitiesFromSession(server, sess, true, !!sess.manager);
      return { caps, err: null };
    }
  }
  if (!server.settings) return { caps: null, err: ErrSessionNotFound };
  let mgr;
  try {
    mgr = openByIDExact(getSessionDir(server.settings), id);
  } catch {
    return { caps: null, err: ErrSessionNotFound };
  }
  const header = mgr.getHeader();
  const workDir = header ? header.cwd : "";
  const caps = defaultSessionCapabilities(server, workDir, false, true);
  caps.id = id;
  const stored = loadStoredCapabilities(server, id);
  if (stored.ok && stored.caps) {
    applyStoredCapabilitiesToResponse(caps, stored.caps);
  }
  const probe = new APISession();
  probe.id = id;
  probe.manager = mgr;
  probe.mode = caps.mode;
  const resolved = resolveSessionMode(server, probe, "");
  if (resolved.err) return { caps: null, err: resolved.err };
  caps.mode = resolved.mode;
  return { caps, err: null };
}

/** getSessionRuntime returns a structured runtime snapshot for the WebUI. */
export function getSessionRuntime(
  server: Server,
  id: string,
): { snapshot: SessionRuntimeSnapshot | null; err: Error | null } {
  if (id === "") return { snapshot: null, err: ErrSessionNotFound };
  const { caps, err } = getSessionCapabilities(server, id);
  if (err || !caps) return { snapshot: null, err };
  return { snapshot: runtimeSnapshotFromCapabilities(server, caps), err: null };
}

/** runtimeSnapshotFromCapabilities projects capability state into a snapshot. */
export function runtimeSnapshotFromCapabilities(
  server: Server,
  caps: SessionCapabilities | null,
): SessionRuntimeSnapshot {
  if (!caps) {
    return {
      sessionId: "",
      mode: "",
      displayMode: "",
      capabilities: {},
      pendingApprovals: [],
      pendingQuestions: [],
    };
  }
  const snapshot: SessionRuntimeSnapshot = {
    sessionId: caps.id ?? "",
    mode: caps.mode,
    displayMode: normalizedDisplayMode(caps.displayMode),
    model: caps.model,
    thinkingLevel: caps.thinkingLevel,
    workDir: caps.workDir,
    capabilities: {},
    pendingApprovals: [],
    pendingQuestions: [],
  };
  if (snapshot.mode === "") snapshot.mode = "yolo";
  const state = (
    available: boolean,
    enabled: boolean,
    unavailableReason: string,
  ) => {
    let reason = "";
    if (!available) reason = unavailableReason;
    if (available && !enabled && reason === "") {
      reason = "disabled for this session";
    }
    return {
      available,
      enabled,
      effective: available && enabled,
      disabledReason: reason,
    };
  };
  const available = (name: string) => runtimeCapabilityAvailable(server, name);
  snapshot.capabilities["browser"] = state(
    available("browser"),
    caps.browser,
    "disabled by serve config",
  );
  snapshot.capabilities["delegate"] = state(
    available("delegate"),
    caps.delegateMode,
    "disabled by serve config",
  );
  snapshot.capabilities["multiAgent"] = state(
    available("multiAgent"),
    caps.multiAgent,
    "disabled by serve config",
  );
  snapshot.capabilities["workflows"] = state(
    available("workflows"),
    caps.workflows,
    "disabled by serve config",
  );
  snapshot.capabilities["webSearch"] = state(
    available("webSearch"),
    caps.webSearch,
    "disabled by serve config",
  );
  snapshot.capabilities["a2aMaster"] = state(
    available("a2aMaster"),
    caps.a2aMaster,
    "disabled by serve config",
  );
  if (server.settings && caps.id) {
    let execution: SessionExecutionSnapshot | undefined;
    try {
      execution = inspectSessionExecution(
        getSessionDir(server.settings),
        caps.id,
      );
    } catch {
      // Go ignores the inspect error and projects the zero snapshot; the
      // missing execution field carries the same "unknown" meaning.
    }
    if (execution) {
      snapshot.execution = execution;
      if (execution.activeRun) {
        const run = execution.activeRun;
        const activeRun: SessionActiveRun = {
          runId: run.id,
          status: run.status,
          source: run.source,
          model: run.model,
          mode: run.mode,
          startedAt: run.startedAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
        };
        snapshot.activeRun = activeRun;
      }
    }
  }
  if (server.settings && caps.id) {
    try {
      const runs = listResponseRuns(
        getSessionDir(server.settings),
        caps.id,
        50,
      );
      for (let i = runs.length - 1; i >= 0; i--) {
        if (isTerminalResponsesRunState(runs[i].state)) continue;
        snapshot.responsesRun = {
          localRunId: runs[i].localRunId,
          responseId: runs[i].responseId,
          state: runs[i].state,
          cancelRequested: runs[i].cancelRequested,
        };
        break;
      }
    } catch {
      // Go ignores the ListResponseRuns error.
    }
    // Go additionally projects `snapshot.ESM` through s.GetESM when it
    // succeeds; the ESM API slice adds that call.
  }
  // Pending approvals are tracked in-memory and keyed by session+run.
  if (server.pool && caps.id) {
    const sess = server.pool.getExact(caps.id);
    if (sess) {
      const runId = sess.activeRunId;
      const decisionIDs = pendingDecisionIDsForRun(sess, runId);
      for (const [approvalId, pending] of sess.pendingApprovals) {
        if (
          pending.request.runId === runId &&
          (decisionIDs.size === 0 ||
            decisionIDs.get(approvalId) === DecisionApproval)
        ) {
          snapshot.pendingApprovals.push(pending.request);
        }
      }
      for (const [questionId, pending] of sess.pendingQuestions) {
        if (
          pending.request.runId === runId &&
          (decisionIDs.size === 0 ||
            decisionIDs.get(questionId) === DecisionQuestion)
        ) {
          snapshot.pendingQuestions.push(pending.request);
        }
      }
      if (snapshot.pendingQuestions.length === 0) {
        snapshot.pendingQuestions.push(
          ...recoveredPendingQuestions(server, caps.id, runId),
        );
      }
    }
  }
  return snapshot;
}

/** publishRuntimeSnapshot fans one snapshot out to broker + stream. */
export function publishRuntimeSnapshot(
  server: Server,
  sessionId: string,
  snapshot: SessionRuntimeSnapshot | null,
): void {
  if (!server || sessionId === "" || !snapshot) return;
  const runId = snapshot.activeRun?.runId ?? "";
  server.getEventBroker().publishRuntimeEvent(sessionId, runId, snapshot);
  publishSessionStreamEvent(server, sessionId, "runtime_event", snapshot);
}

/**
 * publishSessionRuntimeById publishes the canonical runtime state for an
 * external execution source such as the WeChat or Feishu channel dispatcher
 * (Go's PublishSessionRuntime).
 */
export function publishSessionRuntimeById(
  server: Server,
  sessionId: string,
): void {
  if (!server || sessionId === "") return;
  const { snapshot } = getSessionRuntime(server, sessionId);
  if (!snapshot) return;
  publishRuntimeSnapshot(server, sessionId, snapshot);
}

/** publishSessionRuntimeForSession projects a live session's snapshot (Go's publishSessionRuntime(sess)). */
export function publishSessionRuntimeForSession(
  server: Server,
  sess: APISession,
): void {
  if (!server || !sess) return;
  const caps = capabilitiesFromSession(server, sess, true, !!sess.manager);
  publishRuntimeSnapshot(
    server,
    sess.id,
    runtimeSnapshotFromCapabilities(server, caps),
  );
}
