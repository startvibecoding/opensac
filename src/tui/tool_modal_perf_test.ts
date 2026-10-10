// Ctrl+O rendering performance contract.
//
// The tool modal is a scrollable window over the whole expanded transcript,
// including every tool's full output. Rebuilding and re-wrapping that body on
// each frame made the modal cost O(conversation) per keystroke and per spinner
// tick (a 3 MB transcript measured ~100 ms/frame before the incremental cache).
// These tests pin the contract: an unchanged body rebuilds nothing, one
// streaming row rebuilds one block, a spinner tick touches only live rows, and
// the cached window equals a body rebuilt from scratch.

import { assert, assertEquals } from "../compat/assert.ts";
import {
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_TOOL_EXECUTION_START,
} from "../agentruntime/events.ts";
import { TUISession } from "./tui_session.ts";
import { createFakeTUIService, type FakeTUIService } from "./service.ts";
import { test } from "#testing";

function makeSession(): { session: TUISession; service: FakeTUIService } {
  const service = createFakeTUIService();
  const session = new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    service,
  );
  return { session, service };
}

/** A transcript with wide tool output, mirroring a long real session. */
function fillTranscript(session: TUISession, rounds: number): void {
  const store = session.controller.store;
  for (let i = 0; i < rounds; i++) {
    store.addMessageRow(`user request ${i}`, "plain");
    store.appendToolExecutionStart(`call-${i}`, "read", {
      path: `src/file${i}.ts`,
    });
    store.appendToolResult({
      toolCallID: `call-${i}`,
      toolName: "read",
      toolArgs: { path: `src/file${i}.ts` },
      toolResult: Array.from(
        { length: 60 },
        (_, j) => `output line ${i}/${j} ${"padding ".repeat(8)}`,
      ).join("\n"),
    });
    store.addMessageRow(`assistant reply ${i}`, "plain");
  }
}

test("tool modal scroll rebuilds no transcript block", () => {
  const { session } = makeSession();
  session.setTerminalSize(100, 30);
  fillTranscript(session, 6);
  session.openToolModal();
  // The first frame pays for the body once.
  const cold = session.toolModalCacheStatsForTest();
  assert(cold.blocks === 0, "no frame has rendered yet");
  session.toolModalView();
  const first = session.toolModalCacheStatsForTest();
  assertEquals(first.blocks, 18);
  assertEquals(first.rebuiltBlocks, 18, "cold frame wraps the whole body");

  // Scrolling (up and down) only moves the window.
  session.scrollToolModal(-1);
  session.scrollToolModal(-1);
  session.scrollToolModal(4);
  session.toolModalView();
  assertEquals(
    session.toolModalCacheStatsForTest().rebuiltBlocks,
    0,
    "a scroll must not re-format or re-wrap any row",
  );
});

test("tool modal streams one row without re-wrapping the transcript", () => {
  const { session } = makeSession();
  session.setTerminalSize(100, 30);
  fillTranscript(session, 4);
  session.openToolModal();
  session.toolModalView();
  const blocks = session.toolModalCacheStatsForTest().blocks;

  session.controller.store.appendAssistantDelta("partially streamed answer ");
  session.toolModalView();
  const afterDelta = session.toolModalCacheStatsForTest();
  assertEquals(afterDelta.blocks, blocks + 1, "the new row joins the body");
  assertEquals(
    afterDelta.rebuiltBlocks,
    1,
    "only the streaming row is formatted and wrapped again",
  );

  session.controller.store.appendAssistantDelta("more text");
  session.toolModalView();
  assertEquals(session.toolModalCacheStatsForTest().rebuiltBlocks, 1);
});

test("tool modal spinner tick touches only running rows", () => {
  const { session } = makeSession();
  session.setTerminalSize(100, 30);
  fillTranscript(session, 3);
  const store = session.controller.store;
  store.appendToolExecutionStart("live", "bash", { command: "sleep 30" });
  session.openToolModal();
  session.toolModalView("⠋");
  assertEquals(session.toolModalCacheStatsForTest().rebuiltBlocks, 10);

  // The next frame animates the spinner: only the live row re-formats.
  session.toolModalView("⠙");
  assertEquals(
    session.toolModalCacheStatsForTest().rebuiltBlocks,
    1,
    "a spinner tick re-formats the running row only",
  );

  // Settling the row rebuilds that one row and nothing else.
  store.appendToolResult({
    toolCallID: "live",
    toolName: "bash",
    toolResult: "(no output)",
  });
  session.toolModalView("⠙");
  assertEquals(session.toolModalCacheStatsForTest().rebuiltBlocks, 1);
});

