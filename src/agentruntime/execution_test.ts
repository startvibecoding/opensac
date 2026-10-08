// execution_events_test.go, execution_persistence_test.go, and the durable
// portions of execution_observation_test.go.
//
// Deviation: the Go tests that drive `transitionMu`/`mu` directly are omitted
// because the port relies on the single-threaded event loop instead of explicit
// mutexes (see execution.ts).

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@opensac/assert";
import {
  type Event as AgentEvent,
  EVENT_RETRY,
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  EVENT_TOOL_EXECUTION_START,
  TASK_ERROR,
} from "../agent/events.ts";
import { RETRY_DECISION_REQUIRED, SIDE_EFFECT_UNKNOWN } from "./error_info.ts";
import { ExecutionRuntime } from "./execution.ts";
import { type RunEvent, type RunEventSink } from "./run_event.ts";
import { type DurableRun, type DurableRunStore } from "./run_store.ts";
import {
  RUN_STATE_CANCELLED,
  RUN_STATE_CANCELLING,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_RUNNING,
  RUN_STATE_WAITING_APPROVAL,
  type RunState,
} from "./run_state.ts";

function makeRun(partial: Partial<DurableRun>): DurableRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(0),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    userMessage: undefined,
    assistantEntryId: "",
    assistantMessage: undefined,
    conversationTurnId: "",
    conversationTurn: false,
    ...partial,
  };
}

class RecordingRunEventSink implements RunEventSink {
  events: RunEvent[] = [];
  record(ev: RunEvent): string {
    this.events.push({ ...ev });
    return "event-1";
  }
}

class RecordingDurableRunStore implements DurableRunStore {
  created: DurableRun[] = [];
  finished: { id: string; state: RunState; message: string }[] = [];
  createErr: Error | null = null;
  updateErr: Error | null = null;
  finishErr: Error | null = null;

  create(run: DurableRun): void {
    if (this.createErr !== null) throw this.createErr;
    this.created.push({ ...run });
  }

  update(id: string, state: RunState, message: string): void {
    if (this.updateErr !== null) throw this.updateErr;
    this.finished.push({ id, state, message });
  }

  finish(id: string, state: RunState, message: string): void {
    if (this.finishErr !== null) throw this.finishErr;
    this.finished.push({ id, state, message });
  }
}

class AtomicStartRunStore extends RecordingDurableRunStore {
  atomicCreated = 0;
  atomicRun: DurableRun | null = null;
  atomicEvent: RunEvent | null = null;

  createRunWithEvent(run: DurableRun, event: RunEvent): string {
    this.atomicCreated++;
    this.atomicRun = { ...run };
    this.atomicEvent = { ...event };
    return "started-1";
  }
}

class ObservationRunStore extends RecordingDurableRunStore {
  progress: unknown[] = [];
  errors: import("./error_info.ts").ErrorInfo[] = [];

  updateProgress(_id: string, value: unknown): void {
    this.progress.push(value);
  }

  updateErrorInfo(
    _id: string,
    value: import("./error_info.ts").ErrorInfo,
  ): void {
    this.errors.push(value);
  }
}

class IntentRunStore extends RecordingDurableRunStore {
  intents = new Map<string, import("../session/mod.ts").ExecutionIntent>();

  createIntentAndRun(
    intent: import("../session/mod.ts").ExecutionIntent,
    run: DurableRun,
  ): void {
    this.intents.set(intent.id, intent);
    this.created.push({ ...run });
  }

  getIntent(id: string): import("../session/mod.ts").ExecutionIntent | null {
    return this.intents.get(id) ?? null;
  }
}

Deno.test("execution runtime exclusive begin and finish", () => {
  const runtime = new ExecutionRuntime();
  const ctx = runtime.begin(undefined, "run-1");
  assert(ctx !== undefined);
  assertThrows(() => runtime.begin(undefined, "run-2"));
  const active = runtime.active();
  assert(active.active && active.runId === "run-1");
  assert(runtime.cancel());
  assert(ctx.aborted);
  runtime.finish("run-1");
  assert(!runtime.active().active);
  assertEquals(runtime.stateValue(), RUN_STATE_COMPLETED);
  runtime.begin(undefined, "run-2");
});

Deno.test("execution runtime cancel needs explicit terminal state", () => {
  const runtime = new ExecutionRuntime();
  const ctx = runtime.begin(undefined, "run-1");
  assert(runtime.cancel());
  assertEquals(runtime.stateValue(), RUN_STATE_CANCELLING);
  assert(ctx.aborted);
  runtime.finishWithState("run-1", RUN_STATE_CANCELLED);
  assertEquals(runtime.stateValue(), RUN_STATE_CANCELLED);
});

