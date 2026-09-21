// Ported from internal/serve/openaiapi/external_subagents.go — the channel-
// owned sub-agent history sink and its live-broker publication. Channel
// dispatchers own their AgentManager, so their child transcripts cannot be
// read from an APISession's AgentMgr. Keeping this small WebUI projection in
// the serve runtime makes those live transcripts available through the same
// sub-agent endpoints as API-owned sessions.
//
// Deviations: Go's sync.RWMutex is dropped because Deno is single-threaded;
// time.RFC3339Nano maps to Date.toISOString; Go's nil-receiver guards become
// falsy checks; Go's zero-value struct lookup (`h.agents[id]` with
// `info.ID == ""`) maps to a Map miss.
import {
  type Event,
  EventDone,
  EventError,
  EventRunFinished,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  type TaskStatus,
  TaskSuccess,
} from "../../agent/events.ts";
import {
  assistantDeltaTranscriptEvent,
  resolveToolEvent,
  safeAgentErrorMessage,
  subAgentStatusForTaskStatus,
  subAgentStatusTranscriptEvent,
  toolStatusSummary,
  transcriptToolCallEntry,
  transcriptToolResultEntry,
} from "./chat_support.ts";
import { BrokerEventStream, EventBroker } from "./event_broker.ts";
import { activeRunIDForSession, publishToolEvent } from "./session_stream.ts";
import { Server } from "./server.ts";
import {
  type SessionMessageEntry,
  SessionPool,
  type SessionSubAgentInfo,
} from "./session_mgr.ts";

/** externalSubAgentUpdate reports what one child event changed. */
export interface ExternalSubAgentUpdate {
  changed: boolean;
  recoveredText: string;
}

/**
 * ExternalSubAgentHistory retains channel-owned sub-agent activity: the
 * per-child status projection plus the in-memory transcript entries.
 */
export class ExternalSubAgentHistory {
  agents = new Map<string, SessionSubAgentInfo>();
  messages = new Map<string, SessionMessageEntry[]>();

  update(sessionId: string, ev: Event): ExternalSubAgentUpdate {
    if (!sessionId || !ev.agentId) {
      return { changed: false, recoveredText: "" };
    }
    const id = ev.agentId;
    const now = new Date().toISOString();

    let info = this.agents.get(id);
    if (!info) {
      info = {
        id,
        status: "running",
        active: true,
        messageCount: 0,
        startedAt: now,
      };
    } else if (
      !info.active &&
      (info.status === "done" || info.status === "incomplete" ||
        info.status === "error" || info.status === "canceled")
    ) {
      // Terminal state is sticky: the manager status listener and the parent
      // event stream can both deliver the same terminal event.
      return { changed: false, recoveredText: "" };
    }
    info.updatedAt = now;
    mergeSubAgentMemberMetadata(info, ev);
    let entries = this.messages.get(id) ?? [];
    const update: ExternalSubAgentUpdate = { changed: true, recoveredText: "" };

    switch (ev.type) {
      case EventTextDelta:
        if (ev.textDelta) {
          const n = entries.length;
          if (n > 0 && entries[n - 1].role === "assistant") {
            entries[n - 1].content = (entries[n - 1].content ?? "") +
              ev.textDelta;
          } else {
            entries.push({
              id: `${id}:assistant:${n}`,
              role: "assistant",
              agentId: id,
              content: ev.textDelta,
            });
          }
        }
        break;
      case EventToolCall: {
        const { name, callID } = resolveToolEvent(ev);
        entries.push(transcriptToolCallEntry(name, callID, ev));
        break;
      }
      case EventToolExecutionEnd: {
        const status = ev.toolError ? "failed" : "completed";
        entries.push(transcriptToolResultEntry(ev.toolName ?? "", ev, status));
        break;
      }
      case EventRunFinished: {
        const reconciled = reconcileExternalAssistantResult(
          entries,
          id,
          ev.statusMessage ?? "",
        );
        entries = reconciled.entries;
        update.recoveredText = reconciled.recoveredText;
        switch (ev.status) {
          case TaskFailed:
            info.status = "error";
            info.error = safeAgentErrorMessage(ev.error);
            break;
          case TaskIncomplete:
            info.status = "incomplete";
            info.error = safeAgentErrorMessage(ev.error);
            break;
          case TaskCanceled:
            info.status = "canceled";
            info.error = safeAgentErrorMessage(ev.error);
            break;
          default:
            info.status = "done";
            break;
        }
        info.active = false;
        info.lastResponse = lastExternalAssistantResponse(entries);
        entries.push(
          externalSubAgentStatusEntry(id, info.status, info.error ?? ""),
        );
        break;
      }
      case EventDone:
        info.status = "done";
        info.active = false;
        info.lastResponse = lastExternalAssistantResponse(entries);
        entries.push(externalSubAgentStatusEntry(id, "done", ""));
        break;
      case EventError:
        info.status = "error";
        info.active = false;
        info.error = safeAgentErrorMessage(ev.error);
        entries.push(externalSubAgentStatusEntry(id, "error", info.error));
        break;
    }

    for (const entry of entries) {
      entry.agentId = id;
    }
    info.messageCount = entries.length;
    this.agents.set(id, info);
    this.messages.set(id, entries);
    return update;
  }

