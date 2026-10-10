// Test for the ported internal/session/input_resources.go public surface.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import {
  listInputResourceEvents,
  saveInputResourceEvent,
} from "./input_resources.ts";
import { test } from "#testing";

test("input resource events round-trip in durable order", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    saveInputResourceEvent(sessionDir, {
      id: "evt-1",
      sessionId: "session-input",
      resourceId: "res-1",
      runId: "run-1",
      eventType: "input_resource_created",
      status: "draft",
      timestamp: new Date(Date.now() - 1000),
      data: { origin: "acp" },
    });
    saveInputResourceEvent(sessionDir, {
      id: "evt-2",
      sessionId: "session-input",
      resourceId: "res-1",
      runId: "run-1",
      eventType: "input_resource_attached",
      status: "attached",
      timestamp: new Date(),
      data: { runId: "run-1" },
    });

    const events = listInputResourceEvents(sessionDir, "session-input");
    assertEquals(events.length, 2);
    assertEquals(events[0].id, "evt-1");
    assertEquals(events[0].eventType, "input_resource_created");
    assertEquals(events[0].status, "draft");
    assertEquals(events[0].data, { origin: "acp" });
    assertEquals(events[1].id, "evt-2");
    assertEquals(events[1].data, { runId: "run-1" });
    assert(!Number.isNaN(events[0].timestamp.getTime()));

    assertEquals(listInputResourceEvents(sessionDir, ""), []);
  } finally {
    closeAll();
  }
});

test("input resource event identity is validated", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    assertThrows(() =>
      saveInputResourceEvent(sessionDir, {
        id: "",
        sessionId: "session-input",
        resourceId: "res-1",
        runId: "",
        eventType: "input_resource_created",
        status: "",
        timestamp: new Date(),
      }),
    );
  } finally {
    closeAll();
  }
});