Deno.test("execution runtime wait and resume", () => {
  const runtime = new ExecutionRuntime();
  runtime.begin(undefined, "run-1");
  assertEquals(runtime.stateValue(), RUN_STATE_RUNNING);
  runtime.waitForApproval("run-1");
  assertEquals(runtime.stateValue(), RUN_STATE_WAITING_APPROVAL);
  runtime.resume("run-1");
  assertEquals(runtime.stateValue(), RUN_STATE_RUNNING);
  assertThrows(() => runtime.waitForQuestion("other"));
  runtime.finish("run-1");
});

Deno.test("execution runtime explicit terminal states", () => {
  const runtime = new ExecutionRuntime();
  runtime.begin(undefined, "run-1");
  runtime.finishWithState("run-1", RUN_STATE_FAILED);
  assertEquals(runtime.stateValue(), RUN_STATE_FAILED);
  assertThrows(() => runtime.finishWithState("run-1", RUN_STATE_COMPLETED));
});

Deno.test("execution runtime finish ignores different run", () => {
  const runtime = new ExecutionRuntime();
  runtime.begin(undefined, "run-1");
  runtime.finish("other");
  const active = runtime.active();
  assert(active.active && active.runId === "run-1");
});

Deno.test("execution runtime begin and finish with events", () => {
  const sink = new RecordingRunEventSink();
  const runtime = new ExecutionRuntime();
  runtime.setEventSink(sink);
  runtime.beginWithEvent(undefined, "run-1", {
    sessionId: "session-1",
    runId: "",
    eventType: "started",
    status: "running",
    source: "",
    model: "",
    mode: "",
  });
  runtime.finishWithEvent("run-1", RUN_STATE_COMPLETED, {
    sessionId: "session-1",
    runId: "",
    eventType: "finished",
    status: "completed",
    source: "",
    model: "",
    mode: "",
  });
  assertEquals(sink.events.length, 2);
  assertEquals(sink.events[0].eventType, "started");
  assertEquals(sink.events[1].eventType, "finished");
  assertEquals(sink.events[0].runId, "run-1");
  assertEquals(sink.events[1].runId, "run-1");
});

Deno.test("execution runtime wait sees terminal transition", async () => {
  const runtime = new ExecutionRuntime();
  runtime.begin(undefined, "run-wait");
  const finished = (async () => {
    await new Promise((r) => setTimeout(r, 10));
    runtime.finishWithState("run-wait", RUN_STATE_COMPLETED);
  })();
  await runtime.wait();
  await finished;
  assertEquals(runtime.stateValue(), RUN_STATE_COMPLETED);
});

Deno.test("execution runtime begin durable uses atomic start store", () => {
  const store = new AtomicStartRunStore();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  runtime.beginDurable(
    undefined,
    makeRun({
      id: "run-atomic",
      sessionId: "session-atomic",
      status: "running",
    }),
    {
      sessionId: "",
      runId: "",
      eventType: "started",
      status: "",
      source: "",
      model: "",
      mode: "",
    },
  );
  assertEquals(store.atomicCreated, 1);
  assertEquals(store.created.length, 0);
  assertEquals(store.atomicRun?.id, "run-atomic");
  assertEquals(store.atomicEvent?.eventType, "started");
  assertEquals(store.atomicEvent?.id ?? "", "");
});

Deno.test("execution runtime durable lifecycle", () => {
  const store = new RecordingDurableRunStore();
  const sink = new RecordingRunEventSink();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  runtime.setEventSink(sink);
  const run = makeRun({
    id: "run-1",
    sessionId: "session-1",
    status: "running",
  });
  runtime.beginDurable(undefined, run, {
    sessionId: "",
    runId: "",
    eventType: "started",
    status: "",
    source: "",
    model: "",
    mode: "",
  });
  runtime.finishDurable("run-1", RUN_STATE_COMPLETED, "", {
    sessionId: run.sessionId,
    runId: "",
    eventType: "finished",
    status: "",
    source: "",
    model: "",
    mode: "",
  });
  assertEquals(store.created.length, 1);
  assertEquals(store.finished.length, 1);
  assertEquals(store.finished[0].state, RUN_STATE_COMPLETED);
  assertEquals(sink.events.length, 2);
  assertEquals(sink.events[0].runId, "run-1");
  assertEquals(sink.events[1].status, RUN_STATE_COMPLETED);
});

