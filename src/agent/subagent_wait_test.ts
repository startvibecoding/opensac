// registry cases (`RegisterSubAgentTools`, child-registry stripping) move with
// the AgentManager and subagent_tools modules.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "../compat/assert.ts";
import { type ToolResult } from "../tools/tool.ts";
import {
  createMemberMailbox,
  MEMBER_STATUS_DONE,
  MemberMailbox,
} from "./mailbox.ts";
import { type MemberCompletion } from "./mailbox.ts";
import {
  createSubAgentWaitTool,
  resolveSubAgentWaitTimeoutMS,
  subAgentWaitDefaultTimeoutMS,
  subAgentWaitMaxTimeoutMS,
  subAgentWaitMinTimeoutMS,
} from "./subagent_wait.ts";
import { test } from "#testing";

function completion(partial: Partial<MemberCompletion>): MemberCompletion {
  return {
    kind: "",
    memberId: "",
    displayName: "",
    status: "",
    payload: "",
    questionId: "",
    options: [],
    ...partial,
  };
}

interface WaitParsed {
  message: string;
  timed_out: boolean;
  pending?: Array<{
    member: string;
    status: string;
    display_name?: string;
  }>;
}

function parse(t: ToolResult): WaitParsed {
  return JSON.parse(t.text) as WaitParsed;
}

test("subagent_wait tool metadata", () => {
  const tool = createSubAgentWaitTool({});
  assertEquals(tool.name(), "subagent_wait");
  assert(tool.description() !== "");
  assert(tool.promptSnippet() !== "");
  const guidelines = tool.promptGuidelines();
  assert(guidelines.length > 0);
  assertStringIncludes(guidelines.join(" "), "reflexive");
  const schema = tool.parameters() as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  assert(schema.properties?.["timeout_ms"] !== undefined);
  assert(schema.required === undefined || schema.required === null);
});

test("resolveSubAgentWaitTimeoutMS clamps", () => {
  const cases: Array<[Record<string, unknown>, number]> = [
    [{}, subAgentWaitDefaultTimeoutMS],
    [{ timeout_ms: 10 }, subAgentWaitMinTimeoutMS],
    [{ timeout_ms: 0 }, subAgentWaitMinTimeoutMS],
    [{ timeout_ms: -500 }, subAgentWaitMinTimeoutMS],
    [{ timeout_ms: 1000000 }, subAgentWaitMaxTimeoutMS],
    [{ timeout_ms: 5000 }, 5000],
    [{ timeout_ms: 60000 }, 60000],
    [{ timeout_ms: 100 }, subAgentWaitMinTimeoutMS],
    [{ timeout_ms: "soon" }, subAgentWaitDefaultTimeoutMS],
  ];
  for (const [params, want] of cases) {
    assertEquals(resolveSubAgentWaitTimeoutMS(params), want);
  }
  assertEquals(
    [
      subAgentWaitMinTimeoutMS,
      subAgentWaitMaxTimeoutMS,
      subAgentWaitDefaultTimeoutMS,
    ],
    [2500, 120000, 30000],
  );
});

test("subagent_wait nil mailbox", async () => {
  const tool = createSubAgentWaitTool({});
  const result = await tool.execute({}, {});
  const parsed = parse(result);
  assertEquals(parsed.message, "no member mailbox is bound to this session");
  assert(!parsed.timed_out);
  assertEquals(parsed.pending ?? [], []);
  assert(!result.text.includes("pending"));
});

test("subagent_wait pending summary excludes payload", async () => {
  const mbox: MemberMailbox = createMemberMailbox();
  mbox.enqueue(
    completion({
      memberId: "engineer",
      displayName: "工程师",
      status: MEMBER_STATUS_DONE,
      payload: "SECRET-PAYLOAD-CONTENT",
    }),
  );

  const tool = createSubAgentWaitTool({ mailbox: mbox });
  const start = Date.now();
  const result = await tool.execute({}, {});
  assert(
    Date.now() - start < 1000,
    "wait with pending completions must return immediately",
  );
  assert(!result.text.includes("SECRET-PAYLOAD-CONTENT"));

  const parsed = parse(result);
  assertEquals(parsed.message, "Wait completed.");
  assert(!parsed.timed_out);
  assertEquals(parsed.pending?.length, 1);
  const entry = parsed.pending![0];
  assertEquals(entry.member, "engineer");
  assertEquals(entry.status, "done");
  assertEquals(entry.display_name, "工程师");
  assert(mbox.hasPending(), "wait must not drain the mailbox");
});

test("subagent_wait returns on activity", async () => {
  const mbox = createMemberMailbox();
  setTimeout(() => {
    mbox.enqueue(
      completion({
        memberId: "qa",
        status: MEMBER_STATUS_DONE,
        payload: "passed",
      }),
    );
  }, 30);

  const tool = createSubAgentWaitTool({ mailbox: mbox });
  const result = await tool.execute({}, { timeout_ms: 10000 });
  const parsed = parse(result);
  assertEquals(parsed.message, "Wait completed.");
  assert(!parsed.timed_out);
  assertEquals(parsed.pending?.length, 1);
  assertEquals(parsed.pending![0].member, "qa");
  assertEquals(parsed.pending![0].status, "done");
});

test("subagent_wait timeout", async () => {
  const mbox = createMemberMailbox();
  const tool = createSubAgentWaitTool({ mailbox: mbox });
  const start = Date.now();
  // timeout_ms below the minimum must be clamped up to 2500ms.
  const result = await tool.execute({}, { timeout_ms: 1 });
  const elapsed = Date.now() - start;
  assert(
    elapsed >= 2400,
    `wait returned after ${elapsed}ms, want >= ~2.5s (min clamp)`,
  );
  const parsed = parse(result);
  assertEquals(parsed.message, "Wait timed out.");
  assert(parsed.timed_out);
  assertEquals(parsed.pending ?? [], []);
});

test("subagent_wait context canceled", async () => {
  const mbox = createMemberMailbox();
  const controller = new AbortController();
  controller.abort();
  const tool = createSubAgentWaitTool({ mailbox: mbox });
  await assertRejects(
    async () => await tool.execute({ signal: controller.signal }, {}),
    Error,
    "subagent_wait:",
  );
});
