// Ctrl+T plan modal: shows the current task plan in the same framed box as
// the Ctrl+O tool modal.

import { assert, assertEquals, assertStringIncludes } from "@opensac/assert";
import { AppController } from "./app_controller.ts";
import { Translator } from "./i18n.ts";
import { TUISession } from "./tui_session.ts";
import { createFakeTUIService } from "./service.ts";
import { defaultSettings } from "../config/settings.ts";
import type { Event } from "../agent/events.ts";
import {
  EVENT_PLAN_UPDATE,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
} from "../agent/events.ts";

function ev(partial: Partial<Event>): Event {
  return { ...partial } as Event;
}

function harness(): {
  session: TUISession;
  messages: string[];
  controller: AppController;
} {
  const settings = defaultSettings();
  const messages: string[] = [];
  const controller = new AppController(new Translator("en"), {
    onMessage: (_kind, text) => void messages.push(text),
    scheduleRender: () => {},
  });
  const session = new TUISession(
    {
      provider: settings.defaultProvider ?? "openai",
      model: settings.defaultModel ?? "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    createFakeTUIService(),
  );
  // Swap in the controller that owns the recorded plan state.
  // deno-lint-ignore no-explicit-any
  (session as any).controller = controller;
  return { session, messages, controller };
}

const plan = {
  title: "Demo plan",
  note: "next: run tests",
  steps: [
    { title: "first step", status: "done" },
    { title: "second step", status: "running" },
  ],
};

Deno.test("plan modal renders the current plan in a framed box", () => {
  const { session, controller } = harness();
  controller.handleAgentEvent(
    ev({ type: EVENT_PLAN_UPDATE, toolCallId: "tc-plan", plan }),
  );
  session.openPlanModal();
  const view = session.planModalView();
  assertStringIncludes(view, "Demo plan");
  assertStringIncludes(view, "✓ first step");
  assertStringIncludes(view, "▸ second step");
  assertStringIncludes(view, "next: run tests");
  // Same framed chrome as the Ctrl+O tool modal.
  assert(view.includes("╭"));
  assert(view.includes("╯"));
});

Deno.test("tool rows keep the plan payload for rendering", () => {
  const { session, controller } = harness();
  controller.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "tc",
      toolName: "plan",
    }),
  );
  controller.handleAgentEvent(
    ev({ type: EVENT_PLAN_UPDATE, toolCallId: "tc", plan }),
  );
  controller.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_END,
      toolCallId: "tc",
      toolName: "plan",
      toolResult: "Plan: Demo plan",
    }),
  );
  assertEquals(controller.store.toolResults[0]?.plan?.title, "Demo plan");
  session.openPlanModal();
  session.closePlanModal();
  assertEquals(session.planModalOpen, false);
});

Deno.test("opening the plan with no published plan only reports", () => {
  const { session, messages } = harness();
  session.openPlanModal();
  assertEquals(session.planModalOpen, false);
  // The no-plan hint in whichever language the session resolved.
  const expected = [
    new Translator("en").text("plan.modal.no_plan"),
    new Translator("zh").text("plan.modal.no_plan"),
  ];
  assertEquals(messages.length, 1);
  assert(expected.includes(messages[0]));
});
