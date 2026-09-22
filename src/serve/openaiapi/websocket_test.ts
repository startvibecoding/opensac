// Translated coverage for internal/serve/openaiapi/websocket.go's replay
// half: the Go file has no dedicated websocket_test.go (the WS surface is
// covered by external_subagents_test.go); this adds a deterministic replay
// assertion for the Deno upgrade path, reusing the persisted-ledger setup of
// session_stream_test.ts.
import { assert, assertEquals } from "@std/assert";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import { ConversationTurnDAO } from "../../dao/mod.ts";
import { newUserMessage } from "../../provider/types.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { openRootDB } from "../../session/root_db.ts";
import { newExternalSubAgentServer } from "./external_subagents.ts";
import { runWebSocketHandler } from "./websocket.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-openaiapi-ws-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket message")),
      5000,
    );
    ws.addEventListener(
      "message",
      (m) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(typeof m.data === "string" ? m.data : "{}"));
        } catch (err) {
          reject(err);
        }
      },
      { once: true },
    );
  });
}

Deno.test("runWebSocket subscribes with durable replay then confirms", async () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    const db = openRootDB(dir);
    new ConversationTurnDAO(null).appendEntry(db.db!, {
      seq: 0,
      sessionId: "s1",
      id: "e1",
      type: "message",
      parentId: null,
      timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
      data: JSON.stringify({
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
        message: newUserMessage("hello"),
      }),
    });
    new SessionRunEventSink(dir).record({
      sessionId: "s1",
      runId: "run-1",
      eventType: "run_started",
      source: "webui",
      status: "running",
      model: "m",
      mode: "yolo",
      timestamp: new Date("2026-01-01T00:00:01Z"),
    });

    const server = newExternalSubAgentServer();
    server.settings = settingsFor(dir);
    const ac = new AbortController();
    const http = Deno.serve(
      { port: 0, signal: ac.signal },
      (req) => runWebSocketHandler(server, req),
    );
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(`ws://localhost:${(http.addr as Deno.NetAddr).port}`);
      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => resolve();
        ws!.onerror = () => reject(new Error("websocket dial failed"));
      });

      ws.send(JSON.stringify({ type: "hello", clientId: "ws-replay-test" }));
      const ready = await nextJson(ws);
      assertEquals(ready["type"], "ready");
      assertEquals(ready["protocol"], 1);

      // Frames from the durable replay arrive before the subscribed ack, and
      // the post-replay runtime snapshot is best-effort (absent here because
      // the sink server has no live session resources).
      const seen: Record<string, unknown>[] = [];
      ws.send(JSON.stringify({
        type: "subscribe",
        subscriptions: [{
          sessionId: "s1",
          cursor: {
            entrySeq: 0,
            runSeq: 0,
            capabilitySeq: 0,
          },
        }],
      }));
      for (;;) {
        const msg = await nextJson(ws);
        seen.push(msg);
        if (msg["type"] === "subscribed") break;
        if (seen.length > 20) throw new Error("no subscribed ack");
      }
      const transcript = seen.find((m) =>
        m["type"] === "session_event" && m["stream"] === "transcript"
      );
      assert(transcript, "expected a replayed transcript frame");
      assertEquals(transcript["sessionId"], "s1");
      assertEquals(transcript["event"], "transcript");
      const data = transcript["data"] as {
        type?: string;
        message?: { content?: string };
      };
      assertEquals(data.type, "message");
      assertEquals(data.message?.content, "hello");

      const runEvent = seen.find((m) =>
        m["type"] === "session_event" && m["stream"] === "run"
      );
      assert(runEvent, "expected a replayed run frame");
      assertEquals(runEvent["runId"], "run-1");
      assertEquals(runEvent["event"], "run_started");

      // Unknown message types answer with the protocol error frame.
      ws.send(JSON.stringify({ type: "bogus" }));
      const errFrame = await nextJson(ws);
      assertEquals(errFrame["type"], "error");
      assertEquals(errFrame["error"], "unknown websocket message type");
    } finally {
      ac.abort();
      await http.finished.catch(() => {});
      ws?.close();
      await server.pool!.stop();
    }
  } finally {
    closeAll();
  }
});
