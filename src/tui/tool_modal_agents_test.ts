// Regression: Ctrl+O (tool modal) must expose one target per background/sub
// agent with the full activity snapshot (latest tool, thinking, response,
// result, event timeline), mirroring the Go renderAgentActivity.

import { runtime } from "../platform/runtime.ts";
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "../compat/assert.ts";
import { AppController } from "./app_controller.ts";
import { Translator } from "./i18n.ts";
import { TUISession } from "./tui_session.ts";
import { createFakeTUIService } from "./service.ts";
import { defaultSettings } from "../config/settings.ts";
import {
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
} from "../agent/events.ts";
import { test } from "#testing";

function makeSession(controller: AppController): TUISession {
  const settings = defaultSettings();
  // TUISession needs a provider/model; the stub only exercises the modal, so
  // construct a minimal shell via the constructor with default provider.
  const session = new TUISession(
    {
      provider: settings.defaultProvider ?? "openai",
      model: settings.defaultModel ?? "",
      mode: "yolo",
      thinking: "",
      workDir: runtime.cwd(),
      version: "test",
    },
    createFakeTUIService(),
  );
  // Swap in the controller with recorded activity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).controller = controller;
  return session;
}

test("tool modal lists sub-agent targets with detailed progress", () => {
  const tr = new Translator("en");
  const controller = new AppController(tr, {
    onMessage: () => {},
    scheduleRender: () => {},
  });

  // A background agent records a status, thinking, text, and a tool call.
  const bg = (extra: Record<string, unknown>) =>
    ({ agentId: "worker-1", ...extra }) as unknown as Parameters<
      AppController["handleAgentEvent"]
    >[0];
  controller.handleAgentEvent(
    bg({ type: EVENT_STATUS, statusMessage: "started scan" }),
  );
  controller.handleAgentEvent(
    bg({ type: EVENT_THINK_DELTA, thinkDelta: "thinking hard" }),
  );
  controller.handleAgentEvent(
    bg({ type: EVENT_TEXT_DELTA, textDelta: "partial answer" }),
  );
  controller.handleAgentEvent(
    bg({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "tc-1",
      toolName: "bash",
      toolArgs: { command: "ls -la" },
    }),
  );

  const session = makeSession(controller);
  session.openToolModal();

  // Targets: main + one sub-agent.
  const modal = session.toolModalForTest();
  assertEquals(
    modal.targets.map((t) => t.id),
    ["main", "agent:worker-1"],
  );

  // Switch to the sub-agent target and render it.
  session.switchToolModalTarget(1);
  const view = session.toolModalView();
  assertStringIncludes(view, "worker-1");
  assertStringIncludes(view, "thinking hard");
  assertStringIncludes(view, "partial answer");
  assertStringIncludes(view, "bash");
  assertStringIncludes(view, "started scan");
});

test("tool modal refuses to open when there is nothing to show", () => {
  const tr = new Translator("en");
  const controller = new AppController(tr, {
    onMessage: () => {},
    scheduleRender: () => {},
  });
  const session = makeSession(controller);
  session.openToolModal();
  assertThrows(() => session.toolModalForTest());
});

test("main tab expands tool calls without one tab per tool", () => {
  const tr = new Translator("en");
  const controller = new AppController(tr, {
    onMessage: () => {},
    scheduleRender: () => {},
  });
  controller.addMessage("plain preamble");
  const ev = (extra: Record<string, unknown>) =>
    extra as unknown as Parameters<AppController["handleAgentEvent"]>[0];
  controller.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "tc-9",
      toolName: "bash",
      toolArgs: { command: "npm test" },
    }),
  );
  controller.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_END,
      toolCallId: "tc-9",
      toolName: "bash",
      toolArgs: { command: "npm test" },
      toolResult: "all 10 tests passed",
    }),
  );

  const session = makeSession(controller);
  session.openToolModal();
  // Tabs: main + agents only — never one tab per tool call.
  const modal = session.toolModalForTest();
  assertEquals(
    modal.targets.map((t) => t.id),
    ["main"],
  );

  // Main renders the expanded transcript: tool header with the command,
  // then `---` plus the full output.
  const view = session.toolModalView();
  assertStringIncludes(view, "[bash]");
  assertStringIncludes(view, "npm test");
  assertStringIncludes(view, "all 10 tests passed");
  assertStringIncludes(view, "plain preamble");
});
