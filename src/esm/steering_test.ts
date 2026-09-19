// Translated from internal/esm/steering_test.go

import { assert, assertEquals } from "@std/assert";
import { SteeringSource } from "./steering.ts";
import { cleanup, makeStore } from "./test_helpers.ts";

Deno.test("SteeringSource injects each active objective version once", () => {
  const { store, sessionID } = makeStore("mothx-esm-steering-");
  try {
    const source = new SteeringSource(store, sessionID);
    assertEquals(source.next().length, 0);

    store.create(sessionID, "finish the first objective");
    let messages = source.next();
    assertEquals(messages.length, 1);
    assert(messages[0].systemInjected === true);
    assert(messages[0].content!.includes("finish the first objective"));
    assertEquals(source.next().length, 0);

    store.edit(sessionID, "finish the revised objective");
    messages = source.next();
    assertEquals(messages.length, 1);
    assert(messages[0].content!.includes("finish the revised objective"));
    assertEquals(source.next().length, 0);
  } finally {
    cleanup();
  }
});

Deno.test("SteeringSource skips paused objective until resumed", () => {
  const { store, sessionID } = makeStore("mothx-esm-steering-");
  try {
    store.create(sessionID, "finish the objective");
    const source = new SteeringSource(store, sessionID);
    assertEquals(source.next().length, 1);
    store.pause(sessionID);
    assertEquals(source.next().length, 0);
    store.resume(sessionID);
    assertEquals(source.next().length, 1);
  } finally {
    cleanup();
  }
});
