// (replay core).
//
// The Go tests drive replay through the session Manager; the not-yet-ported
// Manager is replaced with direct entry slices so the portable replay engine is
// exercised on its own.

import { assert, assertEquals } from "../compat/assert.ts";
import {
  entryCompaction,
  entryContentOverride,
  entryMessage,
  type MessageEntry,
} from "./entry.ts";
import { createCost, createUserMessage } from "../provider/types.ts";
import { type Message } from "../provider/types.ts";
import {
  buildReplayState,
  getEntryMetadata,
  lastSummarizedEntryIDLocked,
  latestCompactionLocked,
} from "./replay.ts";
import { test } from "#testing";

function messageEntry(
  id: string,
  parentId: string | null,
  message: Message,
): MessageEntry {
  return {
    type: entryMessage,
    id,
    parentId,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    message,
  };
}

test("buildReplayState returns messages with entry IDs", () => {
  const entries = [
    messageEntry("e1", null, createUserMessage("hello")),
    messageEntry("e2", "e1", createUserMessage("world")),
  ];
  const state = buildReplayState(entries);
  assertEquals(state.messages.length, 2);
  assertEquals(state.messages[0].content, "hello");
  assertEquals(state.entryIDs, ["e1", "e2"]);
});

test("content override replaces message but preserves the target entry ID", () => {
  const original: Message = {
    role: "toolResult",
    content: "[Image file: /tmp/x.png]",
    toolCallId: "call-1",
    toolName: "read",
    timestamp: new Date(),
    contents: [{
      type: "image",
      image: { data: "AAAA", mimeType: "image/png", width: 4, height: 4 },
    }],
  };
  const replacement: Message = {
    role: "toolResult",
    content: "[Image file: /tmp/x.png]\n\n[image unavailable]",
    toolCallId: "call-1",
    toolName: "read",
    timestamp: new Date(),
  };
  const entries = [
    messageEntry("e1", null, createUserMessage("look")),
    messageEntry("e2", "e1", original),
    {
      type: entryContentOverride,
      id: "override-1",
      parentId: "e2",
      timestamp: new Date(),
      targetEntryId: "e2",
      message: replacement,
      reason: "rejected",
    },
  ];
  const state = buildReplayState(entries);
  assertEquals(state.messages.length, 2);
  assertEquals(state.messages[1].contents, undefined);
  assert(state.messages[1].content!.includes("image unavailable"));
  assertEquals(state.messages[1].toolCallId, "call-1");
  assertEquals(state.messages[1].toolName, "read");
  assertEquals(state.entryIDs, ["e1", "e2"]);
});

test("compaction with empty first-kept entry collapses to the summary", () => {
  const entries = [
    messageEntry("e1", null, createUserMessage("a")),
    messageEntry("e2", "e1", createUserMessage("b")),
    {
      type: entryCompaction,
      id: "c1",
      parentId: "e2",
      timestamp: new Date(),
      summary: "summarized",
      firstKeptEntryId: "",
      tokensBefore: 100,
    },
  ];
  const state = buildReplayState(entries);
  assertEquals(state.messages.length, 1);
  assertEquals(state.messages[0].content, "summarized");
  assert(state.messages[0].systemInjected === true);
  assertEquals(state.entryIDs, [""]);
});

test("compaction keeps the tail after first-kept and drops usage", () => {
  const used = createUserMessage("kept");
  used.usage = {
    input: 5,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 6,
    cost: createCost(),
  };
  const entries = [
    messageEntry("e1", null, createUserMessage("dropped")),
    messageEntry("e2", "e1", used),
    messageEntry("e3", "e2", createUserMessage("tail")),
    {
      type: entryCompaction,
      id: "c1",
      parentId: "e3",
      timestamp: new Date(),
      summary: "summary",
      firstKeptEntryId: "e2",
      tokensBefore: 100,
    },
  ];
  const state = buildReplayState(entries);
  assertEquals(state.messages.length, 3);
  assertEquals(state.messages[0].content, "summary");
  assertEquals(state.messages[1].content, "kept");
  assertEquals(state.messages[1].usage, undefined);
  assertEquals(state.messages[2].content, "tail");
  assertEquals(state.entryIDs, ["", "e2", "e3"]);
});

test("compaction with a missing first-kept entry keeps the full history", () => {
  const entries = [
    messageEntry("e1", null, createUserMessage("a")),
    {
      type: entryCompaction,
      id: "c1",
      parentId: "e1",
      timestamp: new Date(),
      summary: "s",
      firstKeptEntryId: "missing",
      tokensBefore: 1,
    },
  ];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const state = buildReplayState(entries);
    assertEquals(state.messages.length, 1);
    assertEquals(state.messages[0].content, "a");
    assertEquals(state.entryIDs, ["e1"]);
  } finally {
    console.warn = originalWarn;
  }
});

test("replay isolates cloned messages from stored entries", () => {
  const stored = createUserMessage("hello");
  stored.contents = [{ type: "text", text: "hello" }];
  const state = buildReplayState([messageEntry("e1", null, stored)]);
  state.messages[0].contents![0].text = "mutated";
  assertEquals(stored.contents![0].text, "hello");
});

test("latestCompactionLocked returns the newest compaction entry", () => {
  const entries = [
    {
      type: entryCompaction,
      id: "c1",
      parentId: null,
      timestamp: new Date(),
      summary: "first",
      firstKeptEntryId: "",
      tokensBefore: 1,
    },
    messageEntry("e1", null, createUserMessage("x")),
    {
      type: entryCompaction,
      id: "c2",
      parentId: "e1",
      timestamp: new Date(),
      summary: "second",
      firstKeptEntryId: "",
      tokensBefore: 2,
    },
  ];
  const entry = latestCompactionLocked(entries);
  assert(entry !== null);
  assertEquals(entry.id, "c2");
  assertEquals(latestCompactionLocked([]), null);
});

test("lastSummarizedEntryIDLocked resolves the boundary message", () => {
  const entries = [
    messageEntry("e1", null, createUserMessage("a")),
    messageEntry("e2", "e1", createUserMessage("b")),
    messageEntry("e3", "e2", createUserMessage("c")),
  ];
  // The entry immediately before the first kept boundary is the last one a
  // compaction folded into its summary.
  assertEquals(lastSummarizedEntryIDLocked(entries, "e3"), "e2");
  // An empty boundary resolves the newest message entry.
  assertEquals(lastSummarizedEntryIDLocked(entries, ""), "e3");
});

test("getEntryMetadata reads id/type/parent/time from a plain entry", () => {
  const ts = new Date("2026-02-03T04:05:06Z");
  const meta = getEntryMetadata({
    type: "message",
    id: "e1",
    parentId: "p1",
    timestamp: ts,
  });
  assertEquals(meta, {
    id: "e1",
    type: "message",
    parentID: "p1",
    timestamp: ts,
  });
  const missing = getEntryMetadata({});
  assertEquals(missing.id, "");
  assertEquals(missing.type, "");
  assertEquals(missing.parentID, null);
});
