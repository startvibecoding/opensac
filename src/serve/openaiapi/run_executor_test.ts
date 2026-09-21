// Translated from internal/serve/openaiapi/server_test.go — the RunExecutor
// cluster (TestRunExecutor_* and TestRunExecutorFinalizeDefersDurableDone).
// The agent-construction-heavy fixtures use the stub-agent pattern the
// test-hygiene guard requires (execute() only forwards the agent to the
// approval/question registration paths, which these events do not reach), and
// the persistence assertions run against real temp session roots.
import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { EventChannel } from "../../agent/event_channel.ts";
import {
  type Event,
  EventDone,
  EventError,
  EventHostedItem,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
  EventUsage,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../../agent/events.ts";
import { listSessionRunEvents } from "../../session/session_events.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import type { TranscriptStreamEvent } from "./types.ts";
import { newRunExecutor } from "./run_executor.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { getWorkDir } from "./config.ts";
import type { Config } from "./config.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function newExecutorServer(opts: {
  sessionDir: string;
  workDir: string;
}): Server {
  const server = new Server({
    settings: { sessionDir: opts.sessionDir } as never,
    cfg: { defaultMode: "yolo", defaultWorkDir: opts.workDir } as Config,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  return server;
}

function minimalServer(): Server {
  const server = new Server({ cfg: { defaultMode: "yolo" } as Config });
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  return server;
}

function newSession(): APISession {
  const sess = new APISession();
  sess.id = "sess-1";
  sess.workDir = "/tmp/test";
  return sess;
}

function channelOf(events: Event[]): EventChannel {
  const ch = new EventChannel();
  for (const ev of events) ch.push(ev);
  ch.close();
  return ch;
}

function run(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "/tmp/test",
    source: "",
    model: "",
    mode: "",
    status: "running",
    startedAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: null,
    progress: null,
    usage: null,
    contextUsage: null,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
  };
}

Deno.test("runExecutorProcessesEventTypes", async () => {
  const srv = minimalServer();
  const runID = "exec-test-run";
  const executor = newRunExecutor(srv, srv.eventBroker, run(runID, "sess-1"));
  const sess = newSession();

  const eventCh = channelOf([
    { type: EventTextDelta, textDelta: "hello" },
    {
      type: EventToolCall,
      toolName: "read",
      toolArgs: { path: "/tmp/test" },
      toolCallId: "call-1",
    },
    {
      type: EventToolExecutionEnd,
      toolName: "read",
      toolCallId: "call-1",
      toolResult: "file content",
    },
    {
      type: EventUsage,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    { type: EventDone },
  ]);

  const result = await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );
  assertEquals(result.status, "completed");
  assert(result.usage !== undefined);
  assertEquals(result.usage!.prompt_tokens, 10);
  assertEquals(result.usage!.completion_tokens, 5);
  assertEquals(result.toolCalls.length, 1);
  assertEquals(result.toolCalls[0].name, "read");
  assertEquals(result.toolCalls[0].status, "completed");
});

Deno.test("runExecutorTextDeltaPublishedAsAssistantDelta", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("delta-run", "sess-1"),
  );
  const sess = newSession();

  const { events, cancel } = srv.eventBroker!.subscribe("sess-1");

  const eventCh = channelOf([
    { type: EventTextDelta, textDelta: "hello" },
    { type: EventTextDelta, textDelta: " world" },
    { type: EventDone },
  ]);
  await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );

  const deltas: string[] = [];
  const deadline = Date.now() + 2000;
  while (deltas.length < 2 && Date.now() < deadline) {
    const ev = await Promise.race([
      events.next(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 200)),
    ]);
    if (ev === undefined) continue;
    if (ev.event !== "transcript") continue;
    const evt = ev.data as TranscriptStreamEvent;
    if (evt.type !== "assistant_delta") {
      throw new Error(`transcript event type = ${evt.type}`);
    }
    const message = evt.message as { role?: string; content?: string };
    if (message?.role !== "assistant") {
      throw new Error(`transcript message = ${JSON.stringify(message)}`);
    }
    deltas.push(message.content ?? "");
  }
  cancel();
  assertEquals(deltas, ["hello", " world"]);
});

Deno.test("runExecutorFinalizeDefersDurableDone", async () => {
  const srv = minimalServer();
  const sess = newSession();
  sess.id = "durable-finalize-session";
  const runID = "durable-finalize-run";
  sess.markDurableRun(runID);
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run(runID, sess.id),
  );
  const { events, cancel } = srv.eventBroker!.subscribe(sess.id);

  executor.finalize(sess, {
    runId: runID,
    sessionId: sess.id,
    status: "completed",
    error: "",
    toolCalls: [],
    attachments: [],
    modelId: "",
    startTime: new Date(),
  });
  // Durable finalize must not publish a stream terminal event before the
  // FinishDurable commit; no event may arrive.
  const raced = await Promise.race([
    events.next().then(() => "event"),
    new Promise<string>((r) => setTimeout(() => r("timeout"), 150)),
  ]);
  assertEquals(raced, "timeout");
  cancel();
});

