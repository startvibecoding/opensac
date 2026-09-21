// Translated from internal/serve/channels/decision_test.go,
// decision_deadline_test.go, and decision_persistence_test.go.

import { assert } from "@std/assert";
import {
  DecisionApproval,
  DecisionQuestion,
  DecisionService,
} from "../../agentruntime/decision.ts";
import { replayDecisions } from "../../agentruntime/decision_replay.ts";
import type { DecisionRecord } from "../../agentruntime/decision_record.ts";
import { listSessionRunEvents, newManager } from "../../session/mod.ts";
import { ChannelSession, type Dispatcher } from "./dispatcher.ts";
import {
  clearChannelDecisions,
  persistChannelDecision,
  persistChannelDecisionRequest,
  persistChannelDecisionRequestWithDeadline,
  registerChannelDecision,
} from "./decision_persistence.ts";

Deno.test("channel decision service lifecycle", () => {
  const dispatcher = { sessionDir: "" } as unknown as Dispatcher;
  const sess = new ChannelSession();
  sess.id = "channels/wechat/user-1";
  sess.runID = "run-1";
  sess.decisions = new DecisionService();
  registerChannelDecision(dispatcher, sess, "tool-call-1", DecisionApproval);
  const pending = sess.decisions!.pending();
  assert(pending.length === 1 && pending[0].kind === DecisionApproval);
  sess.decisions!.resolve({
    id: "tool-call-1",
    kind: DecisionApproval,
    status: "resolved",
  });

  registerChannelDecision(dispatcher, sess, "question-1", DecisionQuestion);
  clearChannelDecisions(dispatcher, sess);
  assert(
    sess.decisions!.pending().length === 0,
    "pending decisions after clear",
  );
});

Deno.test("channel decision request persists immediate deadline", () => {
  const d = { sessionDir: Deno.makeTempDirSync() } as unknown as Dispatcher;
  const workDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, d.sessionDir);
  mgr.init();
  const sess = new ChannelSession();
  sess.id = mgr.getHeader()!.id;
  sess.platform = "wechat";
  sess.mode = "yolo";
  sess.runID = "run-1";
  persistChannelDecisionRequestWithDeadline(
    d,
    sess,
    "question-1",
    DecisionQuestion,
    { question: "continue?" },
    new Date(),
  );
  const events = listSessionRunEvents(d.sessionDir, sess.id);
  assert(events !== null && events.length === 1, `events = ${events.length}`);
  const envelope = events[0].data as { decision: DecisionRecord };
  assert(
    envelope.decision.expiresAt !== undefined &&
      envelope.decision.expiresAt !== null,
    "channel decision deadline was not persisted",
  );
  const pending = replayDecisions([envelope.decision]);
  assert(pending.size === 0, "immediate channel decision remained pending");
});

Deno.test("channel decision record persistence", () => {
  const sessionDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, sessionDir);
  mgr.init();
  const channel = new ChannelSession();
  channel.id = mgr.getHeader()!.id;
  channel.platform = "wechat";
  channel.mode = "yolo";
  channel.runID = "run-1";
  const d = { sessionDir } as unknown as Dispatcher;

  persistChannelDecisionRequest(d, channel, "question-1", DecisionQuestion, {
    question: "continue?",
  });
  persistChannelDecision(
    d,
    channel,
    "question-1",
    DecisionQuestion,
    "cancelled",
    "",
    null,
  );
  const events = listSessionRunEvents(sessionDir, channel.id);
  assert(events.length === 2, `events = ${events.length}`);
  assert(events[0].eventType === "decision_pending", events[0].eventType);
  assert(events[1].eventType === "decision_cancelled", events[1].eventType);
  const data = events[0].data as { decision: DecisionRecord };
  assert(data.decision.id === "question-1");
  assert(data.decision.kind === DecisionQuestion);
  assert(data.decision.status === "pending");
  const ts = events[0].timestamp.getTime();
  assert(
    !Number.isNaN(ts) && ts <= Date.now() + 1000,
    "invalid event timestamp",
  );
});
