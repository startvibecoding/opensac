// Task 3: TUI session lifecycle and prompt execution run through `TUIService`.
// Submitting text must call `service.prompt`, forward the returned canonical
// run events into the existing `AppController`, expose the accepted run ID to
// the cancel/replay paths, correlate decision answers to the originating Core
// request, and close the service session exactly once.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import {
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  TASK_SUCCESS,
} from "../agent/events.ts";
import {
  createFakeTUIService,
  type FakeTUIService,
  type TUIDecisionAnswer,
  type TUIService,
} from "./service.ts";
import { splitInputChunk } from "./keys.ts";
import { TUISession } from "./tui_session.ts";

interface Recorder {
  service: TUIService;
  prompts: Array<{ sessionId: string; text: string }>;
  cancels: Array<{ sessionId: string; runId: string }>;
  closes: string[];
  answers: TUIDecisionAnswer[];
}

/**
 * Wraps the deterministic fake with call recording. `liveRunID` makes `prompt`
 * open a non-terminal run (mirroring a still-streaming Core run) so tests can
 * observe the active run ID and drive cancellation.
 */
function recordingService(
  fake: FakeTUIService,
  options: { liveRunID?: string } = {},
): Recorder {
  const prompts: Recorder["prompts"] = [];
  const cancels: Recorder["cancels"] = [];
  const closes: string[] = [];
  const answers: TUIDecisionAnswer[] = [];
  const service = {
    ...fake,
    prompt(input: Parameters<TUIService["prompt"]>[0]) {
      prompts.push({ sessionId: input.sessionId, text: input.text });
      if (options.liveRunID === undefined) return fake.prompt(input);
      fake.emit(input.sessionId, options.liveRunID, "run_started", {
        text: input.text,
      });
      return Promise.resolve({
        sessionId: input.sessionId,
        runId: options.liveRunID,
        status: "running" as const,
        agentId: "agent-lead",
      });
    },
    cancelRun(input: Parameters<TUIService["cancelRun"]>[0]) {
      cancels.push({ sessionId: input.sessionId, runId: input.runId });
      return fake.cancelRun(input);
    },
    closeSession(input: { sessionId: string }) {
      closes.push(input.sessionId);
      return fake.closeSession(input);
    },
    answerDecision(input: TUIDecisionAnswer) {
      answers.push(input);
      return fake.answerDecision(input);
    },
  };
  return {
    service: service as unknown as TUIService,
    prompts,
    cancels,
    closes,
    answers,
  };
}

function makeSession(
  service: TUIService,
  options: { coreReconnectNoticeMs?: number } = {},
): TUISession {
  return new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: runtime.cwd(),
      version: "test",
      ...options,
    },
    service,
  );
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function assistantText(session: TUISession): string {
  const store = session.controller.store;
  let text = "";
  for (let i = 0; i < store.messages.length; i++) {
    const raw = store.assistantRaw(i);
    if (raw !== "") text += raw;
  }
  return text;
}

test("submitting text calls service.prompt and projects run events", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake, { liveRunID: "run-live" });
  const session = makeSession(rec.service);
  await session.start();
  const sessionId = session.currentSessionID();

  const pending = session.handleSubmit("hello");
  await tick();
  fake.emit(sessionId, "run-live", "text_delta", {
    agentEvent: {
      type: EVENT_TEXT_DELTA,
      textDelta: "Hello from the Core",
    },
  });
  fake.emit(
    sessionId,
    "run-live",
    "run_finished",
    {
      status: "completed",
      agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
    },
    true,
  );
  await pending;

  assertEquals(rec.prompts, [{ sessionId, text: "hello" }]);
  assertEquals(assistantText(session), "Hello from the Core");
  assertEquals(session.controller.runTerminalHandled, true);
  assertEquals(session.busy, false);
  // The service session adopts the persisted session identity.
  assertEquals(session.serviceSessionID, sessionId);
  await fake.openSession({ sessionId });
});

test("the accepted run ID is exposed to cancel and replay", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake, { liveRunID: "run-live" });
  const session = makeSession(rec.service);
  await session.start();
  const sessionId = session.currentSessionID();

  const pending = session.handleSubmit("continue");
  await tick();
  assertEquals(session.activeRunID, "run-live");
  session.cancelRun();
  await pending;

  assertEquals(rec.cancels, [{ sessionId, runId: "run-live" }]);
  assertEquals(session.activeRunID, "");
  assertEquals(session.busy, false);
  assertEquals(session.controller.runTerminalHandled, true);
});

test("close() closes the service session exactly once", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake);
  const session = makeSession(rec.service);
  await session.start();
  const sessionId = session.currentSessionID();

  await session.close();
  await session.close();
  assertEquals(rec.closes, [sessionId]);
});

