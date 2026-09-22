// Ported from internal/agentruntime/idempotency_test.go.
//
// The Go fixture creates a session through the Manager; this port builds
// canonical runs directly (foreign-key enforcement is off and a session with no
// lease row skips lease validation), matching the session run-store tests.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import { createSessionRun, type SessionRun } from "../session/run_store.ts";
import { saveSessionRunEvent } from "../session/session_events.ts";
import {
  ErrIdempotencyKeyConflict,
  findIdempotentRun,
  idempotencyKeyFingerprint,
} from "./idempotency.ts";

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

Deno.test("IdempotencyKeyFingerprint", () => {
  assertEquals(idempotencyKeyFingerprint(""), "");
  assertEquals(idempotencyKeyFingerprint("  "), "");
  const fp = idempotencyKeyFingerprint("submission-1");
  assert(fp.startsWith("sha256:"));
  assertEquals(fp, idempotencyKeyFingerprint("submission-1"));
  assert(fp !== idempotencyKeyFingerprint("submission-2"));
});

Deno.test("FindIdempotentRun uses canonical started event", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-agentruntime-" });
  try {
    const sessionId = "session-idempotent";
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-idempotent",
        sessionId,
        status: "running",
      }),
    );
    saveSessionRunEvent(sessionDir, {
      id: "",
      sessionId,
      runId: "run-idempotent",
      eventType: "started",
      source: "",
      status: "completed",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: {
        idempotencyKeyHash: idempotencyKeyFingerprint("submission-1"),
        idempotencyScope: "channel",
        requestFingerprint: "request-1",
      },
    });

    const run = findIdempotentRun(
      sessionDir,
      sessionId,
      "submission-1",
      "request-1",
      "channel",
    );
    assertEquals(run?.id, "run-idempotent");

    assertThrows(
      () =>
        findIdempotentRun(
          sessionDir,
          sessionId,
          "submission-1",
          "request-2",
          "channel",
        ),
      Error,
    );
    assertThrows(
      () =>
        findIdempotentRun(
          sessionDir,
          sessionId,
          "submission-1",
          "request-1",
          "external",
        ),
      Error,
    );
    assert(ErrIdempotencyKeyConflict instanceof Error);
  } finally {
    closeAll();
  }
});

Deno.test("FindIdempotentRun resolves a durable submission reservation", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-agentruntime-" });
  try {
    const sessionId = "session-submission";
    const keyHash = idempotencyKeyFingerprint("durable-submission");
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-first",
        sessionId,
        status: "running",
        submissionKeyHash: keyHash,
        submissionScope: "channel",
        submissionFingerprint: "request-one",
      }),
    );

    const run = findIdempotentRun(
      sessionDir,
      sessionId,
      "durable-submission",
      "request-one",
      "channel",
    );
    assertEquals(run?.id, "run-first");

    assertThrows(
      () =>
        findIdempotentRun(
          sessionDir,
          sessionId,
          "durable-submission",
          "request-two",
          "channel",
        ),
      Error,
    );
  } finally {
    closeAll();
  }
});
