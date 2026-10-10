// Focused contract tests for the in-process async event channel.
//
// Pins the contract documented in event_channel.ts: FIFO delivery, unbounded
// buffering (the recorded deviation from Go's capacity-100 chan), close/seal
// semantics (late pushes are dropped while buffered events still drain), and
// the AsyncIterable projection.

import { assert, assertEquals } from "../compat/assert.ts";
import { EventChannel } from "./event_channel.ts";
import { EVENT_AGENT_END, EVENT_AGENT_START } from "./events.ts";
import { test } from "#testing";

test("EventChannel buffers without bound and drains FIFO", async () => {
  const channel = new EventChannel();
  // Documented deviation: the buffer is unbounded, so a stalled consumer must
  // not cause drops (Go bounds at 100 instead).
  for (let i = 0; i < 256; i++) {
    assertEquals(channel.push({ type: i }), true);
  }
  channel.close();
  const seen: number[] = [];
  for await (const ev of channel) seen.push(ev.type);
  assertEquals(seen, Array.from({ length: 256 }, (_, i) => i));
});

test("EventChannel hands a push to a waiting consumer", async () => {
  const channel = new EventChannel();
  const pending = channel.next();
  assertEquals(channel.push({ type: EVENT_AGENT_START }), true);
  const first = await pending;
  assertEquals(first.done, false);
  assertEquals(first.value.type, EVENT_AGENT_START);

  // Delivered straight to the waiter: the channel is not left buffering.
  const waiting = channel.next();
  assertEquals(channel.push({ type: EVENT_AGENT_END }), true);
  const second = await waiting;
  assertEquals(second.value.type, EVENT_AGENT_END);
});

test("EventChannel wakes concurrent waiters in registration order", async () => {
  const channel = new EventChannel();
  const wakeOrder: number[] = [];
  const first = channel.next().then((r) => {
    wakeOrder.push(1);
    return r;
  });
  const second = channel.next().then((r) => {
    wakeOrder.push(2);
    return r;
  });
  channel.push({ type: 1 });
  channel.push({ type: 2 });
  await Promise.all([first, second]);
  assertEquals(wakeOrder, [1, 2]);
});

test("EventChannel drops pushes after close", async () => {
  const channel = new EventChannel();
  channel.close();
  assert(channel.closed);
  // A late child-agent forward must be dropped instead of racing the terminal
  // events.
  assertEquals(channel.push({ type: EVENT_AGENT_START }), false);
  const result = await channel.next();
  assert(result.done);
});

test("EventChannel close finishes waiters and is idempotent", async () => {
  const channel = new EventChannel();
  const pending = channel.next();
  channel.close();
  channel.close();
  assert((await pending).done);
  assert((await channel.next()).done);
});

test("EventChannel drains buffered events before finishing after close", async () => {
  const channel = new EventChannel();
  channel.push({ type: EVENT_AGENT_START });
  channel.push({ type: EVENT_AGENT_END });
  channel.close();
  const first = await channel.next();
  assertEquals(first.done, false);
  assertEquals(first.value.type, EVENT_AGENT_START);
  const second = await channel.next();
  assertEquals(second.done, false);
  assertEquals(second.value.type, EVENT_AGENT_END);
  assert((await channel.next()).done);
});

test("EventChannel Symbol.dispose seals the channel", () => {
  const channel = new EventChannel();
  channel[Symbol.dispose]();
  assert(channel.closed);
  assertEquals(channel.push({ type: EVENT_AGENT_START }), false);
});
