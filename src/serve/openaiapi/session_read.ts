// Ported from internal/serve/openaiapi/session_mgr.go — the Server-bound read
// half (the live/persisted session listing, capability overview, transcript
// and event reads, titles/metadata). Go defines these as *Server methods;
// the TS projection passes the Server as the first argument because a class
// record cannot be spread across the Go package's files. The stop/cancel and
// patch halves bind to the runtime-snapshot slice; the sub-agent reads bind
// to the external-sub-agent slice.
//
// Deviations: Go's `errors.Is` sentinels map to the shared error objects from
// session_mgr.ts; `provider.DebugLogf` maps to src/provider/debug.ts.
import type { Server } from "./server.ts";
import {
  inspectSessionExecution,
  type SessionExecutionSnapshot,
  SessionExecutionUnknown,
} from "../../agentruntime/execution.ts";
import type { Message } from "../../provider/types.ts";
import { debugLogf } from "../../provider/debug.ts";
import type { ResponsesCapabilityReport } from "../../provider/openai/responses_config.ts";
import type { SessionMetadata } from "../../session/projects.ts";
import {
  getSessionMetadata,
  setSessionMetadata as persistSessionMetadata,
} from "../../session/projects.ts";
import {
  listAllDetailed,
  openByIDExact,
  type SessionDetail,
  withMessagesOnly,
} from "../../session/manager.ts";
import {
  listSessionCapabilityEventsWithSeq,
  listSessionMessagesBefore,
  listSessionMessagesLatest,
  listSessionMessagesWithSeq,
  listSessionRunEventsWithSeq,
} from "../../session/session_events.ts";
import { listSessionRuns, type SessionRun } from "../../session/run_store.ts";
import {
  applyStoredCapabilitiesToResponse,
  capabilitiesFromSession,
  defaultSessionCapabilities,
  loadStoredCapabilities,
  resolveSessionMode,
} from "./session_capabilities.ts";
import {
  type ActiveSessionInfo,
  APISession,
  channelLabel,
  cloneContentBlocks,
  ErrSessionNotFound,
  ErrSessionToolResultNotFound,
  ErrSubAgentNotFound,
  sequencedMessagesToEntries,
  sessionCapabilityEventToEntry,
  type SessionMessageEntry,
  sessionMessagesToEntries,
  sessionRunEventToEntry,
  type SessionSubAgentInfo,
  type SessionToolResultDetail,
  toolResultText,
} from "./session_mgr.ts";
import { externalSubAgentHistoryFor } from "./external_subagents.ts";
import { messagesFromPublic } from "../../agent/bridge.ts";
import type {
  CapabilityOverview,
  SessionCapabilities,
  SessionCapabilityEventEntry,
  SessionRunEventEntry,
} from "./types.ts";

import { getSessionDir } from "../../config/settings.ts";
import { getWorkDir } from "./config.ts";

/**
 * listActiveSessions merges the live pool with the persisted session
 * directory. The persisted session_info row is authoritative for the title;
 * live runtime state wins for everything the pool already knows.
 */
