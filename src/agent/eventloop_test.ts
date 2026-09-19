// Focused tests for the event-loop consumer (port of eventloop.go).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Event, EventAgentEnd, EventAgentStart } from "./events.ts";
import { consumeEvents, eventHandlerFunc } from "./eventloop.ts";

async function* stream(...events: Event[]): AsyncIterable<Event> {
  for (const e of events) yield e;
}

Deno.test("consumeEvents forwards every event until the stream closes", async () => {
  const seen: number[] = [];
  await consumeEvents(
    stream({ type: EventAgentStart }, { type: EventAgentEnd }),
    eventHandlerFunc((e) => {
      seen.push(e.type);
    }),
  );
  assertEquals(seen, [EventAgentStart, EventAgentEnd]);
});

Deno.test("consumeEvents stops when the handler throws", async () => {
  const seen: number[] = [];
  await assertRejects(
    () =>
      consumeEvents(
        stream(
          { type: EventAgentStart },
          { type: EventAgentEnd },
          { type: EventAgentStart },
        ),
        eventHandlerFunc((e) => {
          seen.push(e.type);
          if (seen.length === 2) throw new Error("boom");
        }),
      ),
    Error,
    "boom",
  );
  assertEquals(seen.length, 2);
});

Deno.test("consumeEvents stops on abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const seen: number[] = [];
  await assertRejects(
    () =>
      consumeEvents(
        stream({ type: EventAgentStart }),
        eventHandlerFunc((e) => {
          seen.push(e.type);
        }),
        controller.signal,
      ),
    DOMException,
  );
  assert(seen.length === 0);
});
