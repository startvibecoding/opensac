// Regression tests for interactive submission plumbing: decision answers must
// route through the Core-owned decision request (identity and
// first-response-wins stay canonical), and a failure before a run starts must
// unwind the busy state and surface one error row instead of wedging the
// session.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@opensac/assert";
import {
  createFakeTUIService,
  type FakeTUIService,
  TUIServiceError,
} from "./service.ts";
import { TUISession } from "./tui_session.ts";

/**
 * Redirects the config dir to a temp dir so session/lease writes during these
 * tests never touch the developer's real state.
 */
function isolateConfigDir(): { restore: () => void } {
  const dir = Deno.makeTempDirSync();
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", dir);
  return {
    restore: () => {
      if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
      else Deno.env.set("OPENSAC_DIR", previous);
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

function session(
  service: FakeTUIService = createFakeTUIService(),
): TUISession {
  return new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    service,
  );
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

Deno.test("answerApproval answers the Core decision request", async () => {
  const iso = isolateConfigDir();
  try {
    const fake = createFakeTUIService();
    const s = session(fake);
    fake.requestDecision({
      sessionId: "session-1",
      runId: "run-1",
      requestId: "ap-1",
      kind: "approval",
      toolName: "write",
    });
    s.controller.shownApproval = {
      agentID: undefined,
      approvalID: "ap-1",
      toolName: "write",
    };
    s.answerApproval(true);
    await tick();
    // The panel advances locally while the answer went to the Core request.
    assertEquals(s.controller.shownApproval, undefined);
    // First response wins: the request is resolved in the Core-owned store.
    await assertRejects(
      () =>
        fake.answerDecision({
          requestId: "ap-1",
          kind: "approval",
          approved: true,
        }),
      TUIServiceError,
      "TUI decision not found",
    );
  } finally {
    iso.restore();
  }
});

Deno.test("answerQuestion answers the Core decision request", async () => {
  const iso = isolateConfigDir();
  try {
    const fake = createFakeTUIService();
    const s = session(fake);
    fake.requestDecision({
      sessionId: "session-1",
      runId: "run-1",
      requestId: "q-1",
      kind: "question",
      question: "pick",
    });
    s.controller.shownQuestion = { questionID: "q-1", question: "pick" };
    s.answerQuestion("option-a");
    await tick();
    assertEquals(s.controller.shownQuestion, undefined);
    await assertRejects(
      () =>
        fake.answerDecision({
          requestId: "q-1",
          kind: "question",
          answer: "option-a",
        }),
      TUIServiceError,
      "TUI decision not found",
    );
  } finally {
    iso.restore();
  }
});

Deno.test("answering an unknown decision still clears the panel quietly", async () => {
  const iso = isolateConfigDir();
  try {
    const s = session();
    s.controller.shownApproval = {
      agentID: undefined,
      approvalID: "ap-fallback",
      toolName: "write",
    };
    // The decision is unknown to the Core (already resolved or expired): the
    // answer is dropped silently and the panel still advances.
    s.answerApproval(true);
    await tick();
    assertEquals(s.controller.shownApproval, undefined);
    const errors = s.controller.store.messages.filter((m) =>
      m.startsWith("Error:")
    );
    assertEquals(errors, []);
  } finally {
    iso.restore();
  }
});

Deno.test("an early submit failure unwinds busy and surfaces the error", async () => {
  const iso = isolateConfigDir();
  try {
    const s = session();
    // start() is intentionally not called: the turn fails before the run
    // exists and must still release the busy state and report the failure.
    await s.handleSubmit("hello");
    assertEquals(s.busy, false);
    assertEquals(s.controller.isThinking, false);
    const errors = s.controller.store.messages.filter((m) =>
      m.startsWith("Error:")
    );
    assert(errors.length >= 1, "expected a visible error row");
    assertStringIncludes(errors[0], "Error:");
  } finally {
    iso.restore();
  }
});
