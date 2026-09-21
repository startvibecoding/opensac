// Ported from internal/serve/openaiapi/handler_session_trajectory.go: the
// read-only, front-end-neutral trajectory window assembled from the canonical
// transcript, run-event, and capability-event stores, plus the NDJSON
// session.log exporter. Go's *Server methods become functions taking the
// Server first; Go's http.ResponseWriter streaming maps to a ReadableStream
// Response.
import type { Server } from "./server.ts";
import { DecisionRecordSource } from "../../agentruntime/decision_events.ts";
import { openByIDExact } from "../../session/manager.ts";
import { listAllDetailed } from "../../session/manager.ts";
import { getSessionDir } from "../../config/settings.ts";
import { isNonTerminalSessionRunStatus } from "../../session/run_status.ts";
import type { SessionRun } from "../../session/run_store.ts";
import { listSessionRuns } from "../../session/run_store.ts";
import type { SessionMessageEntry } from "./session_mgr.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import {
  getSessionCapabilityEvents,
  getSessionMessages,
  getSessionRunEvents,
} from "./session_read.ts";
import { writeJSON } from "./auth.ts";

/** SessionTrajectoryResponse is one trajectory window. */
export interface SessionTrajectoryResponse {
  sessionId: string;
  records: Record<string, unknown>[];
  highWater: Record<string, number>;
  hasMore: boolean;
}

interface TrajectoryCursor {
  entrySeq: number;
  runSeq: number;
  capabilitySeq: number;
  decisionSeq: number;
}

interface TrajectoryRecord {
  value: Record<string, unknown>;
  source: string;
  seq: number;
  when: Date | null;
}

export const trajectoryLimitDefault = 200;
export const trajectoryLimitMax = 500;

export const ErrInvalidTrajectoryCursor = new Error(
  "invalid trajectory cursor",
);

/** getSessionTrajectory assembles a deterministic trajectory projection. */
export function getSessionTrajectory(
  server: Server,
  id: string,
  before: string,
  limit: number,
): SessionTrajectoryResponse {
  if (id === "") throw ErrSessionNotFound;
  const { found } = server.findSessionWorkDir(id);
  if (!found) throw ErrSessionNotFound;
  if (limit <= 0) limit = trajectoryLimitDefault;
  if (limit > trajectoryLimitMax) limit = trajectoryLimitMax;
  const cursor = decodeTrajectoryCursor(before);
  const { records, highWater } = trajectoryRecords(server, id);
  let filtered = filterTrajectoryRecords(records, cursor);
  const hasMore = filtered.length > limit;
  if (hasMore) {
    filtered = filtered.slice(filtered.length - limit);
  }
  return {
    sessionId: id,
    records: filtered.map((item) => item.value),
    highWater,
    hasMore,
  };
}

/**
 * handleSessionExport serves the browser-facing session.log exporter. GET is
 * streamed directly to the response; HEAD validates the same snapshot without
 * buffering or returning a body.
 */
export function handleSessionExport(
  server: Server,
  req: Request,
  id: string,
): Response | Promise<Response> {
  if (id === "") return writeTrajectoryError(ErrSessionNotFound);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  let format = (new URL(req.url).searchParams.get("format") ?? "").trim()
    .toLowerCase();
  if (format === "") format = "log";
  if (format !== "log") {
    return writeJSON(400, { error: "unsupported export format" });
  }
  let includeDescendants: boolean;
  try {
    includeDescendants = parseBoolQuery(
      new URL(req.url).searchParams.get("include_descendants") ?? "",
      true,
    );
  } catch {
    return writeJSON(400, { error: "invalid include_descendants" });
  }
  let sessions: string[];
  try {
    sessions = exportSessionIDs(server, id, includeDescendants);
  } catch (err) {
    return writeTrajectoryError(err);
  }

  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="${
      safeSessionFilename(id)
    }.log"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-mothx-session-count": String(sessions.length),
  };
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (value: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      };
      try {
        write({
          schemaVersion: 1,
          type: "manifest",
          sessionId: id,
          generatedAt: new Date().toISOString(),
          includeDescendants,
          sessionCount: sessions.length,
        });
        for (const sessionID of sessions) {
          if (req.signal.aborted) return;
          let records: TrajectoryRecord[];
          let highWater: Record<string, number>;
          try {
            ({ records, highWater } = trajectoryRecords(server, sessionID));
          } catch (err) {
            console.error(
              `[session-export] projection failed session=${sessionID}: ${err}`,
            );
            return;
          }
          const activeRunIDs: string[] = [];
          for (const item of records) {
            if (item.value.snapshot === true) {
              const runID = item.value.runId;
              if (typeof runID === "string" && runID !== "") {
                activeRunIDs.push(runID);
              }
            }
          }
          write({
            schemaVersion: 1,
            type: "session_snapshot",
            sessionId: sessionID,
            highWater,
            activeRunIds: activeRunIDs,
          });
          for (const item of records) {
            if (req.signal.aborted) return;
            const line: Record<string, unknown> = {
              schemaVersion: 1,
              type: "record",
            };
            for (const [key, value] of Object.entries(item.value)) {
              line[key] = value;
            }
            write(line);
          }
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers });
}

