// Ported from internal/serve/openaiapi/events.go — the free-function half: run
// and intent ID vocabulary, idempotency fingerprints, capability snapshots and
// the durable event-data shapers. The `Server`-bound record/persist methods
// (recordSessionRunEvent, recordSessionCapabilityChanges, safeRunEventData,
// canonicalRunIdentity and the capability persistence wrappers) land with the
// server slice; `safeHostedItemRunData` is shared with chat_support.ts, which
// already ported it.
import {
  type ErrorInfo,
  PhaseModel,
  PhaseTransport,
} from "../../agentruntime/error_info.ts";
import {
  ErrIdempotencyKeyConflict,
  ErrIdempotencyRunMissing,
  findIdempotentRun as findIdempotentRunRuntime,
  idempotencyKeyFingerprint,
} from "../../agentruntime/idempotency.ts";
import { createHash } from "node:crypto";
import type { ContextUsage } from "../../context/context.ts";
import type { HostedItem } from "../../provider/types.ts";
import { generateID } from "../../session/entry.ts";
import type { SessionRun } from "../../session/run_store.ts";
import { updateSessionRunErrorInfo } from "../../session/run_store.ts";
import {
  saveSessionCapabilityEvent,
  type SessionCapabilityEvent,
  type SessionRunEvent,
} from "../../session/session_events.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import {
  type RunEvent,
  SessionRunEventSink,
} from "../../agentruntime/run_event.ts";
import {
  classifyError,
  displayErrorMessage,
  type RunPhase,
  SideEffectUnknown,
} from "../../agentruntime/error_info.ts";
import { policyForSource } from "../../agentruntime/source.ts";
import {
  persistSessionCapabilities,
  resolveSessionPolicy,
} from "./session_capabilities.ts";
import { publishSessionStreamEvent } from "./session_stream.ts";
import {
  sessionCapabilityEventToEntry,
  sessionRunEventToEntry,
} from "./session_mgr.ts";
import { getSessionDir } from "../../config/settings.ts";
import { runtimeRunEventSink } from "./runtime_run_events.ts";
import type { Server } from "./server.ts";
import type { APISession } from "./session_mgr.ts";
import type { CompletionUsage } from "./types.ts";

export interface CapabilitySnapshot {
  mode: string;
  delegateMode: boolean;
  multiAgent: boolean;
  workflows: boolean;
  webSearch: boolean;
  browser: boolean;
  a2aMaster: boolean;
}

export function newRunID(): string {
  return "run_" + generateID();
}

export function newExecutionIntentID(): string {
  return "intent_" + generateID();
}

// Compatibility aliases keep the OpenAI API error surface stable while the
// reconciliation implementation is owned by the shared Runtime.
export { ErrIdempotencyKeyConflict, ErrIdempotencyRunMissing };

/**
 * requestFingerprint returns a stable, non-sensitive digest for the request
 * fields selected by the caller. Only the digest is persisted in run events.
 */
export function requestFingerprint(value: unknown): string {
  let payload: string;
  try {
    payload = JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

/**
 * idempotencyKeyFingerprint keeps the client-generated key out of durable
 * events. The key is only used as an equality token during an unknown-submit
 * reconciliation, so a stable digest is sufficient for lookup.
 */
export { idempotencyKeyFingerprint };

export function retryIdempotencyScope(
  intentId: string,
  retryOf: string,
): string {
  if (intentId === "" || retryOf === "") return "retry";
  return "retry:" + intentId + ":" + retryOf;
}

export function findIdempotentRun(
  sessionDir: string,
  sessionId: string,
  key: string,
  fingerprint: string,
  scope: string,
): SessionRun | null {
  return findIdempotentRunRuntime(
    sessionDir,
    sessionId,
    key,
    fingerprint,
    scope,
  );
}

export function capabilitySnapshotFromSession(
  sess: APISession | undefined,
): CapabilitySnapshot {
  if (!sess) {
    return {
      mode: "",
      delegateMode: false,
      multiAgent: false,
      workflows: false,
      webSearch: false,
      browser: false,
      a2aMaster: false,
    };
  }
  return {
    mode: sess.mode,
    delegateMode: sess.delegateMode,
    multiAgent: sess.multiAgent,
    workflows: sess.workflows,
    webSearch: sess.webSearch,
    browser: sess.browser,
    a2aMaster: sess.a2aMaster,
  };
}

export function capabilitySnapshotValues(
  c: CapabilitySnapshot,
): Record<string, string> {
  return {
    mode: c.mode,
    delegateMode: String(c.delegateMode),
    multiAgent: String(c.multiAgent),
    workflows: String(c.workflows),
    webSearch: String(c.webSearch),
    browser: String(c.browser),
    a2aMaster: String(c.a2aMaster),
  };
}

export function isTerminalRunStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "completed":
    case "incomplete":
    case "failed":
    case "cancelled":
    case "canceled":
    case "timed_out":
    case "expired":
      return true;
    default:
      return false;
  }
}

