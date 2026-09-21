// Translated from internal/serve/openaiapi handler_session_trajectory_test.go,
// adapted to the Server-bound trajectory functions.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import {
  ErrInvalidTrajectoryCursor,
  getSessionTrajectory,
  handleSessionExport,
} from "./handler_session_trajectory.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import { ConversationTurnDAO } from "../../dao/mod.ts";
import { newUserMessage } from "../../provider/types.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { openRootDB } from "../../session/root_db.ts";
import { saveSessionCapabilityEvent } from "../../session/session_events.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-trajectory-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

function appendMessage(
  dir: string,
  sessionId: string,
  message: unknown,
  id: string,
) {
  const db = openRootDB(dir);
  new ConversationTurnDAO(null).appendEntry(db.db!, {
    seq: 0,
    sessionId,
    id,
    type: "message",
    parentId: null,
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    data: JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
      message,
    }),
  });
}

function seedSession(dir: string) {
  createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
  appendMessage(dir, "s1", newUserMessage("hello world"), "e1");
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
  new SessionRunEventSink(dir).record({
    sessionId: "s1",
    runId: "run-1",
    eventType: "approval_request",
    source: "webui",
    status: "waiting_for_approval",
    model: "m",
    mode: "agent",
    timestamp: new Date("2026-01-01T00:00:02Z"),
    data: { apiKey: "supersecret", cwd: "/home/user/project" },
  });
  saveSessionCapabilityEvent(dir, {
    id: "",
    sessionId: "s1",
    runId: "run-1",
    eventType: "capability_changed",
    source: "webui",
    actor: "user",
    capability: "multiAgent",
    oldValue: "false",
    newValue: "true",
    timestamp: new Date("2026-01-01T00:00:03Z"),
    data: {},
  });
  new RunStore(dir).create({
    id: "run-1",
    sessionId: "s1",
    intentId: "intent-1",
    retryOf: "",
    attempt: 1,
    workDir: "/tmp",
    source: "webui",
    model: "m",
    mode: "yolo",
    status: "running",
    startedAt: new Date("2026-01-01T00:00:01Z"),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: { inputTokens: 3 },
    contextUsage: {},
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
  });
}

Deno.test("getSessionTrajectory merges transcript, run, decision, and capability records", () => {
  const dir = tempDir();
  try {
    seedSession(dir);
    const server = new Server({
      pool: new SessionPool(0, 0),
      settings: settingsFor(dir),
    });
    const result = getSessionTrajectory(server, "s1", "", 200);
    assertEquals(result.sessionId, "s1");
    assertEquals(result.hasMore, false);
    // 1 run snapshot + 1 transcript + 2 run events (one becomes a decision) + 1 capability
    assertEquals(result.records.length, 5);
    // The run snapshot stays first (transcript source order 0 vs run 1; the
    // snapshot has no seq but carries the earliest timestamp).
    assert(
      result.records.some((r) =>
        r.kind === "run" && r.snapshot === true && r.runId === "run-1"
      ),
    );
    const decision = result.records.find((r) => r.source === "decision");
    assert(decision);
    assertEquals(decision.kind, "decision");
    assertEquals(decision.status, "pending");
    const capability = result.records.find((r) => r.source === "capability");
    assert(capability);
    assertEquals(capability.summary, "multiAgent");
    assertEquals(capability.preview, "false -> true");
    const transcript = result.records.find((r) => r.source === "transcript");
    assert(transcript);
    assertEquals(transcript.summary, "hello world");
    // Decision events raise the decision high-water mark; the approval event
    // data is redacted in both output and sourceEvent projections.
    assert(result.highWater.decisionSeq > 0);
    assert(result.highWater.runSeq > 0);
    assert(result.highWater.entrySeq > 0);
    assert(result.highWater.capabilitySeq > 0);
    const redacted = JSON.stringify(result.records);
    assert(!redacted.includes("supersecret"));
    assert(redacted.includes("[REDACTED]"));
    assert(!redacted.includes("/home/user/project"));
  } finally {
    closeAll();
  }
});

Deno.test("getSessionTrajectory limits and hasMore pagination", () => {
  const dir = tempDir();
  try {
    seedSession(dir);
    const server = new Server({
      pool: new SessionPool(0, 0),
      settings: settingsFor(dir),
    });
    const result = getSessionTrajectory(server, "s1", "", 2);
    assertEquals(result.records.length, 2);
    assertEquals(result.hasMore, true);
  } finally {
    closeAll();
  }
});

Deno.test("getSessionTrajectory validates cursors and unknown sessions", () => {
  const dir = tempDir();
  try {
    seedSession(dir);
    const server = new Server({
      pool: new SessionPool(0, 0),
      settings: settingsFor(dir),
    });
    // Unknown session.
    assertThrows(() => getSessionTrajectory(server, "missing", "", 200));
    // Garbage cursor.
    const badCursor = assertThrows(() =>
      getSessionTrajectory(server, "s1", "!!!not-base64!!!", 200)
    );
    assertEquals(badCursor, ErrInvalidTrajectoryCursor);
    // A cursor keeps only records older than it (snapshots are always dropped).
    const cursor = btoa(
      JSON.stringify({
        entrySeq: 99,
        runSeq: 99,
        capabilitySeq: 99,
        decisionSeq: 99,
      }),
    ).replace(/=+$/, "");
    const filtered = getSessionTrajectory(server, "s1", cursor, 200);
    assertEquals(filtered.records.length, 4);
    assert(filtered.records.every((r) => r.snapshot !== true));
  } finally {
    closeAll();
  }
});

Deno.test("handleSessionExport streams the NDJSON log", async () => {
  const dir = tempDir();
  try {
    seedSession(dir);
    const server = new Server({
      pool: new SessionPool(0, 0),
      settings: settingsFor(dir),
    });
    const resp = handleSessionExport(
      server,
      new Request("http://x/export?format=log"),
      "s1",
    ) as Response;
    assertEquals(resp.status, 200);
    assertEquals(
      resp.headers.get("content-type"),
      "application/x-ndjson; charset=utf-8",
    );
    assert(
      resp.headers.get("content-disposition")!.includes("mothx-session-s1.log"),
    );
    assertEquals(resp.headers.get("x-mothx-session-count"), "1");
    const text = await resp.text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines[0].type, "manifest");
    assertEquals(lines[0].sessionCount, 1);
    assertEquals(lines[1].type, "session_snapshot");
    assertEquals(lines[1].sessionId, "s1");
    assert(lines.slice(2).every((l) => l.type === "record"));
    assert(!text.includes("supersecret"));

    // HEAD validates without a body.
    const head = handleSessionExport(
      server,
      new Request("http://x/export", { method: "HEAD" }),
      "s1",
    ) as Response;
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");

    // Unsupported format and unknown sessions are rejected.
    assertEquals(
      (handleSessionExport(
        server,
        new Request("http://x/export?format=json"),
        "s1",
      ) as Response).status,
      400,
    );
    const missing = handleSessionExport(
      server,
      new Request("http://x/export"),
      "missing",
    ) as Response;
    assertEquals(missing.status, 404);
  } finally {
    closeAll();
  }
});