function trajectoryRecords(
  server: Server,
  id: string,
): {
  records: TrajectoryRecord[];
  highWater: Record<string, number>;
} {
  let parentSessionID = "";
  try {
    const manager = openByIDExact(sessionDir(server), id);
    const header = manager.getHeader();
    if (header) parentSessionID = header.parentSession ?? "";
  } catch {
    // Go only reads the header when the session opens successfully.
  }
  const messages = getSessionMessages(server, id);
  const runEvents = getSessionRunEvents(server, id);
  const capabilityEvents = getSessionCapabilityEvents(server, id);
  const records: TrajectoryRecord[] = [];
  const highWater: Record<string, number> = {
    entrySeq: 0,
    runSeq: 0,
    capabilitySeq: 0,
    decisionSeq: 0,
  };
  for (const run of sessionRunsForTrajectory(server, id)) {
    const status = normalizeTrajectoryStatus(run.status, "");
    const startedAt = formatTrajectoryTime(run.startedAt);
    const completedAt = run.finishedAt
      ? formatTrajectoryTime(run.finishedAt)
      : "";
    const value: Record<string, unknown> = {
      id: "run:" + id + ":snapshot:" + run.id,
      sessionId: id,
      parentSessionId: parentSessionID,
      runId: run.id,
      source: "run",
      kind: "run",
      status,
      attempt: run.attempt,
      summary: "Run " + run.status,
      preview: run.error,
      timestamp: startedAt,
      startedAt,
      completedAt,
      snapshot: isActiveTrajectoryRun(run.status),
      model: run.model,
      mode: run.mode,
      error: run.error,
      usage: redactTrajectoryValue(run.usage),
      output: redactTrajectoryValue(run.progress),
      sourceEvent: redactTrajectoryValue(sourceEventOfRun(id, run)),
    };
    records.push({
      value: compactTrajectoryValue(value),
      source: "run",
      seq: 0,
      when: run.startedAt,
    });
  }
  for (const message of messages) {
    const [kind, status] = trajectoryMessageKindStatus(message);
    const idValue = trajectoryMessageID(id, message);
    const value: Record<string, unknown> = {
      id: idValue,
      sessionId: id,
      parentSessionId: parentSessionID,
      seq: message.seq,
      source: "transcript",
      kind,
      status,
      role: message.role,
      summary: trajectoryMessageSummary(message),
      preview: trajectoryMessagePreview(message),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      hasDetail: message.hasDetail,
      error: message.invalidArguments,
      sourceEvent: redactTrajectoryValue(message),
    };
    if (message.content) value.content = message.content;
    if (message.contents && message.contents.length > 0) {
      value.contents = redactTrajectoryValue(message.contents);
    }
    if (message.attachments && message.attachments.length > 0) {
      value.attachments = redactTrajectoryValue(message.attachments);
    }
    if (message.arguments !== undefined && message.arguments !== null) {
      value.input = redactTrajectoryValue(message.arguments);
    }
    records.push({
      value: compactTrajectoryValue(value),
      source: "transcript",
      seq: message.seq ?? 0,
      when: null,
    });
    if ((message.seq ?? 0) > highWater.entrySeq) {
      highWater.entrySeq = message.seq ?? 0;
    }
  }
  for (const event of runEvents) {
    let kind = "run";
    let recordSource = "run";
    const status = normalizeTrajectoryStatus(
      event.status ?? "",
      event.eventType,
    );
    const lowerType = event.eventType.toLowerCase();
    if (lowerType.includes("approval") || lowerType.includes("question")) {
      kind = DecisionRecordSource;
      recordSource = DecisionRecordSource;
      if ((event.seq ?? 0) > highWater.decisionSeq) {
        highWater.decisionSeq = event.seq ?? 0;
      }
    }
    const value: Record<string, unknown> = {
      id: trajectoryEventID(recordSource, id, event.id),
      sessionId: event.sessionId,
      parentSessionId: parentSessionID,
      runId: event.runId,
      seq: event.seq,
      source: recordSource,
      kind,
      status,
      eventType: event.eventType,
      summary: event.eventType,
      preview: event.status,
      model: event.model,
      mode: event.mode,
      timestamp: event.timestamp,
      output: redactTrajectoryValue(event.data),
      sourceEvent: redactTrajectoryValue(event),
    };
    records.push({
      value: compactTrajectoryValue(value),
      source: recordSource,
      seq: event.seq ?? 0,
      when: parseTrajectoryTime(event.timestamp),
    });
    if ((event.seq ?? 0) > highWater.runSeq) {
      highWater.runSeq = event.seq ?? 0;
    }
  }
  for (const event of capabilityEvents) {
    const value: Record<string, unknown> = {
      id: "capability:" + id + ":" + event.id,
      sessionId: event.sessionId,
      parentSessionId: parentSessionID,
      runId: event.runId,
      seq: event.seq,
      source: "capability",
      kind: "capability",
      status: "completed",
      eventType: event.eventType,
      summary: event.capability,
      preview: `${event.oldValue} -> ${event.newValue}`,
      capability: event.capability,
      oldValue: event.oldValue,
      newValue: event.newValue,
      timestamp: event.timestamp,
      output: redactTrajectoryValue(event.data),
      sourceEvent: redactTrajectoryValue(event),
    };
    records.push({
      value: compactTrajectoryValue(value),
      source: "capability",
      seq: event.seq ?? 0,
      when: parseTrajectoryTime(event.timestamp),
    });
    if ((event.seq ?? 0) > highWater.capabilitySeq) {
      highWater.capabilitySeq = event.seq ?? 0;
    }
  }
  const merged = mergeTrajectoryRecords(records);
  merged.sort(compareTrajectoryRecords);
  return { records: merged, highWater };
}

