// Differential guard for the Ctrl+O incremental cache.
//
// The modal body is now assembled from cached, lazily built blocks and only the
// visible window is materialized. This test recomputes the same body the naive
// way (every transcript row expanded, blank-separated, ANSI-wrapped) and frames
// it with the same modal state, then asserts the panel renders byte-identical
// output at every scroll offset, on every tab, and after the transcript keeps
// streaming. The cache can therefore never drop, duplicate, reorder, or
// stale-serve content.

import { assert, assertEquals } from "@std/assert";
import { TUISession } from "./tui_session.ts";
import { createFakeTUIService } from "./service.ts";
import { expandedToolRow } from "./tool_row_format.ts";
import { renderAgentActivity } from "./activity.ts";
import { wrapANSI } from "./renderutil.ts";
import { ToolModalState } from "./tool_modal.ts";
import {
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_TOOL_EXECUTION_START,
} from "../agentruntime/events.ts";

function makeSession(): TUISession {
  return new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    createFakeTUIService(),
  );
}

/** The pre-cache assembly: expand every row, drop blanks, wrap per line. */
function referenceBody(session: TUISession, spinner: string): string[] {
  const store = session.controller.store;
  const tr = session.translator;
  const width = ToolModalState.contentWidthFor(session.termWidth);
  const parts: string[] = [];
  for (let i = 0; i < store.messages.length; i++) {
    const tool = store.toolRowAt(i);
    let text: string;
    if (tool !== undefined) {
      text = expandedToolRow(tr, {
        toolName: tool.toolName,
        toolArgs: tool.toolArgs,
        status: tool.status,
        summary: tool.summary,
        fullContent: tool.fullContent,
        diff: tool.diff,
        plan: tool.plan,
        spinner,
        toolError: tool.toolError,
        executionState: tool.executionState,
      });
    } else {
      const assistant = store.assistantRaw(i);
      const think = store.thinkRaw(i);
      const message = store.messages[i] ?? "";
      text = assistant !== ""
        ? `${tr.text("transcript.assistant_prefix")}\n${assistant}`
        : think !== ""
        ? `${tr.text("activity.thinking")}\n${think}`
        : message;
    }
    if (text.trim() !== "") parts.push(text);
  }
  if (parts.length === 0) return [tr.text("tool.modal.no_conversation")];
  const out: string[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push("");
    for (const line of part.split("\n")) {
      out.push(...wrapANSI(line, width).split("\n"));
    }
  });
  return out;
}

/** The reference sub-agent tab body. */
function referenceAgentBody(
  session: TUISession,
  agentId: string,
): string[] {
  const width = ToolModalState.contentWidthFor(session.termWidth);
  const lines = renderAgentActivity(
    session.controller.activities.get(agentId),
    agentId,
    session.translator,
  ).split("\n");
  const out: string[] = [];
  for (const line of lines) out.push(...wrapANSI(line, width).split("\n"));
  return out;
}

function fillTranscript(session: TUISession): void {
  const store = session.controller.store;
  store.addMessageRow("first user message", "plain");
  store.appendToolExecutionStart("tc-1", "bash", { command: "deno task test" });
  store.appendToolResult({
    toolCallID: "tc-1",
    toolName: "bash",
    toolArgs: { command: "deno task test" },
    toolResult: `[runtime]\ntest output line one\n${
      "x".repeat(140)
    }\n[stderr]\n(no output)`,
  });
  store.appendAssistantDelta("a streamed assistant answer that wraps around");
  store.commitActiveStream();
  store.appendToolExecutionStart("tc-2", "edit", { path: "src/a.ts" });
  store.appendToolResult({
    toolCallID: "tc-2",
    toolName: "edit",
    toolArgs: { path: "src/a.ts" },
    toolResult: "applied",
    toolDiff: {
      path: "src/a.ts",
      added: 2,
      deleted: 1,
      addedLines: [3, 4],
      deletedLines: [3],
      unified:
        "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added2",
    } as never,
  });
  store.addMessageRow("最后一条中文消息，用于验证换行宽度", "plain");
}

