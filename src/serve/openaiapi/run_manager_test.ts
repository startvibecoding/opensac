// Translated from internal/serve/openaiapi/server_test.go — the RunManager
// cluster (TestRunManager_RecoverOrphanedRuns*, TestRunManager_Cancel*,
// TestRunManager_FinalizeOnceIdempotent, TestRunManager_ActiveReturnsNil*)
// and TestServer_FinalizeRunIsIdempotent. The run rows are exercised against
// real temp session roots through the RunManager compatibility bridge, the
// same surface the Go tests use.
import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { newManager } from "../../session/manager.ts";
import type { SessionRun } from "../../session/run_store.ts";
import { EventChannel } from "../../agent/event_channel.ts";
import type { Event } from "../../agent/events.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import { finalizeRun, RunManager } from "./run_manager.ts";
import type { Config } from "./config.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function newRun(
  id: string,
  sessionId: string,
  status: string,
  overrides: Partial<SessionRun> = {},
): SessionRun {
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
    status,
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
    ...overrides,
  };
}

Deno.test("runManagerRecoverOrphanedRunsFailsOrphansOnly", async () => {
  const sessionDir = tempDir("openaiapi-rm-recover-");
  try {
    const mgr = newManager(tempDir("openaiapi-rm-recover-work-"), sessionDir);
    mgr.initWithID("sess-1");

    const rm = new RunManager(sessionDir);
    // Create an orphaned run (non-terminal status).
    rm.create(newRun("orphan-1", "sess-1", "running"));
    // Create a terminal run (should not be affected).
    rm.create(
      newRun("done-1", "sess-1", "completed", { finishedAt: new Date() }),
    );

    await rm.recoverOrphanedRuns();

    assertEquals(rm.get("orphan-1")?.status, "failed");
    assertEquals(rm.get("done-1")?.status, "completed");
  } finally {
    closeAll();
  }
});

Deno.test("runManagerRecoverOrphanedRunsExceptKeepsRemoteRuns", async () => {
  const sessionDir = tempDir("openaiapi-rm-recover-except-");
  try {
    for (const id of ["sess-1", "sess-2"]) {
      const mgr = newManager(tempDir("openaiapi-rm-except-work-"), sessionDir);
      mgr.initWithID(id);
    }
    const rm = new RunManager(sessionDir);
    rm.create(
      newRun("responses-run", "sess-1", "running", {
        source: "responses_background",
      }),
    );
    rm.create(newRun("local-run", "sess-2", "running", { source: "webui" }));

    await rm.recoverOrphanedRunsExcept((run) =>
      run.source === "responses_background"
    );

    assertEquals(rm.get("responses-run")?.status, "running");
    assertEquals(rm.get("local-run")?.status, "failed");
  } finally {
    closeAll();
  }
});

Deno.test("runManagerCancelRunInTerminalStateReturnsFalse", () => {
  const sessionDir = tempDir("openaiapi-rm-cancel-terminal-");
  try {
    const rm = new RunManager(sessionDir);
    rm.create(
      newRun("terminal-run", "sess-1", "completed", {
        finishedAt: new Date(),
      }),
    );

    // Cancelling a terminal run should return false.
    assertEquals(rm.cancel("terminal-run"), false);
    // Verify the run status is unchanged.
    assertEquals(rm.get("terminal-run")?.status, "completed");
  } finally {
    closeAll();
  }
});

Deno.test("runManagerCancelDBOnlyRunMarksCancelling", () => {
  const sessionDir = tempDir("openaiapi-rm-cancel-dbonly-");
  try {
    const rm = new RunManager(sessionDir);
    // Create the run in DB but NOT in memory (no attach).
    rm.create(newRun("db-only-run", "sess-1", "running"));

    // Cancel should succeed even without in-memory cancel func.
    assertEquals(rm.cancel("db-only-run"), true);
    // Verify the run status is updated to cancelling.
    assertEquals(rm.get("db-only-run")?.status, "cancelling");
  } finally {
    closeAll();
  }
});

Deno.test("runManagerFinalizeOnceIsIdempotent", () => {
  const sessionDir = tempDir("openaiapi-rm-finalize-once-");
  try {
    const rm = new RunManager(sessionDir);
    rm.create(newRun("finalize-once-run", "sess-1", "running"));

    let callCount = 0;
    const fn = () => callCount++;

    // First call should execute.
    assertEquals(rm.finalizeOnce("finalize-once-run", fn), true);
    assertEquals(callCount, 1);

    // Second call should be a no-op.
    assertEquals(rm.finalizeOnce("finalize-once-run", fn), false);
    assertEquals(callCount, 1);
  } finally {
    closeAll();
  }
});

Deno.test("runManagerActiveReturnsNullForNoActiveRun", () => {
  const sessionDir = tempDir("openaiapi-rm-active-");
  try {
    const rm = new RunManager(sessionDir);
    assertEquals(rm.active("nonexistent-session"), null);
  } finally {
    closeAll();
  }
});

Deno.test("runManagerSubscribePublishesAndClosesSubscribers", async () => {
  const sessionDir = tempDir("openaiapi-rm-subscribe-");
  try {
    const rm = new RunManager(sessionDir);
    rm.register(newRun("sub-run", "sess-1", "running"));

    const { events, cancel } = rm.subscribe("sub-run");
    const collected: string[] = [];
    const reader = (async () => {
      for await (const ev of events) {
        collected.push(ev.textDelta ?? "");
      }
    })();

    const ch = new EventChannel();
    ch.push({ type: 7, textDelta: "hello" } as Event);
    ch.close();
    rm.start("sub-run", ch);
    await reader;

    assert(collected.includes("hello"));
    // After the stream ends the subscribers are closed; further publish drops.
    rm.publish("sub-run", { type: 7, textDelta: "late" } as Event);
    cancel();

    // Unknown runs reject subscribe/start like Go.
    let threw = false;
    try {
      rm.subscribe("missing-run");
    } catch {
      threw = true;
    }
    assert(threw);
  } finally {
    closeAll();
  }
});

Deno.test("serverFinalizeRunIsIdempotent", () => {
  const cwd = tempDir("openaiapi-rm-finalize-");
  const sessionDir = `${cwd}/sessions`;
  try {
    let completionCalls = 0;
    const server = new Server({
      cfg: { defaultMode: "yolo" } as Config,
      settings: { sessionDir } as never,
      runManager: new RunManager(sessionDir),
      pool: new SessionPool(0, 0),
      runComplete: (_sessionId, _runId, _status, _errMsg) => {
        completionCalls++;
      },
    });
    server.streamHub = newSessionStreamHub();
    server.eventBroker = new EventBroker();

    const runID = "finalize-run-1";
    const sess = new APISession();
    sess.id = "sess-finalize-1";
    sess.workDir = cwd;
    sess.manager = newManager(cwd, sessionDir);
    sess.manager.init();
    sess.beginRun(runID);

    // Create the run in the RunManager first (as the handler does).
    server.runManager!.create(newRun(runID, sess.id, "running"));

    // First call: should succeed.
    finalizeRun(server, sess, runID, "completed", "");

    // Second call: should be a no-op because of the finalize-once guard.
    // This must not panic, duplicate events, or corrupt state.
    finalizeRun(server, sess, runID, "completed", "");

    // Verify the run is now terminal in the DB.
    const run = server.runManager!.get(runID);
    assert(run !== null, "run not found after finalization");
    assertEquals(run.status, "completed");
    assert(run.finishedAt !== null, "expected FinishedAt to be set");
    assertEquals(completionCalls, 1);
  } finally {
    closeAll();
  }
});
