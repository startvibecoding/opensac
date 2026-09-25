// Regression tests for interactive submission plumbing: decision answers must
// route through the attached RunHandle so the resolved DecisionRecord is
// persisted, and a failure before a run starts must unwind the busy state and
// surface one error row instead of wedging the session.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DECISION_APPROVAL,
  DECISION_QUESTION,
  type DecisionKind,
} from "../agentruntime/decision.ts";
import type { RunState } from "../agentruntime/run_state.ts";
import { defaultSettings } from "../config/settings.ts";
import type { RunHandle } from "./app_controller.ts";
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

function session(): TUISession {
  const settings = defaultSettings();
  return new TUISession(
    {
      provider: settings.defaultProvider ?? "openai",
      model: settings.defaultModel ?? "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    settings,
  );
}

function recordingRun(
  resolved: Array<[string, DecisionKind, string]>,
): RunHandle {
  return {
    registerDecision: () => undefined,
    bindDecision: () => {},
    finish: (_state: RunState) => {},
    resolveDecision: (id, kind, value) => void resolved.push([id, kind, value]),
  };
}

Deno.test("answerApproval resolves through the attached run handle", () => {
  const iso = isolateConfigDir();
  try {
    const s = session();
    const resolved: Array<[string, DecisionKind, string]> = [];
    s.controller.attachRun(recordingRun(resolved));
    s.controller.shownApproval = {
      agentID: undefined,
      approvalID: "ap-1",
      toolName: "write",
    };
    s.answerApproval(true);
    s.controller.shownApproval = {
      agentID: undefined,
      approvalID: "ap-2",
      toolName: "bash",
    };
    s.answerApproval(false);
    assertEquals(resolved, [
      ["ap-1", DECISION_APPROVAL, "true"],
      ["ap-2", DECISION_APPROVAL, "false"],
    ]);
  } finally {
    iso.restore();
  }
});

Deno.test("answerQuestion resolves through the attached run handle", () => {
  const iso = isolateConfigDir();
  try {
    const s = session();
    const resolved: Array<[string, DecisionKind, string]> = [];
    s.controller.attachRun(recordingRun(resolved));
    s.controller.shownQuestion = { questionID: "q-1", question: "pick" };
    s.answerQuestion("option-a");
    assertEquals(resolved, [["q-1", DECISION_QUESTION, "option-a"]]);
  } finally {
    iso.restore();
  }
});

Deno.test("answers without a resolving run fall back to clearing the panel", () => {
  const iso = isolateConfigDir();
  try {
    const s = session();
    s.controller.attachRun({
      registerDecision: () => undefined,
      bindDecision: () => {},
      finish: (_state: RunState) => {},
    });
    s.controller.shownApproval = {
      agentID: undefined,
      approvalID: "ap-fallback",
      toolName: "write",
    };
    // The decision was never registered, so the DecisionService rejects the
    // resolution and the answer path must still advance the panel.
    s.answerApproval(true);
    assertEquals(s.controller.shownApproval, undefined);
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
