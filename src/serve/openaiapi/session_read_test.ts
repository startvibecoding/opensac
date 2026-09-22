// Translated from internal/serve/openaiapi/server_test.go's
// ListActiveSessions/capability-overview cases and session_mgr.go's message,
// event, run, title, and metadata read paths, adapted to the Server-bound
// functions in session_read.ts.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Server } from "./server.ts";
import {
  capabilityOverview,
  getSessionCapabilities,
  getSessionCapabilityEvents,
  getSessionMessages,
  getSessionMessagesBefore,
  getSessionMessagesLatest,
  getSessionRunEvents,
  getSessionToolResult,
  listServerSessionRuns,
  sessionMessages,
  setSessionMetadata,
  setSessionTitle,
} from "./session_read.ts";
import { SessionPool } from "./session_mgr.ts";
import type { Config } from "./config.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import { ConversationTurnDAO } from "../../dao/mod.ts";
import {
  newAssistantMessage,
  newToolResultMessage,
  newUserMessage,
} from "../../provider/types.ts";
import type { ContentBlock } from "../../provider/types.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { openRootDB } from "../../session/root_db.ts";
import { saveSessionCapabilityEvent } from "../../session/session_events.ts";
import { getSessionMetadata } from "../../session/projects.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-openaiapi-read-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

/** Go handlers always run with a pool + config installed; the port keeps the
 * nil-pool branches untested. */
function serverFor(dir: string): Server {
  return new Server({
    pool: new SessionPool(0, 0),
    settings: settingsFor(dir),
    cfg: {} as Config,
  });
}

function messageEntry(
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

Deno.test("sessionMessages and message projections read the persisted transcript", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    messageEntry(dir, "s1", newUserMessage("hello"), "e1");
    messageEntry(
      dir,
      "s1",
      newAssistantMessage([
        { type: "text", text: "hi there" } as ContentBlock,
      ]),
      "e2",
    );
    const server = serverFor(dir);
    const messages = sessionMessages(server, "s1");
    assertEquals(messages.length, 2);
    const entries = getSessionMessages(server, "s1");
    assertEquals(entries.length, 2);
    assertEquals(entries[0].role, "user");
    assertEquals(entries[0].content, "hello");
    assertEquals(entries[1].role, "assistant");
    assertEquals(entries[1].content, "hi there");

    const latest = getSessionMessagesLatest(server, "s1", 1);
    assertEquals(latest.entries.length, 1);
    assertEquals(latest.entries[0].content, "hi there");
    // Go's `len(messages) >= limit` reports more pages whenever the window is full.
    assertEquals(latest.hasMore, true);

    // The seeded entries occupy seqs 2 and 3; paging before 3 leaves the user message.
    const before = getSessionMessagesBefore(server, "s1", 3, 50);
    assertEquals(before.entries.length, 1);
    assertEquals(before.entries[0].role, "user");
  } finally {
    closeAll();
  }
});

Deno.test("run and capability events project through the entry mappers", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
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
      timestamp: new Date("2026-01-01T00:00:02Z"),
      data: {},
    });
    const server = serverFor(dir);
    const runEvents = getSessionRunEvents(server, "s1");
    assertEquals(runEvents.length, 1);
    assertEquals(runEvents[0].eventType, "run_started");
    assertEquals(runEvents[0].seq, 1);
    const capEvents = getSessionCapabilityEvents(server, "s1");
    assertEquals(capEvents.length, 1);
    assertEquals(capEvents[0].capability, "multiAgent");
    assertEquals(capEvents[0].oldValue, "false");
    assertEquals(capEvents[0].newValue, "true");

    // Unknown sessions surface the shared sentinel.
    assertThrows(() => getSessionRunEvents(server, "missing"));
    assertThrows(() => getSessionCapabilityEvents(server, "missing"));
  } finally {
    closeAll();
  }
});

Deno.test("listServerSessionRuns returns the durable run rows", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    const store = new RunStore(dir);
    store.create({
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
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: null,
      error: "",
      errorInfo: {},
      progress: {},
      usage: {},
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
    const server = serverFor(dir);
    const runs = listServerSessionRuns(server, "s1", 100);
    assertEquals(runs.length, 1);
    assertEquals(runs[0].id, "run-1");
    assertThrows(() => listServerSessionRuns(server, "missing", 100));
  } finally {
    closeAll();
  }
});

Deno.test("capability overview reports config defaults and feature availability", () => {
  const server = new Server({
    cfg: {
      defaultMode: "",
      enableSubAgents: true,
      sandbox: { enabled: true },
    } as unknown as Config,
  });
  const overview = capabilityOverview(server);
  assertEquals(overview.modes, ["plan", "agent", "yolo", "os"]);
  assertEquals(overview.defaults.mode, "yolo");
  assertEquals(overview.features.multiAgent.default, true);
  assertEquals(overview.features.sandbox.default, true);
  assertEquals(overview.attachmentDownload, false);
  assertEquals(overview.responses, undefined);
});

Deno.test("getSessionCapabilities resolves persisted sessions", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    const server = serverFor(dir);
    const caps = getSessionCapabilities(server, "s1");
    assertEquals(caps.id, "s1");
    assertEquals(caps.workDir, "/tmp");
    assertEquals(caps.active, false);
    assertEquals(caps.persisted, true);
    assertEquals(caps.mode, "yolo");
    assertThrows(() => getSessionCapabilities(server, ""));
    assertThrows(() => getSessionCapabilities(server, "missing"));
  } finally {
    closeAll();
  }
});

Deno.test("setSessionTitle and setSessionMetadata update persisted state", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    // messagesOnly listings only include sessions with at least one message.
    messageEntry(dir, "s1", newUserMessage("hello"), "e1");
    const server = serverFor(dir);
    const info = setSessionTitle(server, "s1", "My Title");
    assertEquals(info.id, "s1");
    assertEquals(info.title, "My Title");

    const pinned = setSessionMetadata(server, "s1", { pinned: true });
    assertEquals(pinned.pinned, true);
    assertEquals(getSessionMetadata(dir, "s1").pinned, true);

    assertThrows(() => setSessionTitle(server, "missing", "x"));
    assertThrows(() => setSessionMetadata(server, "missing", { pinned: true }));
  } finally {
    closeAll();
  }
});

Deno.test("getSessionToolResult matches persisted tool results", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    messageEntry(dir, "s1", newUserMessage("run tool"), "e1");
    messageEntry(
      dir,
      "s1",
      newToolResultMessage("tc1", "bash", "ok", false),
      "e2",
    );
    const server = serverFor(dir);
    const detail = getSessionToolResult(server, "s1", "tc1");
    assert(detail !== undefined);
    assertEquals(detail.toolCallId, "tc1");
    assertEquals(detail.toolName, "bash");
    assertThrows(() => getSessionToolResult(server, "s1", "nope"));
    assertThrows(() => getSessionToolResult(server, "s1", ""));
  } finally {
    closeAll();
  }
});
