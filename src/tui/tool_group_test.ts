// Parallel tool-call batches render as one tree block, ported from the Go
// TUI's tool_group_test.go (renderToolGroupBlock / printToolGroupOnce): a live
// count title, one indented branch per call, and a single scrollback commit
// once the whole batch reaches a terminal state.

import { assert, assertEquals } from "@std/assert";
import { render } from "ink";
import type { Event } from "../agent/events.ts";
import {
  EVENT_TOOL_EXECUTION_START,
  EVENT_TOOL_RESULT,
  TOOL_EXECUTION_INTERRUPTED,
} from "../agent/events.ts";
import { App } from "./app.tsx";
import { AppController } from "./app_controller.ts";
import { Translator } from "./i18n.ts";
import { stripANSI } from "./renderutil.ts";
import { TranscriptStore } from "./transcript_store.ts";
import { formatToolGroup } from "./tool_row_format.ts";

// ── group assignment (TranscriptStore) ──────────────────────────────────────

function store(): TranscriptStore {
  return new TranscriptStore({ translator: new Translator("en") });
}

Deno.test("calls that overlap share one parallel group", () => {
  const s = store();
  s.appendToolExecutionStart("t1", "bash", { command: "sleep 100" });
  s.appendToolExecutionStart("t2", "read", { path: "/tmp/file.go" });
  s.appendToolExecutionStart("t3", "grep", { pattern: "needle" });

  assertEquals(s.toolResults.map((r) => r.groupID), [1, 1, 1]);
  assertEquals(s.isMultiToolGroup(1), true);
  assertEquals(
    s.toolGroupMembers(1).map((r) => r.toolCallID),
    ["t1", "t2", "t3"],
  );
  assertEquals(s.toolGroupIDAt(1), 1);
  assertEquals(s.toolGroupIDAt(999), 0);
});

Deno.test("a call after its predecessor finished opens a new group", () => {
  const s = store();
  s.appendToolExecutionStart("t1", "bash");
  s.appendToolResult({ toolCallID: "t1", toolResult: "done" });
  s.appendToolExecutionStart("t2", "bash");

  assertEquals(s.toolResults[0].groupID, 1);
  assertEquals(s.toolResults[1].groupID, 2);
  // A lone row keeps its id but renders on its own.
  assertEquals(s.isMultiToolGroup(1), false);
  assertEquals(s.isMultiToolGroup(2), false);
});

Deno.test("a result that opens its own row stays ungrouped", () => {
  const s = store();
  s.appendToolResult({
    toolCallID: "stray",
    toolName: "read",
    toolResult: "x",
  });
  assertEquals(s.toolResults[0].groupID, 0);
  assertEquals(s.toolGroupMembers(0), []);
  assertEquals(s.isMultiToolGroup(0), false);
});

Deno.test("resetting the transcript restarts group numbering", () => {
  const s = store();
  s.appendToolExecutionStart("t1", "bash");
  s.appendToolExecutionStart("t2", "bash");
  assertEquals(s.toolResults.map((r) => r.groupID), [1, 1]);
  s.resetTranscriptState();
  s.appendToolExecutionStart("t3", "bash");
  s.appendToolExecutionStart("t4", "bash");
  assertEquals(s.toolResults.map((r) => r.groupID), [1, 1]);
});

// ── tree block shape ────────────────────────────────────────────────────────

Deno.test("formatToolGroup draws a title with one branch per call", () => {
  assertEquals(
    formatToolGroup("🔧 Running: 3 tools", [
      "[bash] sleep 100 (running)",
      "[read] /tmp/file.go",
      "[grep] needle",
    ]),
    [
      "🔧 Running: 3 tools",
      "├─ [bash] sleep 100 (running)",
      "├─ [read] /tmp/file.go",
      "└─ [grep] needle",
    ].join("\n"),
  );
});

Deno.test("formatToolGroup aligns continuation lines under the branch", () => {
  assertEquals(
    formatToolGroup("✅ Done: 2 tools", ["[bash] a\nline2\nline3", "[read] b"]),
    [
      "✅ Done: 2 tools",
      "├─ [bash] a",
      "   line2",
      "   line3",
      "└─ [read] b",
    ].join("\n"),
  );
});

Deno.test("formatToolGroup drops empty member rows", () => {
  assertEquals(
    formatToolGroup("✅ Done: 2 tools", ["", "[read] b"]),
    ["✅ Done: 2 tools", "└─ [read] b"].join("\n"),
  );
});

// ── Ink rendering ───────────────────────────────────────────────────────────