  /** list projects every retained child status. */
  list(): SessionSubAgentInfo[] {
    return [...this.agents.values()];
  }

  /** transcript copies one child's retained entries, or undefined. */
  transcript(agentID: string): SessionMessageEntry[] | undefined {
    if (agentID === "") return undefined;
    const entries = this.messages.get(agentID);
    if (!entries) return undefined;
    return entries.map((entry) => ({ ...entry }));
  }
}

/**
 * mergeSubAgentMemberMetadata copies the immutable child-event identity only
 * when it is present. Generic sub-agents and ESM workers intentionally keep
 * these fields empty; the serve projection never attempts to infer a persona
 * from a mutable expert bundle.
 */
export function mergeSubAgentMemberMetadata(
  info: SessionSubAgentInfo,
  ev: Event,
): void {
  if (!info || !ev.memberId) return;
  info.memberId = ev.memberId;
  info.expertId = ev.expertId;
  info.memberDisplayName = ev.memberDisplayName;
  info.memberEmoji = ev.memberEmoji;
  info.memberRole = ev.memberRole;
}

/**
 * reconcileExternalAssistantResult folds a terminal status message into the
 * retained assistant entries and reports the suffix that still needs a live
 * delta so clients missing the tail catch up.
 */
export function reconcileExternalAssistantResult(
  entries: SessionMessageEntry[],
  agentID: string,
  result: string,
): { entries: SessionMessageEntry[]; recoveredText: string } {
  if (result === "") return { entries, recoveredText: "" };
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role !== "assistant") continue;
    const existing = entries[i].content ?? "";
    if (existing === result || existing.startsWith(result)) {
      return { entries, recoveredText: "" };
    }
    entries[i].content = result;
    if (result.startsWith(existing)) {
      return { entries, recoveredText: result.slice(existing.length) };
    }
    return { entries, recoveredText: result };
  }
  const next: SessionMessageEntry[] = [...entries, {
    id: `${agentID}:assistant:${entries.length}`,
    role: "assistant",
    agentId: agentID,
    content: result,
  }];
  return { entries: next, recoveredText: result };
}

/** externalSubAgentStatusEntry builds the terminal status transcript entry. */
export function externalSubAgentStatusEntry(
  agentID: string,
  status: string,
  summary: string,
): SessionMessageEntry {
  return {
    id: `${agentID}:status:${status}:${summary}`,
    role: "status",
    agentId: agentID,
    content: status,
    summary,
    isError: status === "error",
  };
}

/** lastExternalAssistantResponse returns the newest non-empty assistant text. */
export function lastExternalAssistantResponse(
  entries: SessionMessageEntry[],
): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "assistant" && entries[i].content) {
      return entries[i].content ?? "";
    }
  }
  return "";
}