Deno.test("runExecutorAttachmentsPublishedAsTranscriptEvent", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("attachment-run", "sess-1"),
  );
  const sess = newSession();
  const { events, cancel } = srv.eventBroker!.subscribe("sess-1");

  const eventCh = channelOf([
    {
      type: EventDone,
      attachments: [
        {
          kind: "citation",
          name: "Source",
          url: "https://example.test/source",
        },
      ],
    } as Event,
  ]);
  await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );

  let published = false;
  const deadline = Date.now() + 2000;
  while (!published && Date.now() < deadline) {
    const ev = await Promise.race([
      events.next(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 200)),
    ]);
    if (ev === undefined) continue;
    if (ev.event !== "transcript") continue;
    const transcript = ev.data as TranscriptStreamEvent;
    const message = transcript.message as {
      attachments?: { url?: string }[];
    } | undefined;
    if (
      transcript.type === "attachments" && message &&
      message.attachments?.length === 1 && message.attachments[0].url !== ""
    ) {
      published = true;
    }
  }
  cancel();
  assert(published, "attachment transcript event not published");
});

Deno.test("runExecutorPersistsHostedItemLifecycleEvent", async () => {
  const sessionDir = tempDir("openaiapi-exec-hosted-");
  const workDir = tempDir("openaiapi-exec-hosted-work-");
  try {
    const srv = newExecutorServer({ sessionDir, workDir });
    const sess = await getOrCreateSession(
      srv,
      "hosted-lifecycle-run",
      getWorkDir(srv.cfg!),
    );
    const executor = newRunExecutor(
      srv,
      srv.getEventBroker(),
      run("hosted-lifecycle-run-id", sess.id),
    );
    const eventCh = channelOf([
      {
        type: EventHostedItem,
        hostedItem: {
          id: "search-".repeat(100),
          type: "web_search_call",
          status: "completed",
          outputIndex: 1,
          metadata: { title: "Source", secret: "do-not-persist" },
        },
      },
      { type: EventDone },
    ]);
    await executor.execute(
      undefined,
      sess,
      null,
      eventCh,
      "test-model",
      "agent",
      false,
    );

    const events = listSessionRunEvents(sessionDir, sess.id);
    let found = false;
    for (const item of events) {
      if (item.eventType !== "hosted_item") continue;
      const data = item.data as {
        hostedItem?: {
          id?: string;
          status?: string;
          metadata?: Record<string, unknown>;
        };
      };
      const hosted = data.hostedItem;
      if (
        hosted?.id?.endsWith("...") && hosted.status === "completed" &&
        hosted.metadata && !("secret" in hosted.metadata)
      ) {
        found = true;
      }
    }
    assert(
      found,
      `hosted lifecycle event not persisted: ${JSON.stringify(events)}`,
    );
  } finally {
    closeAll();
  }
});

Deno.test("runExecutorPersistsResponsesStateTransition", async () => {
  const sessionDir = tempDir("openaiapi-exec-resp-");
  const workDir = tempDir("openaiapi-exec-resp-work-");
  try {
    const srv = newExecutorServer({ sessionDir, workDir });
    const sess = await getOrCreateSession(
      srv,
      "responses-state-transition",
      getWorkDir(srv.cfg!),
    );
    const executor = newRunExecutor(
      srv,
      srv.getEventBroker(),
      {
        ...run("responses-state-run", sess.id),
        source: "chat_completion",
        mode: "agent",
      },
    );
    const eventCh = channelOf([
      {
        type: EventStatus,
        statusMessage:
          "remote Responses lineage unavailable; retrying this turn from local replay",
        responseStateFailureClass: "expired",
      },
      { type: EventDone },
    ]);
    await executor.execute(
      undefined,
      sess,
      null,
      eventCh,
      "test-model",
      "agent",
      false,
    );

    const events = listSessionRunEvents(sessionDir, sess.id);
    assertEquals(events.length, 1);
    assertEquals(events[0].eventType, "responses_state_transition");
    assertEquals(events[0].status, "retrying");
    assertEquals(
      (events[0].data as { failureClass?: string }).failureClass,
      "expired",
    );
  } finally {
    closeAll();
  }
});