/** Frames the reference body with the modal's own state and geometry. */
function referenceFrame(session: TUISession, body: string[]): string {
  return session.toolModalForTest().render(body, session.translator, {
    availableHeight: panelHeight(session),
  });
}

function panelHeight(session: TUISession): number {
  const editorRows = Math.max(
    session.input.editor.view().split("\n").length,
    1,
  );
  return Math.max(session.termHeight - 6 - editorRows, 6);
}

Deno.test("tool modal window equals a naive full recomputation", () => {
  const session = makeSession();
  session.setTerminalSize(72, 24);
  fillTranscript(session);
  session.openToolModal();

  // Pinned at the bottom, then every scroll step up to the top.
  let previousOffset = session.toolModalForTest().offset;
  let sawScroll = 0;
  for (let step = 0; step < 40; step++) {
    const body = referenceBody(session, "");
    assertEquals(
      session.toolModalView(),
      referenceFrame(session, body),
      `frame at offset ${session.toolModalForTest().offset}`,
    );
    if (session.toolModalForTest().offset !== previousOffset) sawScroll++;
    previousOffset = session.toolModalForTest().offset;
    session.scrollToolModal(-1);
  }
  assert(sawScroll > 1, "scrolling must move the window");
  assert(
    previousOffset === 0,
    `the walk reached the top (offset ${previousOffset})`,
  );
  assert(
    referenceBody(session, "").some((l) => l.includes("deno task test")),
    "the reference body carries the tool row",
  );
});

Deno.test("tool modal matches the reference while the transcript streams", () => {
  const session = makeSession();
  session.setTerminalSize(80, 26);
  fillTranscript(session);
  const store = session.controller.store;
  store.appendToolExecutionStart("tc-live", "bash", {
    command: "deno task check",
  });
  session.openToolModal();
  for (const spinner of ["⠋", "⠙", "⠹", ""]) {
    assertEquals(
      session.toolModalView(spinner),
      referenceFrame(session, referenceBody(session, spinner)),
      `live row with spinner ${spinner}`,
    );
  }
  // Settling the live row, then a brand new streamed row.
  store.appendToolResult({
    toolCallID: "tc-live",
    toolName: "bash",
    toolResult: "[stdout]\ndone\n[exit_code]\n0",
  });
  assertEquals(
    session.toolModalView("⠋"),
    referenceFrame(session, referenceBody(session, "⠋")),
    "settled row",
  );
  store.beginAssistantSlot();
  store.appendThinkDelta("reasoning that is still arriving");
  assertEquals(
    session.toolModalView(),
    referenceFrame(session, referenceBody(session, "")),
    "thinking slot",
  );
});

Deno.test("tool modal sub-agent tab matches the reference body", () => {
  const session = makeSession();
  session.setTerminalSize(80, 26);
  fillTranscript(session);
  const controller = session.controller;
  const ev = (extra: Record<string, unknown>) =>
    ({ agentId: "worker-9", ...extra }) as unknown as Parameters<
      typeof controller.handleAgentEvent
    >[0];
  controller.handleAgentEvent(
    ev({ type: EVENT_STATUS, statusMessage: "scanning src" }),
  );
  controller.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "tc-w",
      toolName: "grep",
      toolArgs: { pattern: "ToolModalState" },
    }),
  );
  controller.handleAgentEvent(
    ev({ type: EVENT_TEXT_DELTA, textDelta: "found three call sites" }),
  );
  session.openToolModal();
  session.switchToolModalTarget(1);
  assertEquals(
    session.toolModalView(),
    session.toolModalForTest().render(
      referenceAgentBody(session, "worker-9"),
      session.translator,
      { availableHeight: panelHeight(session) },
    ),
    "agent tab body equals the snapshot rendering",
  );
});