/** Go marshals the whole SessionRun struct as sourceEvent; the port projects
 * the same durable fields the TS run store carries. */
function sourceEventOfRun(
  sessionId: string,
  run: SessionRun,
): Record<string, unknown> {
  return {
    id: run.id,
    sessionId,
    intentId: run.intentId,
    attempt: run.attempt,
    source: run.source,
    model: run.model,
    mode: run.mode,
    status: run.status,
    startedAt: formatTrajectoryTime(run.startedAt),
    finishedAt: run.finishedAt ? formatTrajectoryTime(run.finishedAt) : "",
    error: run.error,
  };
}

function compareTrajectoryRecords(
  a: TrajectoryRecord,
  b: TrajectoryRecord,
): number {
  if (a.when && b.when && a.when.getTime() !== b.when.getTime()) {
    return a.when.getTime() - b.when.getTime();
  }
  const ao = sourceOrder(a.source);
  const bo = sourceOrder(b.source);
  if (ao !== bo) return ao - bo;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return String(a.value.id) < String(b.value.id) ? -1 : 1;
}

function mergeTrajectoryRecords(
  records: TrajectoryRecord[],
): TrajectoryRecord[] {
  const merged: TrajectoryRecord[] = [];
  const indexes = new Map<string, number>();
  for (const item of records) {
    const id = typeof item.value.id === "string" ? item.value.id : "";
    if (id === "") {
      merged.push(item);
      continue;
    }
    const index = indexes.get(id);
    if (index === undefined) {
      indexes.set(id, merged.length);
      merged.push(item);
      continue;
    }
    const current = merged[index];
    for (const [key, value] of Object.entries(item.value)) {
      current.value[key] = value;
    }
    if (current.seq === 0 || (item.seq > 0 && item.seq < current.seq)) {
      current.seq = item.seq;
      current.value.seq = item.seq;
    }
    if (!current.when || (item.when && item.when < current.when)) {
      current.when = item.when;
    }
  }
  return merged;
}

function sessionRunsForTrajectory(
  server: Server,
  sessionID: string,
): SessionRun[] {
  if (!server.settings) return [];
  try {
    return listSessionRuns(sessionDir(server), sessionID, 500);
  } catch {
    return [];
  }
}

function formatTrajectoryTime(value: Date): string {
  if (!value || value.getTime() === 0) return "";
  return value.toISOString();
}

