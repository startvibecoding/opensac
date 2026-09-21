// Ported from internal/serve/openaiapi/websocket.go — the durable session/run
// event WebSocket protocol used by WebUI. Disconnecting the socket only
// removes subscriptions; it never cancels a run.
//
// Deviations: Go's golang.org/x/net/websocket handler maps to
// Deno.upgradeWebSocket — `runWebSocketHandler` upgrades the request and the
// protocol loop is driven by socket event handlers instead of a blocking
// receive loop; Go's per-subscription goroutines (the resync watcher and the
// event forwarder) map to async tasks; the write mutex is dropped because
// Deno is single-threaded and `socket.send` is synchronous; Go's
// `findSessionWorkDir` error result has no Deno counterpart, so an
// unresolvable session and a denied one both arrive as `found=false` and
// subscribe without replay exactly like the not-yet-created client sessions.
// Go's forwarder receives the replay cursor but never uses it; the port drops
// the unused parameter.
import { getSessionDir } from "../../config/settings.ts";
import {
  classifyError,
  type ErrorInfo,
  PhasePersistence,
  RetryReconcile,
} from "../../agentruntime/error_info.ts";
import {
  listSessionCapabilityEventsAfter,
  listSessionMessagesAfter,
  listSessionRunEventsAfter,
} from "../../session/session_events.ts";
import {
  ErrSessionNotFound,
  providerMessageToSessionEntries,
  sessionCapabilityEventToEntry,
  sessionRunEventToEntry,
} from "./session_mgr.ts";
import { getSessionRuntime } from "./session_runtime_snapshot.ts";
import type { Server } from "./server.ts";
import {
  messageTranscriptEvent,
  type SessionStreamCursor,
} from "./session_stream.ts";

/** runWebSocketSubscription is one client subscription request. */
export interface RunWebSocketSubscription {
  sessionId: string;
  cursor?: SessionStreamCursor;
}

/** runWebSocketMessage is one client-to-server protocol frame. */
export interface RunWebSocketMessage {
  type: string;
  clientId?: string;
  subscriptions?: RunWebSocketSubscription[];
  sessionIds?: string[];
  // Replay fields
  sessionId?: string;
  cursor?: SessionStreamCursor;
}

/** runWebSocketEvent is one server-to-client protocol frame. */
export interface RunWebSocketEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  stream?: string;
  event?: string;
  seq?: number;
  data?: unknown;
}

/** wsWrite sends one JSON frame; false means the socket is no longer usable. */
export type wsWrite = (value: unknown) => boolean;

/**
 * runWebSocketHandler upgrades the HTTP request and serves the durable
 * session/run event protocol (Go's `RunWebSocketHandler` bound at /ws/runs).
 */
export function runWebSocketHandler(
  server: Server,
  request: Request,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);
  runWebSocketLoop(server, socket);
  return response;
}

interface WsSubscription {
  sessionId: string;
  cancel: () => void;
}

/** runWebSocketLoop drives the protocol until the socket closes. */
export function runWebSocketLoop(server: Server, socket: WebSocket): void {
  if (!server || !socket) return;
  const subs = new Map<string, WsSubscription>();
  let closed = false;

  const write: wsWrite = (value) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const cleanup = () => {
    for (const sub of subs.values()) sub.cancel();
    subs.clear();
  };
  const shutdown = () => {
    closed = true;
    cleanup();
  };
  socket.onclose = shutdown;
  socket.onerror = shutdown;
  socket.onmessage = (m) => {
    let msg: RunWebSocketMessage;
    try {
      msg = JSON.parse(
        typeof m.data === "string" ? m.data : "",
      ) as RunWebSocketMessage;
    } catch {
      // Go exits the receive loop on a decode error.
      shutdown();
      try {
        socket.close();
      } catch {
        // already closing
      }
      return;
    }
    switch (msg.type) {
      case "hello":
        write({ type: "ready", protocol: 1, clientId: msg.clientId });
        break;
      case "subscribe": {
        for (const item of msg.subscriptions ?? []) {
          if (!item || item.sessionId === "") continue;
          // Validate session access before subscribing. Sessions created
          // client-side (e.g. the Web UI) do not exist yet — subscribe
          // without replay so events flow once the session is created.
          const { found } = server.findSessionWorkDir(item.sessionId);
          const old = subs.get(item.sessionId);
          if (old) old.cancel();
          // Subscribe first, then capture the boundary immediately so events
          // published during replay are retained by the forwarder.
          const { events, resync, cancel } = server.getEventBroker()
            .subscribeWithResync(item.sessionId);
          subs.set(item.sessionId, { sessionId: item.sessionId, cancel });
          // A broker overflow means this connection missed live state. Close
          // the socket so the client reconnects and replays durable SQLite
          // cursors. Normal unsubscribe never closes resync.
          void resync.then(() => {
            if (closed) return;
            shutdown();
            try {
              socket.close();
            } catch {
              // already closing
            }
          });
          // Capture the broker boundary before replay. Events published after
          // this point must remain in the live stream even if they arrive
          // while the SQLite replay is still being written to the socket.
          const replayBoundary = server.getEventBroker().currentSeq(
            item.sessionId,
          );
          const cursor: SessionStreamCursor = {
            entrySeq: item.cursor?.entrySeq ?? 0,
            runSeq: item.cursor?.runSeq ?? 0,
            capabilitySeq: item.cursor?.capabilitySeq ?? 0,
          };
          if (found) {
            try {
              writeRunWebSocketReplay(server, write, item.sessionId, cursor);
            } catch (err) {
              cancel();
              subs.delete(item.sessionId);
              write({
                type: "error",
                sessionId: item.sessionId,
                data: websocketReplayError(err),
              });
              continue;
            }
            // Approval and question requests are held in the live session
            // runtime, while the replay above only contains durable transcript
            // and run events. Send a post-replay snapshot so a request that
            // was emitted before this subscription (especially a
            // newly-created WebUI session) cannot leave the client waiting
            // forever with no prompt.
            writeRunWebSocketRuntimeSnapshot(server, write, item.sessionId);
          }
          void forwardRunWebSocketEvents(
            write,
            events,
            replayBoundary,
          );
          write({ type: "subscribed", sessionId: item.sessionId });
        }
        break;
      }
      case "unsubscribe":
        for (const id of msg.sessionIds ?? []) {
          const sub = subs.get(id);
          if (sub) {
            sub.cancel();
            subs.delete(id);
          }
        }
        break;
      case "replay":
        if (msg.sessionId) {
          const cursor: SessionStreamCursor = {
            entrySeq: msg.cursor?.entrySeq ?? 0,
            runSeq: msg.cursor?.runSeq ?? 0,
            capabilitySeq: msg.cursor?.capabilitySeq ?? 0,
          };
          try {
            writeRunWebSocketReplay(server, write, msg.sessionId, cursor);
          } catch (err) {
            write({
              type: "error",
              sessionId: msg.sessionId,
              data: websocketReplayError(err),
            });
            break;
          }
          writeRunWebSocketRuntimeSnapshot(server, write, msg.sessionId);
        }
        break;
      default:
        write({ type: "error", error: "unknown websocket message type" });
        break;
    }
  };
}

