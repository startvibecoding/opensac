//
// `RunEvent` is the front-end-neutral durable representation of a run event.
// Adapters may keep their protocol payload in `data`, but persistence is owned
// by this runtime boundary. Go's `json.RawMessage` maps to decoded `unknown`;
// `time.Time` maps to `Date`.
//
import { type Message } from "../provider/types.ts";
import {
  saveSessionRunEvent,
  type SessionRunEvent,
} from "../session/session_events.ts";
import { displayErrorMessage, type ErrorInfo } from "./error_info.ts";

export interface RunEvent {
  id?: string;
  sessionId: string;
  runId: string;
  eventType: string;
  source: string;
  status: string;
  model: string;
  mode: string;
  timestamp?: Date;
  data?: unknown;
  /**
   * Runtime-only terminal transaction inputs. They are not serialized into the
   * generic event envelope or exposed to prompts.
   */
  assistantEntryId?: string;
  assistantMessage?: Message;
}

/** Adapts a function to the adapter-neutral event sink. */
export type RunEventSinkFunc = (event: RunEvent) => string;

/**
 * Persists run lifecycle events without exposing the adapter implementation to
 * the Runtime.
 */
export interface RunEventSink {
  record(event: RunEvent): string;
}

/**
 * Optional live-transport hook used when an event was persisted as part of an
 * atomic admission transaction. It must not write a second durable row; it only
 * fans the already committed event out to clients.
 */
export interface RunEventProjector {
  project(event: RunEvent, id: string): void;
}

/**
 * Ensures a terminal event payload carries the assistant transcript entry ID
 * under the canonical key without clobbering an existing adapter value.
 */
export function withAssistantEntryData(raw: unknown, entryId: string): unknown {
  if (entryId === "") return raw;
  const data = asObject(raw);
  if (data === undefined) return raw;
  if (!("assistantEntryId" in data)) data.assistantEntryId = entryId;
  return data;
}

/**
 * Stores events in the existing `session_run_events` table. It intentionally
 * reuses the existing session persistence API and schema.
 */
export class SessionRunEventSink implements RunEventSink {
  sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  record(ev: RunEvent): string {
    if (ev.sessionId === "" || ev.runId === "" || ev.eventType === "") {
      throw new Error("run event requires session ID, run ID, and event type");
    }
    return saveSessionRunEvent(this.sessionDir, {
      id: ev.id ?? "",
      sessionId: ev.sessionId,
      runId: ev.runId,
      eventType: ev.eventType,
      source: ev.source,
      status: ev.status,
      model: ev.model,
      mode: ev.mode,
      timestamp: ev.timestamp ?? new Date(),
      data: ev.data,
    } satisfies SessionRunEvent);
  }

  recordJSON(
    sessionId: string,
    runId: string,
    eventType: string,
    source: string,
    status: string,
    model: string,
    mode: string,
    data: unknown,
  ): string {
    return this.record({
      sessionId,
      runId,
      eventType,
      source,
      status,
      model,
      mode,
      timestamp: new Date(),
      data,
    });
  }
}

/**
 * Ensures a run event payload carries the canonical attempt identity without
 * clobbering adapter-provided values. The `DurableRun` argument maps to the
 * canonical `SessionRun` row.
 */
export function withRunAttemptData(
  raw: unknown,
  run: { intentId: string; retryOf: string; attempt: number },
): unknown {
  const data = asObject(raw) ?? {};
  if (run.intentId !== "" && !("intentId" in data)) {
    data.intentId = run.intentId;
  }
  if (run.retryOf !== "" && !("retryOf" in data)) {
    data.retryOf = run.retryOf;
  }
  if (
    !("attempt" in data) &&
    (run.intentId !== "" || run.retryOf !== "" || run.attempt > 0)
  ) {
    const attempt = run.attempt <= 0 ? 1 : run.attempt;
    data.attempt = attempt;
  }
  if (Object.keys(data).length === 0) return raw;
  return data;
}

/**
 * Ensures every unsuccessful durable terminal event carries the same safe
 * `ErrorInfo` persisted on the Run row. Malformed adapter data is discarded
 * instead of retaining a possible raw provider diagnostic.
 */
export function withTerminalErrorInfo(raw: unknown, info: ErrorInfo): unknown {
  const data = asObject(raw) ?? {};
  data.error = info;
  data.errorInfo = info;
  data.errorMessage = displayErrorMessage(info);
  return data;
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
