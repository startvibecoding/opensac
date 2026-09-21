// Ported from internal/serve/openaiapi/approval.go — the Server-bound
// approval/question registration, resolution, clearing, rule persistence, and
// recovery helpers. Go's methods become exported functions taking the `Server`
// as the first argument (the convention of the other Server-bound projections).
//
// Deviations: Go's `sess.approvalMu` critical sections are dropped for the
// purely-synchronous bodies (Deno is single-threaded and no persistence call
// here awaits); `filepath.Clean` maps to
// `@std/path`'s posix `normalize`; Go's `json.Marshal` map canonicalization is
// reproduced by sorting object keys before comparing recovered arguments.
import { normalize } from "@std/path";
import type { Agent } from "../../agent/agent.ts";
import type { Event } from "../../agent/events.ts";
import {
  addBashCommand,
  addBashPrefix,
  addEditPath,
  type AllowConfig,
  removeBashCommand,
  removeBashPrefix,
  removeEditPath,
  saveProject,
} from "../../config/allow.ts";
import { getSessionDir } from "../../config/settings.ts";
import {
  DecisionApproval,
  DecisionQuestion,
  type DecisionRequest,
  type DecisionResolution,
  DecisionService,
} from "../../agentruntime/decision.ts";
import { debugLogf } from "../../provider/debug.ts";
import { listSessionRunEvents } from "../../session/session_events.ts";
import {
  APISession,
  ErrInvalidCapability,
  ErrSessionNotFound,
  formatEventTimestamp,
  type SessionApprovalResponse,
} from "./session_mgr.ts";
import { resolveSessionMode } from "./session_capabilities.ts";
import { publishSessionRuntimeForSession } from "./session_runtime_snapshot.ts";
import { publishSessionStreamEvent } from "./session_stream.ts";
import type { Server } from "./server.ts";
import type {
  SessionApprovalRequest,
  SessionApprovalResolution,
  SessionQuestionRequest,
  SessionQuestionResolution,
  SessionQuestionResponse,
} from "./types.ts";
import {
  decisionDeadline,
  recordDecisionEvent,
  recordDecisionEventWithDeadline,
} from "./decision_persistence.ts";

/**
 * marshalJSONCanonical reproduces Go's `json.Marshal` for decoded JSON maps:
 * object keys are sorted at every level so two renders of the same args
 * compare equal regardless of insertion order.
 */
function marshalJSONCanonical(value: unknown): string {
  return JSON.stringify(canonicalizeJSON(value));
}

function canonicalizeJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJSON);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalizeJSON(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * recoveredApprovalDecision returns a durable decision made before a process
 * stopped. Only a resolved decision is reusable; pending and cancelled
 * requests deliberately cause the recovered agent to ask again.
 */
export function recoveredApprovalDecision(
  server: Server,
  sessionID: string,
  runID: string,
  toolCallID: string,
  toolName: string,
  args: Record<string, unknown>,
): { approved: boolean; found: boolean } {
  if (
    !server || !server.settings || sessionID === "" || runID === "" ||
    toolName === ""
  ) {
    return { approved: false, found: false };
  }
  let events;
  try {
    events = listSessionRunEvents(getSessionDir(server.settings), sessionID);
  } catch (err) {
    debugLogf(
      "recover approval for session %q run %q: list events: %v",
      sessionID,
      runID,
      err,
    );
    return { approved: false, found: false };
  }
  let argsJSON: string;
  try {
    argsJSON = marshalJSONCanonical(args);
  } catch {
    return { approved: false, found: false };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.runId !== runID || event.eventType !== "approval_resolved") {
      continue;
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    const resolution = data["resolution"] as
      | { status?: string; action?: string }
      | undefined;
    if (!resolution || resolution.status !== "resolved") continue;
    const approval = data["approval"] as SessionApprovalRequest | undefined;
    if (
      !approval ||
      !matchesRecoveredApproval(approval, toolCallID, toolName, argsJSON)
    ) {
      continue;
    }
    return { approved: resolution.action !== "deny_once", found: true };
  }
  return { approved: false, found: false };
}

export function matchesRecoveredApproval(
  request: SessionApprovalRequest,
  toolCallID: string,
  toolName: string,
  argsJSON: string,
): boolean {
  if (
    request.toolCallId !== undefined && request.toolCallId !== "" &&
    request.toolCallId !== toolCallID
  ) {
    return false;
  }
  const tool = (request.tool ?? {}) as Record<string, unknown>;
  const storedName = typeof tool["name"] === "string" ? tool["name"] : "";
  if (storedName !== toolName) {
    return false;
  }
  if (!("args" in tool)) {
    return argsJSON === "" || argsJSON === "null" || argsJSON === "{}";
  }
  try {
    return marshalJSONCanonical(tool["args"]) === argsJSON;
  } catch {
    return false;
  }
}

export function approvalCommand(args: Record<string, unknown>): string {
  for (const key of ["command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

export function approvalPath(args: Record<string, unknown>): string {
  const value = args["path"];
  if (typeof value === "string") return value.trim();
  return "";
}

export function suggestedApprovalCommandPrefix(command: string): string {
  command = command.replace(/^[\t\r\n ]+/, "");
  const fields = command.split(/\s+/).filter((field) => field !== "");
  if (fields.length === 0) return "";
  let count = fields.length;
  if (count > 2) count = 2;
  let prefix = fields.slice(0, count).join(" ");
  const index = command.indexOf(prefix);
  if (index >= 0) prefix = command.slice(index, index + prefix.length);
  if (command.length > prefix.length && command[prefix.length] === " ") {
    return prefix + " ";
  }
  return prefix;
}

export function approvalToolLabel(name: string): string {
  // ASCII-only title case for internal tool names; avoids the deprecated
  // strings.Title which has incorrect Unicode word-boundary semantics.
  return name
    .replace(/_/g, " ")
    .split(" ")
    .map(approvalCapitalize)
    .join(" ");
}

function approvalCapitalize(s: string): string {
  if (s === "") return "";
  const r = [...s];
  if (r[0] >= "a" && r[0] <= "z") {
    r[0] = String.fromCharCode(
      r[0].charCodeAt(0) - ("a".charCodeAt(0) - "A".charCodeAt(0)),
    );
  }
  return r.join("");
}

/**
 * questionRequestFromEvent converts a core question event into the WebUI
 * shape.
 */
export function questionRequestFromEvent(
  sess: APISession,
  runID: string,
  ev: Event,
): SessionQuestionRequest {
  return {
    questionId: ev.questionId ?? "",
    sessionId: sess.id,
    runId: runID,
    question: ev.questionText ?? "",
    options: ev.questionOptions ? [...ev.questionOptions] : [],
    context: ev.questionContext ?? "",
    timestamp: formatEventTimestamp(new Date()),
  };
}

/**
 * ensureSessionDecisionLocked keeps the protocol pending map and the shared
 * decision service aligned for restored/legacy sessions. Go holds
 * `sess.approvalMu` here; the port is purely synchronous, so resolving through
 * the service still supplies first-response-wins even when the adapter map was
 * populated without a DecisionService.
 */
export function ensureSessionDecisionLocked(
  sess: APISession | null,
  request: DecisionRequest,
): { decisions: DecisionService | null; err: Error | null } {
  if (!sess) {
    return { decisions: null, err: new Error("session is nil") };
  }
  if (!sess.decisions) {
    sess.decisions = new DecisionService();
    if (sess.runtime) sess.runtime.setDecisions(sess.decisions);
  }
  for (const pending of sess.decisions.pending()) {
    if (pending.id !== request.id) continue;
    if (
      pending.runId !== request.runId ||
      pending.sessionId !== request.sessionId ||
      pending.kind !== request.kind
    ) {
      return {
        decisions: null,
        err: new Error(
          `decision "${request.id}" does not match the pending session request`,
        ),
      };
    }
    return { decisions: sess.decisions, err: null };
  }
  try {
    sess.decisions.register(request);
  } catch (err) {
    return { decisions: null, err: asError(err) };
  }
  return { decisions: sess.decisions, err: null };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function registerSessionQuestion(
  server: Server,
  sess: APISession | null,
  a: Agent | null,
  runID: string,
  ev: Event,
): SessionQuestionRequest | null {
  if (!sess || !a || !ev.questionId || runID === "") return null;
  if (sess.activeRunId !== runID || sess.activeRunStatus !== "running") {
    a.handleQuestionResponse(ev.questionId, "");
    return null;
  }
  const request = questionRequestFromEvent(sess, runID, ev);
  sess.pendingQuestions.set(request.questionId, { request });
  if (!sess.decisions) {
    sess.decisions = new DecisionService();
    if (sess.runtime) sess.runtime.setDecisions(sess.decisions);
  }
  try {
    sess.decisions.register({
      id: request.questionId,
      runId: runID,
      sessionId: sess.id,
      kind: DecisionQuestion,
    });
  } catch (err) {
    debugLogf("register question decision %q: %v", request.questionId, err);
  }
  try {
    sess.decisions.bind(request.questionId, (answer) => {
      a.handleQuestionResponse(request.questionId, answer);
    });
  } catch {
    // Go ignores bind errors.
  }
  const execution = sess.executionRuntime();
  if (execution) execution.waitForQuestion(runID);
  publishSessionStreamEvent(server, sess.id, "question_request", request);
  recordSessionQuestionRequest(server, sess, request);
  server.getEventBroker().publishRawJSON(
    sess.id,
    runID,
    "question_request",
    request,
  );
  // Same rationale as approval: publish the runtime projection so a dropped
  // event stream cannot hide a run waiting on a question.
  publishSessionRuntimeForSession(server, sess);
  return request;
}

export function resolveSessionQuestion(
  server: Server,
  sessionID: string,
  questionID: string,
  response: SessionQuestionResponse,
): { resolution: SessionQuestionResolution | null; err: Error | null } {
  if (sessionID === "" || questionID === "") {
    return { resolution: null, err: ErrSessionNotFound };
  }
  const sess = server.pool?.getExact(sessionID);
  if (!sess) return { resolution: null, err: ErrSessionNotFound };
  const pending = sess.pendingQuestions.get(questionID);
  if (
    !pending || pending.request.runId !== sess.activeRunId ||
    sess.activeRunStatus !== "running"
  ) {
    return {
      resolution: null,
      err: new Error(`question "${questionID}" is no longer pending`),
    };
  }
  const resolution: SessionQuestionResolution = {
    questionId: questionID,
    sessionId: sessionID,
    runId: pending.request.runId,
    answer: response.answer,
    status: "resolved",
  };
  const { decisions, err } = ensureSessionDecisionLocked(sess, {
    id: questionID,
    runId: pending.request.runId ?? "",
    sessionId: sess.id,
    kind: DecisionQuestion,
  });
  if (err) return { resolution: null, err };
  const commitError = resolveDecisionWithCommit(
    decisions,
    {
      id: questionID,
      kind: DecisionQuestion,
      status: "resolved",
      value: response.answer,
    },
    () =>
      recordSessionQuestionResolution(
        server,
        sess,
        pending.request,
        resolution,
      ),
  );
  if (commitError) return { resolution: null, err: commitError };
  sess.pendingQuestions.delete(questionID);
  const execution = sess.executionRuntime();
  if (execution) {
    // Go ignores the Resume error (`_ =`): the decision bind callback already
    // unblocked the agent, and a non-waiting execution needs no resume.
    try {
      execution.resume(pending.request.runId ?? "");
    } catch {
      // ignored, matching Go
    }
  }
  publishSessionStreamEvent(server, sessionID, "question_resolved", resolution);
  server.getEventBroker().publishRawJSON(
    sessionID,
    pending.request.runId ?? "",
    "question_resolved",
    resolution,
  );
  return { resolution, err: null };
}

export function recordSessionQuestionRequest(
  server: Server,
  sess: APISession,
  request: SessionQuestionRequest,
): Error | null {
  const decision: DecisionRequest = {
    id: request.questionId,
    sessionId: request.sessionId,
    runId: request.runId ?? "",
    kind: DecisionQuestion,
  };
  return recordDecisionEventWithDeadline(
    server,
    sess,
    decision,
    null,
    "question_requested",
    "pending",
    "question",
    "",
    request,
    decisionDeadline(server),
  );
}

export function recordSessionQuestionResolution(
  server: Server,
  sess: APISession,
  request: SessionQuestionRequest,
  resolution: SessionQuestionResolution | null,
): Error | null {
  if (!sess || !resolution) return null;
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
  return recordDecisionEvent(
    server,
    sess,
    decision,
    result,
    "question_resolved",
    resolution.status,
    "question",
    "",
    { question: request, resolution },
  );
}

export function approvalRequestFromEvent(
  server: Server,
  sess: APISession,
  runID: string,
  ev: Event,
): SessionApprovalRequest {
  const toolName = ev.approvalTool ?? "";
  const args = ev.approvalArgs ?? {};
  let summary = "Run " + toolName;
  let risk = "medium";
  const reason = "requires confirmation in agent mode";
  const details: Record<string, unknown> = {};
  switch (toolName) {
    case "bash": {
      const command = approvalCommand(args);
      summary = "Run bash: " + command;
      risk = "high";
      details["command"] = command;
      details["workDir"] = sess.workDir;
      break;
    }
    case "write":
    case "edit":
    case "delete": {
      const path = approvalPath(args);
      summary = approvalCapitalize(toolName) + " " + path;
      risk = "high";
      details["path"] = path;
      details["operation"] = toolName;
      break;
    }
    case "git_access":
      summary = "Allow git metadata access";
      risk = "low";
      break;
  }
  const actions = ["approve_once", "deny_once"];
  if (toolName === "bash" && approvalCommand(args) !== "") {
    actions.push("remember_command", "remember_prefix");
  }
  if (
    (toolName === "write" || toolName === "edit") && approvalPath(args) !== ""
  ) {
    actions.push("allow_edit_path");
  }
  let mode = sess.mode;
  const resolved = resolveSessionMode(server, sess, "");
  if (resolved.err === null) mode = resolved.mode;
  return {
    approvalId: ev.approvalId ?? "",
    toolCallId: ev.toolCallId,
    sessionId: sess.id,
    runId: runID,
    timestamp: formatEventTimestamp(new Date()),
    agentId: ev.agentId ?? "",
    mode,
    risk,
    summary,
    reason,
    tool: {
      name: toolName,
      label: approvalToolLabel(toolName),
      args,
      details,
    },
    context: { workDir: sess.workDir },
    actions,
  };
}

export function registerSessionApproval(
  server: Server,
  sess: APISession | null,
  a: Agent | null,
  ev: Event,
): SessionApprovalRequest | null {
  if (!sess || !a || !ev.approvalId) return null;

  // Approval registration and run cancellation share approvalMu in Go. Once a
  // run is cancelling, a late approval event is denied and recorded as
  // cancelled rather than exposed as a new WebUI decision.
  const runID = sess.activeRunId;
  const runStatus = sess.activeRunStatus;
  const sameAgent = !sess.activeRunAgent || sess.activeRunAgent === a;
  if (runID === "" || runStatus !== "running" || !sameAgent) {
    a.handleApprovalResponse(ev.approvalId, false);
    if (runID !== "") {
      const request = approvalRequestFromEvent(server, sess, runID, ev);
      const resolution: SessionApprovalResolution = {
        approvalId: ev.approvalId,
        sessionId: sess.id,
        action: "deny_once",
        status: "cancelled",
        message: "run ended before approval was resolved",
      };
      const requestErr = recordSessionApprovalRequest(server, sess, request);
      if (requestErr) {
        debugLogf(
          "record cancelled approval request %q for session %q: %v",
          request.approvalId,
          sess.id,
          requestErr,
        );
      }
      const resolutionErr = recordSessionApprovalResolution(
        server,
        sess,
        request,
        resolution,
      );
      if (resolutionErr) {
        debugLogf(
          "record cancelled approval resolution %q for session %q: %v",
          request.approvalId,
          sess.id,
          resolutionErr,
        );
      }
      publishSessionStreamEvent(
        server,
        sess.id,
        "approval_resolved",
        resolution,
      );
      server.getEventBroker().publishApprovalEvent(
        sess.id,
        runID,
        "approval_resolved",
        resolution,
      );
    }
    return null;
  }
  const request = approvalRequestFromEvent(server, sess, runID, ev);
  // Do not persist while holding approvalMu in Go. The run-event persistence
  // path checks durable-run bookkeeping through the same mutex, so doing this
  // under the lock self-deadlocks the Agent exactly when it emits an approval
  // request. The port is synchronous here, so ordering is preserved.
  const requestErr = recordSessionApprovalRequest(server, sess, request);
  if (requestErr) {
    a.handleApprovalResponse(request.approvalId, false);
    return null;
  }

  // A cancellation can win while the request is being persisted. Re-check the
  // admission state before exposing the request to the WebUI; if the run
  // ended, append the cancellation resolution after the request and unblock
  // the Agent.
  const stillActive = sess.activeRunId === runID &&
    sess.activeRunStatus === "running" &&
    (!sess.activeRunAgent || sess.activeRunAgent === a);
  if (!stillActive) {
    a.handleApprovalResponse(request.approvalId, false);
    const resolution: SessionApprovalResolution = {
      approvalId: request.approvalId,
      sessionId: sess.id,
      action: "deny_once",
      status: "cancelled",
      message: "run ended before approval was resolved",
    };
    const resolutionErr = recordSessionApprovalResolution(
      server,
      sess,
      request,
      resolution,
    );
    if (resolutionErr) {
      debugLogf(
        "record cancelled approval resolution %q for session %q: %v",
        request.approvalId,
        sess.id,
        resolutionErr,
      );
    }
    publishSessionStreamEvent(server, sess.id, "approval_resolved", resolution);
    server.getEventBroker().publishApprovalEvent(
      sess.id,
      runID,
      "approval_resolved",
      resolution,
    );
    return null;
  }
  sess.pendingApprovals.set(request.approvalId, { request });
  if (!sess.decisions) {
    sess.decisions = new DecisionService();
    if (sess.runtime) sess.runtime.setDecisions(sess.decisions);
  }
  try {
    sess.decisions.register({
      id: request.approvalId,
      runId: runID,
      sessionId: sess.id,
      kind: DecisionApproval,
    });
  } catch (err) {
    debugLogf("register approval decision %q: %v", request.approvalId, err);
  }
  try {
    sess.decisions.bind(request.approvalId, (action) => {
      a.handleApprovalResponse(request.approvalId, action !== "deny_once");
    });
  } catch {
    // Go ignores bind errors.
  }

  publishSessionStreamEvent(server, sess.id, "approval_request", request);
  server.getEventBroker().publishApprovalEvent(
    sess.id,
    runID,
    "approval_request",
    request,
  );
  // Publish a runtime snapshot alongside the approval event so clients that
  // missed the approval frame (e.g. a dropped WebSocket that replays only
  // transcript/run/capability streams) still learn about the blocking run and
  // its pending decision through the runtime projection.
  publishSessionRuntimeForSession(server, sess);
  return request;
}

export function resolveSessionApproval(
  server: Server,
  id: string,
  approvalID: string,
  response: SessionApprovalResponse,
): { resolution: SessionApprovalResolution | null; err: Error | null } {
  if (id === "" || approvalID === "") {
    return { resolution: null, err: ErrSessionNotFound };
  }
  if (
    response.action !== "approve_once" &&
    response.action !== "deny_once" &&
    response.action !== "remember_command" &&
    response.action !== "remember_prefix" &&
    response.action !== "allow_edit_path"
  ) {
    return {
      resolution: null,
      err: new Error(
        `${ErrInvalidCapability.message}: unsupported approval action`,
      ),
    };
  }
  const sess = server.pool?.getExact(id);
  if (!sess) return { resolution: null, err: ErrSessionNotFound };
  const pending = sess.pendingApprovals.get(approvalID);
  if (
    !pending || pending.request.runId !== sess.activeRunId ||
    sess.activeRunStatus !== "running"
  ) {
    return {
      resolution: null,
      err: new Error(`approval "${approvalID}" is no longer pending`),
    };
  }
  const approved = response.action !== "deny_once";
  if (approved) {
    const ruleErr = rememberApprovalRule(
      server,
      pending.request,
      response.action,
    );
    if (ruleErr) return { resolution: null, err: ruleErr };
  }
  const resolution: SessionApprovalResolution = {
    approvalId: approvalID,
    sessionId: id,
    action: response.action,
    status: "resolved",
    message: approved ? "approval accepted" : "approval denied",
  };
  const { decisions, err } = ensureSessionDecisionLocked(sess, {
    id: approvalID,
    runId: pending.request.runId ?? "",
    sessionId: sess.id,
    kind: DecisionApproval,
  });
  if (err) return { resolution: null, err };
  const commitError = resolveDecisionWithCommit(
    decisions,
    {
      id: approvalID,
      kind: DecisionApproval,
      status: "resolved",
      value: response.action,
    },
    () =>
      recordSessionApprovalResolution(
        server,
        sess,
        pending.request,
        resolution,
      ),
  );
  if (commitError) return { resolution: null, err: commitError };
  sess.pendingApprovals.delete(approvalID);
  const execution = sess.executionRuntime();
  if (execution) {
    // Go ignores the Resume error (`_ =`); see resolveSessionQuestion.
    try {
      execution.resume(pending.request.runId ?? "");
    } catch {
      // ignored, matching Go
    }
  }
  publishSessionStreamEvent(server, id, "approval_response", resolution);
  publishSessionStreamEvent(server, id, "approval_resolved", resolution);
  server.getEventBroker().publishApprovalEvent(
    id,
    sess.activeRunId,
    "approval_response",
    resolution,
  );
  server.getEventBroker().publishApprovalEvent(
    id,
    sess.activeRunId,
    "approval_resolved",
    resolution,
  );
  return { resolution, err: null };
}

/**
 * resolveDecisionWithCommit mirrors Go's `decisions.ResolveWith(...)` call
 * shape: the commit persists the resolution and a failure leaves the pending
 * decision retryable.
 */
function resolveDecisionWithCommit(
  decisions: DecisionService | null,
  resolution: DecisionResolution,
  commit: () => Error | null,
): Error | null {
  if (!decisions) return null;
  try {
    decisions.resolveWith(resolution, () => {
      const err = commit();
      if (err) throw err;
    });
  } catch (err) {
    return asError(err);
  }
  return null;
}

export function rememberApprovalRule(
  server: Server,
  request: SessionApprovalRequest,
  action: string,
): Error | null {
  if (action === "approve_once") return null;
  const args = (request.tool?.["args"] ?? {}) as Record<string, unknown>;
  const allow = server.getAllow();
  let changed = false;
  switch (action) {
    case "remember_command":
      changed = addBashCommand(allow, approvalCommand(args));
      break;
    case "remember_prefix":
      changed = addBashPrefix(
        allow,
        suggestedApprovalCommandPrefix(approvalCommand(args)),
      );
      break;
    case "allow_edit_path":
      changed = addEditPath(allow, normalize(approvalPath(args)));
      break;
  }
  if (!changed) return null;
  const rollback = () => rollbackApprovalRule(allow, args, action);
  if (server.saveProjectAllow) {
    try {
      server.saveProjectAllow(allow);
    } catch (err) {
      rollback();
      return new Error(`save project allow rule: ${asError(err).message}`);
    }
    return null;
  }
  try {
    saveProject(allow);
  } catch (err) {
    rollback();
    return new Error(`save project allow rule: ${asError(err).message}`);
  }
  return null;
}

export function rollbackApprovalRule(
  allow: AllowConfig,
  args: Record<string, unknown>,
  action: string,
): void {
  switch (action) {
    case "remember_command":
      removeBashCommand(allow, approvalCommand(args));
      break;
    case "remember_prefix":
      removeBashPrefix(
        allow,
        suggestedApprovalCommandPrefix(approvalCommand(args)),
      );
      break;
    case "allow_edit_path":
      removeEditPath(allow, normalize(approvalPath(args)));
      break;
  }
}

export function clearSessionApprovals(
  server: Server,
  sess: APISession | null,
  status: string,
  message: string,
): void {
  if (!sess) return;
  const runID = sess.activeRunId;
  clearSessionApprovalsForRun(server, sess, runID, status, message);
}

export function clearSessionApprovalsForRun(
  server: Server,
  sess: APISession | null,
  runID: string,
  status: string,
  message: string,
): void {
  if (!sess || runID === "") return;
  const pending = new Map<string, { request: SessionApprovalRequest }>();
  const questions = new Map<string, { request: SessionQuestionRequest }>();
  for (const [approvalID, item] of sess.pendingApprovals) {
    if (item.request.runId !== runID) continue;
    pending.set(approvalID, item);
    sess.pendingApprovals.delete(approvalID);
  }
  for (const [questionID, item] of sess.pendingQuestions) {
    if (item.request.runId !== runID) continue;
    questions.set(questionID, item);
    sess.pendingQuestions.delete(questionID);
  }
  if (sess.decisions) {
    sess.decisions.clearRunWithValue(runID, "");
  }

  for (const [approvalID, item] of pending) {
    const resolution: SessionApprovalResolution = {
      approvalId: approvalID,
      sessionId: sess.id,
      action: "deny_once",
      status,
      message,
    };
    const err = recordSessionApprovalResolution(
      server,
      sess,
      item.request,
      resolution,
    );
    if (err) {
      debugLogf(
        "record cleared approval resolution %q for session %q: %v",
        approvalID,
        sess.id,
        err,
      );
    }
    publishSessionStreamEvent(server, sess.id, "approval_resolved", resolution);
    server.getEventBroker().publishApprovalEvent(
      sess.id,
      runID,
      "approval_resolved",
      resolution,
    );
  }
  for (const [questionID, item] of questions) {
    const resolution: SessionQuestionResolution = {
      questionId: questionID,
      sessionId: sess.id,
      runId: runID,
      status,
      message,
    };
    publishSessionStreamEvent(server, sess.id, "question_resolved", resolution);
    recordSessionQuestionResolution(server, sess, item.request, resolution);
    server.getEventBroker().publishRawJSON(
      sess.id,
      runID,
      "question_resolved",
      resolution,
    );
  }
}

export function recordSessionApprovalRequest(
  server: Server,
  sess: APISession,
  request: SessionApprovalRequest,
): Error | null {
  const decision: DecisionRequest = {
    id: request.approvalId,
    sessionId: request.sessionId,
    runId: request.runId ?? "",
    kind: DecisionApproval,
  };
  return recordDecisionEventWithDeadline(
    server,
    sess,
    decision,
    null,
    "approval_requested",
    "pending",
    "approval",
    request.mode ?? "",
    request,
    decisionDeadline(server),
  );
}

export function recordSessionApprovalResolution(
  server: Server,
  sess: APISession,
  request: SessionApprovalRequest,
  resolution: SessionApprovalResolution | null,
): Error | null {
  if (!sess || !resolution) return null;
  const decision: DecisionRequest = {
    id: request.approvalId,
    sessionId: request.sessionId,
    runId: request.runId ?? "",
    kind: DecisionApproval,
  };
  const result: DecisionResolution = {
    id: request.approvalId,
    kind: DecisionApproval,
    status: resolution.status,
    value: resolution.action,
  };
  return recordDecisionEvent(
    server,
    sess,
    decision,
    result,
    "approval_resolved",
    resolution.status,
    "approval",
    request.mode ?? "",
    { approval: request, resolution },
  );
}
