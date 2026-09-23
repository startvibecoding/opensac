// (pure cases).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  MEMBER_STATUS_DONE,
  MEMBER_STATUS_ERROR,
  type MemberCompletion,
  newMemberCompletion,
  newMemberMailbox,
} from "./mailbox.ts";

function completion(partial: Partial<MemberCompletion>): MemberCompletion {
  return { ...newMemberCompletion(), ...partial };
}

Deno.test("member mailbox drain steering order and format", () => {
  const m = newMemberMailbox();
  assert(!m.hasPending());
  assertEquals(m.drainSteering(), null);

  m.enqueue(
    completion({
      memberId: "pm",
      displayName: "产品经理",
      status: MEMBER_STATUS_DONE,
      payload: "PRD 已完成",
    }),
  );
  m.enqueue(
    completion({
      memberId: "engineer",
      displayName: "工程师",
      status: MEMBER_STATUS_DONE,
      payload: "Result: done",
    }),
  );
  assert(m.hasPending());

  const msgs = m.drainSteering()!;
  assertEquals(msgs.length, 2);
  for (const msg of msgs) {
    assertEquals(msg.role, "user");
    assert(msg.systemInjected === true);
    assert(
      msg.content!.startsWith(
        "[MEMBER_COMPLETION] 系统注入的成员状态上下文（非用户输入）。",
      ),
    );
  }
  const wantFirst =
    "[MEMBER_COMPLETION] 系统注入的成员状态上下文（非用户输入）。\n" +
    "member: pm（产品经理）\n" +
    "status: done\n" +
    "payload:\n" +
    "PRD 已完成";
  assertEquals(msgs[0].content, wantFirst);
  assert(msgs[1].content!.includes("member: engineer（工程师）"));
  assert(msgs[1].content!.includes("Result: done"));

  assert(!m.hasPending());
  assertEquals(m.drainSteering(), null);
});

Deno.test("member mailbox drain truncates done payload runes", () => {
  const m = newMemberMailbox();
  const payload = "测".repeat(4000);
  m.enqueue(
    completion({ memberId: "qa", status: MEMBER_STATUS_DONE, payload }),
  );
  const msgs = m.drainSteering()!;
  assertEquals(msgs.length, 1);
  const content = msgs[0].content!;
  assert(content.includes("测".repeat(3500) + "…[truncated]"));
  assert(!content.includes("测".repeat(3501)));
});

Deno.test("member mailbox drain error truncation and next step", () => {
  const m = newMemberMailbox();
  const payload = "e".repeat(3500);
  m.enqueue(
    completion({
      memberId: "engineer",
      displayName: "工程师",
      status: MEMBER_STATUS_ERROR,
      payload,
    }),
  );
  const content = m.drainSteering()![0].content!;
  assert(content.includes("e".repeat(3000) + "…[truncated]"));
  assert(!content.includes("e".repeat(3001)));
  assert(
    content.endsWith(
      '下一步：如仍需该成员，用 subagent_spawn(member:"engineer", task:…) 重新派发任务。',
    ),
  );
  assert(content.includes("status: error\n"));
});

Deno.test("member mailbox drain error short payload keeps next step", () => {
  const m = newMemberMailbox();
  m.enqueue(
    completion({
      memberId: "qa",
      status: MEMBER_STATUS_ERROR,
      payload: "boom",
    }),
  );
  const content = m.drainSteering()![0].content!;
  assert(content.includes("payload:\nboom\n"));
  assert(content.includes('subagent_spawn(member:"qa", task:…)'));
});

Deno.test("member mailbox pending summary does not drain", () => {
  const m = newMemberMailbox();
  assertEquals(m.pendingSummary(), null);
  m.enqueue(
    completion({ memberId: "pm", status: MEMBER_STATUS_DONE, payload: "PRD" }),
  );
  m.enqueue(
    completion({
      memberId: "qa",
      status: MEMBER_STATUS_ERROR,
      payload: "boom",
    }),
  );

  const summary = m.pendingSummary()!;
  assertEquals(summary.length, 2);
  assertEquals(summary[0].memberId, "pm");
  assertEquals(summary[0].payload, "PRD");
  assert(m.hasPending());

  summary[0].payload = "mutated";
  assertEquals(m.pendingSummary()![0].payload, "PRD");
  assertEquals(m.drainSteering()!.length, 2);
});

Deno.test("member mailbox wait for activity signal", async () => {
  const m = newMemberMailbox();
  setTimeout(
    () => m.enqueue(completion({ memberId: "pm", status: MEMBER_STATUS_DONE })),
    20,
  );
  const start = Date.now();
  const timedOut = await m.waitForActivity(undefined, 10_000);
  assert(!timedOut);
  assert(Date.now() - start < 5_000);
});

Deno.test("member mailbox wait for activity timeout", async () => {
  const m = newMemberMailbox();
  const timedOut = await m.waitForActivity(undefined, 30);
  assert(timedOut);
});

Deno.test("member mailbox wait for activity aborts", async () => {
  const m = newMemberMailbox();
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => m.waitForActivity(controller.signal, 10_000),
    Error,
  );
});

Deno.test("member mailbox drain clears activity signal", async () => {
  const m = newMemberMailbox();
  m.enqueue(completion({ memberId: "pm", status: MEMBER_STATUS_DONE }));
  assertEquals(m.drainSteering()!.length, 1);
  const timedOut = await m.waitForActivity(undefined, 30);
  assert(timedOut);
});

Deno.test("member mailbox running predicate", () => {
  const m = newMemberMailbox();
  assert(!m.runningChildrenRunning());
  m.setRunningPredicate(() => true);
  assert(m.runningChildrenRunning());
  m.setRunningPredicate(undefined);
  assert(!m.runningChildrenRunning());
});
