// (the Agent-bound
// approval/question coordination) and internal/agent/send_event_test.go (the
// context-aware event send).
//
// Deviations: Go's RequestToolApproval/RequestQuestion block on channels; the
// TS port resolves async promises and races them against the agent abort signal
// and the run context signal. The "parked on a channel with no consumer" cases
// are projected as "the context-aware send refuses to deliver to a cancelled
// run", which is the observable guarantee that unblocks a cancelled run.

import { assert, assertEquals } from "@opensac/assert";
import type { AllowConfig } from "../config/allow.ts";
import type { ApprovalSettings } from "../config/settings.ts";
import { EventChannel } from "./event_channel.ts";
import { EVENT_TOOL_APPROVAL_REQUEST } from "./events.ts";
import type { Event } from "./events.ts";
import type { EventSink } from "./agent.ts";
import { createAgent } from "./agent.ts";
import { createRunContext } from "./run_context.ts";

function sinkFor(channel: EventChannel): EventSink {
  return (ev: Event) => channel.push(ev);
}

/** Waits for the next approval request event and returns its ID. */
async function waitApprovalId(channel: EventChannel): Promise<string> {
  const result = await channel.next();
  assert(!result.done, "expected an approval request event");
  assertEquals(result.value.type, EVENT_TOOL_APPROVAL_REQUEST);
  const id = result.value.approvalId ?? "";
  assert(id !== "", "approval ID must be non-empty");
  return id;
}

Deno.test("requestQuestion resolves to empty on context cancel", async () => {
  const a = createAgent({ id: "agent-question", mode: "plan" }, undefined);
  const chapter = new EventChannel();
  const controller = new AbortController();
  const ctx = createRunContext(controller.signal);
  const pending = a.requestQuestion(ctx, sinkFor(chapter), "pick one", [
    "a",
    "b",
  ], "");

  const ev = await chapter.next();
  assert(!ev.done, "expected a question request event");
  const questionId = ev.value.questionId ?? "";
  assert(questionId !== "", "question ID must be non-empty");

  controller.abort();
  assertEquals(await pending, "");
  // A late answer for a cancelled request must be a no-op, not a false success.
  assert(
    !a.deliverQuestionAnswer(questionId, "option a"),
    "cancelled question must not accept a late answer",
  );
});

Deno.test("requestQuestion still answers", async () => {
  const a = createAgent({ id: "agent-question", mode: "plan" }, undefined);
  const chapter = new EventChannel();
  const responder = (async () => {
    const result = await chapter.next();
    assert(!result.done);
    // Question IDs embed the agent ID, so the responder uses the published ID.
    a.handleQuestionResponse(result.value.questionId ?? "", "option a");
  })();
  const answer = await a.requestQuestion(
    createRunContext(),
    sinkFor(chapter),
    "pick one",
    ["a", "b"],
    "",
  );
  await responder;
  assertEquals(answer, "option a");
});

Deno.test("requestToolApproval IDs are unique across agents", async () => {
  const lead = createAgent({ id: "agent-lead", mode: "agent" }, undefined);
  const child = createAgent({ id: "agent-child", mode: "agent" }, undefined);
  const leadCh = new EventChannel();
  const childCh = new EventChannel();

  const leadPending = lead.requestToolApproval(
    createRunContext(),
    sinkFor(leadCh),
    "call-1",
    "bash",
    { command: "ls" },
  );
  const childPending = child.requestToolApproval(
    createRunContext(),
    sinkFor(childCh),
    "call-2",
    "bash",
    { command: "ls" },
  );

  const leadId = await waitApprovalId(leadCh);
  const childId = await waitApprovalId(childCh);
  assert(leadId !== childId, "approval IDs collided across agents");
  assert(leadId.includes("agent-lead"), "lead approval ID embeds agent ID");
  assert(childId.includes("agent-child"), "child approval ID embeds agent ID");

  lead.handleApprovalResponse(leadId, true);
  child.handleApprovalResponse(childId, true);
  assertEquals(await leadPending, true);
  assertEquals(await childPending, true);
});