export function listActiveSessions(server: Server): ActiveSessionInfo[] {
  const active = server.pool?.listDetails() ?? [];
  if (!server.settings || !server.cfg) {
    return active;
  }
  const dir = getSessionDir(server.settings);
  let details: SessionDetail[];
  try {
    details = listAllDetailed(dir, [withMessagesOnly()]);
  } catch (err) {
    debugLogf("list persisted sessions: %v", err);
    return active;
  }
  const byID = new Map<string, ActiveSessionInfo>();
  for (const item of details) {
    const info: ActiveSessionInfo = {
      id: item.id,
      workDir: item.cwd,
      lastUsed: item.modTime,
      messageCount: item.messageCount,
      preview: item.preview,
      title: item.name,
      channelType: item.channelType,
      channelId: item.channelId,
      channelLabel: channelLabel(item.channelType, item.channelId),
      bound: item.channelType === "wechat" || item.channelType === "feishu",
      parentSessionId: item.parentSession,
      forkBoundarySeq: item.forkBoundarySeq,
      seedLength: item.seedLength,
      forkKind: item.forkKind,
      active: false,
    };
    if (item.channelType === "") {
      info.channelType = "local";
      info.channelLabel = channelLabel(info.channelType, info.channelId ?? "");
    }
    try {
      const metadata = getSessionMetadata(dir, item.id);
      info.projectId = metadata.projectId;
      info.pinned = metadata.pinned;
    } catch {
      // metadata is best-effort, exactly like Go
    }
    byID.set(item.id, info);
  }
  for (const item of active) {
    const persisted = byID.get(item.id);
    if (!persisted || persisted.id === "") {
      try {
        const metadata = getSessionMetadata(dir, item.id);
        item.projectId = metadata.projectId;
        item.pinned = metadata.pinned;
      } catch {
        // best-effort
      }
      byID.set(item.id, item);
      continue;
    }
    const merged: ActiveSessionInfo = { ...item };
    merged.messageCount = persisted.messageCount;
    if (merged.workDir === "") merged.workDir = persisted.workDir;
    if (merged.preview === "") merged.preview = persisted.preview;
    if (persisted.title !== "") {
      // The persisted session_info entry is authoritative: an active runtime
      // can still hold the title from before a user rename.
      merged.title = persisted.title;
    }
    merged.projectId = persisted.projectId;
    merged.pinned = persisted.pinned;
    if (merged.channelType === "") merged.channelType = persisted.channelType;
    if (merged.channelId === "") merged.channelId = persisted.channelId;
    if (merged.channelLabel === "") {
      merged.channelLabel = persisted.channelLabel;
    }
    merged.bound = persisted.bound || merged.bound;
    byID.set(item.id, merged);
  }
  const sessions: ActiveSessionInfo[] = [];
  for (const item of byID.values()) {
    let execution: SessionExecutionSnapshot;
    try {
      execution = inspectSessionExecution(dir, item.id);
    } catch (err) {
      debugLogf("inspect execution for session %q: %v", item.id, err);
      execution = unknownExecutionSnapshot(item.id);
    }
    item.execution = execution;
    item.running = execution.running;
    sessions.push(item);
  }
  sessions.sort((a, b) => {
    if (a.lastUsed.getTime() === b.lastUsed.getTime()) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return b.lastUsed.getTime() - a.lastUsed.getTime();
  });
  return sessions;
}

/** capabilityOverview returns serve-level capability defaults and availability. */
export function capabilityOverview(server: Server): CapabilityOverview {
  const defaults = defaultSessionCapabilities(server, "", false, false);
  const overview: CapabilityOverview = {
    modes: ["plan", "agent", "yolo", "os"],
    features: {
      delegate: { available: true, default: defaults.delegateMode },
      multiAgent: { available: true, default: defaults.multiAgent },
      workflows: { available: true, default: defaults.workflows },
      webSearch: { available: true, default: defaults.webSearch },
      browser: { available: true, default: defaults.browser },
      a2aMaster: { available: true, default: defaults.a2aMaster },
      sandbox: {
        available: true,
        default: server.cfg?.sandbox?.enabled ?? false,
      },
    },
    defaults,
    attachmentDownload: hasAttachmentResolver(server),
  };
  const report = responsesCapabilityReport(server);
  if (report) {
    overview.responses = {
      modelId: report.modelId,
      provider: report.provider,
      api: report.api,
      supportsResponses: report.supportsResponses,
      supportsPreviousResponseId: report.supportsPreviousResponse,
      supportsConversation: report.supportsConversation,
      supportsBackground: report.supportsBackground,
      supportsStructuredOutput: report.supportsStructuredOutput,
      supportsServiceTier: report.supportsServiceTier,
      supportsParallelToolCalls: report.supportsParallelTools,
      supportsToolChoice: report.supportsToolChoice,
      supportsAttachmentDownload: report.supportsAttachmentDownload,
      hostedTools: report.hostedTools,
      hostedPolicies: report.hostedPolicies,
      supportedInclude: report.supportedInclude,
      supportedEvents: report.supportedEvents,
      supportedItems: report.supportedItems,
      attachmentKinds: report.attachmentKinds,
      supportedAnnotations: report.supportedAnnotations,
    };
  }
  return overview;
}

