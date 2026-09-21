// Translated from the recordDecisionEvent / pendingDecisionIDsForRun
// behaviors exercised by internal/serve/openaiapi's approval.go, question
// handling, and session_mgr recovery (the dedicated Go coverage lives in
// decision_recovery_test.go / server_test.go), adapted to the Server-bound
// helper projection.
import { assert, assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import { APISession } from "./session_mgr.ts";
import {
  decisionDeadline,
  mergeDecisionPayload,
  recordDecisionEvent,
  recordDecisionEventWithDeadline,
} from "./decision_persistence.ts";
import { pendingDecisionIDsForRun } from "./decision_projection.ts";
import { DecisionService } from "../../agentruntime/decision.ts";
import {
  DecisionApproval,
  DecisionQuestion,
} from "../../agentruntime/decision.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import { listSessionRunEvents } from "../../session/session_events.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-decision-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

Deno.test("decisionDeadline maps the request timeout, undefined without one", () => {
  const bare = new Server({});
  assertEquals(decisionDeadline(bare), undefined);
  const zero = new Server({ cfg: { requestTimeoutSecs: 0 } });
  assertEquals(decisionDeadline(zero), undefined);
  const timed = new Server({ cfg: { requestTimeoutSecs: 30 } });
  const deadline = decisionDeadline(timed);
  assert(deadline !== undefined);
  assert(deadline.getTime() > Date.now());
});

Deno.test("recordDecisionEvent persists the neutral record and the legacy payload", () => {
  const dir = tempDir();
  try {
    const server = new Server({ settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s-decision";
    const request = {
      id: "approval-1",
      runId: "run-1",
      sessionId: "s-decision",
      kind: DecisionApproval,
    };
    const payload = { tool: { name: "bash", args: { command: "ls" } } };

    const err = recordDecisionEvent(
      server,
      sess,
      request,
      null,
      "approval_requested",
      "pending",
      "approval",
      "agent",
      payload,
    );
    assertEquals(err, null);
    const events = listSessionRunEvents(dir, "s-decision");
    assertEquals(events.length, 1);
    const data = events[0].data as Record<string, unknown>;
    // The neutral record rides under the canonical key.
    const record = data["decision"] as Record<string, unknown>;
    assertEquals(record["id"], "approval-1");
    assertEquals(record["runId"], "run-1");
    assertEquals(record["kind"], "approval");
    assertEquals(record["status"], "pending");
    // The requested event keeps the legacy top-level payload object.
    assertEquals(data["approval"], payload);

    // Resolutions merge the payload fields into the legacy top level.
    const resolved = recordDecisionEvent(
      server,
      sess,
      request,
      { id: "approval-1", status: "resolved", value: "allow" },
      "approval_resolved",
      "resolved",
      "approval",
      "agent",
      { action: "allow" },
    );
    assertEquals(resolved, null);
    const eventsAfter = listSessionRunEvents(dir, "s-decision");
    assertEquals(eventsAfter.length, 2);
    const resolutionData = eventsAfter[1].data as Record<string, unknown>;
    const resolutionRecord = resolutionData["decision"] as Record<
      string,
      unknown
    >;
    assertEquals(resolutionRecord["status"], "resolved");
    assertEquals(resolutionData["action"], "allow");

    // A nil session is a no-op.
    assertEquals(
      recordDecisionEvent(
        server,
        undefined,
        request,
        null,
        "x",
        "y",
        "",
        "",
        {},
      ),
      null,
    );
  } finally {
    closeAll();
  }
});

Deno.test("recordDecisionEventWithDeadline stores the decision expiry for questions", () => {
  const dir = tempDir();
  try {
    const server = new Server({ settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s-question";
    const expiresAt = new Date(Date.now() + 60_000);
    const request = {
      id: "question-1",
      runId: "run-1",
      kind: DecisionQuestion,
    };
    const err = recordDecisionEventWithDeadline(
      server,
      sess,
      request,
      null,
      "question_requested",
      "pending",
      "question",
      "",
      { prompt: "continue?" },
      expiresAt,
    );
    assertEquals(err, null);
    const data = listSessionRunEvents(dir, "s-question")[0]
      .data as Record<string, unknown>;
    const record = data["decision"] as Record<string, unknown>;
    assertEquals(record["kind"], "question");
    assertEquals((record["expiresAt"] as string).length > 0, true);
    // The requested question event keeps the legacy top-level payload object.
    assertEquals(
      (data["question"] as Record<string, unknown>)["prompt"],
      "continue?",
    );
  } finally {
    closeAll();
  }
});

Deno.test("mergeDecisionPayload flattens only plain object payloads", () => {
  const data: Record<string, unknown> = { keep: 1 };
  mergeDecisionPayload(data, { action: "allow", note: undefined });
  assertEquals(data["action"], "allow");
  assertEquals("note" in data, false);
  mergeDecisionPayload(data, "scalar");
  mergeDecisionPayload(data, ["array"]);
  mergeDecisionPayload(data, null);
  assertEquals(Object.keys(data).length, 2);
});

Deno.test("pendingDecisionIDsForRun scopes Runtime decision identity to one run", () => {
  const sess = new APISession();
  // No decision service yet.
  assertEquals(pendingDecisionIDsForRun(sess, "run-1").size, 0);
  assertEquals(pendingDecisionIDsForRun(undefined, "run-1").size, 0);

  sess.decisions = new DecisionService();
  sess.decisions.register({
    id: "approval-1",
    runId: "run-1",
    kind: DecisionApproval,
  });
  sess.decisions.register({
    id: "question-1",
    runId: "run-1",
    kind: DecisionQuestion,
  });
  sess.decisions.register({
    id: "approval-2",
    runId: "run-2",
    kind: DecisionApproval,
  });
  const run1 = pendingDecisionIDsForRun(sess, "run-1");
  assertEquals(run1.size, 2);
  assertEquals(run1.get("approval-1"), "approval");
  assertEquals(run1.get("question-1"), "question");
  const run2 = pendingDecisionIDsForRun(sess, "run-2");
  assertEquals(run2.size, 1);
  assertEquals(run2.get("approval-2"), "approval");
  // Empty run IDs return an empty map without consulting the service.
  assertEquals(pendingDecisionIDsForRun(sess, "").size, 0);
});
