// Translated from internal/serve/openaiapi/events_test.go and the
// recordSessionRunEvent/recordSessionCapabilityChanges cases of
// server_test.go, adapted to the Server-bound functions in events.ts.
import { assert, assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import {
  canonicalRunIdentity,
  capabilitySnapshotFromSession,
  cloneRunEventData,
  isTerminalRunStatus,
  rawEventData,
  recordSessionCapabilityChanges,
  recordSessionRunEvent,
  runEventErrorInfo,
  safeRunEventData,
} from "./events.ts";
import { APISession } from "./session_mgr.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import {
  listSessionCapabilityEvents,
  listSessionRunEvents,
} from "../../session/session_events.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-events-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

Deno.test("isTerminalRunStatus matches the Go table", () => {
  for (
    const status of [
      "completed",
      "incomplete",
      "failed",
      "cancelled",
      "canceled",
      "timed_out",
      "expired",
    ]
  ) {
    assertEquals(isTerminalRunStatus(status), true, status);
  }
  assertEquals(isTerminalRunStatus(" running "), false);
  assertEquals(isTerminalRunStatus(""), false);
});

Deno.test("runEventErrorInfo extracts classified errors", () => {
  assertEquals(runEventErrorInfo(undefined).ok, false);
  assertEquals(runEventErrorInfo({}).ok, false);
  const info = { code: "boom", type: "server_error", message: "x" };
  const extracted = runEventErrorInfo({ errorInfo: info });
  assertEquals(extracted.ok, true);
  assertEquals(extracted.info.code, "boom");
  // A non-error value without a code is not an ErrorInfo.
  assertEquals(runEventErrorInfo({ error: "plain string" }).ok, false);
});

Deno.test("cloneRunEventData and rawEventData shape event payloads", () => {
  const original = { a: 1 };
  const copy = cloneRunEventData(original);
  copy.b = 2;
  assertEquals((original as Record<string, unknown>).b, undefined);
  assertEquals(rawEventData(undefined), undefined);
  assertEquals(rawEventData({}), undefined);
  assertEquals(rawEventData({ a: 1 }), { a: 1 });
});

Deno.test("safeRunEventData classifies string errors and keeps ErrorInfo", () => {
  const server = new Server({});
  // No error key: passthrough.
  assertEquals(
    safeRunEventData(server, null, "run_started", "running", { a: 1 }),
    { a: 1 },
  );
  // ErrorInfo value: mirrored into errorInfo/errorMessage.
  const info = { code: "c1", type: "server_error", message: "m" };
  const withInfo = safeRunEventData(server, null, "run_started", "failed", {
    error: info,
  });
  assertEquals(withInfo?.errorInfo, info);
  assert(typeof withInfo?.errorMessage === "string");
  // String error: classified, transport-containing event types use the
  // transport phase.
  const classified = safeRunEventData(
    server,
    null,
    "transport_failed",
    "failed",
    {
      error: "socket closed",
    },
  );
  assert(classified !== undefined);
  const extracted = runEventErrorInfo(classified);
  assertEquals(extracted.ok, true);
  assertEquals(extracted.info.phase, "transport");
  // Blank string errors are left untouched.
  assertEquals(
    safeRunEventData(server, null, "x", "failed", { error: "  " })?.error,
    "  ",
  );
});