/** getSessionCapabilities returns runtime capabilities for an active or persisted session. */
export function getSessionCapabilities(
  server: Server,
  id: string,
): SessionCapabilities {
  if (id === "") throw ErrSessionNotFound;
  if (server.pool) {
    const sess = server.pool.getExact(id);
    if (sess) {
      return capabilitiesFromSession(server, sess, true, !!sess.manager);
    }
  }
  if (!server.settings) throw ErrSessionNotFound;
  let mgr;
  try {
    mgr = openByIDExact(getSessionDir(server.settings), id);
  } catch {
    throw ErrSessionNotFound;
  }
  let workDir = "";
  const header = mgr.getHeader();
  if (header) workDir = header.cwd;
  const caps = defaultSessionCapabilities(server, workDir, false, true);
  caps.id = id;
  const { caps: stored, ok } = loadStoredCapabilities(server, id);
  if (ok && stored) {
    applyStoredCapabilitiesToResponse(caps, stored);
  }
  const probe = new APISession();
  probe.id = id;
  probe.manager = mgr;
  probe.mode = caps.mode;
  const { mode, err } = resolveSessionMode(server, probe, "");
  if (err) throw err;
  caps.mode = mode;
  return caps;
}

/** getSessionMessages returns the message history for a persisted session. */
export function getSessionMessages(
  server: Server,
  id: string,
): SessionMessageEntry[] {
  if (!server.pool) return [];
  if (server.settings && id !== "") {
    const { found } = server.findSessionWorkDir(id);
    if (found) {
      const messages = listSessionMessagesWithSeq(
        getSessionDir(server.settings),
        id,
      );
      return sequencedMessagesToEntries(messages);
    }
  }
  const messages = sessionMessages(server, id);
  return sessionMessagesToEntries(messages);
}

/**
 * getSessionMessagesLatest returns the latest N messages for a session,
 * converted to WebUI entries. hasMore reports whether older messages may remain.
 */
export function getSessionMessagesLatest(
  server: Server,
  id: string,
  limit: number,
): { entries: SessionMessageEntry[]; hasMore: boolean } {
  if (!server.pool) return { entries: [], hasMore: false };
  if (limit <= 0 || limit > 500) limit = 50;
  if (server.settings && id !== "") {
    const { found } = server.findSessionWorkDir(id);
    if (found) {
      const messages = listSessionMessagesLatest(
        getSessionDir(server.settings),
        id,
        limit,
      );
      return {
        entries: sequencedMessagesToEntries(messages),
        hasMore: messages.length >= limit,
      };
    }
  }
  const messages = sessionMessages(server, id);
  return {
    entries: sessionMessagesToEntries(messages),
    hasMore: false,
  };
}

/**
 * getSessionMessagesBefore returns up to N messages with seq < beforeSeq,
 * converted to WebUI entries. In-memory sessions have no seq cursors; nothing
 * older to page.
 */
export function getSessionMessagesBefore(
  server: Server,
  id: string,
  beforeSeq: number,
  limit: number,
): { entries: SessionMessageEntry[]; hasMore: boolean } {
  if (!server.pool) return { entries: [], hasMore: false };
  if (limit <= 0 || limit > 500) limit = 50;
  if (server.settings && id !== "") {
    const { found } = server.findSessionWorkDir(id);
    if (found) {
      const messages = listSessionMessagesBefore(
        getSessionDir(server.settings),
        id,
        beforeSeq,
        limit,
      );
      return {
        entries: sequencedMessagesToEntries(messages),
        hasMore: messages.length >= limit,
      };
    }
  }
  return { entries: [], hasMore: false };
}

/** getSessionToolResult returns the full persisted result for a tool call.
 * Go returns (nil, nil) when no pool is installed; the port maps that to
 * undefined so callers distinguish "no pool" from the not-found sentinel. */
export function getSessionToolResult(
  server: Server,
  id: string,
  toolCallID: string,
): SessionToolResultDetail | undefined {
  if (!server.pool) {
    return undefined;
  }
  if (toolCallID === "") throw ErrSessionToolResultNotFound;
  const messages = sessionMessages(server, id);
  for (const msg of messages) {
    if (
      msg.systemInjected || msg.role !== "toolResult" ||
      msg.toolCallId !== toolCallID
    ) {
      continue;
    }
    const detail: SessionToolResultDetail = {
      toolCallId: msg.toolCallId ?? "",
      toolName: msg.toolName,
      content: toolResultText(msg),
      isError: msg.isError,
    };
    if (msg.contents && msg.contents.length > 0) {
      detail.contents = cloneContentBlocks(msg.contents);
    }
    return detail;
  }
  throw ErrSessionToolResultNotFound;
}