/** Minimal duck-typed stdout so Ink can render without a real TTY. */
class FakeStdout {
  columns = 100;
  rows = 30;
  isTTY = true;
  output = "";
  write(s: string | Uint8Array): boolean {
    this.output += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  once(): this {
    return this;
  }
  addListener(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
  listenerCount(): number {
    return 0;
  }
  setEncoding(): this {
    return this;
  }
  end(): void {}
  hasColors(): boolean {
    return false;
  }
  getColorDepth(): number {
    return 1;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function ev(partial: Partial<Event>): Event {
  return { ...partial } as Event;
}

function startTool(
  c: AppController,
  toolCallId: string,
  toolName: string,
  toolArgs?: Record<string, unknown>,
): void {
  c.handleAgentEvent(
    ev({ type: EVENT_TOOL_EXECUTION_START, toolCallId, toolName, toolArgs }),
  );
}

function finishTool(
  c: AppController,
  toolCallId: string,
  toolName: string,
  result: string,
  toolExecutionState?: string,
): void {
  c.handleAgentEvent(
    ev({
      type: EVENT_TOOL_RESULT,
      toolCallId,
      toolName,
      toolResult: result,
      ...(toolExecutionState === undefined ? {} : { toolExecutionState }),
    } as Partial<Event>),
  );
}

interface Screen {
  instance: ReturnType<typeof render>;
  stdout: FakeStdout;
  out: () => string;
}

async function openScreen(c: AppController): Promise<Screen> {
  const stdout = new FakeStdout();
  const view = () => App({ controller: c, compactMode: true, width: 100 });
  const instance = render(view(), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await sleep(30);
  return {
    instance,
    stdout,
    out: () => stripANSI(stdout.output),
  };
}

function controller(): AppController {
  return new AppController(new Translator("en"), {
    onMessage: () => {},
    scheduleRender: () => {},
  });
}

Deno.test("parallel running calls render as one tree group", async () => {
  const c = controller();
  startTool(c, "t1", "bash", { command: "sleep 100" });
  startTool(c, "t2", "read", { path: "/tmp/file.go" });
  startTool(c, "t3", "grep", { pattern: "needle" });

  const screen = await openScreen(c);
  try {
    const out = screen.out();
    assert(out.includes("🔧 Running: 3 tools"), out);
    assert(out.includes("├─ "), out);
    assert(out.includes("└─ "), out);
    assert(out.includes("[bash] sleep 100 (running)"), out);
    // One title, no per-call emoji: the batch reads as a single unit.
    assertEquals(count(out, "🔧"), 1);
    // Grouped calls are listed by the tree, not repeated by the timeline.
    assertEquals(count(out, "bash: sleep 100"), 0);
  } finally {
    screen.instance.unmount();
  }
});

Deno.test("a single running call keeps its standalone row", async () => {
  const c = controller();
  startTool(c, "t1", "bash", { command: "sleep 100" });

  const screen = await openScreen(c);
  try {
    const out = screen.out();
    assert(!out.includes("Running:"), out);
    assert(!out.includes("├─"), out);
    assert(!out.includes("└─"), out);
    // The standalone running call stays on the activity timeline.
    assert(out.includes("bash: sleep 100"), out);
  } finally {
    screen.instance.unmount();
  }
});

Deno.test("a partially finished batch stays one running group", async () => {
  const c = controller();
  startTool(c, "t1", "bash", { command: "sleep 100" });
  startTool(c, "t2", "bash", { command: "sleep 200" });
  finishTool(c, "t1", "bash", "first done");

  const screen = await openScreen(c);
  try {
    const out = screen.out();
    assert(out.includes("🔧 Running: 2 tools"), out);
    assert(out.includes("sleep 100 (succeeded)"), out);
    assert(out.includes("sleep 200 (running)"), out);
    assertEquals(count(out, "✅"), 0);
  } finally {
    screen.instance.unmount();
  }
});

Deno.test("a finished batch commits to scrollback as one tree block", async () => {
  const c = controller();
  startTool(c, "t1", "bash", { command: "sleep 100" });
  startTool(c, "t2", "read", { path: "/tmp/file.go" });
  startTool(c, "t3", "grep", { pattern: "needle" });

  const screen = await openScreen(c);
  try {
    finishTool(c, "t1", "bash", "first");
    finishTool(c, "t2", "read", "second");
    finishTool(c, "t3", "grep", "third");
    screen.instance.rerender(
      App({ controller: c, compactMode: true, width: 100 }),
    );
    await sleep(30);

    const out = screen.out();
    // The settled block is admitted exactly once; the batch rendered live
    // under its running title and is no longer part of the managed view.
    assertEquals(count(out, "✅ Done: 3 tools"), 1);
    assertEquals(count(out, "🔧"), 1);
    assert(out.includes("├─ [bash] sleep 100 (succeeded)"), out);
    assert(out.includes("└─ [grep]"), out);
    assertEquals(count(out, "✅"), 1);
  } finally {
    screen.instance.unmount();
  }
});

Deno.test("an interrupted batch still commits as one tree block", async () => {
  const c = controller();
  startTool(c, "t1", "bash", { command: "sleep 100" });
  startTool(c, "t2", "bash", { command: "sleep 200" });

  const screen = await openScreen(c);
  try {
    finishTool(c, "t1", "bash", "first");
    finishTool(c, "t2", "bash", "", TOOL_EXECUTION_INTERRUPTED);
    screen.instance.rerender(
      App({ controller: c, compactMode: true, width: 100 }),
    );
    await sleep(30);

    const out = screen.out();
    assertEquals(count(out, "✅ Done: 2 tools"), 1);
    assert(out.includes("succeeded"), out);
    assert(out.includes("canceled"), out);
  } finally {
    screen.instance.unmount();
  }
});

Deno.test("the batch title follows the session language", async () => {
  const c = new AppController(new Translator("zh"), {
    onMessage: () => {},
    scheduleRender: () => {},
  });
  startTool(c, "t1", "bash", { command: "sleep 100" });
  startTool(c, "t2", "read", { path: "/tmp/file.go" });

  const screen = await openScreen(c);
  try {
    assert(screen.out().includes("🔧 执行中：2 个工具"), screen.out());
  } finally {
    screen.instance.unmount();
  }
});