test("sub-agent tab follows its activity stream", () => {
  const { session } = makeSession();
  session.setTerminalSize(100, 30);
  fillTranscript(session, 1);
  const controller = session.controller;
  const ev = (extra: Record<string, unknown>) =>
    ({ agentId: "worker-1", ...extra }) as unknown as Parameters<
      typeof controller.handleAgentEvent
    >[0];
  controller.handleAgentEvent(
    ev({ type: EVENT_STATUS, statusMessage: "started scan" }),
  );
  session.openToolModal();
  session.switchToolModalTarget(1);
  const first = session.toolModalView();
  assert(first.includes("started scan"), first);
  // A later event must reach the tab even though the transcript is untouched.
  controller.handleAgentEvent(
    ev({ type: EVENT_TEXT_DELTA, textDelta: "half an answer" }),
  );
  const second = session.toolModalView();
  assert(second.includes("half an answer"), "agent tab followed the stream");
  assertEquals(
    session.toolModalCacheStatsForTest().rebuiltBlocks,
    1,
    "one snapshot block re-renders",
  );
});

test("tool modal releases its wrapped text when closed", () => {
  const { session } = makeSession();
  session.setTerminalSize(100, 30);
  fillTranscript(session, 5);
  session.openToolModal();
  session.toolModalView();
  assert(
    session.toolModalCachedCharsForTest() > 0,
    "an open panel holds its wrapped text",
  );
  // Closing must not keep the duplicated body text alive.
  session.closeToolModal();
  assertEquals(session.toolModalCachedCharsForTest(), 0);
  // The cheap layout survives, so a reopen re-wraps no transcript row: only the
  // visible window materializes on demand.
  session.openToolModal();
  session.toolModalView();
  assertEquals(
    session.toolModalCacheStatsForTest().rebuiltBlocks,
    0,
    "reopen reuses the warm layout instead of re-wrapping the conversation",
  );
  assert(
    session.toolModalCachedCharsForTest() > 0,
    "the reopened panel re-materialized its window",
  );
});

test("tool modal frame window matches a freshly built body", () => {
  const { session } = makeSession();
  session.setTerminalSize(90, 26);
  fillTranscript(session, 3);
  // Pinned to the bottom by default: the tail of the conversation is visible.
  session.openToolModal();
  const pinned = session.toolModalView();
  assert(pinned.includes("assistant reply 2"), "tail row visible");
  assert(!pinned.includes("user request 0"), "head row scrolled out");

  // Scrolling to the top shows the first row, and the cached window matches
  // the same frame produced after a resize (which drops the cache entirely).
  session.scrollToolModal(-1000);
  const top = session.toolModalView();
  assert(top.includes("user request 0"), "head row visible after scroll up");
  session.setTerminalSize(90, 26);
  assertEquals(session.toolModalView(), top, "rebuild from scratch is equal");
});

test("tool modal keeps tab bodies cached separately", () => {
  const { session } = makeSession();
  session.setTerminalSize(100, 30);
  fillTranscript(session, 2);
  session.controller.handleAgentEvent({
    agentId: "worker-1",
    type: EVENT_TOOL_EXECUTION_START,
    toolCallId: "tc-1",
    toolName: "bash",
    toolArgs: { command: "ls" },
  } as never);
  session.openToolModal();
  const modal = session.toolModalForTest();
  assertEquals(modal.targets.map((t) => t.id), ["main", "agent:worker-1"]);

  // Warm the main tab, then leave it and come back.
  session.toolModalView();
  assertEquals(session.toolModalCacheStatsForTest().rebuiltBlocks, 6);
  session.switchToolModalTarget(1);
  assert(session.toolModalView().includes("worker-1"));
  assertEquals(session.toolModalCacheStatsForTest().rebuiltBlocks, 1);
  session.switchToolModalTarget(-1);
  session.toolModalView();
  const mainStats = session.toolModalCacheStatsForTest();
  assertEquals(
    mainStats.rebuiltBlocks,
    0,
    "returning to the main tab reuses its cached body",
  );
  assertEquals(
    mainStats.blocks,
    6,
    "the main tab body is still the transcript",
  );
});
