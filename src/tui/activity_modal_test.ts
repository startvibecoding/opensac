// Focused tests for TUI slice 2c: the agent-activity store (event folding),
// its renderers, and the tool-modal state/geometry (scrolling, target
// switching, chrome math, framed rendering).

import { assertEquals } from "@std/assert";
import {
  AgentActivityStore,
  formatActivityAge,
  formatActivityTool,
  renderActivitySummary,
  renderAgentActivity,
  truncatePlain,
} from "./activity.ts";
import {
  EventDone,
  EventError,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolCall,
  EventToolResult,
  TaskCanceled,
  TaskFailed,
} from "../agent/events.ts";
import { Translator } from "./i18n.ts";
import { ToolModalState, type ToolModalTarget } from "./tool_modal.ts";

// ─── activity store ─────────────────────────────────────────────────────────

Deno.test("activity store ignores lead and approval/question events", () => {
  assertEquals(
    AgentActivityStore.isBackgroundAgentEvent({ type: EventTextDelta }),
    false,
  );
  assertEquals(
    AgentActivityStore.isBackgroundAgentEvent({
      type: EventTextDelta,
      agentId: "a1",
    }, "a1"),
    false,
  );
  assertEquals(
    AgentActivityStore.isBackgroundAgentEvent({
      type: EventTextDelta,
      agentId: "a1",
    }, "lead"),
    true,
  );
  assertEquals(
    AgentActivityStore.isBackgroundAgentEvent({
      type: EventToolCall,
      agentId: "a1",
    }),
    true,
  );
});

Deno.test("activity store folds deltas, tools, and terminal states", () => {
  const store = new AgentActivityStore();
  const now = new Date();
  store.record({ type: EventTextDelta, agentId: "a1", textDelta: "Hel" }, now);
  store.record({ type: EventTextDelta, agentId: "a1", textDelta: "lo" }, now);
  store.record(
    { type: EventThinkDelta, agentId: "a1", thinkDelta: "hmm" },
    now,
  );
  store.record(
    {
      type: EventToolCall,
      agentId: "a1",
      toolName: "read_file",
      toolArgs: { path: "/x" },
    },
    now,
  );
  store.record({
    type: EventToolResult,
    agentId: "a1",
    toolName: "read_file",
    toolResult: " contents ",
  }, now);
  store.record({
    type: EventRunFinished,
    agentId: "a1",
    status: TaskFailed,
    error: new Error("boom"),
  }, now);

  const act = store.get("a1")!;
  assertEquals(act.state, "error");
  assertEquals(act.fullText, "Hello");
  assertEquals(act.lastToolName, "read_file");
  // Go semantics: the terminal failure message overrides the tool result
  assertEquals(act.lastResult, "boom");
  assertEquals(act.fullResult, "boom");
  // Timeline: tool started, tool result, error
  assertEquals(act.events.length, 3);
  assertEquals(store.order, ["a1"]);
});

Deno.test("activity store keeps terminal state on late events", () => {
  const store = new AgentActivityStore();
  store.record({ type: EventDone, agentId: "a1" });
  assertEquals(store.get("a1")!.state, "done");
  // A late error must not flip a terminal state
  store.record({ type: EventError, agentId: "a1", error: new Error("late") });
  assertEquals(store.get("a1")!.state, "done");
});

Deno.test("activity store records workflow kind and cancellation", () => {
  const store = new AgentActivityStore();
  store.record({
    type: EventRunFinished,
    agentId: "workflow:build",
    status: TaskCanceled,
  });
  const act = store.get("workflow:build")!;
  assertEquals(act.kind, "workflow");
  assertEquals(act.state, "canceled");
});

Deno.test("activity store caps the event timeline", () => {
  const store = new AgentActivityStore();
  for (let i = 0; i < 250; i++) {
    store.record({ type: EventStatus, agentId: "a1", statusMessage: `s${i}` });
  }
  const act = store.get("a1")!;
  assertEquals(act.events.length, 200);
  assertEquals(act.events[act.events.length - 1].text, "s249");
});

