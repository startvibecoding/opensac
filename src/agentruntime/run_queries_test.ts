//
// The Go fixture uses the agentruntime `RunStore`; this port builds canonical
// runs through the session layer directly (the `RunStore` wrapper lands with the
// `ExecutionRuntime` slice).

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import {
  createSessionRun,
  type SessionRun,
  updateSessionRunStatus,
} from "../session/run_store.ts";
import {
  annotateDurableRunError,
  getActiveDurableRun,
  getDurableRun,
  listLatestDurableRunsBySessions,
} from "./run_queries.ts";
import { test } from "#testing";

function baseRun(overrides: Partial<SessionRun>): SessionRun {
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
    startedAt: new Date(),
    updatedAt: new Date(),
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

test("AnnotateDurableRunError only terminalizes empty errors", () => {
  const sessionDir = runtime.makeTempDirSync({
    prefix: "opensac-agentruntime-",
  });
  try {
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-annotate",
        sessionId: "session-annotate",
        workDir: runtime.makeTempDirSync(),
        source: "responses_background",
        mode: "yolo",
        status: "running",
        startedAt: new Date(),
      }),
    );

    assert(
      !annotateDurableRunError(
        sessionDir,
        "run-annotate",
        "abandoned after interrupted tool execution",
      ),
    );

    updateSessionRunStatus(
      sessionDir,
      "run-annotate",
      "failed",
      "",
      new Date(),
    );
    assert(
      annotateDurableRunError(
        sessionDir,
        "run-annotate",
        "abandoned after interrupted tool execution",
      ),
    );
    const run = getDurableRun(sessionDir, "run-annotate")!;
    assertEquals(run.status, "failed");
    assertEquals(run.error, "abandoned after interrupted tool execution");

    assert(
      !annotateDurableRunError(sessionDir, "run-annotate", "later reason"),
    );
    assertEquals(
      getDurableRun(sessionDir, "run-annotate")!.error,
      "abandoned after interrupted tool execution",
    );

    assert(!annotateDurableRunError(sessionDir, "missing-run", "reason"));
  } finally {
    closeAll();
  }
});

test("ListLatestDurableRunsBySessions projects newest run per session", () => {
  const sessionDir = runtime.makeTempDirSync({
    prefix: "opensac-agentruntime-",
  });
  try {
    const now = Date.now();
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-page-a1",
        sessionId: "session-page-a",
        workDir: runtime.makeTempDirSync(),
        source: "acp",
        mode: "yolo",
        status: "running",
        startedAt: new Date(now - 2 * 3600_000),
      }),
    );
    updateSessionRunStatus(
      sessionDir,
      "run-page-a1",
      "completed",
      "",
      new Date(),
    );
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-page-a2",
        sessionId: "session-page-a",
        workDir: runtime.makeTempDirSync(),
        source: "acp",
        mode: "yolo",
        status: "running",
        startedAt: new Date(now - 3600_000),
      }),
    );
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-page-b",
        sessionId: "session-page-b",
        workDir: runtime.makeTempDirSync(),
        source: "acp",
        mode: "yolo",
        status: "running",
        startedAt: new Date(now),
      }),
    );

    const latest = listLatestDurableRunsBySessions(sessionDir, [
      "session-page-a",
      "session-page-b",
      "session-page-missing",
    ]);
    assertEquals(latest.size, 2);
    assertEquals(latest.get("session-page-a")?.id, "run-page-a2");
    assertEquals(latest.get("session-page-a")?.status, "running");
    assertEquals(latest.has("session-page-missing"), false);
    assertEquals(latest.get("session-page-b")?.id, "run-page-b");

    const active = getActiveDurableRun(sessionDir, "session-page-a");
    assertEquals(active?.id, "run-page-a2");

    assertEquals(listLatestDurableRunsBySessions(sessionDir, []).size, 0);
  } finally {
    closeAll();
  }
});