export function cloneRunEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { ...data };
}

export function runEventErrorInfo(
  data: Record<string, unknown> | undefined,
): { info: ErrorInfo; ok: boolean } {
  if (!data) return { info: {} as ErrorInfo, ok: false };
  for (const key of ["errorInfo", "error"]) {
    if (!(key in data)) continue;
    const value = data[key];
    if (
      typeof value === "object" && value !== null && "code" in value &&
      (value as { code?: unknown }).code !== ""
    ) {
      const info = value as ErrorInfo;
      return { info, ok: true };
    }
    // Go's typed-nil *ErrorInfo case cannot occur for decoded JSON values.
  }
  return { info: {} as ErrorInfo, ok: false };
}

/** Go serialized the map to json.RawMessage; the port carries decoded values. */
export function rawEventData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || Object.keys(data).length === 0) return undefined;
  return data;
}

export { PhaseModel, PhaseTransport };

const MAX_HOSTED_RUN_STRING = 512;

export function boundedHostedString(value: string): string {
  if (value.length <= MAX_HOSTED_RUN_STRING) return value;
  return value.slice(0, MAX_HOSTED_RUN_STRING) + "...";
}

export function runEventTypeForStatus(status: string): string {
  switch (status) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "finished";
  }
}

/** Reports only a fully completed Responses run. */
export function isSuccessfulRunStatus(status: string): boolean {
  return status.trim().toLowerCase() === "completed";
}

/** Reports a run that produced a partial result without completing its objective. */
export function isIncompleteRunStatus(status: string): boolean {
  return status.trim().toLowerCase() === "incomplete";
}

export function usageEventData(
  usage: CompletionUsage,
  errMsg: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
    },
  };
  if (errMsg !== "") data.error = errMsg;
  return data;
}

/**
 * Adds the final request-context footprint to a durable run event. Unlike
 * cumulative CompletionUsage, this reflects the currently occupied portion of
 * the selected model's context window.
 */
export function withContextUsageEventData(
  data: Record<string, unknown>,
  usage: ContextUsage | null | undefined,
): Record<string, unknown> {
  if (!usage || usage.contextWindow <= 0) return data;
  data.contextUsage = { ...usage };
  return data;
}

export type { HostedItem };

// ---------------------------------------------------------------------------
// Server-bound half of events.go (persistSessionCapabilitiesWithEvents,
// recordSessionCapabilityChanges, recordSessionRunEvent, safeRunEventData,
// canonicalRunIdentity). The Server-bound methods become exported functions
// taking the `Server` as their first argument.
// ---------------------------------------------------------------------------