Deno.test("execution runtime update durable persists running", () => {
  const store = new RecordingDurableRunStore();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  runtime.beginDurable(
    undefined,
    makeRun({ id: "run-1", sessionId: "session-1", status: "queued" }),
    {
      sessionId: "",
      runId: "",
      eventType: "started",
      status: "",
      source: "",
      model: "",
      mode: "",
    },
  );
  runtime.updateDurable("run-1", RUN_STATE_RUNNING, "remote started");
  assertEquals(runtime.stateValue(), RUN_STATE_RUNNING);
  assertEquals(store.finished.length, 1);
  assertEquals(store.finished[0].state, RUN_STATE_RUNNING);
});

Deno.test("execution runtime update durable rejects terminal state", () => {
  const runtime = new ExecutionRuntime();
  assertThrows(() => runtime.updateDurable("run-1", RUN_STATE_COMPLETED, ""));
});

Deno.test("execution runtime cancel durable persists cancelling", () => {
  const store = new RecordingDurableRunStore();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  runtime.beginDurable(
    undefined,
    makeRun({ id: "run-1", sessionId: "session-1" }),
    {
      sessionId: "",
      runId: "",
      eventType: "started",
      status: "",
      source: "",
      model: "",
      mode: "",
    },
  );
  assert(runtime.cancelDurable("requested"));
  assertEquals(store.finished.length, 1);
  assertEquals(store.finished[0].state, RUN_STATE_CANCELLING);
});

Deno.test("execution runtime durable begin compensates create failure", () => {
  const store = new RecordingDurableRunStore();
  store.createErr = new Error("write failed");
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  assertThrows(() =>
    runtime.beginDurable(
      undefined,
      makeRun({ id: "run-1", sessionId: "session-1" }),
      {
        sessionId: "",
        runId: "",
        eventType: "started",
        status: "",
        source: "",
        model: "",
        mode: "",
      },
    )
  );
  assert(!runtime.active().active);
  assertEquals(runtime.stateValue(), RUN_STATE_FAILED);
});

Deno.test("execution runtime intent admission and linked retry", () => {
  const store = new IntentRunStore();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  const intent = {
    id: "intent-1",
    sessionId: "session-1",
    source: "",
    model: "",
    mode: "",
    workDir: "",
    requestFingerprint: "",
    request: undefined,
    policy: undefined,
    createdAt: new Date(0),
  };
  const first = makeRun({
    id: "run-1",
    sessionId: "session-1",
    intentId: intent.id,
    attempt: 1,
    status: "queued",
  });
  runtime.beginIntentDurable(undefined, intent, first, {
    sessionId: "",
    runId: "",
    eventType: "started",
    status: "",
    source: "",
    model: "",
    mode: "",
  });
  runtime.finishDurable("run-1", RUN_STATE_FAILED, "failed", {
    sessionId: "session-1",
    runId: "",
    eventType: "failed",
    status: "",
    source: "",
    model: "",
    mode: "",
  });
  const retry = makeRun({
    id: "run-2",
    sessionId: "session-1",
    intentId: intent.id,
    retryOf: "run-1",
    attempt: 2,
    status: "queued",
  });
  const { intent: loaded } = runtime.beginRetryDurable(undefined, retry, {
    sessionId: "",
    runId: "",
    eventType: "started",
    status: "",
    source: "",
    model: "",
    mode: "",
  });
  assertEquals(loaded.id, intent.id);
  assertEquals(store.created.length, 2);
  assertEquals(store.created[0].id, "run-1");
  assertEquals(store.created[1].id, "run-2");
  assertEquals(store.created[1].retryOf, "run-1");
});

