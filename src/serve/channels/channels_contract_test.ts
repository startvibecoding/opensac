// Translated from internal/serve/channels/lease_test.go,
// question_test.go, and background_recovery_runtime_test.go — the deferred
// test halves of the dispatcher slice that do not need a provider.

import { assert, assertEquals } from "@std/assert";
import { Event as AgentEvent, EventQuestionRequest } from "../../agent/mod.ts";
import {
  DecisionQuestion,
  DecisionService,
} from "../../agentruntime/decision.ts";
import { newAssistantMessage } from "../../provider/mod.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { listSessionRunEvents, newManager } from "../../session/mod.ts";
import { replayDeliveries } from "../../agentruntime/delivery_replay.ts";
import { ChannelSession, Dispatcher } from "./dispatcher.ts";
import { sessionKey } from "./session_paths.ts";
import {
  clearChannelDecisions,
  registerChannelDecision,
} from "./decision_persistence.ts";
import { reconcileCompletedBackgroundRun } from "./background_recovery.ts";
import type { RunEvent } from "../../agentruntime/run_event.ts";

// --- lease_test.go -----------------------------------------------------------

Deno.test("promote failure underflows pending entrants", () => {
  const d = new Dispatcher();
  const key = sessionKey("wechat", "underflow-user");
  const sess = new ChannelSession();
  sess.id = "session-underflow";
  sess.platform = "wechat";
  sess.userID = "underflow-user";
  d.sessions.set(key, sess);

  const leaseA = d.acquireSessionLease(key, "wechat", "underflow-user", sess);
  assert(leaseA !== null, "acquire lease A failed");
  const leaseB = d.acquireSessionLease(key, "wechat", "underflow-user", sess);
  assert(leaseB !== null, "acquire lease B failed");
  assertEquals(sess.pendingEntrants, 2);

  // Invalidate the session while both leases are still pending.
  d.invalidateSessionLocked(key, sess);
  assert(sess.invalidated, "session was not invalidated");

  // First lease fails to promote (session invalidated).
  const promoted = leaseA.promoteAfterRuntimeLock();
  // The TS projection returns a promise for the wechat/feishu identity path.
  return promoted.then((ok) => {
    assert(!ok, "lease A promoted despite invalidation");

    // leaseA's failure must release exactly one pending entrant. leaseB is
    // still pending, so the session must NOT be evicted yet.
    assert(
      d.sessions.get(key) === sess,
      "session was evicted while lease B was still pending (double-decrement)",
    );
    assertEquals(sess.pendingEntrants, 1);
  });
});

Deno.test("lease generation rejects stale entrant", () => {
  const d = new Dispatcher();
  const key = sessionKey("wechat", "generation-user");
  const sess = new ChannelSession();
  sess.id = "session-generation";
  sess.platform = "wechat";
  sess.userID = "generation-user";
  sess.generation = 1;
  d.sessions.set(key, sess);
  const lease = d.acquireSessionLease(key, "wechat", "generation-user", sess);
  assert(lease !== null, "acquire lease failed");
  sess.generation++;
  return lease.promoteAfterRuntimeLock().then((promoted) => {
    assert(!promoted, "stale generation was promoted");
    assertEquals(sess.pendingEntrants, 0);
    assertEquals(sess.activeRuns, 0);
  });
});

Deno.test("invalidated session stays until active lease releases", () => {
  const d = new Dispatcher();
  const key = sessionKey("wechat", "active-user");
  const sess = new ChannelSession();
  sess.id = "session-active";
  sess.platform = "wechat";
  sess.userID = "active-user";
  d.sessions.set(key, sess);
  const lease = d.acquireSessionLease(key, "wechat", "active-user", sess);
  assert(lease !== null, "acquire active lease failed");
  return lease.promoteAfterRuntimeLock().then((promoted) => {
    assert(promoted, "active lease did not promote");
    d.invalidateSessionLocked(key, sess);
    assert(
      d.getSession(key) !== null,
      "active invalidated session was evicted too early",
    );
    lease.release();
    assert(
      d.getSession(key) === null,
      "session remained after active lease release",
    );
  });
});

// --- question_test.go --------------------------------------------------------

Deno.test("channel question observer and decision lifecycle", () => {
  const d = new Dispatcher();
  const sess = new ChannelSession();
  sess.id = "channels/wechat/user-1";
  sess.runID = "run-1";
  sess.decisions = null;
  let observed: AgentEvent | undefined;
  d.setQuestionObserver((_sessionID, ev) => {
    observed = ev;
  });

  const ev: AgentEvent = {
    type: EventQuestionRequest,
    questionId: "question-1",
    questionText: "continue?",
  };
  d.notifyQuestionObserver(sess.id, ev);
  assert(
    observed?.questionId === ev.questionId &&
      observed?.questionText === ev.questionText,
    "observed question mismatch",
  );

  // Go's test installs the session decisions service in the struct literal; the
  // dispatcher's registration path fills it in lazily, so mirror the literal.
  sess.decisions = new DecisionService();
  registerChannelDecision(d, sess, ev.questionId!, DecisionQuestion);
  assertEquals(sess.decisions.pending().length, 1);
  sess.decisions.resolve({
    id: ev.questionId!,
    kind: DecisionQuestion,
    status: "cancelled",
  });
  assertEquals(sess.decisions.pending().length, 0);
  clearChannelDecisions(d, sess);
  assertEquals(sess.decisions.pending().length, 0);
});

// --- background_recovery_runtime_test.go --------------------------------------

Deno.test("channel recovery uses runtime delivery projection", () => {
  const sessionDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, sessionDir);
  mgr.init();
  const entryID = mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "recovered" }]),
  );
  const now = new Date();
  const sink = new SessionRunEventSink(sessionDir);
  const event: RunEvent = {
    sessionId: mgr.getHeader()!.id,
    runId: "run-1",
    eventType: "finished",
    source: "channel:wechat",
    status: "completed",
    model: "",
    mode: "",
    timestamp: now,
    data: { channelDeliveryPending: true, assistantEntryId: entryID },
  };
  sink.record(event);

  const d = { sessionDir } as unknown as Dispatcher;
  const channel = new ChannelSession();
  channel.platform = "wechat";
  channel.userID = "user";
  channel.manager = mgr;
  const deliveries: string[] = [];
  reconcileCompletedBackgroundRun(d, channel, (text) => deliveries.push(text));
  assertEquals(
    deliveries,
    ["recovered"],
    `deliveries = ${JSON.stringify(deliveries)}`,
  );

  const events = listSessionRunEvents(sessionDir, mgr.getHeader()!.id);
  const pending = replayDeliveries(events);
  assertEquals(pending.size, 0, "pending after reconciliation");
});