test("decision answers correlate to the originating Core request", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake, { liveRunID: "run-live" });
  const session = makeSession(rec.service);
  await session.start();
  const sessionId = session.currentSessionID();

  const pending = session.handleSubmit("do it");
  await tick();
  fake.requestDecision({
    sessionId,
    runId: "run-live",
    requestId: "ap-1",
    kind: "approval",
    toolName: "write",
    args: { path: "notes.txt" },
  });
  assertEquals(session.controller.shownApproval?.approvalID, "ap-1");

  session.answerApproval(true);
  await tick();
  assertEquals(
    rec.answers.map((answer) => [answer.requestId, answer.approved]),
    [["ap-1", true]],
  );
  assertEquals(session.controller.shownApproval, undefined);
  // First response wins: the pending decision is consumed on the service side.
  await assertRejects(() =>
    fake.answerDecision({
      requestId: "ap-1",
      kind: "approval",
      approved: true,
    }),
  );

  fake.emit(
    sessionId,
    "run-live",
    "run_finished",
    {
      status: "completed",
      agentEvent: { type: EVENT_RUN_FINISHED, status: TASK_SUCCESS },
    },
    true,
  );
  await pending;
});

test("an early submit failure unwinds busy without a bound session", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake);
  const session = makeSession(rec.service);
  // start() is intentionally not called: the turn fails before the run exists
  // and must still release the busy state and report the failure.
  await session.handleSubmit("hello");
  assertEquals(session.busy, false);
  assertEquals(session.controller.isThinking, false);
  const errors = session.controller.store.messages.filter((message) =>
    message.startsWith("Error:"),
  );
  assert(errors.length >= 1, "expected a visible error row");
});

test("settling a dialog publishes its message exactly once without recursing", async () => {
  // Regression: #settleDialog used to publish the outcome message before
  // clearing the dialog, so addMessage -> scheduleRender -> requestRender ->
  // #settleDialog recursed on the same closed dialog until the stack blew.
  const fake = createFakeTUIService();
  const rec = recordingService(fake);
  const session = makeSession(rec.service);
  session.setRenderScheduler(() => {});

  await session.openDefaultModelDialog("global");
  const before = session.controller.store.messages.length;
  assert(session.handleDialogKey(splitInputChunk("\r")[0]));
  assert(session.handleDialogKey(splitInputChunk("\r")[0]));
  await tick();

  // Exactly one outcome message is published (its text is localized), and it
  // is published once — the pre-fix recursion published forever or crashed.
  const added = session.controller.store.messages.slice(before);
  assertEquals(added.length, 1);
  assert(added[0].length > 0);
  // The dialog settled: further keys are no longer consumed.
  assertEquals(session.handleDialogKey(splitInputChunk("\r")[0]), false);
});

test("a Core restart shows in the live view and never enters history", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake);
  const session = makeSession(rec.service, { coreReconnectNoticeMs: 20 });
  await session.start();

  const history = (): string[] => session.controller.store.messages;
  const before = history().length;

  // Reconnecting: a live-view line, never a transcript row.
  fake.setConnectionState("reconnecting");
  assertEquals(session.controller.coreConnection, "reconnecting");
  assertEquals(
    session.controller.coreConnectionNotice,
    session.translator.text("core.reconnecting"),
  );
  assertEquals(history().length, before, "the restart must not enter history");

  // Reconnected: confirmed in the same live view.
  fake.setConnectionState("connected");
  assertEquals(session.controller.coreConnection, "connected");
  assertEquals(
    session.controller.coreConnectionNotice,
    session.translator.text("core.reconnected"),
  );
  assertEquals(
    history().length,
    before,
    "the reconnect must not enter history",
  );

  // The confirmation clears itself, leaving the live view as it was.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(session.controller.coreConnectionNotice, "");
  assertEquals(session.controller.coreConnection, "connected");
  assertEquals(history().length, before);

  await session.close();
});

test("a replaced incompatible Core is reported locally and clears itself", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake);
  const session = makeSession(rec.service, { coreReconnectNoticeMs: 20 });
  await session.start();

  const history = (): number => session.controller.store.messages.length;
  const before = history();

  // A registered Core the client cannot talk to was replaced during startup.
  session.notifyCoreReplaced();
  assertEquals(
    session.controller.coreConnectionNotice,
    session.translator.text("core.replaced"),
  );
  assertEquals(session.controller.coreConnection, "connected");
  assertEquals(history(), before, "the replacement must not enter history");

  // The notice is localized: both dictionaries carry the key, and the session
  // uses the translator rather than an English literal.
  assert(session.translator.text("core.replaced").length > 0);
  assert(!session.translator.text("core.replaced").includes("undefined"));

  // It clears itself, and a later connection replay stays silent because a
  // healthy front end did not actually lose its connection.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(session.controller.coreConnectionNotice, "");

  await session.close();
});

test("a connected front end does not announce a reconnect it never lost", async () => {
  const fake = createFakeTUIService();
  const rec = recordingService(fake);
  const session = makeSession(rec.service, { coreReconnectNoticeMs: 20 });
  await session.start();

  // Subscribing replays the current state; a front end that was connected all
  // along must not claim it reconnected.
  assertEquals(session.controller.coreConnection, "connected");
  assertEquals(
    session.controller.coreConnectionNotice,
    "",
    "startup must not announce a reconnect",
  );

  // A real restart is still announced, and recovering clears the flag so the
  // replay of a later subscribe stays silent.
  fake.setConnectionState("reconnecting");
  assertEquals(
    session.controller.coreConnectionNotice,
    session.translator.text("core.reconnecting"),
  );
  fake.setConnectionState("connected");
  assertEquals(
    session.controller.coreConnectionNotice,
    session.translator.text("core.reconnected"),
  );
  fake.setConnectionState("connected");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assertEquals(session.controller.coreConnectionNotice, "");

  await session.close();
});
