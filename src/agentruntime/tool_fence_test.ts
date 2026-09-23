//
// The Go test drives a real session database, admits an execution lease, begins
// a durable Run, and asserts the fence follows fenced ownership: a fresh lease
// allows, an expired-but-still-owned lease allows (expiry alone is not ownership
// loss), and a fenced epoch bump blocks. Raw SQL lease fixtures are allowed in
// tests (the DAO/DB rule governs production code).

import { assert } from "@std/assert";
import type { BeforeToolExecuteContext } from "../agent/mod.ts";
import type { ToolCallBlock } from "../provider/types.ts";
import { newManager } from "../session/manager.ts";
import { acquireExecutionAdmission } from "../session/mod.ts";
import { closeDatabases, openRootDB } from "../session/root_db.ts";
import {
  type DurableRun,
  ExecutionRuntime,
  RUN_STATE_FAILED,
  RUN_STATE_RUNNING,
  RunStore,
} from "./mod.ts";
import { beforeToolExecuteForRuntime } from "./tool_fence.ts";

function makeRun(overrides: Partial<DurableRun>): DurableRun {
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
    status: "running",
    startedAt: new Date(),
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
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
    ...overrides,
  };
}

function hookInput(runId: string): BeforeToolExecuteContext {
  const toolCall: ToolCallBlock = {
    id: "bash-1",
    name: "bash",
    arguments: { command: "echo hi" },
  };
  return {
    toolCall,
    args: { command: "echo hi" },
    context: null,
    executionContext: {},
    runId,
    executionKey: "key-1",
    sideEffecting: true,
  };
}

Deno.test("beforeToolExecuteFenceFollowsFencedOwnership", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fence-" });
  try {
    const manager = newManager(
      Deno.makeTempDirSync({ prefix: "opensac-fence-work-" }),
      sessionDir,
    );
    manager.initWithID("fence-session");
    const guard = acquireExecutionAdmission(sessionDir, "fence-session");
    try {
      const execution = new ExecutionRuntime();
      execution.setRunStore(new RunStore(sessionDir));
      const now = new Date();
      execution.beginDurable(
        undefined,
        makeRun({
          id: "fence-run",
          sessionId: "fence-session",
          status: RUN_STATE_RUNNING,
          startedAt: now,
        }),
        {
          sessionId: "fence-session",
          runId: "fence-run",
          eventType: "started",
          source: "",
          status: "",
          model: "",
          mode: "",
          timestamp: now,
        },
      );
      const hook = beforeToolExecuteForRuntime({
        id: "fence-session",
        manager,
        execution,
      });
      assert(
        hook(hookInput("fence-run")) === undefined,
        "fresh lease unexpectedly blocked",
      );

      const db = openRootDB(sessionDir);
      // Expiry alone is not ownership loss: a transient database stall can lapse
      // the heartbeat without any other process taking the session, and blocking
      // side effects then would interrupt a live run. The fenced identity is the
      // authority, mirroring RuntimeLeaseDAO.Renew.
      db.db!.run(
        "UPDATE session_runtime_leases SET expires_at = CAST(strftime('%s','now') AS INTEGER) - 1 WHERE session_id = ?",
        "fence-session",
      );
      assert(
        hook(hookInput("fence-run")) === undefined,
        "expired but still-owned lease unexpectedly blocked",
      );

      // A fenced takeover (epoch bump) is definitive loss and must block.
      db.db!.run(
        "UPDATE session_runtime_leases SET epoch = epoch + 1 WHERE session_id = ?",
        "fence-session",
      );
      const decision = hook(hookInput("fence-run"));
      if (decision === undefined || !decision.block) {
        throw new Error(
          `displaced lease decision = ${
            JSON.stringify(decision)
          }, want blocked`,
        );
      }

      // The displaced lease makes the terminal persistence fail (by design);
      // Go ignores this error here too.
      try {
        execution.finishDurable(
          "fence-run",
          RUN_STATE_FAILED,
          "lease displaced",
          {
            sessionId: "fence-session",
            runId: "fence-run",
            eventType: "failed",
            source: "",
            status: "failed",
            model: "",
            mode: "",
            timestamp: new Date(),
          },
        );
      } catch {
        // ignored: the fenced lease is intentionally lost
      }
    } finally {
      guard.release();
    }
  } finally {
    closeDatabases();
  }
});

Deno.test("beforeToolExecuteFenceAllowsNonSideEffectingAndUnboundRuns", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fence-" });
  try {
    const manager = newManager(Deno.makeTempDirSync(), sessionDir);
    manager.initWithID("fence-idle");
    const hook = beforeToolExecuteForRuntime({
      id: "fence-idle",
      manager,
      execution: undefined,
    });
    const input = hookInput("run-any");
    assert(hook(input) === undefined, "unbound execution must not block");
    assert(
      hook({ ...input, sideEffecting: false }) === undefined,
      "non-side-effecting tools must not be fenced",
    );
  } finally {
    closeDatabases();
  }
});