// ─── activity rendering ─────────────────────────────────────────────────────

Deno.test("renderAgentActivity shows header, sections, and timeline", () => {
  const store = new AgentActivityStore();
  const now = new Date("2026-09-20T12:00:30");
  store.record(
    { type: EventTextDelta, agentId: "a1", textDelta: "answer" },
    new Date("2026-09-20T12:00:00"),
  );
  store.record(
    {
      type: EventToolCall,
      agentId: "a1",
      toolName: "bash",
      toolArgs: { cmd: "ls" },
    },
    now,
  );
  const tr = new Translator("en");
  const panel = renderAgentActivity(store.get("a1"), "a1", tr, now);
  const lines = panel.split("\n");
  assertEquals(lines[0].startsWith("a1 (subagent) [running] updated "), true);
  assertEquals(panel.includes("Latest tool:"), true);
  assertEquals(panel.includes("Response:"), true);
  assertEquals(panel.includes("Activity timeline:"), true);
});

Deno.test("renderAgentActivity handles unknown agent", () => {
  const tr = new Translator("en");
  const panel = renderAgentActivity(undefined, "ghost", tr);
  assertEquals(panel, "ghost\n\nno activity captured yet");
});

Deno.test("formatActivityTool picks known keys and truncates values", () => {
  assertEquals(formatActivityTool("bash"), "bash");
  assertEquals(
    formatActivityTool("bash", { cmd: "ls -la" }),
    'bash(cmd="ls -la")',
  );
  assertEquals(
    formatActivityTool("read", { path: "/a", other: 1 }),
    'read(path="/a")',
  );
  assertEquals(
    formatActivityTool("bash", { cmd: "x".repeat(100) }),
    `bash(cmd="${"x".repeat(77)}...")`,
  );
});

Deno.test("truncatePlain collapses whitespace and ellipsizes by runes", () => {
  assertEquals(truncatePlain("  a   b  ", 10), "a b");
  assertEquals(truncatePlain("abcdef", 6), "abcdef");
  assertEquals(truncatePlain("abcdef", 5), "ab...");
  assertEquals(truncatePlain("中文中文中文", 5), "中文...");
  assertEquals(truncatePlain("abcdef", 2), "ab");
});

Deno.test("formatActivityAge renders seconds and minutes", () => {
  const now = new Date("2026-09-20T12:01:00");
  assertEquals(
    formatActivityAge(new Date("2026-09-20T12:00:45"), now),
    "15s ago",
  );
  assertEquals(
    formatActivityAge(new Date("2026-09-20T11:58:00"), now),
    "3m ago",
  );
  assertEquals(
    formatActivityAge(new Date("2026-09-20T12:02:00"), now),
    "0s ago",
  );
});

Deno.test("renderActivitySummary shows last 4 agents with state", () => {
  const store = new AgentActivityStore();
  for (let i = 0; i < 6; i++) {
    store.record({
      type: EventTextDelta,
      agentId: `a${i}`,
      textDelta: `text ${i}`,
    });
  }
  const summary = renderActivitySummary(store, 200);
  const lines = summary.split("\n");
  assertEquals(lines.length, 4);
  assertEquals(lines[0].startsWith("a5 [running] text"), true);
  assertEquals(lines[3].startsWith("a2 [running]"), true);
  assertEquals(renderActivitySummary(new AgentActivityStore(), 80), "");
});

// ─── tool modal state ───────────────────────────────────────────────────────

Deno.test("tool modal geometry helpers match the Go math", () => {
  assertEquals(ToolModalState.widthFor(80), 76);
  assertEquals(ToolModalState.widthFor(10), 20);
  assertEquals(ToolModalState.contentWidthFor(76), 72);
  assertEquals(ToolModalState.contentWidthFor(2), 1);
  assertEquals(ToolModalState.chromeFor(false), 3);
  assertEquals(ToolModalState.chromeFor(true), 4);
  assertEquals(ToolModalState.verticalFrame(), 2);
  assertEquals(ToolModalState.maxOffsetFor(10, 5), 5);
  assertEquals(ToolModalState.maxOffsetFor(3, 5), 0);
});

