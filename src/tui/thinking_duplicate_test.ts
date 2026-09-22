// Regression test: an active thinking block must render its text exactly once.
// ThinkDelta was previously written both into the transcript-store streaming
// row and into the activity timeline, producing two identical lines.

import { assertEquals } from "@std/assert";
import { App } from "./app.tsx";
import { AppController } from "./app_controller.ts";
import { EventThinkDelta, EventTurnStart } from "../agent/events.ts";
import React from "react";
import { render } from "ink";

import { Translator } from "./i18n.ts";

function makeController(): AppController {
  const translator = new Translator("en");
  return new AppController(
    translator,
    {
      onMessage: () => {},
      scheduleRender: () => {},
      deliverQuestion: () => {},
    },
  );
}

function capture(controller: AppController): string {
  const frames: string[] = [];
  const stdout = {
    columns: 100,
    rows: 40,
    write: (s: string) => {
      frames.push(s);
      return true;
    },
    on: () => {},
    off: () => {},
    // deno-lint-ignore no-explicit-any
  } as any;
  const instance = render(
    React.createElement(App, { controller, width: 100 }),
    { stdout },
  );
  instance.unmount();
  return frames.join("\n");
}

Deno.test("active think block appears once, not twice", () => {
  const c = makeController();
  c.handleAgentEvent({ type: EventTurnStart });
  c.handleAgentEvent(
    {
      type: EventThinkDelta,
      thinkDelta: "let me reason about this carefully",
    } as unknown as Parameters<AppController["handleAgentEvent"]>[0],
  );

  const frame = capture(c);
  const occurrences = frame.split(
    "let me reason about this carefully",
  ).length - 1;
  assertEquals(occurrences, 1, `rendered ${occurrences} times:\n${frame}`);
});

Deno.test("multiple think deltas accumulate into one line", () => {
  const c = makeController();
  c.handleAgentEvent({ type: EventTurnStart });
  const ev = (delta: string) =>
    ({ type: EventThinkDelta, thinkDelta: delta }) as unknown as Parameters<
      AppController["handleAgentEvent"]
    >[0];
  c.handleAgentEvent(ev("part one "));
  c.handleAgentEvent(ev("part two"));

  const frame = capture(c);
  assertEquals(frame.includes("part one part two"), true);
  assertEquals(frame.split("part one").length - 1, 1);
});
