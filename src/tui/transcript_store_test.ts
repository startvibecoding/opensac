// Focused tests for the transcript store: assistant/think streaming slots
// (including the think-conversion of an empty assistant slot), the tool
// result state machine (dedup, matching, late stragglers, interruption
// finalization), and per-tool summaries.

import { assertEquals } from "../compat/assert.ts";
import {
  formatLineRangesForDisplay,
  summarizeFileDiff,
  summarizeToolResult,
  TranscriptStore,
} from "./transcript_store.ts";
import { type FileDiff } from "../tools/io_helpers.ts";
import { Translator } from "./i18n.ts";
import { test } from "#testing";

const tr = new Translator("en");

function store(): TranscriptStore {
  return new TranscriptStore({ translator: tr });
}

// ─── streaming slots ────────────────────────────────────────────────────────

test("assistant slot opens on first delta and accumulates", () => {
  const s = store();
  s.appendAssistantDelta("Hel");
  s.appendAssistantDelta("lo");
  assertEquals(s.currentAssistantIdx, 0);
  assertEquals(s.messages.length, 1);
  assertEquals(s.assistantRaw(0), "Hello");
  assertEquals(s.isAssistantDirty(0), true);
  s.markAssistantRendered(0);
  assertEquals(s.isAssistantDirty(0), false);
});

test("turn start reserves the slot before deltas", () => {
  const s = store();
  s.beginAssistantSlot();
  assertEquals(s.currentAssistantIdx, 0);
  assertEquals(s.messages, [""]);
  s.appendAssistantDelta("text");
  assertEquals(s.assistantRaw(0), "text");
  assertEquals(s.messages.length, 1); // reused the reserved slot
});

test("commit clears active indices and allows a new slot", () => {
  const s = store();
  s.appendAssistantDelta("first");
  s.commitActiveStream();
  assertEquals(s.currentAssistantIdx, -1);
  s.appendAssistantDelta("second");
  assertEquals(s.currentAssistantIdx, 1);
  assertEquals(s.assistantRaw(1), "second");
  assertEquals(s.assistantRaw(0), "first");
});

test("think deltas convert an untouched assistant slot", () => {
  const s = store();
  s.beginAssistantSlot(); // reserved but empty
  s.appendThinkDelta("thinking...");
  // The empty assistant slot became the think slot; a fresh assistant slot
  // opened after it (Go EVENT_THINK_DELTA handling).
  assertEquals(s.currentThinkIdx, 0);
  assertEquals(s.thinkRaw(0), "thinking...");
  assertEquals(s.currentAssistantIdx, 1);
  assertEquals(s.messages.length, 2);
});

test("think deltas open their own slot after committed assistant", () => {
  const s = store();
  s.appendAssistantDelta("visible text");
  s.commitActiveStream();
  s.appendThinkDelta("hmm");
  assertEquals(s.currentThinkIdx, 1);
  assertEquals(s.thinkRaw(1), "hmm");
});

// ─── tool rows ──────────────────────────────────────────────────────────────

test("tool start opens one running row; duplicate starts dedup", () => {
  const s = store();
  s.appendToolExecutionStart("call-1", "bash", { cmd: "ls" });
  assertEquals(s.toolResults.length, 1);
  assertEquals(s.toolResults[0].status, "running");
  assertEquals(s.toolResults[0].msgIndex, 0);
  assertEquals(s.messages.length, 1);
  // Duplicate start is ignored
  s.appendToolExecutionStart("call-1", "bash", { cmd: "ls" });
  assertEquals(s.toolResults.length, 1);
});

test("tool result terminalizes the running row in place", () => {
  const s = store();
  s.appendToolExecutionStart("call-1", "bash", { cmd: "ls" });
  s.appendToolResult({
    toolCallID: "call-1",
    toolResult: "file\n\n\nsub",
  });
  assertEquals(s.toolResults.length, 1);
  const row = s.toolResults[0];
  assertEquals(row.status, "completed");
  assertEquals(row.fullContent, "file\n\n\nsub");
  assertEquals(row.summary, "file\n\nsub"); // compactBashOutput keeps one blank
  assertEquals(s.messages.length, 1); // no extra row opened
});

test("tool result without a running row opens its own row", () => {
  const s = store();
  s.appendToolResult({
    toolCallID: "call-9",
    toolName: "read",
    toolResult: "a\nb",
  });
  assertEquals(s.toolResults.length, 1);
  assertEquals(s.toolResults[0].status, "completed");
  assertEquals(s.toolResults[0].msgIndex, 0);
  assertEquals(s.toolResults[0].summary, "2 lines");
});