/**
 * getSessionSubAgents returns sub-agent statuses for an active session.
 * Sessions that exist in the session DB but are not currently loaded have no
 * live sub-agents, so they return an empty list instead of ErrSessionNotFound.
 */
export function getSessionSubAgents(
  server: Server,
  id: string,
): SessionSubAgentInfo[] {
  if (!server || !server.pool) throw ErrSessionNotFound;
  const history = externalSubAgentHistoryFor(server, id);
  const external = history ? history.list() : [];
  const sess = server.pool.getExact(id);
  if (!sess) {
    if (external.length > 0) return external;
    const { found } = server.findSessionWorkDir(id);
    if (found) return external;
    throw ErrSessionNotFound;
  }
  if (!sess.agentMgr) return external;

  const out: SessionSubAgentInfo[] = [];
  for (const st of sess.agentMgr.statuses.values()) {
    if (!st.parentId) continue;
    const info: SessionSubAgentInfo = {
      id: String(st.id),
      parentId: String(st.parentId),
      memberId: st.memberId,
      expertId: st.expertId,
      memberDisplayName: st.memberDisplayName,
      memberEmoji: st.memberEmoji,
      memberRole: st.memberRole,
      status: st.state,
      lastResponse: st.result,
      error: st.error,
      active: false,
      messageCount: 0,
    };
    if (info.status === "") info.status = "unknown";
    if (st.startedAt) info.startedAt = st.startedAt.toISOString();
    if (st.updatedAt) info.updatedAt = st.updatedAt.toISOString();
    const [a, ok] = sess.agentMgr.get(st.id);
    if (ok && a) {
      info.active = true;
      info.messageCount = a.getMessages().length;
    }
    out.push(info);
  }
  const seen = new Set<string>(out.map((info) => info.id));
  for (const info of external) {
    if (!seen.has(info.id)) out.push(info);
  }
  return out;
}

/**
 * getSessionSubAgentMessages returns the in-memory transcript for a sub-agent.
 * Sessions that exist in the session DB but are not currently loaded have no
 * live sub-agent transcripts, so they return an empty list instead of
 * ErrSessionNotFound; the WebUI replays persisted sub-agent messages instead.
 */
export function getSessionSubAgentMessages(
  server: Server,
  id: string,
  agentID: string,
): SessionMessageEntry[] {
  if (!server || !server.pool) throw ErrSessionNotFound;
  const history = externalSubAgentHistoryFor(server, id);
  if (history) {
    const entries = history.transcript(agentID);
    if (entries) return entries;
  }
  const sess = server.pool.getExact(id);
  if (!sess) {
    const { found } = server.findSessionWorkDir(id);
    if (found) return [];
    throw ErrSessionNotFound;
  }
  if (!sess.agentMgr || agentID === "") throw ErrSubAgentNotFound;
  const [a, ok] = sess.agentMgr.get(agentID as never);
  if (!ok || !a) {
    const [, statusOK] = sess.agentMgr.status(agentID as never);
    if (statusOK) return [];
    throw ErrSubAgentNotFound;
  }
  const entries = sessionMessagesToEntries(
    messagesFromPublic(a.getMessages()) ?? [],
  );
  for (let i = 0; i < entries.length; i++) {
    entries[i].agentId = agentID;
    if (!entries[i].id) entries[i].id = `${agentID}:${i}`;
  }
  return entries;
}

/** getSessionRunEvents returns persisted run lifecycle events for a session. */
export function getSessionRunEvents(
  server: Server,
  id: string,
): SessionRunEventEntry[] {
  if (!server.settings || id === "") throw ErrSessionNotFound;
  const { found } = server.findSessionWorkDir(id);
  if (!found) throw ErrSessionNotFound;
  const events = listSessionRunEventsWithSeq(
    getSessionDir(server.settings),
    id,
  );
  return events.map((item) => sessionRunEventToEntry(item.event, item.seq));
}

/** getSessionCapabilityEvents returns persisted capability transitions for a session. */
export function getSessionCapabilityEvents(
  server: Server,
  id: string,
): SessionCapabilityEventEntry[] {
  if (!server.settings || id === "") throw ErrSessionNotFound;
  const { found } = server.findSessionWorkDir(id);
  if (!found) throw ErrSessionNotFound;
  const events = listSessionCapabilityEventsWithSeq(
    getSessionDir(server.settings),
    id,
  );
  return events.map((item) =>
    sessionCapabilityEventToEntry(item.event, item.seq)
  );
}