Deno.test("requestToolApproval resolves false on context cancel", async () => {
  const a = createAgent({ id: "agent-cancel", mode: "agent" }, undefined);
  const chapter = new EventChannel();
  const controller = new AbortController();
  const ctx = createRunContext(controller.signal);
  const pending = a.requestToolApproval(
    ctx,
    sinkFor(chapter),
    "call-1",
    "bash",
    {
      command: "ls",
    },
  );
  const approvalId = await waitApprovalId(chapter);
  controller.abort();
  assertEquals(await pending, false);
  // A late response for a cancelled request must be a no-op, not a block.
  a.handleApprovalResponse(approvalId, true);
});

Deno.test("request events do not park without a consumer when canceled", async () => {
  const controller = new AbortController();
  controller.abort();

  const approvalAgent = createAgent(
    { id: "agent-approval-send", mode: "agent" },
    undefined,
  );
  approvalAgent.setRunContext(createRunContext(controller.signal));
  let approvalDelivered = 0;
  const approved = await approvalAgent.requestToolApproval(
    createRunContext(controller.signal),
    () => {
      approvalDelivered += 1;
      return true;
    },
    "call-1",
    "bash",
    { command: "ls" },
  );
  assertEquals(approved, false);
  assertEquals(approvalDelivered, 0, "cancelled run must not deliver approval");

  const questionAgent = createAgent(
    { id: "agent-question-send", mode: "agent" },
    undefined,
  );
  questionAgent.setRunContext(createRunContext(controller.signal));
  let questionDelivered = 0;
  const answer = await questionAgent.requestQuestion(
    createRunContext(controller.signal),
    () => {
      questionDelivered += 1;
      return true;
    },
    "pick one",
    ["a"],
    "",
  );
  assertEquals(answer, "");
  assertEquals(
    questionDelivered,
    0,
    "cancelled run must not deliver question",
  );
});

Deno.test("sendEvent stops when run context is done", () => {
  const a = createAgent({ id: "send-event", mode: "yolo" }, undefined);
  const chapter = new EventChannel();
  const controller = new AbortController();
  controller.abort();
  a.setRunContext(createRunContext(controller.signal));

  let delivered = 0;
  const accepted = a.sendEvent(() => {
    delivered += 1;
    return true;
  }, { type: 7, textDelta: "late" });
  assertEquals(accepted, false);
  assertEquals(delivered, 0);

  // A live run delivers.
  a.setRunContext(createRunContext());
  const acceptedLive = a.sendEvent(sinkFor(chapter), {
    type: 7,
    textDelta: "live",
  });
  assertEquals(acceptedLive, true);
  assertEquals(delivered, 0);
});

Deno.test("sendEvent counts dropped events", () => {
  const a = createAgent({ id: "send-drop", mode: "yolo" }, undefined);
  const controller = new AbortController();
  controller.abort();
  a.setRunContext(createRunContext(controller.signal));
  for (let i = 0; i < 3; i++) {
    assertEquals(a.sendEvent(() => true, { type: 7 }), false);
  }
  assertEquals(a.droppedEvents, 3);

  // A new run resets the counter.
  a.setRunContext(createRunContext());
  assertEquals(a.droppedEvents, 0);
});

Deno.test("sendEvent does not require any message lock", () => {
  const a = createAgent({ id: "send-lock", mode: "yolo" }, undefined);
  a.setRunContext(createRunContext());
  assertEquals(a.sendEvent(() => true, { type: 4 }), true);
});

Deno.test("needsApproval method reads the agent's mode and rules", () => {
  const confirm: ApprovalSettings = { confirmBeforeWrite: true };
  const agentMode = createAgent(
    { id: "approval-method", mode: "agent", settings: { approval: confirm } },
    undefined,
  );
  assert(agentMode.needsApproval("write", { path: "README.md" }));
  assert(!agentMode.needsApproval("read", { path: "README.md" }));

  const yoloMode = createAgent(
    { id: "approval-yolo", mode: "yolo", settings: { approval: confirm } },
    undefined,
  );
  assert(!yoloMode.needsApproval("write", { path: "README.md" }));

  const allow: AllowConfig = { autoEdit: true };
  const allowed = createAgent(
    {
      id: "approval-allow",
      mode: "agent",
      settings: { approval: confirm },
      allow,
    },
    undefined,
  );
  assert(!allowed.needsApproval("write", { path: "any/file.go" }));
});
