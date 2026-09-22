// Translated tests for internal/session/execution_intent.go.
//
// The Go package ships no dedicated test for these helpers; this file pins the
// durable intent round trip and the atomic intent/Run/event/turn admission
// contract against the ported implementation.

import { assertEquals, assertThrows } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import {
  createExecutionIntentAndSessionRun,
  createExecutionIntentAndSessionRunEventWithTurn,
  type ExecutionIntent,
  getExecutionIntent,
  getSessionRun,
  saveExecutionIntent,
  type SessionRun,
} from "./mod.ts";

function baseRun(overrides: Partial<SessionRun>): SessionRun {
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

function baseIntent(overrides: Partial<ExecutionIntent>): ExecutionIntent {
  return {
    id: "",
    sessionId: "",
    source: "",
    model: "",
    mode: "",
    workDir: "",
    requestFingerprint: "",
    request: undefined,
    policy: undefined,
    createdAt: new Date(),
    ...overrides,
  };
}

Deno.test("execution intent round trips through durable storage", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-intent-" });
  try {
    saveExecutionIntent(
      sessionDir,
      baseIntent({
        id: "intent-1",
        sessionId: "session-intent",
        source: "cli",
        model: "deepseek",
        mode: "yolo",
        workDir: "/tmp/work",
        requestFingerprint: "fp-1",
        request: { text: "hello" },
        policy: { sandbox: "none" },
      }),
    );
    const got = getExecutionIntent(sessionDir, "intent-1");
    assertEquals(got?.sessionId, "session-intent");
    assertEquals(got?.source, "cli");
    assertEquals(got?.model, "deepseek");
    assertEquals(got?.mode, "yolo");
    assertEquals(got?.workDir, "/tmp/work");
    assertEquals(got?.requestFingerprint, "fp-1");
    assertEquals(got?.request, { text: "hello" });
    assertEquals(got?.policy, { sandbox: "none" });
    assertEquals(getExecutionIntent(sessionDir, "missing"), null);
  } finally {
    closeAll();
  }
});

Deno.test("execution intent admission rejects mismatched identity", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-intent-" });
  try {
    assertThrows(
      () =>
        createExecutionIntentAndSessionRun(
          sessionDir,
          baseIntent({ id: "intent-a", sessionId: "session-a" }),
          baseRun({
            id: "run-a",
            sessionId: "session-b",
            status: "running",
          }),
        ),
      Error,
    );
    assertThrows(
      () =>
        createExecutionIntentAndSessionRun(
          sessionDir,
          baseIntent({ id: "intent-a", sessionId: "session-a" }),
          baseRun({
            id: "run-a",
            sessionId: "session-a",
            intentId: "intent-other",
            status: "running",
          }),
        ),
      Error,
    );
  } finally {
    closeAll();
  }
});

Deno.test("execution intent atomically admits run, event, and turn", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-intent-" });
  try {
    const now = new Date();
    const eventId = createExecutionIntentAndSessionRunEventWithTurn(
      sessionDir,
      baseIntent({
        id: "intent-atomic",
        sessionId: "session-atomic",
        source: "acp",
      }),
      baseRun({
        id: "run-atomic",
        sessionId: "session-atomic",
        intentId: "intent-atomic",
        status: "running",
        startedAt: now,
        updatedAt: now,
      }),
      {
        id: "event-started",
        sessionId: "",
        runId: "",
        eventType: "started",
        source: "",
        status: "",
        model: "",
        mode: "",
        timestamp: now,
        data: undefined,
      },
      {
        id: "turn-atomic",
        sessionId: "session-atomic",
        intentId: "intent-atomic",
        runId: "run-atomic",
        attempt: 0,
        kind: "conversation",
        status: "",
        startSeq: 0,
        endSeq: null,
        startedAt: now,
        endedAt: null,
      },
    );
    assertEquals(eventId, "event-started");
    assertEquals(
      getExecutionIntent(sessionDir, "intent-atomic")?.source,
      "acp",
    );
    assertEquals(getSessionRun(sessionDir, "run-atomic")?.status, "running");
  } finally {
    closeAll();
  }
});
