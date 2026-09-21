// Translated from internal/serve/channels/watchdog_test.go (the watchdog and
// rotate-admission cases; the /stop /status /new command cases land with the
// handleCommand slice).

import { assert } from "@std/assert";
import { newAgent } from "../../agent/mod.ts";
import { newRegistry } from "../../tools/tool.ts";
import {
  getSessionRun,
  listSessionRunEvents,
  lockRuntime,
  newManager,
  saveSessionRun,
  type SessionRun,
} from "../../session/mod.ts";
import {
  awaitRuntimeRelease,
  ChannelSession,
  Dispatcher,
  ErrSessionRunBusy,
} from "./dispatcher.ts";
import { sessionKey } from "./session_paths.ts";
import { checkStalledRuns } from "./watchdog.ts";
import { defaultConfig } from "./config.ts";

function baseSessionRun(overrides: Partial<SessionRun>): SessionRun {
  const now = new Date();
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
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: "",
    errorInfo: undefined,
    progress: undefined,
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    ...overrides,
  };
}

function newWatchdogTestDispatcher(cfg = defaultConfig()): Dispatcher {
  const d = new Dispatcher({ cfg });
  d.sessionDir = Deno.makeTempDirSync({ prefix: "mothx-watchdog-" });
  return d;
}

interface RunningSession {
  sess: ChannelSession;
  cancelled: () => boolean;
  runningAgent: ReturnType<typeof newAgent>;
}

function registerRunningSession(
  d: Dispatcher,
  sessionID: string,
  startedAt: Date,
  lastEventAt: Date,
): RunningSession {
  saveSessionRun(
    d.sessionDir,
    baseSessionRun({
      id: "run-1",
      sessionId: sessionID,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    }),
  );
  const controller = new AbortController();
  const runningAgent = newAgent(
    { mode: "yolo" },
    newRegistry(Deno.makeTempDirSync(), undefined),
  );
  const sess = new ChannelSession();
  sess.id = sessionID;
  sess.platform = "wechat";
  sess.userID = "u1";
  sess.runID = "run-1";
  sess.runCancel = () => controller.abort();
  sess.runAgent = runningAgent;
  sess.runStartedAt = startedAt;
  sess.lastEventAt = lastEventAt;
  d.sessions.set(sessionKey("wechat", "u1"), sess);
  return {
    sess,
    cancelled: () => controller.signal.aborted,
    runningAgent,
  };
}

async function assertAgentAborted(
  a: ReturnType<typeof newAgent>,
): Promise<void> {
  const answer = await a.requestQuestion(undefined, undefined, "q", ["a"], "");
  if (answer !== "") {
    throw new Error("expected aborted agent to unblock question waits");
  }
}

Deno.test("watchdog force stops stale run", async () => {
  const d = newWatchdogTestDispatcher();
  const now = new Date();
  const { sess, cancelled, runningAgent } = registerRunningSession(
    d,
    "sess-stale",
    new Date(now.getTime() - 3600_000),
    new Date(now.getTime() - 3600_000),
  );

  checkStalledRuns(d, now);

  assert(cancelled(), "watchdog did not cancel the stalled run context");
  await assertAgentAborted(runningAgent);

  const run = getSessionRun(d.sessionDir, "run-1");
  assert(run !== null && run !== undefined, "run row missing");
  assert(run!.status === "cancelling", `run status = ${run!.status}`);
  assert(run!.error.includes("watchdog"), `run error = ${run!.error}`);
  const events = listSessionRunEvents(d.sessionDir, sess.id);
  assertEqualsWatchdog(events, 1);

  // A run that ignores abort must not be spammed on every tick.
  checkStalledRuns(d, new Date(now.getTime() + 2 * 3600_000));
  const events2 = listSessionRunEvents(d.sessionDir, sess.id);
  assertEqualsWatchdog(events2, 1, "watchdog refired");
});

function assertEqualsWatchdog(
  events: ReturnType<typeof listSessionRunEvents>,
  want: number,
  msg = "",
): void {
  const count = events.filter((ev) => ev.source === "channel:watchdog").length;
  assert(
    count === want,
    `watchdog events = ${count}, want ${want} ${msg}`,
  );
}

Deno.test("watchdog skips active run", () => {
  const d = newWatchdogTestDispatcher();
  const now = new Date();
  const { cancelled } = registerRunningSession(
    d,
    "sess-active",
    new Date(now.getTime() - 60_000),
    now,
  );

  checkStalledRuns(d, now);

  assert(
    !cancelled(),
    "watchdog cancelled a run that is still making progress",
  );
  const run = getSessionRun(d.sessionDir, "run-1");
  assert(run !== null && run !== undefined, "run row missing");
  assert(run!.status === "running", `run status = ${run!.status}`);
});

Deno.test("watchdog force stops overlong run", () => {
  const cfg = defaultConfig();
  cfg.agent.runMaxDurationSecs = 60;
  const d = newWatchdogTestDispatcher(cfg);
  const now = new Date();
  // Recent heartbeat: only the total-duration cap can fire.
  const { cancelled } = registerRunningSession(
    d,
    "sess-long",
    new Date(now.getTime() - 2 * 3600_000),
    now,
  );

  checkStalledRuns(d, now);

  assert(cancelled(), "watchdog did not cancel an overlong run");
  const run = getSessionRun(d.sessionDir, "run-1");
  assert(run !== null && run !== undefined, "run row missing");
  assert(run!.status === "cancelling", `run status = ${run!.status}`);
  assert(run!.error.includes("max duration"), `run error = ${run!.error}`);
});

Deno.test("acquire runtime for rotate busy without force", async () => {
  const d = newWatchdogTestDispatcher();
  const workDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, d.sessionDir);
  mgr.initWithID("sess-busy");
  const release = await lockRuntime(d.sessionDir, "sess-busy");
  try {
    let err: unknown = null;
    try {
      await d.acquireRuntimeForRotate(
        undefined,
        d.sessionDir,
        "sess-busy",
        false,
      );
    } catch (e) {
      err = e;
    }
    assert(err === ErrSessionRunBusy, `err = ${err}, want ErrSessionRunBusy`);
  } finally {
    release();
  }
});

Deno.test("acquire runtime for rotate force cancels and acquires", async () => {
  const d = newWatchdogTestDispatcher();
  const workDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, d.sessionDir);
  mgr.initWithID("sess-force");
  const release = await lockRuntime(d.sessionDir, "sess-force");

  const controller = new AbortController();
  const sess = new ChannelSession();
  sess.id = "sess-force";
  sess.platform = "wechat";
  sess.userID = "u1";
  sess.runID = "run-force";
  sess.runCancel = () => controller.abort();
  d.sessions.set(sessionKey("wechat", "u1"), sess);

  // The runtime lock is released once the forced cancellation is delivered
  // through the stop path's legacy local-cancel hook.
  const originalCancel = sess.runCancel;
  sess.runCancel = () => {
    originalCancel!();
    release();
  };

  const acquired = await d.acquireRuntimeForRotate(
    undefined,
    d.sessionDir,
    "sess-force",
    true,
  );
  acquired();
  assert(
    controller.signal.aborted,
    "forced rotation did not cancel the active run",
  );

  // Sanity: the shared grace helper reports null for an absent lease holder.
  const none = await awaitRuntimeRelease(
    undefined,
    d.sessionDir,
    "sess-other",
    100,
  );
  assert(none === null);
});
