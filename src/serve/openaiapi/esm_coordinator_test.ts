// Translated from internal/serve/openaiapi/esm_coordinator_test.go — the
// coordinator start/stop lifecycle, the foreground-admission wait, the paused
// idle gate, the steering-source injection into normal WebUI agent options,
// the closed-runtime adapter failure, the worker-continue streak reset, and
// the unattended-mode policy derivation.
//
// Deviations: Go's context.WithCancel/done channel maps to an AbortController
// plus the worker promise; srv.runESMCoordinator(context.Background(), ...) is
// awaited; the stop helpers bind through wireESMCoordinator.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { acquireExecutionAdmission } from "../../agentruntime/execution_admission.ts";
import { listSessionRuns } from "../../session/run_store.ts";
import { statusComplete } from "../../esm/mod.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { newMockProvider } from "../../provider/mock.ts";
import {
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/mod.ts";
import { type Config, getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import {
  applyESMWorker,
  ESMCoordinator,
  resolveESMRuntimePolicy,
  runESMCoordinator,
  WebESMRuntimeAdapter,
  wireESMCoordinator,
} from "./esm_coordinator.ts";
import { esmStore, getOrCreateSession } from "./handler_chat_session.ts";
import { buildAgentOptionsForSession } from "./session_patch.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function testModel(): Model {
  return {
    id: "m1",
    name: "Model 1",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };
}

function newTestServer(): Server {
  const sessionDir = tempDir("openaiapi-esm-coord-sess-");
  const workDir = tempDir("openaiapi-esm-coord-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: { defaultWorkDir: workDir } as Config,
  });
  server.pool = new SessionPool(0, 0);
  const p = newMockProvider("mock", [testModel()], [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "ok" },
    { type: streamDone, stopReason: "stop" },
  ]);
  server.provider = p as unknown as Provider;
  server.model = p.models()[0];
  return server;
}

function testConfig(server: Server): Config {
  return server.cfg as Config;
}

Deno.test("esmCoordinatorStopAllCancelsAndWaits", async () => {
  const coordinator = new ESMCoordinator();
  const controller = new AbortController();
  let releaseDone!: () => void;
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  controller.signal.addEventListener("abort", () => releaseDone(), {
    once: true,
  });
  coordinator.running.set("session-1", () => controller.abort());
  coordinator.done.set("session-1", done);

  await coordinator.stopAll(AbortSignal.timeout(1000));
  assertEquals(coordinator.closed, true);
});

Deno.test("esmCoordinatorStopCancelsAndWaits", async () => {
  const coordinator = new ESMCoordinator();
  const controller = new AbortController();
  let releaseDone!: () => void;
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  controller.signal.addEventListener("abort", () => releaseDone(), {
    once: true,
  });
  coordinator.running.set("session-1", () => controller.abort());
  coordinator.done.set("session-1", done);

  await coordinator.stop(AbortSignal.timeout(1000), "session-1");
});