Deno.test("tool modal scrolls, clamps, and tracks the bottom pin", () => {
  const modal = new ToolModalState(80, 24);
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const pageSize = modal.pageSizeFor(false, 24); // 24 - 3 - 2 = 19 → clamped to line count on render
  assertEquals(pageSize, 19);
  modal.scroll(3, lines.length, 5);
  assertEquals(modal.offset, 3);
  assertEquals(modal.pinnedBottom, false);
  modal.scroll(100, lines.length, 5);
  assertEquals(modal.offset, 5); // max offset
  assertEquals(modal.pinnedBottom, true);
  modal.scroll(-2, lines.length, 5);
  assertEquals(modal.offset, 3);
  modal.scroll(-100, lines.length, 5);
  assertEquals(modal.offset, 0);
  assertEquals(modal.pinnedBottom, false);
});

Deno.test("tool modal switches targets with wrap and resets scroll", () => {
  const modal = new ToolModalState(80, 24);
  const targets: ToolModalTarget[] = [
    { id: "lead", kind: "main", label: "Main" },
    { id: "a1", kind: "subagent" },
  ];
  modal.setTargets(targets);
  modal.switchTarget(1);
  assertEquals(modal.active, 1);
  modal.switchTarget(1);
  assertEquals(modal.active, 0); // wrapped
  modal.switchTarget(-1);
  assertEquals(modal.active, 1);
  // ≤1 target: no-op
  modal.setTargets([{ id: "lead", kind: "main" }]);
  modal.switchTarget(1);
  assertEquals(modal.active, 0);
});

Deno.test("tool modal renders framed content with title and position", () => {
  const modal = new ToolModalState(60, 20);
  modal.setTargets([{ id: "lead", kind: "main" }]);
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  const view = modal.render(lines, new Translator("en"), {
    availableHeight: 20,
  });
  const raw = view.replace(
    // deno-lint-ignore no-control-regex
    /\u001B\[[0-9;]*m/g,
    "",
  );
  const out = raw.split("\n");
  assertEquals(out[0].startsWith("╭"), true);
  assertEquals(out[out.length - 1].startsWith("╰"), true);
  assertEquals(raw.includes("Agent details"), true);
  assertEquals(raw.includes("lines 1-"), true);
  assertEquals(raw.includes("line 0"), true);
  // Narrow modal truncates the long hint tail (Go xansi.Truncate)
  assertEquals(raw.includes("Esc:close"), false);
  const wide = new ToolModalState(140, 40);
  wide.setTargets([{ id: "lead", kind: "main" }]);
  const wideView = wide.render(lines, new Translator("en"), {
    availableHeight: 40,
  }).replace(
    // deno-lint-ignore no-control-regex
    /\u001B\[[0-9;]*m/g,
    "",
  );
  assertEquals(wideView.includes("Esc:close"), true);
  // All framed rows share the same width
  const widths = new Set(out.map((l) => l.length));
  assertEquals(widths.size, 1);
});

Deno.test("tool modal renders tabs when multiple targets", () => {
  const modal = new ToolModalState(80, 24);
  modal.setTargets([
    { id: "lead", kind: "main", label: "Main" },
    { id: "a1", kind: "subagent", label: "worker-1" },
  ]);
  const view = modal.render(["content"], new Translator("en"), {
    availableHeight: 24,
  });
  // deno-lint-ignore no-control-regex
  const raw = view.replace(/\u001B\[[0-9;]*m/g, "");
  assertEquals(raw.includes("Main"), true);
  assertEquals(raw.includes("worker-1"), true);
  assertEquals(raw.includes("|"), true);
});
