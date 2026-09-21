// Translated from internal/serve/openaiapi (session_stream.go's hub and SSE
// handler behavior plus the Server-bound publish helpers). The Go tests drive
// these through httptest responses; the port asserts on the SSE frames and
// hub/broker fan-out directly.
import { assert, assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import {
  activeRunIDForSession,
  isSessionRunActive,
  messageTranscriptEvent,
  newSessionStreamHub,
  publishSessionStreamEvent,
  replaySessionStream,
  type SessionSSESink,
  type SessionStreamCursor,
  SessionStreamEventStream,
  streamIntQuery,
  writeSessionSSE,
  writeSessionSSEFailure,
} from "./session_stream.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import { ConversationTurnDAO } from "../../dao/mod.ts";
import { newUserMessage } from "../../provider/types.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { openRootDB } from "../../session/root_db.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-stream-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

Deno.test("session stream hub subscribe/publish/cancel", async () => {
  const hub = newSessionStreamHub();
  const a = hub.subscribe("s1");
  const b = hub.subscribe("s1");
  hub.publish("s1", { name: "transcript", data: { n: 1 } });
  const firstA = await a.events.next();
  const firstB = await b.events.next();
  assert(firstA && !firstA.done);
  assert(firstB && !firstB.done);
  assertEquals(firstA.value.data, { n: 1 });

  a.cancel();
  const closed = await a.events.next();
  assert(closed.done, "cancelled subscription must be closed");

  hub.publish("s1", { name: "done", data: {} });
  const secondB = await b.events.next();
  assert(secondB && !secondB.done);
  assertEquals(secondB.value.name, "done");
  b.cancel();
});

Deno.test("session stream hub empty session ID yields closed stream", async () => {
  const hub = newSessionStreamHub();
  const { events, cancel } = hub.subscribe("");
  const result = await events.next();
  assert(result.done, "expected pre-closed stream");
  cancel();
});

Deno.test("session stream queue drops on overflow like Go's non-blocking send", () => {
  const stream = new SessionStreamEventStream();
  let dropped = 0;
  for (let i = 0; i < 200; i++) {
    if (!stream.push({ name: "e", data: i })) dropped++;
  }
  assert(dropped >= 72, "expected overflow drops beyond the 128 capacity");
  stream.close();
});

Deno.test("streamIntQuery resolves aliases and rejects invalid values", () => {
  const url = new URL("http://x/stream?a=7&afterRunSeq=3");
  assertEquals(streamIntQuery(url, "after_entry_seq", "afterEntrySeq", "a"), 7);
  assertEquals(streamIntQuery(url, "after_run_seq", "afterRunSeq"), 3);
  assertEquals(streamIntQuery(url, "missing"), 0);
  assertEquals(streamIntQuery(new URL("http://x/?n=-1"), "n"), 0);
  assertEquals(streamIntQuery(new URL("http://x/?n=abc"), "n"), 0);
});

Deno.test("writeSessionSSE emits canonical frames and failure classifies errors", () => {
  const frames: string[] = [];
  const sink: SessionSSESink = { enqueue: (f) => frames.push(f) };
  writeSessionSSE(sink, "transcript", { sessionId: "s1" });
  assertEquals(frames[0], 'event: transcript\ndata: {"sessionId":"s1"}\n\n');

  writeSessionSSEFailure(sink, new Error("db locked"), "persistence");
  const payload = frames[1].slice("event: error\ndata: ".length, -2);
  const parsed = JSON.parse(payload);
  assertEquals(parsed.errorInfo.type, "server_error");
  assertEquals(parsed.errorInfo.retryMode, "reconcile");
  assertEquals(parsed.errorInfo.retryable, true);
  assert(parsed.error.length > 0);
});

Deno.test("messageTranscriptEvent wraps a message entry", () => {
  const evt = messageTranscriptEvent({
    seq: 1,
    id: "e1",
    role: "user",
    content: "hello",
  });
  assertEquals(evt.type, "message");
  assertEquals((evt.message as { role: string }).role, "user");
});

Deno.test("publishSessionStreamEvent fans out to broker and legacy hub", async () => {
  const server = new Server();
  const broker = server.getEventBroker();
  const sub = broker.subscribe("s1");
  const hub = server.getStreamHub();
  const legacy = hub.subscribe("s1");

  publishSessionStreamEvent(server, "s1", "tool_status", {
    runId: "run-9",
    n: 1,
  });
  const brokered = await sub.events.next();
  assert(brokered !== undefined);
  assertEquals(brokered.event, "tool_status");
  assertEquals(brokered.runId, "run-9");
  sub.cancel();

  const frame = await legacy.events.next();
  assert(frame && !frame.done);
  assertEquals(frame.value.name, "tool_status");
  legacy.cancel();
});

Deno.test("activeRunIDForSession and isSessionRunActive use the pool fallback", () => {
  const pool = new SessionPool(0, 0);
  const server = new Server({ pool });
  const sess = new APISession();
  sess.id = "s1";
  sess.workDir = "/tmp";
  pool.put(sess);

  assertEquals(activeRunIDForSession(server, "s1"), "");
  assertEquals(activeRunIDForSession(server, "missing"), "");
  assertEquals(isSessionRunActive(server, "s1"), false);
  assertEquals(isSessionRunActive(server, ""), false);

  sess.beginRun("run-42");
  assertEquals(activeRunIDForSession(server, "s1"), "run-42");
  assertEquals(isSessionRunActive(server, "s1"), true);
  sess.markRunTerminalizing("run-42");
  pool.remove("s1");
});

Deno.test("findSessionWorkDir prefers the pool then the persisted header", () => {
  const dir = tempDir();
  try {
    const pool = new SessionPool(0, 0);
    const server = new Server({ pool, settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s1";
    sess.workDir = "/from-pool";
    pool.put(sess);
    assertEquals(server.findSessionWorkDir("s1"), {
      workDir: "/from-pool",
      found: true,
    });

    // Persisted header for a session that is not in the pool.
    createSession({ workDir: "/persisted", sessionDir: dir, id: "s2" });
    assertEquals(server.findSessionWorkDir("s2"), {
      workDir: "/persisted",
      found: true,
    });
    assertEquals(server.findSessionWorkDir("missing"), {
      workDir: "",
      found: false,
    });
    assertEquals(server.findSessionWorkDir(""), { workDir: "", found: false });
    pool.remove("s1");
  } finally {
    closeAll();
  }
});

Deno.test("replaySessionStream writes transcript and run event frames from persistence", () => {
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

    const server = new Server({ settings: settingsFor(dir) });
    const frames: string[] = [];
    const sink: SessionSSESink = { enqueue: (f) => frames.push(f) };
    const cursor: SessionStreamCursor = {
      entrySeq: 0,
      runSeq: 0,
      capabilitySeq: 0,
    };
    const result = replaySessionStream(server, sink, "s1", cursor, true);
    assertEquals(result.err, null);
    assert(result.changed);
    assert(frames.some((f) => f.startsWith("event: transcript\n")));
    assert(frames.some((f) => f.startsWith("event: run_event\n")));
    assertEquals(cursor.runSeq, 1);

    // A second replay from the new cursor yields nothing further.
    const again = replaySessionStream(server, sink, "s1", cursor, true);
    assertEquals(again.changed, false);
    assertEquals(again.err, null);
  } finally {
    closeAll();
  }
});