test("completed results dedup and interrupted rows block stragglers", () => {
  const s = store();
  s.appendToolResult({ toolCallID: "c1", toolName: "edit", toolResult: "ok" });
  s.appendToolResult({
    toolCallID: "c1",
    toolName: "edit",
    toolResult: "ok again",
  });
  assertEquals(s.toolResults.length, 1);

  s.appendToolExecutionStart("c2", "bash");
  s.finalizeInterruptedTools();
  assertEquals(s.toolResults[1].status, "interrupted");
  assertEquals(s.toolResults[1].executionState, "interrupted");
  // Late straggler for an interrupted call must not open a row
  s.appendToolResult({
    toolCallID: "c2",
    toolName: "bash",
    toolResult: "late",
  });
  assertEquals(s.toolResults.length, 2);
});

test("finalizeInterruptedTools touches only running rows", () => {
  const s = store();
  s.appendToolResult({
    toolCallID: "done-1",
    toolName: "read",
    toolResult: "x",
  });
  s.appendToolExecutionStart("run-1", "bash");
  s.finalizeInterruptedTools();
  assertEquals(s.toolResults[0].status, "completed");
  assertEquals(s.toolResults[1].status, "interrupted");
});

test("hasToolEntry and msgIndexOf track states", () => {
  const s = store();
  s.appendToolExecutionStart("c1", "bash");
  assertEquals(s.hasToolEntry("c1", "running"), true);
  assertEquals(s.hasToolEntry("c1", "completed"), false);
  assertEquals(s.msgIndexOf("c1"), 0);
  s.appendToolResult({ toolCallID: "c1", toolResult: "out" });
  assertEquals(s.hasToolEntry("c1", "running"), false);
  assertEquals(s.hasToolEntry("c1", "completed"), true);
  assertEquals(s.msgIndexOf("c1"), undefined === s.msgIndexOf("c1") ? 0 : 0);
});

test("resetTranscriptState clears everything", () => {
  const s = store();
  s.appendAssistantDelta("hi");
  s.appendToolExecutionStart("c1", "bash");
  s.resetTranscriptState();
  assertEquals(s.messages, []);
  assertEquals(s.toolResults, []);
  assertEquals(s.currentAssistantIdx, -1);
  assertEquals(s.currentThinkIdx, -1);
});

// ─── summaries ──────────────────────────────────────────────────────────────

const diff: FileDiff = {
  path: "/x/y",
  added: 3,
  deleted: 1,
  addedLines: [1, 2, 3],
  deletedLines: [7],
  unified: "",
  oldText: "",
  newText: "",
  truncated: false,
};

test("summarizeToolResult picks per-tool forms", () => {
  assertEquals(
    summarizeToolResult("bash", "a\n\n\nb", undefined, tr),
    "a\n\nb",
  );
  assertEquals(
    summarizeToolResult("read", "a\nb\nc", undefined, tr),
    "3 lines",
  );
  assertEquals(summarizeToolResult("ls", "x\ny", undefined, tr), "x\ny");
  assertEquals(
    summarizeToolResult("edit", "ignored", diff, tr),
    "+3 -1 (-7 +1-3)",
  );
  assertEquals(
    summarizeToolResult("edit", "ignored", undefined, tr),
    "Applied",
  );
  assertEquals(summarizeToolResult("write", "", diff, tr), "+3 -1 (-7 +1-3)");
  assertEquals(
    summarizeToolResult("search", "x".repeat(60), undefined, tr).length === 50,
    true,
  );
});

test("summarizeFileDiff renders ranges and large suffix", () => {
  assertEquals(summarizeFileDiff(undefined), "");
  assertEquals(summarizeFileDiff(diff), "+3 -1 (-7 +1-3)");
  assertEquals(
    summarizeFileDiff({ ...diff, truncated: true }),
    "+3 -1 large (-7 +1-3)",
  );
  assertEquals(
    summarizeFileDiff({
      ...diff,
      added: 0,
      deleted: 0,
      addedLines: [],
      deletedLines: [],
    }),
    "+0 -0 (-none +none)",
  );
});

test("formatLineRangesForDisplay compresses runs", () => {
  assertEquals(formatLineRangesForDisplay([]), "none");
  assertEquals(formatLineRangesForDisplay([1]), "1");
  assertEquals(formatLineRangesForDisplay([1, 2, 3, 5]), "1-3,5");
  assertEquals(formatLineRangesForDisplay([4, 2]), "4,2"); // order preserved
});