Deno.test("runExecutorPersistsFailedResponsesStateTransition", async () => {
  const sessionDir = tempDir("openaiapi-exec-resp-fail-");
  const workDir = tempDir("openaiapi-exec-resp-fail-work-");
  try {
    const srv = newExecutorServer({ sessionDir, workDir });
    const sess = await getOrCreateSession(
      srv,
      "responses-state-failure",
      getWorkDir(srv.cfg!),
    );
    const executor = newRunExecutor(
      srv,
      srv.getEventBroker(),
      {
        ...run("responses-state-failure-run", sess.id),
        source: "chat_completion",
        mode: "agent",
      },
    );
    const eventCh = channelOf([
      {
        type: EventError,
        error: new Error("forbidden"),
        responseStateFailureClass: "permission",
      },
    ]);
    const result = await executor.execute(
      undefined,
      sess,
      null,
      eventCh,
      "test-model",
      "agent",
      false,
    );
    assertEquals(result.status, "failed");

    const events = listSessionRunEvents(sessionDir, sess.id);
    assertEquals(events.length, 1);
    assertEquals(events[0].eventType, "responses_state_transition");
    assertEquals(events[0].status, "failed");
    assertEquals(
      (events[0].data as { failureClass?: string }).failureClass,
      "permission",
    );
  } finally {
    closeAll();
  }
});

Deno.test("runExecutorContextCancellation", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("cancel-run", "sess-1"),
  );
  const sess = newSession();

  // Cancel immediately, before the executor processes the event. The executor
  // checks the signal between events, so it detects cancellation up front.
  const controller = new AbortController();
  controller.abort();

  const eventCh = channelOf([{
    type: EventTextDelta,
    textDelta: "before cancel",
  }]);
  const result = await executor.execute(
    controller.signal,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );
  assertEquals(result.status, "canceled");
});

Deno.test("runExecutorSubAgentEventsSkippedForDone", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("sa-run", "sess-1"),
  );
  const sess = newSession();

  // Sub-agent done should be skipped, main agent done should terminate.
  const eventCh = channelOf([
    { type: EventDone, agentId: "sub-agent-1" },
    { type: EventTextDelta, textDelta: "main output" },
    { type: EventDone },
  ]);
  const result = await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );
  assertEquals(result.status, "completed");
});

Deno.test("runExecutorErrorEvent", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("err-run", "sess-1"),
  );
  const sess = newSession();

  const eventCh = channelOf([{
    type: EventError,
    error: new Error("test error"),
  }]);
  const result = await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );
  assertEquals(result.status, "failed");
  assertEquals(result.error, "test error");
  assertEquals(result.errorInfo?.code, "run_failed");
  assertEquals(result.errorInfo?.detail, "test error");
});

Deno.test("runExecutorSubAgentErrorSkipped", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("sa-err-run", "sess-1"),
  );
  const sess = newSession();

  // Sub-agent error should be skipped, main agent done should terminate.
  const eventCh = channelOf([
    { type: EventError, agentId: "sub-agent-1", error: new Error("sub error") },
    { type: EventDone },
  ]);
  const result = await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );
  assertEquals(result.status, "completed");
});

Deno.test("runExecutorRunFinishedStatusMapping", async () => {
  const cases = [
    {
      name: "success",
      status: TaskSuccess,
      runErr: undefined,
      want: "completed",
    },
    {
      name: "incomplete",
      status: TaskIncomplete,
      runErr: undefined,
      want: "incomplete",
    },
    {
      name: "failed",
      status: TaskFailed,
      runErr: new Error("boom"),
      want: "failed",
    },
    {
      name: "canceled",
      status: TaskCanceled,
      runErr: new DOMException("aborted", "AbortError"),
      want: "canceled",
    },
  ];
  for (const tc of cases) {
    const srv = minimalServer();
    const executor = newRunExecutor(
      srv,
      srv.eventBroker,
      run(`rf-${tc.name}`, "sess-1"),
    );
    const sess = newSession();

    const events: Event[] = [
      {
        type: EventRunFinished,
        status: tc.status,
        error: tc.runErr,
        done: true,
      },
    ];
    // Legacy terminal events follow the canonical one and must not change the
    // outcome classification.
    if (tc.status === TaskFailed || tc.status === TaskCanceled) {
      events.push({ type: EventError, error: tc.runErr });
    } else {
      events.push({ type: EventDone });
    }

    const result = await executor.execute(
      undefined,
      sess,
      null,
      channelOf(events),
      "test-model",
      "agent",
      false,
    );
    assertEquals(result.status, tc.want, tc.name);
  }
});

Deno.test("runExecutorChannelClosedWithoutTerminalFails", async () => {
  const srv = minimalServer();
  const executor = newRunExecutor(
    srv,
    srv.eventBroker,
    run("no-terminal-run", "sess-1"),
  );
  const sess = newSession();

  const eventCh = channelOf([{
    type: EventTextDelta,
    textDelta: "partial output",
  }]);
  const result = await executor.execute(
    undefined,
    sess,
    null,
    eventCh,
    "test-model",
    "agent",
    false,
  );
  assertEquals(result.status, "failed");
  assertEquals(result.error, "The run stopped before it could finish.");
  assertEquals(result.errorInfo?.code, "event_stream_interrupted");
  assertEquals(result.errorInfo?.retryable, true);
});