export function persistSessionCapabilitiesWithEvents(
  server: Server,
  sess: APISession,
  before: CapabilitySnapshot,
  source: string,
  actor: string,
  runId: string,
  data: Record<string, unknown> | undefined,
): Error | null {
  try {
    persistSessionCapabilities(server, sess);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return recordSessionCapabilityChanges(
    server,
    sess,
    before,
    source,
    actor,
    runId,
    data,
  );
}

export function recordSessionCapabilityChanges(
  server: Server,
  sess: APISession,
  before: CapabilitySnapshot,
  source: string,
  actor: string,
  runId: string,
  data: Record<string, unknown> | undefined,
): Error | null {
  if (!server.settings || !sess || sess.id === "") return null;
  const after = capabilitySnapshotFromSession(sess);
  const beforeValues = capabilitySnapshotValues(before);
  const afterValues = capabilitySnapshotValues(after);
  const eventData = rawEventData(data);
  for (
    const capability of [
      "mode",
      "delegateMode",
      "multiAgent",
      "workflows",
      "webSearch",
      "browser",
      "a2aMaster",
    ]
  ) {
    const oldValue = beforeValues[capability];
    const newValue = afterValues[capability];
    if (oldValue === newValue) continue;
    const ev: SessionCapabilityEvent = {
      id: "",
      sessionId: sess.id,
      runId,
      eventType: "changed",
      source,
      actor,
      capability,
      oldValue,
      newValue,
      timestamp: new Date(),
      data: eventData,
    };
    let id: string;
    try {
      id = saveSessionCapabilityEvent(getSessionDir(server.settings), ev);
    } catch (err) {
      return new Error(
        `save capability event: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    ev.id = id;
    publishSessionStreamEvent(
      server,
      sess.id,
      "capability_event",
      sessionCapabilityEventToEntry(ev, 0),
    );
    server
      .getEventBroker()
      .publishCapabilityEvent(
        sess.id,
        runId,
        sessionCapabilityEventToEntry(ev, 0),
      );
  }
  return null;
}

export function recordSessionRunEvent(
  server: Server,
  sess: APISession,
  runId: string,
  eventType: string,
  status: string,
  source: string,
  modelId: string,
  mode: string,
  data: Record<string, unknown> | undefined,
): Error | null {
  if (!server.settings || !sess || sess.id === "" || runId === "") return null;
  const execution = sess.ensureExecution();
  // Once a canonical row exists, its source/mode/model are authoritative for
  // every later projection. This prevents provider-specific background code
  // from accidentally reintroducing its adapter fallback in durable events.
  const persistedRun = getDurableRun(getSessionDir(server.settings), runId);
  if (persistedRun) {
    if (persistedRun.source.trim() !== "") source = persistedRun.source;
    if (persistedRun.mode.trim() !== "") mode = persistedRun.mode;
    if (modelId.trim() === "") modelId = persistedRun.model;
  }
  const identity = canonicalRunIdentity(server, sess, source, mode);
  if (identity.err) return identity.err;
  source = identity.source;
  mode = identity.mode;

  data = safeRunEventData(server, persistedRun, eventType, status, data);
  const errorInfo = runEventErrorInfo(data);
  if (errorInfo.ok && execution) {
    let recorded: ErrorInfo;
    try {
      recorded = execution.recordErrorInfo(errorInfo.info);
    } catch (err) {
      return new Error(
        `persist run error info: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    data = cloneRunEventData(data!);
    data["error"] = recorded;
    data["errorInfo"] = recorded;
    data["errorMessage"] = recorded.message;
  }
  // A durable Runtime has one terminalization owner. Legacy background
  // coordinators may still report a terminal-shaped detail event before their
  // defer calls FinishDurable; retain its ErrorInfo fact but do not append a
  // second terminal event to the canonical stream.
  if (persistedRun && sess.isDurableRun(runId) && isTerminalRunStatus(status)) {
    return null;
  }
  const ev: SessionRunEvent = {
    id: "",
    sessionId: sess.id,
    runId,
    eventType,
    source,
    status,
    model: modelId,
    mode,
    timestamp: new Date(),
    data: rawEventData(data),
  };
  execution.setEventSink(
    new SessionRunEventSink(getSessionDir(server.settings)),
  );
  let id: string;
  try {
    id = execution.recordEvent(
      {
        sessionId: ev.sessionId,
        runId: ev.runId,
        eventType: ev.eventType,
        source: ev.source,
        status: ev.status,
        model: ev.model,
        mode: ev.mode,
        timestamp: ev.timestamp,
        data: ev.data,
      } satisfies RunEvent,
    );
  } catch (err) {
    return new Error(
      `save run event: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  ev.id = id;
  publishSessionStreamEvent(
    server,
    sess.id,
    "run_event",
    sessionRunEventToEntry(ev, 0),
  );
  server.getEventBroker().publishRunEvent(
    sess.id,
    runId,
    sessionRunEventToEntry(ev, 0),
  );
  // Keep the live projection sink installed for the next Runtime-owned event;
  // this method uses a persistence-only sink only to avoid double publication
  // for the event it just emitted.
  execution.setEventSink(runtimeRunEventSink(server, sess));
  return null;
}

export function safeRunEventData(
  server: Server,
  run: SessionRun | null | undefined,
  eventType: string,
  _status: string,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || Object.keys(data).length === 0) return data;
  if (!("error" in data)) return data;
  const value = data["error"];
  if (isErrorInfo(value)) {
    const copy = cloneRunEventData(data);
    copy["errorInfo"] = value;
    copy["errorMessage"] = displayErrorMessage(value);
    return copy;
  }
  if (typeof value === "string") {
    if (value.trim() === "") return data;
    let phase: RunPhase = PhaseModel;
    const lowered = eventType.toLowerCase();
    if (lowered.includes("remote") || lowered.includes("transport")) {
      phase = PhaseTransport;
    }
    const info = classifyError(new Error(value), {
      phase,
      sideEffectState: SideEffectUnknown,
      runId: run?.id,
      intentId: run?.intentId,
      attempt: run?.attempt,
    });
    const copy = cloneRunEventData(data);
    copy["error"] = info;
    copy["errorInfo"] = info;
    copy["errorMessage"] = displayErrorMessage(info);
    if (run && server.settings) {
      try {
        updateSessionRunErrorInfo(
          getSessionDir(server.settings),
          run.id,
          info,
        );
      } catch {
        // Go discards the persistence error here.
      }
    }
    return copy;
  }
  return data;
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  return typeof value === "object" && value !== null && "code" in value &&
    typeof (value as { code?: unknown }).code === "string";
}

export function canonicalRunIdentity(
  server: Server,
  sess: APISession,
  fallbackSource: string,
  requestedMode: string,
): { source: string; mode: string; err: Error | null } {
  const resolved = resolveSessionPolicy(server, sess, requestedMode);
  if (resolved.err) return { source: "", mode: "", err: resolved.err };
  if (policyForSource(resolved.resolution.source, "").hasForcedMode()) {
    return {
      source: String(resolved.resolution.source),
      mode: resolved.mode,
      err: null,
    };
  }
  return { source: fallbackSource, mode: resolved.mode, err: null };
}
