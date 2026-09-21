// Ported from internal/serve/openaiapi/runtime_run_events.go — the live
// projection sink the Server installs on a session's ExecutionRuntime after a
// persistence-only write. Persistence remains Runtime-owned while publication
// remains an adapter concern.
import type {
  RunEvent,
  RunEventProjector,
} from "../../agentruntime/run_event.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { getSessionDir } from "../../config/settings.ts";
import type { Server } from "./server.ts";
import type { APISession } from "./session_mgr.ts";
import { sessionRunEventToEntry } from "./session_mgr.ts";
import { publishSessionStreamEvent } from "./session_stream.ts";

/**
 * runtimeRunEventSink persists canonical events and mirrors them to WebUI
 * projections. Go returns the sink struct by value; the port returns an
 * object implementing both the durable `record` hook and the optional
 * `project` fan-out the ExecutionRuntime uses after atomic admission.
 */
export function runtimeRunEventSink(
  server: Server,
  sess: APISession,
): { record(event: RunEvent): string } & RunEventProjector {
  return {
    record(ev: RunEvent): string {
      if (!server.settings || !sess) return "";
      const id = new SessionRunEventSink(getSessionDir(server.settings)).record(
        ev,
      );
      const entry = sessionRunEventToEntry(
        {
          id,
          sessionId: ev.sessionId,
          runId: ev.runId,
          eventType: ev.eventType,
          source: ev.source,
          status: ev.status,
          model: ev.model,
          mode: ev.mode,
          timestamp: ev.timestamp ?? new Date(),
          data: ev.data,
        },
        0,
      );
      publishSessionStreamEvent(server, sess.id, "run_event", entry);
      server.getEventBroker().publishRunEvent(sess.id, ev.runId, entry);
      return id;
    },
    // Project fans out an event that was already committed as part of an
    // atomic intent admission. It deliberately does not touch SQLite a
    // second time.
    project(ev: RunEvent, id: string): void {
      if (!server.settings || !sess) return;
      const entry = sessionRunEventToEntry(
        {
          id,
          sessionId: ev.sessionId,
          runId: ev.runId,
          eventType: ev.eventType,
          source: ev.source,
          status: ev.status,
          model: ev.model,
          mode: ev.mode,
          timestamp: ev.timestamp ?? new Date(),
          data: ev.data,
        },
        0,
      );
      publishSessionStreamEvent(server, sess.id, "run_event", entry);
      server.getEventBroker().publishRunEvent(sess.id, ev.runId, entry);
    },
  };
}
