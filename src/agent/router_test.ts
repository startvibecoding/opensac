// (no dedicated Go test).
// Unknown handlers are routed; global handlers receive every event.

import { assertEquals } from "@std/assert";
import type { Event } from "../../sdk/agent/types.ts";
import { newEventRouter, RouterEventHandlerFunc } from "./router.ts";

function event(agentId: string): Event {
  return { agentId, type: 0 };
}

Deno.test("event router routes to agent-specific then global handlers", () => {
  const router = newEventRouter();
  const seen: string[] = [];

  const h1 = new RouterEventHandlerFunc((e) => seen.push(`h1:${e.agentId}`));
  const h2 = new RouterEventHandlerFunc((e) => seen.push(`h2:${e.agentId}`));
  router.registerAgent("a", h1);
  router.registerGlobal(h2);

  router.dispatch(event("a"));
  assertEquals(seen, ["h1:a", "h2:a"]);
  assertEquals(router.handlerCount("a"), 1);
  assertEquals(router.globalHandlerCount(), 1);

  router.unregisterAgent("a");
  assertEquals(router.handlerCount("a"), 0);

  router.dispatch(event("a"));
  assertEquals(seen, ["h1:a", "h2:a", "h2:a"]);
});