Deno.test("execution runtime observe agent event persists retry and safe terminal error", () => {
  const store = new ObservationRunStore();
  const sink = new RecordingRunEventSink();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  runtime.setEventSink(sink);
  const run = makeRun({
    id: "run-observe",
    sessionId: "session-observe",
    intentId: "intent-observe",
    source: "acp",
    model: "model",
    mode: "agent",
  });
  runtime.beginDurable(undefined, run, {
    sessionId: "",
    runId: "",
    eventType: "started",
    status: "",
    source: "",
    model: "",
    mode: "",
  });

  const observed = runtime.observeAgentEvent({
    type: EVENT_RETRY,
    retryAttempt: 2,
    retryMaxAttempts: 3,
    retryAfterMs: 1200,
    retryReason: "provider timeout",
    statusMessage:
      `"auto" tool choice requires --enable-auto-tool-choice (api_key=sk-secret-123)`,
  } as AgentEvent);
  assert(observed.retry !== undefined);
  assertEquals(observed.retry!.attempt, 2);
  assertEquals(observed.retry!.maxAttempts, 3);
  assertEquals(observed.retry!.retryAfterMs, 1200);
  assertEquals(store.progress.length, 1);
  const retryInfo = store.progress[0] as {
    reasonCode: string;
    message: string;
  };
  assertEquals(retryInfo.reasonCode, "timeout");
  assert(retryInfo.message.includes(`"auto" tool choice requires`));
  assert(!retryInfo.message.includes("sk-secret-123"));
  assert(retryInfo.message.includes("[redacted]"));
  assertEquals(sink.events.length, 2);
  assertEquals(sink.events[1].eventType, "run_retrying");
  assertEquals(sink.events[1].status, RUN_STATE_RUNNING);
  const dataText = sink.events[1].data as string;
  assert(dataText.includes(`"message":`));
  assert(!dataText.includes("sk-secret-123"));

  runtime.observeAgentEvent({
    type: EVENT_TEXT_DELTA,
    textDelta: "partial answer",
  } as AgentEvent);
  runtime.observeAgentEvent({
    type: EVENT_TOOL_EXECUTION_START,
    toolName: "bash",
  } as AgentEvent);
  const terminal = runtime.observeAgentEvent({
    type: EVENT_RUN_FINISHED,
    status: TASK_ERROR,
    error: new Error("HTTP 503 provider returned secret diagnostic"),
  } as AgentEvent);
  assert(terminal.error !== undefined);
  assertEquals(terminal.error!.retryMode, RETRY_DECISION_REQUIRED);
  assertEquals(terminal.error!.sideEffectState, SIDE_EFFECT_UNKNOWN);
  assert(terminal.error!.partialOutput === true);
  assertEquals(
    terminal.error!.message,
    "HTTP 503 provider returned secret diagnostic",
  );
  assertEquals(terminal.error!.detail, terminal.error!.message);
  assertEquals(store.errors.length, 1);
  assertEquals(store.errors[0].intentId, run.intentId);
  assertEquals(store.progress.length, 2);
  assertEquals(JSON.stringify(store.progress[1]), "{}");
});

Deno.test("execution runtime shutdown persists terminal event and is idempotent", async () => {
  const store = new ObservationRunStore();
  const sink = new RecordingRunEventSink();
  const runtime = new ExecutionRuntime();
  runtime.setRunStore(store);
  runtime.setEventSink(sink);
  const run = makeRun({
    id: "run-shutdown",
    sessionId: "session-shutdown",
    source: "acp",
    model: "model-shutdown",
    mode: "agent",
    status: "running",
  });
  runtime.beginDurable(undefined, run, {
    sessionId: run.sessionId,
    runId: "",
    eventType: "started",
    source: run.source,
    model: run.model,
    mode: run.mode,
    status: "running",
  });
  await runtime.shutdown("process stopped");
  await runtime.shutdown("process stopped again");
  assertEquals(runtime.stateValue(), RUN_STATE_CANCELLED);
  assertEquals(store.finished.length, 1);
  assertEquals(store.finished[0].state, RUN_STATE_CANCELLED);
  assert(!store.finished[0].message.includes("process stopped"));
  assertEquals(sink.events.length, 2);
  assertEquals(sink.events[1].eventType, "finished");
  assertEquals(sink.events[1].status, RUN_STATE_CANCELLED);
  const data = sink.events[1].data as {
    errorInfo: { code: string; message: string };
  };
  assertEquals(data.errorInfo.code, "run_cancelled");
  assert(data.errorInfo.message !== "");
  assert(!data.errorInfo.message.includes("process stopped"));
  assertEquals(store.errors.length, 1);
  assertEquals(store.errors[0].code, data.errorInfo.code);
});

Deno.test("execution runtime shutdown waits for bound agent loop", async () => {
  const runtime = new ExecutionRuntime();
  const ctx = runtime.begin(undefined, "run-shutdown");
  runtime.setAgent({ abort: () => {} });
  let release = false;
  const finished = (async () => {
    await new Promise<void>((resolve) => {
      if (ctx.aborted) resolve();
      else ctx.addEventListener("abort", () => resolve(), { once: true });
    });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    runtime.finishWithState("run-shutdown", RUN_STATE_CANCELLED);
  })();

  await assertRejects(
    () =>
      runtime.shutdownContext(AbortSignal.timeout(20), "shutdown requested"),
    DOMException,
  );
  assert(runtime.active().active);

  release = true;
  await runtime.shutdownContext(undefined, "shutdown requested");
  await finished;
  assert(!runtime.active().active);
  assertEquals(runtime.stateValue(), RUN_STATE_CANCELLED);
});