/**
 * writeRunWebSocketRuntimeSnapshot projects the current in-memory runtime
 * after durable replay. Decision requests are intentionally runtime-owned and
 * therefore are not reconstructed by the transcript/run event cursor alone.
 * Snapshot failures are best-effort: the live broker remains authoritative.
 */
export function writeRunWebSocketRuntimeSnapshot(
  server: Server,
  write: wsWrite,
  sessionId: string,
): void {
  if (!server || !write || sessionId === "") return;
  const { snapshot } = getSessionRuntime(server, sessionId);
  if (!snapshot) return;
  write({
    type: "session_event",
    sessionId,
    runId: snapshot.activeRun?.runId ?? "",
    stream: "runtime",
    event: "runtime_event",
    data: snapshot,
  });
}

/** websocketReplayError classifies a replay failure as a reconcile-able
 * persistence error. */
export function websocketReplayError(err: unknown): ErrorInfo {
  const info = classifyError(err, {
    phase: PhasePersistence,
    type: "server_error",
    messageKey: "run.error.persistence",
  });
  info.retryMode = RetryReconcile;
  info.retryable = true;
  return info;
}

/**
 * writeRunWebSocketReplay writes the durable transcript, run, and capability
 * event ledgers after the cursor, advancing it in place.
 */
export function writeRunWebSocketReplay(
  server: Server,
  write: wsWrite,
  sessionId: string,
  cursor: SessionStreamCursor,
): void {
  const { found } = server.findSessionWorkDir(sessionId);
  if (!found) throw ErrSessionNotFound;
  if (!server.settings) throw ErrSessionNotFound;
  const sessionDir = getSessionDir(server.settings);
  const send = (value: RunWebSocketEvent): void => {
    if (!write(value)) throw new Error("websocket send failed");
  };
  const messages = listSessionMessagesAfter(
    sessionDir,
    sessionId,
    cursor.entrySeq,
    200,
  );
  for (const item of messages) {
    for (
      const entry of providerMessageToSessionEntries(
        item.message,
        item.seq,
        item.entryID,
      )
    ) {
      send({
        type: "session_event",
        sessionId,
        stream: "transcript",
        event: "transcript",
        seq: item.seq,
        data: messageTranscriptEvent(entry),
      });
    }
    if (item.seq > cursor.entrySeq) cursor.entrySeq = item.seq;
  }
  const runEvents = listSessionRunEventsAfter(
    sessionDir,
    sessionId,
    cursor.runSeq,
    200,
  );
  for (const item of runEvents) {
    send({
      type: "session_event",
      sessionId,
      runId: item.event.runId,
      stream: "run",
      event: item.event.eventType,
      seq: item.seq,
      data: sessionRunEventToEntry(item.event, item.seq),
    });
    cursor.runSeq = item.seq;
  }
  const capEvents = listSessionCapabilityEventsAfter(
    sessionDir,
    sessionId,
    cursor.capabilitySeq,
    200,
  );
  for (const item of capEvents) {
    send({
      type: "session_event",
      sessionId,
      runId: item.event.runId,
      stream: "capability",
      event: item.event.eventType,
      seq: item.seq,
      data: sessionCapabilityEventToEntry(item.event, item.seq),
    });
    cursor.capabilitySeq = item.seq;
  }
}

/**
 * forwardRunWebSocketEvents forwards live broker events until the
 * subscription closes or the socket fails. Events at or below the
 * pre-subscription broker boundary were already covered by the SQLite replay
 * and are skipped.
 */
async function forwardRunWebSocketEvents(
  write: wsWrite,
  events: AsyncIterable<
    {
      sessionId: string;
      runId?: string;
      stream: string;
      event: string;
      seq: number;
      data?: unknown;
    }
  >,
  replayBoundary: number,
): Promise<void> {
  for await (const ev of events) {
    if (replayBoundary > 0 && ev.seq <= replayBoundary) continue;
    if (
      !write({
        type: "session_event",
        sessionId: ev.sessionId,
        runId: ev.runId,
        stream: ev.stream,
        event: ev.event,
        seq: ev.seq,
        data: ev.data,
      })
    ) {
      return;
    }
  }
}