Deno.test("esmCoordinatorWaitsForForegroundExecutionInsteadOfDroppingContinuation", async () => {
  const server = newTestServer();
  try {
    const sessionID = "webui-esm-wait-for-foreground";
    await getOrCreateSession(server, sessionID, getWorkDir(testConfig(server)));
    esmStore(server)!.create(sessionID, "continue after the foreground run");
    await acquireExecutionAdmission(
      undefined,
      server.sessionDir(),
      sessionID,
      {},
    );

    wireESMCoordinator(server);
    server.startESM!(sessionID);
    const coordinator = server.esmCoordinator!;
    const deadline = Date.now() + 1000;
    while (!coordinator.running.has(sessionID)) {
      if (Date.now() > deadline) {
        throw new Error(
          "ESM coordinator dropped the continuation while a foreground run owned the execution lease",
        );
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    // Cancellation must unblock the admission wait so a pause/clear or
    // shutdown never leaves a coordinator task behind.
    await server.stopESMForControl!(sessionID);
  } finally {
    closeAll();
  }
});

// The Serve half of the same idle-continuation contract asserted in TUI:
// only an auto-runnable objective may reach the role supervisor. A paused
// objective must return before durable Run creation, even though the
// coordinator itself is invoked directly by an adapter entry point.
Deno.test("esmCoordinatorIdleGateRejectsPausedObjective", async () => {
  const server = newTestServer();
  try {
    const sessionID = "webui-esm-paused-idle-gate";
    await getOrCreateSession(server, sessionID, getWorkDir(testConfig(server)));
    const store = esmStore(server)!;
    store.create(sessionID, "do not continue while paused");
    store.pause(sessionID);

    await runESMCoordinator(server, undefined, sessionID);
    const obj = store.get(sessionID);
    assert(
      !canAutoRunForTest(obj),
      `paused objective passed the auto-run gate: ${JSON.stringify(obj)}`,
    );
    const runs = listSessionRuns(server.sessionDir(), sessionID, 10);
    assertEquals(runs.length, 0);
  } finally {
    closeAll();
  }
});

function canAutoRunForTest(obj: { status: string }): boolean {
  return obj.status === "active" || obj.status === "complete_candidate";
}

Deno.test("webSessionAgentOptionsInjectESMObjectiveVersions", async () => {
  const server = newTestServer();
  try {
    const sessionID = "webui-esm-steering-options";
    const sess = await getOrCreateSession(
      server,
      sessionID,
      getWorkDir(testConfig(server)),
    );
    const opts = buildAgentOptionsForSession(
      server,
      sess,
      server.model!,
      "yolo",
    );
    assert(
      opts.getSteeringMessages !== undefined,
      "normal WebUI agent options are missing ESM steering",
    );
    esmStore(server)!.create(sessionID, "finish the first objective");
    let messages = opts.getSteeringMessages!();
    assertEquals(messages.length, 1);
    assertEquals(messages[0].systemInjected, true);
    assertStringIncludes(
      messages[0].content ?? "",
      "finish the first objective",
    );
    assertEquals(opts.getSteeringMessages!().length, 0);
    esmStore(server)!.edit(sessionID, "finish the revised objective");
    messages = opts.getSteeringMessages!();
    assertEquals(messages.length, 1);
    assertStringIncludes(
      messages[0].content ?? "",
      "finish the revised objective",
    );
  } finally {
    closeAll();
  }
});

Deno.test("webESMRuntimeAdapterHandlesClosedSessionRuntime", async () => {
  const server = newTestServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "webui-esm-closed-runtime",
      getWorkDir(testConfig(server)),
    );
    assert(sess.runtime !== undefined, "test session has no runtime");
    sess.runtime.close();

    const adapter = new WebESMRuntimeAdapter(
      server,
      sess,
      sess.workDir,
      "webui",
      "agent",
    );
    let failed = false;
    try {
      await adapter.runRole(undefined, {
        sessionId: sess.id,
        runId: "closed-runtime-role",
        role: "worker",
        workDir: sess.workDir,
        mode: "agent",
        tools: [],
        maxIterations: 0,
        prompt: "should fail cleanly",
        objective: {
          sessionId: "",
          esmId: "",
          objective: "",
          status: "active",
          tokensUsed: 0,
          timeUsedMs: 0,
          blockedCount: 0,
          blockedReason: "",
          blockedRunId: "",
          completionReason: "",
          completionRunId: "",
          completionReview: "",
          phase: "worker",
          progressSummary: "",
          remainingWork: [],
          rejectionCount: 0,
          rejectionRunId: "",
          recoveryCount: 0,
          recoveryReason: "",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      });
    } catch (err) {
      failed = true;
      assertStringIncludes(
        (err as Error).message,
        "agent manager is unavailable",
      );
    }
    assert(failed, "RunRole error = nil, want unavailable manager error");
  } finally {
    closeAll();
  }
});

Deno.test("applyESMWorkerContinueResetsCompletionRejectionStreak", () => {
  const server = newTestServer();
  try {
    const sessionID = "webui-esm-worker-continue";
    const store = esmStore(server)!;
    store.create(sessionID, "finish migration");

    for (let i = 1; i <= 4; i++) {
      const runID = `run-${i}`;
      const obj = store.updateFromModelForRun(
        sessionID,
        statusComplete,
        "worker evidence",
        runID,
      );
      store.rejectCompletionCandidateForRun(
        sessionID,
        runID,
        "missing requirement",
        [
          "finish implementation",
        ],
      );

      const applied = applyESMWorker(server, store, obj, `${runID}-continue`, {
        response:
          `{"status":"continue","summary":"implemented missing requirement","evidence":["focused test passes"],"remaining_work":[],"blockers":[]}`,
        tokens: 0,
        durationMs: 0,
        toolCalls: 1,
        toolNames: new Map(),
        toolError: new Map(),
      });
      assertEquals(applied, true, `apply continue ${i} failed`);
      const next = store.get(sessionID);
      assertEquals(next.status, "active", `continue ${i} status`);
      assertEquals(next.rejectionCount, 0, `continue ${i} rejection count`);
      assertEquals(next.rejectionRunId, "", `continue ${i} rejection run`);
    }
  } finally {
    closeAll();
  }
});

Deno.test("resolveESMRuntimePolicyDerivesUnattendedMode", async () => {
  const server = newTestServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "webui-esm-mode-policy",
      getWorkDir(testConfig(server)),
    );
    assert(sess.runtime !== undefined, "test session has no runtime");

    for (
      const [session, want] of [
        ["agent", "yolo"],
        ["plan", "yolo"],
        ["yolo", "yolo"],
        ["os", "os"],
        ["", "yolo"],
      ] as const
    ) {
      sess.mode = session;
      const { mode } = resolveESMRuntimePolicy(server, sess);
      assertEquals(mode, want, `resolveESMRuntimePolicy(${session})`);
    }
  } finally {
    closeAll();
  }
});
