// Test for the ported internal/session/runtime_submission.go admission surface.

import { assertEquals, assertThrows } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import { writeRootDatabase } from "./database.ts";
import {
  getRuntimeSubmission,
  reserveRuntimeSubmissionTx,
  RuntimeSubmissionError,
  type RuntimeSubmissionRunInput,
} from "./runtime_submission.ts";
import { test } from "#testing";

function runInput(
  overrides: Partial<RuntimeSubmissionRunInput>,
): RuntimeSubmissionRunInput {
  return {
    submissionKeyHash: "key-1",
    submissionScope: "chat",
    submissionFingerprint: "fp-1",
    sessionId: "session-submit",
    startedAt: new Date("2024-01-01T00:00:00Z"),
    intentId: "intent-1",
    id: "run-1",
    ...overrides,
  };
}

test("runtime submission reserve and lookup", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    writeRootDatabase(
      sessionDir,
      (tx) => reserveRuntimeSubmissionTx(tx, runInput({})),
    );

    const found = getRuntimeSubmission(
      sessionDir,
      "session-submit",
      "chat",
      "key-1",
    );
    assertEquals(found?.runId, "run-1");
    assertEquals(found?.intentId, "intent-1");
    assertEquals(found?.requestFingerprint, "fp-1");
    assertEquals(found?.createdAt.toISOString(), "2024-01-01T00:00:00.000Z");

    assertEquals(
      getRuntimeSubmission(sessionDir, "session-submit", "chat", "missing"),
      null,
    );
    assertEquals(getRuntimeSubmission(sessionDir, "", "chat", "key-1"), null);

    // An identical replay is a non-conflicting duplicate.
    const replay = assertThrows(
      () =>
        writeRootDatabase(
          sessionDir,
          (tx) => reserveRuntimeSubmissionTx(tx, runInput({ id: "run-2" })),
        ),
      RuntimeSubmissionError,
    );
    assertEquals((replay as RuntimeSubmissionError).conflict, false);
    assertEquals((replay as RuntimeSubmissionError).existing.runId, "run-1");

    // A different fingerprint for the same key is a conflict.
    const conflict = assertThrows(
      () =>
        writeRootDatabase(sessionDir, (tx) =>
          reserveRuntimeSubmissionTx(
            tx,
            runInput({ id: "run-3", submissionFingerprint: "fp-2" }),
          )),
      RuntimeSubmissionError,
    );
    assertEquals((conflict as RuntimeSubmissionError).conflict, true);
  } finally {
    closeAll();
  }
});