/** sessionMessages resolves the raw provider transcript for a session. */
export function sessionMessages(server: Server, id: string): Message[] {
  if (id === "") {
    const workDir = server.cfg ? getWorkDir(server.cfg) : "";
    id = server.defaultSessionIDs.get(workDir) ?? "";
  }
  if (id === "") return [];
  if (server.settings) {
    try {
      const mgr = openByIDExact(getSessionDir(server.settings), id);
      return mgr.getMessages();
    } catch {
      // fall through to the pool
    }
  }
  const sess = server.pool?.getExact(id);
  if (!sess || !sess.manager) return [];
  return sess.manager.getMessages();
}

/** listSessionRuns returns the persisted Runs for a session. */
export function listServerSessionRuns(
  server: Server,
  id: string,
  limit: number,
): SessionRun[] {
  if (!server.settings || id === "") throw ErrSessionNotFound;
  const { found } = server.findSessionWorkDir(id);
  if (!found) throw ErrSessionNotFound;
  return listSessionRuns(getSessionDir(server.settings), id, limit);
}

/** setSessionMetadata updates project/pin metadata without touching the title. */
export function setSessionMetadata(
  server: Server,
  id: string,
  metadata: SessionMetadata,
): ActiveSessionInfo {
  if (!server.settings) throw ErrSessionNotFound;
  try {
    openByIDExact(getSessionDir(server.settings), id);
  } catch {
    throw ErrSessionNotFound;
  }
  persistSessionMetadata(getSessionDir(server.settings), id, metadata);
  for (const item of listActiveSessions(server)) {
    if (item.id === id) return item;
  }
  throw ErrSessionNotFound;
}

/** setSessionTitle records a user-provided title without changing project metadata. */
export function setSessionTitle(
  server: Server,
  id: string,
  title: string,
): ActiveSessionInfo {
  if (!server.settings) throw ErrSessionNotFound;
  const mgr = openByIDExact(getSessionDir(server.settings), id);
  mgr.appendSessionTitle(title, "manual");
  for (const item of listActiveSessions(server)) {
    if (item.id === id) return item;
  }
  throw ErrSessionNotFound;
}

/** Builds the zero-value execution snapshot Go leaves behind on inspect failure. */
function unknownExecutionSnapshot(
  sessionId: string,
): SessionExecutionSnapshot {
  return {
    sessionId,
    sessionExists: false,
    state: SessionExecutionUnknown,
    phase: "",
    running: false,
    busy: true,
    canSubmit: false,
    canCancelLocal: false,
    canCancelRemote: false,
    leasePurpose: "",
    leaseEpoch: 0,
    leaseOwnerInstanceId: "",
    leaseOwnerPid: 0,
    leaseTokenIdentity: "",
    linkageState: "",
    recoveryAction: "",
    recoveryAttempt: 0,
    recoveryLastError: "",
    displayOwnerScope: "",
    remoteRunId: "",
    remoteProvider: "",
    remoteState: "",
  };
}

// --- capability-overview provider introspection helpers ---

/**
 * Go asserts provider.AttachmentResolver / AttachmentMetadataResolver
 * interfaces; the TS Provider surface keeps resolvers optional, so the port
 * duck-types the same contract.
 */
function hasAttachmentResolver(server: Server): boolean {
  const p = server.provider as
    | {
      resolveAttachment?: unknown;
      attachmentMetadata?: unknown;
    }
    | undefined;
  if (!p) return false;
  return typeof p.resolveAttachment === "function" ||
    typeof p.attachmentMetadata === "function";
}

/**
 * Go asserts *openaiprovider.Provider with API() == "openai-responses"; the
 * port duck-types the Responses capability report instead of importing the
 * provider module for an instanceof check.
 */
function responsesCapabilityReport(
  server: Server,
): ResponsesCapabilityReport | null {
  const p = server.provider as
    | {
      api?: () => string;
      responsesCapabilityReport?: (
        modelID: string,
      ) => ResponsesCapabilityReport;
    }
    | undefined;
  const model = server.model;
  if (!p || !model) return null;
  if (p.api?.() !== "openai-responses") return null;
  if (typeof p.responsesCapabilityReport !== "function") return null;
  return p.responsesCapabilityReport(model.id);
}
