// (in-memory Store).
//
// The Go tree has no dedicated MemoryStore test; these cases exercise the
// interface contract the agent and TUI layers rely on.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { newAssistantMessage, newUserMessage } from "../provider/types.ts";
import { MemoryStore } from "./store.ts";
import { currentVersion } from "./store.ts";
import { entrySession } from "./entry.ts";

Deno.test("MemoryStore init generates a header at the current version", () => {
  const store = new MemoryStore();
  store.init();
  const header = store.getHeader();
  assert(header !== null);
  assertEquals(header.type, entrySession);
  assertEquals(header.version, currentVersion);
  assertNotEquals(header.id, "");
  assertEquals(store.getLeafID(), null);
});

Deno.test("MemoryStore initWithID keeps or generates the id", () => {
  const store = new MemoryStore();
  store.initWithID("fixed-id");
  assertEquals(store.getHeader()!.id, "fixed-id");
  store.initWithID("");
  assertNotEquals(store.getHeader()!.id, "");
});

Deno.test("MemoryStore appends build a linked replay branch", () => {
  const store = new MemoryStore();
  store.initWithID("s-1");
  const first = store.appendMessage(newUserMessage("hello"));
  assertEquals(store.getLeafID(), first);
  const second = store.appendMessage(
    newAssistantMessage([{ type: "text", text: "hi" }]),
  );
  assertEquals(store.getLeafID(), second);
  const state = store.getReplayState();
  assertEquals(state.messages.length, 2);
  assertEquals(state.messages[0].content, "hello");
  assertEquals(state.messages[1].contents![0].text, "hi");
  assertEquals(state.entryIDs, [first, second]);
});

Deno.test("MemoryStore replays a compaction summary", () => {
  const store = new MemoryStore();
  store.initWithID("s-1");
  store.appendMessage(newUserMessage("dropped"));
  const kept = store.appendMessage(newUserMessage("kept"));
  store.appendCompaction("summary", kept, 100);
  const state = store.getReplayState();
  assertEquals(state.messages.length, 2);
  assertEquals(state.messages[0].content, "summary");
  assert(state.messages[0].systemInjected === true);
  assertEquals(state.messages[1].content, "kept");
  const [compaction, ok] = store.getLatestCompaction();
  assert(ok);
  assertEquals(compaction.summary, "summary");
  assertEquals(compaction.firstKeptEntryId, kept);
});

Deno.test("MemoryStore latest bindings track the newest change", () => {
  const store = new MemoryStore();
  store.initWithID("s-1");
  store.appendModelChange("anthropic", "m1");
  store.appendModelChange("openai", "m2");
  store.appendModeChange("agent");
  store.appendModeChange("yolo");
  store.appendThinkingLevelChange("low");
  store.appendThinkingLevelChange("high");
  store.appendAdditionalDirectories(["/a"]);
  store.appendAdditionalDirectories(["/a", "/b"]);

  const [model, modelOk] = store.getLatestModelChange();
  assert(modelOk);
  assertEquals(model.modelId, "m2");
  const [mode, modeOk] = store.getLatestModeChange();
  assert(modeOk);
  assertEquals(mode.mode, "yolo");
  const [thinking, thinkingOk] = store.getLatestThinkingLevelChange();
  assert(thinkingOk);
  assertEquals(thinking.thinkingLevel, "high");
  const [dirs, dirsOk] = store.getLatestAdditionalDirectories();
  assert(dirsOk);
  assertEquals(dirs.directories, ["/a", "/b"]);

  // The returned directory list must not alias stored state.
  dirs.directories.push("/c");
  const [again] = store.getLatestAdditionalDirectories();
  assertEquals(again.directories, ["/a", "/b"]);
});

Deno.test("MemoryStore reports no latest binding on an empty session", () => {
  const store = new MemoryStore();
  store.init();
  assertEquals(store.getLatestCompaction()[1], false);
  assertEquals(store.getLatestModelChange()[1], false);
  assertEquals(store.getLatestModeChange()[1], false);
  assertEquals(store.getLatestThinkingLevelChange()[1], false);
  assertEquals(store.getLatestAdditionalDirectories()[1], false);
  assertEquals(store.getFile(), "");
});