Deno.test("recordSessionCapabilityChanges persists and publishes only changed capabilities", async () => {
  const dir = tempDir();
  try {
    const server = new Server({ settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s-cap";
    sess.mode = "yolo";
    const broker = server.getEventBroker();
    const sub = broker.subscribe("s-cap");

    const before = capabilitySnapshotFromSession(sess);
    sess.mode = "plan";
    sess.browser = true;
    const err = recordSessionCapabilityChanges(
      server,
      sess,
      before,
      "webui",
      "user",
      "run-1",
      { reason: "user-toggle" },
    );
    assertEquals(err, null);

    const events = listSessionCapabilityEvents(dir, "s-cap");
    assertEquals(events.length, 2, "mode and browser changed");
    const modeEvent = events.find((e) => e.capability === "mode");
    const browserEvent = events.find((e) => e.capability === "browser");
    assert(modeEvent);
    assert(browserEvent);
    assertEquals(modeEvent.oldValue, "yolo");
    assertEquals(modeEvent.newValue, "plan");
    assertEquals(modeEvent.source, "webui");
    assertEquals(modeEvent.actor, "user");
    assertEquals(modeEvent.runId, "run-1");
    assertEquals(modeEvent.eventType, "changed");
    assertEquals(browserEvent.newValue, "true");

    const ev = await sub.events.next();
    assert(ev !== undefined);
    assertEquals(ev.event, "capability_event");
    sub.cancel();

    // A no-op second record persists nothing.
    const err2 = recordSessionCapabilityChanges(
      server,
      sess,
      capabilitySnapshotFromSession(sess),
      "webui",
      "user",
      "run-1",
      undefined,
    );
    assertEquals(err2, null);
    assertEquals(listSessionCapabilityEvents(dir, "s-cap").length, 2);
  } finally {
    closeAll();
  }
});

Deno.test("recordSessionRunEvent persists through the execution sink and publishes", async () => {
  const dir = tempDir();
  try {
    const server = new Server({ settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s-run";
    const broker = server.getEventBroker();
    const sub = broker.subscribe("s-run");

    const err = recordSessionRunEvent(
      server,
      sess,
      "run-77",
      "run_started",
      "running",
      "webui",
      "glm-5.3-flash",
      "yolo",
      { attempt: 1 },
    );
    assertEquals(err, null);

    const events = listSessionRunEvents(dir, "s-run");
    assertEquals(events.length, 1);
    assertEquals(events[0].runId, "run-77");
    assertEquals(events[0].eventType, "run_started");
    assertEquals(events[0].source, "webui");
    assertEquals(events[0].model, "glm-5.3-flash");
    assertEquals(events[0].mode, "yolo");

    const ev = await sub.events.next();
    assert(ev !== undefined);
    assertEquals(ev.event, "run_event");
    sub.cancel();

    // An error payload is classified and persisted via the execution's
    // error-info projection, then republished with errorMessage filled.
    const broker2 = server.getEventBroker();
    const sub2 = broker2.subscribe("s-run");
    const err2 = recordSessionRunEvent(
      server,
      sess,
      "run-77",
      "run_failed",
      "failed",
      "webui",
      "",
      "",
      { error: "boom" },
    );
    assertEquals(err2, null);
    const failed = listSessionRunEvents(dir, "s-run").find(
      (e) => e.eventType === "run_failed",
    );
    assert(failed);
    const data = failed.data as Record<string, unknown>;
    assert(data.errorInfo !== undefined);
    assert(typeof data.errorMessage === "string");
    const ev2 = await sub2.events.next();
    assert(ev2 !== undefined);
    assertEquals(ev2.event, "run_event");
    sub2.cancel();
  } finally {
    closeAll();
  }
});

Deno.test("recordSessionRunEvent no-ops without a server session binding", () => {
  const server = new Server({ settings: settingsFor("") });
  const sess = new APISession();
  sess.id = "";
  assertEquals(
    recordSessionRunEvent(
      server,
      sess,
      "run-1",
      "run_started",
      "running",
      "webui",
      "",
      "",
      undefined,
    ),
    null,
  );
  assertEquals(
    recordSessionRunEvent(
      server,
      sess,
      "",
      "run_started",
      "running",
      "webui",
      "",
      "",
      undefined,
    ),
    null,
  );
});

Deno.test("canonicalRunIdentity falls back without a forced source", () => {
  const dir = tempDir();
  try {
    const server = new Server({ settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s-identity";
    const result = canonicalRunIdentity(server, sess, "webui", "yolo");
    assertEquals(result.err, null);
    assertEquals(result.source, "webui");
  } finally {
    closeAll();
  }
});