/**
 * externalSubAgentHistoryFor lazily creates the per-session history on the
 * Server (Go's `s.externalSubAgents` map guarded by `externalSubAgentMu`).
 */
export function externalSubAgentHistoryFor(
  server: Server,
  sessionId: string,
): ExternalSubAgentHistory | undefined {
  if (!server || sessionId === "") return undefined;
  if (!server.externalSubAgents) server.externalSubAgents = new Map();
  let history = server.externalSubAgents.get(sessionId);
  if (!history) {
    history = new ExternalSubAgentHistory();
    server.externalSubAgents.set(sessionId, history);
  }
  return history;
}

/**
 * newExternalSubAgentServer creates the minimal serve-owned event/history sink
 * used by external runtimes such as messaging channel dispatchers.
 */
export function newExternalSubAgentServer(): Server {
  const server = new Server();
  server.eventBroker = new EventBroker();
  server.pool = new SessionPool(0, 0);
  return server;
}

/**
 * subscribeSessionEvents subscribes to live broker events for a session.
 */
export function subscribeSessionEvents(
  server: Server,
  sessionId: string,
): { events: BrokerEventStream; cancel: () => void } {
  if (!server) {
    const events = new BrokerEventStream();
    events.close();
    return { events, cancel: () => {} };
  }
  return server.getEventBroker().subscribe(sessionId);
}

/**
 * publishExternalSubAgentEvent records a channel-owned child event into the
 * history sink and republishes it as live transcript/tool broker events.
 */
export function publishExternalSubAgentEvent(
  server: Server,
  sessionId: string,
  ev: Event,
): void {
  if (!server || sessionId === "" || !ev.agentId) return;
  const history = externalSubAgentHistoryFor(server, sessionId);
  if (!history) return;
  const update = history.update(sessionId, ev);
  if (!update.changed) return;

  const runID = activeRunIDForSession(server, sessionId);
  const broker = server.getEventBroker();
  if (update.recoveredText !== "") {
    broker.publishTranscriptEvent(
      sessionId,
      runID,
      assistantDeltaTranscriptEvent(update.recoveredText, ev.agentId, ev),
    );
  }
  switch (ev.type) {
    case EventTextDelta:
      broker.publishTranscriptEvent(
        sessionId,
        runID,
        assistantDeltaTranscriptEvent(ev.textDelta ?? "", ev.agentId, ev),
      );
      break;
    case EventToolCall: {
      const { name, callID } = resolveToolEvent(ev);
      publishToolEvent(server, sessionId, {
        tool: name,
        toolCallId: callID,
        agentId: ev.agentId,
        status: "running",
        args: ev.toolArgs,
      });
      break;
    }
    case EventToolExecutionEnd: {
      const status = ev.toolError ? "failed" : "completed";
      publishToolEvent(server, sessionId, {
        tool: ev.toolName ?? "",
        toolCallId: ev.toolCallId,
        agentId: ev.agentId,
        status,
        args: ev.toolArgs,
        summary: toolStatusSummary(ev.toolResult ?? "", ev.toolError),
        isError: !!ev.toolError,
        hasDetail: !!ev.toolCallId,
      });
      break;
    }
    case EventRunFinished: {
      const summary = ev.status === TaskSuccess
        ? ""
        : safeAgentErrorMessage(ev.error);
      broker.publishTranscriptEvent(
        sessionId,
        runID,
        subAgentStatusTranscriptEvent(
          ev.agentId,
          subAgentStatusForTaskStatus(ev.status ?? ("" as TaskStatus)),
          summary,
          ev,
        ),
      );
      break;
    }
    case EventDone:
      broker.publishTranscriptEvent(
        sessionId,
        runID,
        subAgentStatusTranscriptEvent(ev.agentId, "done", "", ev),
      );
      break;
    case EventError: {
      const summary = safeAgentErrorMessage(ev.error);
      broker.publishTranscriptEvent(
        sessionId,
        runID,
        subAgentStatusTranscriptEvent(ev.agentId, "error", summary, ev),
      );
      break;
    }
  }
}