function isActiveTrajectoryRun(status: string): boolean {
  return isNonTerminalSessionRunStatus(status.trim().toLowerCase());
}

function exportSessionIDs(
  server: Server,
  rootID: string,
  includeDescendants: boolean,
): string[] {
  try {
    openByIDExact(sessionDir(server), rootID);
  } catch {
    throw ErrSessionNotFound;
  }
  if (!includeDescendants) return [rootID];
  let details: { id: string }[] = [];
  try {
    details = listAllDetailed(sessionDir(server));
  } catch {
    return [rootID];
  }
  const parent = new Map<string, string>();
  for (const detail of details) {
    try {
      const manager = openByIDExact(sessionDir(server), detail.id);
      const header = manager.getHeader();
      if (header) parent.set(detail.id, header.parentSession ?? "");
    } catch {
      continue;
    }
  }
  const result: string[] = [rootID];
  const seen = new Set<string>([rootID]);
  for (const detail of details) {
    if (detail.id === rootID || seen.has(detail.id)) continue;
    let current = detail.id;
    const visited = new Set<string>();
    while (current !== "" && !visited.has(current)) {
      if (current === rootID) {
        result.push(detail.id);
        seen.add(detail.id);
        break;
      }
      visited.add(current);
      current = parent.get(current) ?? "";
    }
  }
  if (result.length > 1) {
    // Go sorts only the descendants (result[1:]); the root stays first.
    const rest = result.slice(1).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [result[0], ...rest];
  }
  return result;
}

function decodeTrajectoryCursor(raw: string): TrajectoryCursor {
  if (raw.trim() === "") {
    return { entrySeq: 0, runSeq: 0, capabilitySeq: 0, decisionSeq: 0 };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64RawURL(raw);
  } catch {
    throw ErrInvalidTrajectoryCursor;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return {
      entrySeq: Number(parsed.entrySeq ?? 0),
      runSeq: Number(parsed.runSeq ?? 0),
      capabilitySeq: Number(parsed.capabilitySeq ?? 0),
      decisionSeq: Number(parsed.decisionSeq ?? 0),
    };
  } catch {
    throw ErrInvalidTrajectoryCursor;
  }
}

/** Base64 raw-URL decoding without padding (Go's RawURLEncoding). */
function decodeBase64RawURL(value: string): Uint8Array {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function filterTrajectoryRecords(
  records: TrajectoryRecord[],
  cursor: TrajectoryCursor,
): TrajectoryRecord[] {
  if (
    cursor.entrySeq === 0 && cursor.runSeq === 0 &&
    cursor.capabilitySeq === 0 && cursor.decisionSeq === 0
  ) {
    return records;
  }
  const out: TrajectoryRecord[] = [];
  for (const item of records) {
    if (item.value.snapshot === true) continue;
    let limit = 0;
    switch (item.source) {
      case "entry":
      case "transcript":
        limit = cursor.entrySeq;
        break;
      case "run":
        limit = cursor.runSeq;
        break;
      case DecisionRecordSource:
        limit = cursor.decisionSeq;
        break;
      case "capability":
        limit = cursor.capabilitySeq;
        break;
    }
    if (limit === 0 || item.seq < limit) out.push(item);
  }
  return out;
}

function trajectoryMessageKindStatus(
  message: SessionMessageEntry,
): [string, string] {
  switch (message.role.toLowerCase()) {
    case "toolcall":
      return ["tool", "running"];
    case "toolresult":
      return message.isError ? ["tool", "failed"] : ["tool", "completed"];
    case "assistant":
      return message.isError ? ["error", "failed"] : ["assistant", "completed"];
    case "user":
      return ["user", "completed"];
    default:
      return ["reasoning", "completed"];
  }
}

function trajectoryMessageSummary(message: SessionMessageEntry): string {
  if (message.toolName) return message.toolName;
  if ((message.summary ?? "").trim() !== "") return message.summary ?? "";
  if ((message.content ?? "").trim() !== "") {
    return firstLine(message.content ?? "");
  }
  return message.role;
}

function trajectoryMessagePreview(message: SessionMessageEntry): string {
  if (message.content) return firstLine(message.content);
  return message.summary ?? "";
}

function trajectoryMessageID(
  sessionID: string,
  message: SessionMessageEntry,
): string {
  const role = message.role.toLowerCase();
  if (
    message.toolCallId && (role === "toolcall" || role === "toolresult")
  ) {
    return `tool:${sessionID}:${message.toolCallId}`;
  }
  let id = message.id ?? "";
  if (id === "") {
    id = `message:${message.seq ?? 0}:${message.role}`;
  }
  return `transcript:${sessionID}:${id}`;
}

function firstLine(value: string): string {
  value = value.replaceAll("\r\n", "\n").trim();
  const idx = value.indexOf("\n");
  if (idx >= 0) return value.slice(0, idx);
  if (value.length > 180) return value.slice(0, 177) + "...";
  return value;
}

function normalizeTrajectoryStatus(
  status: string,
  eventType: string,
): string {
  status = status.trim().toLowerCase();
  if (status !== "") {
    switch (status) {
      case "created":
      case "queued":
      case "running":
      case "retrying":
      case "terminalizing":
      case "cancelling":
        return "running";
      case "waiting_for_approval":
      case "waiting_for_question":
      case "pending":
        return "pending";
      case "cancelled":
      case "canceled":
        return "canceled";
      case "completed":
      case "succeeded":
      case "success":
      case "done":
        return "completed";
      case "failed":
      case "error":
      case "timed_out":
      case "incomplete":
        return "failed";
    }
    return status;
  }
  eventType = eventType.toLowerCase();
  if (eventType.includes("fail") || eventType.includes("error")) {
    return "failed";
  }
  if (eventType.includes("start") || eventType.includes("begin")) {
    return "running";
  }
  return "completed";
}

function parseTrajectoryTime(value: string): Date | null {
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function sourceOrder(source: string): number {
  switch (source) {
    case "entry":
    case "transcript":
      return 0;
    case "run":
      return 1;
    case DecisionRecordSource:
      return 2;
    case "capability":
      return 3;
    default:
      return 3;
  }
}

function trajectoryEventID(
  source: string,
  sessionID: string,
  eventID: string,
): string {
  return `${source}:${sessionID}:${eventID}`;
}

function compactTrajectoryValue(
  value: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || item === null) {
      delete value[key];
      continue;
    }
    if (typeof item === "string" && item === "") {
      delete value[key];
      continue;
    }
    if (typeof item === "boolean" && !item && key === "hasDetail") {
      delete value[key];
    }
  }
  return value;
}

