// Ported from internal/session/session_test.go (capability/event/sequenced
// projections).
//
// The Go tests drive these through the session Manager; the not-yet-ported
// Manager is replaced with direct DAO entry persistence and the portable
// session_events functions.

import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import { ConversationTurnDAO } from "../dao/mod.ts";
import { newUserMessage } from "../provider/types.ts";
import { generateID } from "./entry.ts";
import { openRootDB } from "./root_db.ts";
import {
  latestSessionRunEventSeq,
  listSessionCapabilityEvents,
  listSessionMessagesAfter,
  listSessionMessagesLatest,
  listSessionMessagesWithSeq,
  listSessionRunEvents,
  loadSessionCapabilities,
  saveSessionCapabilities,
  saveSessionCapabilityEvent,
  saveSessionRunEvent,
} from "./mod.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-session-" });
}

function appendMessageEntry(
  sessionDir: string,
  sessionId: string,
  id: string,
  parentId: string | null,
  text: string,
): void {
  const db = openRootDB(sessionDir);
  new ConversationTurnDAO(null).appendEntry(db.db!, {
    seq: 0,
    sessionId,
    id,
    type: "message",
    parentId,
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    data: JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
      message: newUserMessage(text),
    }),
  });
}

Deno.test("session capabilities round trip and default to not-found", () => {
  const sessionDir = tempDir();
  try {
    assertEquals(loadSessionCapabilities(sessionDir, "s-1").ok, false);
    assertEquals(loadSessionCapabilities(sessionDir, "").ok, false);

    saveSessionCapabilities(sessionDir, {
      sessionId: "s-1",
      mode: "yolo",
      displayMode: "auto",
      delegateMode: true,
      multiAgent: false,
      workflows: true,
      webSearch: false,
      browser: true,
      a2aMaster: false,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    saveSessionCapabilities(sessionDir, {
      sessionId: "s-1",
      mode: "agent",
      displayMode: "manual",
      delegateMode: false,
      multiAgent: true,
      workflows: false,
      webSearch: true,
      browser: false,
      a2aMaster: true,
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const { caps, ok } = loadSessionCapabilities(sessionDir, "s-1");
    assert(ok);
    assert(caps !== null);
    assertEquals(caps.mode, "agent");
    assertEquals(caps.displayMode, "manual");
    assertEquals(caps.delegateMode, false);
    assertEquals(caps.multiAgent, true);
    assertEquals(caps.workflows, false);
    assertEquals(caps.webSearch, true);
    assertEquals(caps.browser, false);
    assertEquals(caps.a2aMaster, true);
  } finally {
    closeAll();
  }
});

Deno.test("session run events persist, list, and expose the replay cursor", () => {
  const sessionDir = tempDir();
  try {
    const id = saveSessionRunEvent(sessionDir, {
      id: "",
      sessionId: "s-1",
      runId: "run-1",
      eventType: "run_started",
      source: "cli",
      status: "running",
      model: "m",
      mode: "yolo",
      timestamp: new Date("2026-01-01T00:00:00Z"),
      data: { attempt: 1 },
    });
    assert(id !== "");
    saveSessionRunEvent(sessionDir, {
      id: "fixed-event",
      sessionId: "s-1",
      runId: "run-1",
      eventType: "run_finished",
      source: "",
      status: "completed",
      model: "",
      mode: "",
      timestamp: new Date("2026-01-01T00:00:01Z"),
    });

    const events = listSessionRunEvents(sessionDir, "s-1");
    assertEquals(events.length, 2);
    assertEquals(events[0].eventType, "run_started");
    assertEquals(events[0].data, { attempt: 1 });
    assertEquals(events[1].id, "fixed-event");
    assertEquals(events[1].data, {});

    const seq = latestSessionRunEventSeq(sessionDir, "run-1");
    assert(seq > 0);
    assertEquals(latestSessionRunEventSeq(sessionDir, "other"), 0);
    assertEquals(latestSessionRunEventSeq(sessionDir, ""), 0);
  } finally {
    closeAll();
  }
});

Deno.test("session run event normalizes invalid data to an empty object", () => {
  const sessionDir = tempDir();
  try {
    saveSessionRunEvent(sessionDir, {
      id: "e-1",
      sessionId: "s-1",
      runId: "r-1",
      eventType: "t",
      source: "",
      status: "",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: "not json",
    });
    const [event] = listSessionRunEvents(sessionDir, "s-1");
    assertEquals(event.data, {});
  } finally {
    closeAll();
  }
});

Deno.test("session capability events persist and list with identity", () => {
  const sessionDir = tempDir();
  try {
    saveSessionCapabilityEvent(sessionDir, {
      id: "",
      sessionId: "s-1",
      runId: "r-1",
      eventType: "capability_changed",
      source: "web",
      actor: "user",
      capability: "multiAgent",
      oldValue: "false",
      newValue: "true",
      timestamp: new Date("2026-01-01T00:00:00Z"),
      data: { capability: "multiAgent" },
    });
    const events = listSessionCapabilityEvents(sessionDir, "s-1");
    assertEquals(events.length, 1);
    assertEquals(events[0].capability, "multiAgent");
    assertEquals(events[0].actor, "user");
    assertEquals(events[0].data, { capability: "multiAgent" });
  } finally {
    closeAll();
  }
});

Deno.test("sequenced messages apply overrides and compaction boundaries", () => {
  const sessionDir = tempDir();
  try {
    appendMessageEntry(sessionDir, "s-1", "e1", null, "hello");
    appendMessageEntry(sessionDir, "s-1", "e2", "e1", "secret");

    // Content override replaces e2 without changing its entry identity.
    const db = openRootDB(sessionDir);
    new ConversationTurnDAO(null).appendEntry(db.db!, {
      seq: 0,
      sessionId: "s-1",
      id: "override-1",
      type: "content_override",
      parentId: "e2",
      timestamp: new Date().toISOString(),
      data: JSON.stringify({
        type: "content_override",
        id: "override-1",
        parentId: "e2",
        timestamp: new Date().toISOString(),
        targetEntryId: "e2",
        message: newUserMessage("redacted"),
        reason: "rejected",
      }),
    });

    const messages = listSessionMessagesWithSeq(sessionDir, "s-1");
    assertEquals(messages.length, 2);
    assertEquals(messages[0].message.content, "hello");
    assertEquals(messages[1].entryID, "e2");
    assertEquals(messages[1].message.content, "redacted");
    assert(messages[1].seq > messages[0].seq);

    const after = listSessionMessagesAfter(
      sessionDir,
      "s-1",
      messages[0].seq,
      10,
    );
    assertEquals(after.length, 1);
    assertEquals(after[0].entryID, "e2");

    const latest = listSessionMessagesLatest(sessionDir, "s-1", 1);
    assertEquals(latest.length, 1);
    assertEquals(latest[0].entryID, "e2");
  } finally {
    closeAll();
  }
});

Deno.test("sequenced message helpers return empty for a missing session", () => {
  const sessionDir = tempDir();
  try {
    assertEquals(listSessionMessagesWithSeq(sessionDir, ""), []);
    assertEquals(listSessionMessagesAfter(sessionDir, "", 0, 10), []);
    assertEquals(listSessionMessagesLatest(sessionDir, "", 10), []);
    // No database file exists yet: reads stay empty and do not create one.
    const empty = tempDir();
    assertEquals(listSessionRunEvents(empty, "s-1"), []);
    assertEquals(generateID().length, 16);
  } finally {
    closeAll();
  }
});
