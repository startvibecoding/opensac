// Regression test: an active thinking block must render its text exactly once.
// ThinkDelta was previously written both into the transcript-store streaming
// row and into the activity timeline, producing two identical lines.

import { assertEquals } from "../compat/assert.ts";
import { App } from "./app.tsx";
import { AppController } from "./app_controller.ts";
import { EVENT_THINK_DELTA, EVENT_TURN_START } from "../agent/events.ts";
import React from "react";
import { render } from "ink";

import { Translator } from "./i18n.ts";
import { test } from "#testing";

function makeController(): AppController {
  const translator = new Translator("en");
  return new AppController(translator, {
    onMessage: () => {},
    scheduleRender: () => {},
    deliverQuestion: () => {},
  });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const instance = render(
    React.createElement(App, { controller, width: 100 }),
    { stdout },
  );
  instance.unmount();
  return frames.join("\n");
}

test("active think block appears once, not twice", () => {
  const c = makeController();
  c.handleAgentEvent({ type: EVENT_TURN_START });
  c.handleAgentEvent({
    type: EVENT_THINK_DELTA,
    thinkDelta: "let me reason about this carefully",
  } as unknown as Parameters<AppController["handleAgentEvent"]>[0]);

  const frame = capture(c);
  const occurrences =
    frame.split("let me reason about this carefully").length - 1;
  assertEquals(occurrences, 1, `rendered ${occurrences} times:\n${frame}`);
});

test("multiple think deltas accumulate into one line", () => {
  const c = makeController();
  c.handleAgentEvent({ type: EVENT_TURN_START });
  const ev = (delta: string) =>
    ({ type: EVENT_THINK_DELTA, thinkDelta: delta }) as unknown as Parameters<
      AppController["handleAgentEvent"]
    >[0];
  c.handleAgentEvent(ev("part one "));
  c.handleAgentEvent(ev("part two"));

  const frame = capture(c);
  assertEquals(frame.includes("part one part two"), true);
  assertEquals(frame.split("part one").length - 1, 1);
});
