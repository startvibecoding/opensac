// (pure cases that do not
// require the agent loop). The Go tests also cover the loop wake path; that
// lands with the core loop port.

import { assert, assertEquals } from "../compat/assert.ts";
import { type Message } from "../provider/types.ts";
import {
  createMemberCompletion,
  createMemberMailbox,
  MEMBER_STATUS_DONE,
} from "./mailbox.ts";
import { composeFollowUps } from "./followup.ts";
import { test } from "#testing";

test("composeFollowUps returns undefined without a mailbox", () => {
  assertEquals(composeFollowUps(null), undefined);
});

test("composeFollowUps returns pending completions", async () => {
  const mbox = createMemberMailbox();
  const hook = composeFollowUps(mbox)!;
  assertEquals(await hook(undefined), null);

  mbox.enqueue(
    {
      ...createMemberCompletion(),
      memberId: "pm",
      status: MEMBER_STATUS_DONE,
      payload: "PRD 已完成",
    },
  );
  const messages = await hook(undefined);
  assert(messages != null);
  assertEquals(messages!.length, 1);
  assert(messages![0].content!.includes("[MEMBER_COMPLETION]"));
});

test("composeFollowUps waits for running children then returns completion", async () => {
  const mbox = createMemberMailbox();
  mbox.setRunningPredicate(() => true);
  const hook = composeFollowUps(mbox)!;

  const done = hook(undefined);
  mbox.enqueue(
    createMemberCompletion2("agent-child-1", "Alice", "member result"),
  );
  const messages = await done;
  assert(messages != null);
  assertEquals(messages!.length, 1);
  assert(messages![0].content!.includes("[MEMBER_COMPLETION]"));
});

test("composeFollowUps keeps adapter steering responsive", async () => {
  const mbox = createMemberMailbox();
  mbox.setRunningPredicate(() => true);

  let pending: Message[] = [];
  const adapter = (): Message[] => {
    const messages = pending;
    pending = [];
    return messages;
  };
  const hook = composeFollowUps(mbox, adapter)!;

  const done = hook(undefined);
  pending = [{ role: "user", content: "steer", timestamp: new Date() }];
  const messages = await done;
  assert(messages != null);
  assertEquals(messages![0].content, "steer");
});

test("composeFollowUps ignores cancellation while waiting", async () => {
  const mbox = createMemberMailbox();
  mbox.setRunningPredicate(() => true);
  const hook = composeFollowUps(mbox)!;

  const controller = new AbortController();
  const done = hook(controller.signal);
  setTimeout(() => controller.abort(), 20);
  assertEquals(await done, null);
});

function createMemberCompletion2(
  memberId: string,
  displayName: string,
  payload: string,
) {
  return {
    ...createMemberCompletion(),
    memberId,
    displayName,
    status: MEMBER_STATUS_DONE,
    payload,
  };
}