function redactTrajectoryValue(value: unknown): unknown {
  let decoded: unknown;
  try {
    decoded = JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
  return redactTrajectoryJSON(decoded);
}

function redactKeyLower(key: string): string {
  return key.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function redactTrajectoryJSON(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      const lower = redactKeyLower(key);
      if (
        lower.includes("token") || lower.includes("secret") ||
        lower.includes("password") || lower.includes("authorization") ||
        lower.includes("api_key") || lower.includes("apikey")
      ) {
        item[key] = "[REDACTED]";
        continue;
      }
      if (
        lower === "workdir" || lower === "cwd" || lower === "sessiondir" ||
        lower === "dbpath" || lower === "serverpath" ||
        lower === "absolutepath"
      ) {
        item[key] = "[OMITTED]";
        continue;
      }
      if (lower === "data" || lower === "data_url" || lower === "dataurl") {
        if (typeof item[key] === "string") {
          item[key] = "[OMITTED]";
          continue;
        }
      }
      item[key] = redactTrajectoryJSON(item[key]);
    }
    return item;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = redactTrajectoryJSON(value[index]);
    }
    return value;
  }
  return value;
}

function parseBoolQuery(raw: string, fallback: boolean): boolean {
  if (raw.trim() === "") return fallback;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "t":
    case "true":
      return true;
    case "0":
    case "f":
    case "false":
      return false;
  }
  throw new Error(`invalid boolean: ${raw}`);
}

function safeSessionFilename(id: string): string {
  let name = "";
  for (const r of id) {
    if (
      (r >= "a" && r <= "z") || (r >= "A" && r <= "Z") ||
      (r >= "0" && r <= "9") || r === "-" || r === "_"
    ) {
      name += r;
    }
  }
  if (name === "") name = "session";
  return `mothx-session-${name}`;
}

function writeTrajectoryError(err: unknown): Response {
  let status = 500;
  let message = "session trajectory unavailable";
  if (err === ErrSessionNotFound) {
    status = 404;
    message = (err as Error).message;
  } else if (err === ErrInvalidTrajectoryCursor) {
    status = 400;
    message = (err as Error).message;
  }
  return writeJSON(status, { error: message });
}

function sessionDir(server: Server): string {
  return server.settings ? getSessionDir(server.settings) : "";
}
