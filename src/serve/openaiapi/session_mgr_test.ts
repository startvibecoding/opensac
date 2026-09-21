// Ported from internal/serve/openaiapi/server_test.go (the SessionPool cases
// plus the message/plan projection assertions of the GetSessionMessages tests,
// adapted to the free projection functions that back them) and
// session_mgr.go's inspectExecution fallback behavior.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  newAssistantMessage,
  newToolResultMessage,
  newUserMessage,
} from "../../provider/types.ts";
import {
  APISession,
  channelLabel,
  cloneContentBlocks,
  messageText,
  normalizeSessionPlanStatus,
  planFromToolCall,
  PoolFullError,
  sequencedMessagesToEntries,
  sessionMessagesToEntries,
  SessionPool,
  summarizeToolResult,
  toolResultText,
  validRawMessage,
} from "./session_mgr.ts";

Deno.test("SessionPool put/get", async () => {
  const pool = new SessionPool(0, 0);
  const sess = new APISession();
  sess.id = "sess-1";
  sess.workDir = "/tmp";
  sess.lastUsed = new Date();
  pool.put(sess);
  const got = pool.get("sess-1");
  assert(got && got.id === "sess-1", "expected to get session back");
  assertEquals(pool.count(), 1);
  await pool.stop();
});

Deno.test("SessionPool max sessions", async () => {
  const pool = new SessionPool(1, 0);
  const sess1 = new APISession();
  sess1.id = "sess-1";
  sess1.lastUsed = new Date();
  pool.put(sess1);
  const sess2 = new APISession();
  sess2.id = "sess-2";
  sess2.lastUsed = new Date();
  assertThrows(() => pool.put(sess2), PoolFullError);
  await pool.stop();
});

Deno.test("SessionPool remove", async () => {
  const pool = new SessionPool(0, 0);
  const sess = new APISession();
  sess.id = "sess-1";
  sess.lastUsed = new Date();
  pool.put(sess);
  pool.remove("sess-1");
  assertEquals(pool.get("sess-1"), undefined);
  await pool.stop();
});

Deno.test("SessionPool list", async () => {
  const pool = new SessionPool(0, 0);
  const a = new APISession();
  a.id = "a";
  a.lastUsed = new Date();
  pool.put(a);
  const b = new APISession();
  b.id = "b";
  b.lastUsed = new Date();
  pool.put(b);
  assertEquals(pool.list().length, 2);
  await pool.stop();
});

Deno.test("SessionPool getForWorkDir scopes by workDir and detects ambiguity", async () => {
  const pool = new SessionPool(0, 0);
  const first = new APISession();
  first.id = "shared";
  first.workDir = "/w1";
  first.lastUsed = new Date();
  pool.put(first);
  const second = new APISession();
  second.id = "shared";
  second.workDir = "/w2";
  second.lastUsed = new Date();
  pool.put(second);

  assert(pool.getForWorkDir("/w1", "shared") === first);
  assert(pool.getForWorkDir("/w2", "shared") === second);
  // Ambiguous bare-ID lookup returns nil, mirroring Go.
  assertEquals(pool.getForWorkDir("", "shared"), undefined);
  assertEquals(pool.getForWorkDir("/w3", "shared"), undefined);

  // getExact keeps Go's (nil, error) ambiguity contract as a throw.
  assertThrows(
    () => pool.getExact("shared"),
    Error,
    "active session ID is ambiguous",
  );

  pool.removeByWorkDir("/w2", "shared");
  assert(pool.getExact("shared") === first);
  await pool.stop();
});

Deno.test("SessionPool pin/unpin tracks residency", async () => {
  const pool = new SessionPool(0, 0);
  const sess = new APISession();
  sess.id = "pinned";
  sess.workDir = "/w";
  pool.put(sess);
  assert(pool.pin(sess));
  assert(!pool.pin(new APISession()));
  sess.unpin();
  assertEquals(sess.isInUse(), false);
  await pool.stop();
});

Deno.test("SessionPool replace swaps the entry", async () => {
  const pool = new SessionPool(0, 0);
  const old = new APISession();
  old.id = "old";
  old.workDir = "/w";
  pool.put(old);
  const next = new APISession();
  next.id = "new";
  next.workDir = "/w";
  pool.replace("old", next);
  assertEquals(pool.get("old"), undefined);
  assertEquals(pool.get("new"), next);
  await pool.stop();
});

Deno.test("SessionPool go refuses work after stop", async () => {
  const pool = new SessionPool(0, 0);
  await pool.stop();
  assertEquals(pool.go(() => {}), false);
});

Deno.test("APISession run bookkeeping lifecycle", () => {
  const sess = new APISession();
  sess.id = "run-lifecycle";
  sess.beginRun("run-1");
  assertEquals(sess.activeRunId, "run-1");
  assertEquals(sess.activeRunStatus, "running");
  assertEquals(sess.isRunning(), true);
  assert(sess.isDurableRun("run-1") === false);
  sess.markDurableRun("run-1");
  assertEquals(sess.isDurableRun("run-1"), true);
  assert(sess.attachRunAgent("run-2", {} as never, () => {}) === false);
  assertEquals(sess.markRunTerminalizing("run-2"), undefined);
  sess.markRunTerminalizing("run-1");
  assertEquals(sess.activeRunStatus, "terminalizing");
  sess.finishRun("run-1");
  assertEquals(sess.activeRunId, "");
  assertEquals(sess.isRunning(), false);
  sess.clearDurableRun("run-1");
  assertEquals(sess.isDurableRun("run-1"), false);
});

Deno.test("APISession attachRunAgent binds the agent to the active run", () => {
  const sess = new APISession();
  sess.beginRun("run-1");
  let aborted = false;
  assert(
    sess.attachRunAgent(
      "run-1",
      { abort: () => aborted = true } as never,
      () => {},
    ),
  );
  assertEquals(sess.activeRunAgent !== undefined, true);
  const execution = sess.executionRuntime()!;
  execution.cancel();
  assertEquals(aborted, true);
});

Deno.test("APISession inspectExecution falls back to the legacy projection", () => {
  const sess = new APISession();
  sess.id = "legacy";
  // No manager and no execution: the idle projection.
  let snapshot = sess.inspectExecution();
  assertEquals(snapshot.state, "idle");
  assertEquals(snapshot.canSubmit, true);
  assertEquals(snapshot.sessionExists, true);

  // Legacy running bit keeps the conservative unknown projection.
  sess.setRunning(true);
  snapshot = sess.inspectExecution();
  assertEquals(snapshot.state, "unknown");
  assertEquals(snapshot.busy, true);
  assertEquals(snapshot.phase, "legacy");

  // A process-local execution without a session root projects as local.
  const other = new APISession();
  other.id = "local";
  other.beginRun("run-local");
  snapshot = other.inspectExecution();
  assertEquals(snapshot.state, "local");
  assertEquals(snapshot.activeRun?.id, "run-local");
  assertEquals(snapshot.busy, true);
});

Deno.test("message entries include tool calls and collapsed results", () => {
  const fullOutput = "total 8\n-rw-r--r-- file.txt\n";
  const msgs = [
    newUserMessage("list files"),
    newAssistantMessage([
      { type: "text", text: "I will inspect the tree." },
      {
        type: "toolCall",
        toolCall: {
          id: "call-1",
          name: "bash",
          arguments: { command: "ls -la" },
        },
      },
    ]),
    newToolResultMessage("call-1", "bash", fullOutput, false),
  ];
  const entries = sessionMessagesToEntries(msgs);
  assertEquals(entries.length, 4);
  assertEquals(entries[1].role, "assistant");
  assertEquals(entries[1].content, "I will inspect the tree.");
  assertEquals(entries[2].role, "toolCall");
  assertEquals(entries[2].toolCallId, "call-1");
  assertEquals(entries[2].toolName, "bash");
  assertEquals(JSON.stringify(entries[2].arguments), '{"command":"ls -la"}');
  assertEquals(entries[3].role, "toolResult");
  assertEquals(entries[3].content, undefined);
  assertEquals(entries[3].hasDetail, true);
  assertEquals(entries[3].summary, "total 8");
});

Deno.test("message entries extract plan tool calls", () => {
  const assistant = newAssistantMessage([
    {
      type: "toolCall",
      toolCall: {
        id: "plan-call",
        name: "plan",
        arguments: {
          title: "Ship WebUI plan",
          steps: [
            { title: "Read current UI", status: "done" },
            { title: "Render todo card", status: "running" },
            { title: "Build frontend", status: "pending" },
          ],
          note: "Keep output compact",
        },
      },
    },
  ]);
  const msgs = [
    assistant,
    newToolResultMessage("plan-call", "plan", "Plan updated.", false),
  ];
  const entries = sessionMessagesToEntries(msgs);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].role, "toolCall");
  assertEquals(entries[0].toolName, "plan");
  assertEquals(entries[0].plan?.title, "Ship WebUI plan");
  assertEquals(entries[0].plan?.note, "Keep output compact");
  assertEquals(entries[0].plan?.steps?.length, 3);
  assertEquals(entries[0].plan?.steps?.[1].status, "running");
  assertEquals(entries[1].role, "toolResult");
  assertEquals(entries[1].toolName, "plan");
});

Deno.test("sequenced message entries carry entry cursors", () => {
  const msgs = [
    { seq: 3, entryID: "e3", message: newUserMessage("hello") },
    {
      seq: 4,
      entryID: "e4",
      message: newAssistantMessage([{ type: "text", text: "hi" }]),
    },
  ];
  const entries = sequencedMessagesToEntries(msgs);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].seq, 3);
  assertEquals(entries[0].id, "e3");
  assertEquals(entries[1].id, "e4:assistant");
  assertEquals(entries[1].seq, 4);
});

Deno.test("provider message entries skip system-injected messages", () => {
  const injected = newUserMessage("session context");
  injected.systemInjected = true;
  assertEquals(sessionMessagesToEntries([injected]), []);
});

Deno.test("assistant entries without content are omitted", () => {
  assertEquals(sessionMessagesToEntries([newAssistantMessage([])]), []);
});

Deno.test("message text helpers", () => {
  assertEquals(messageText(newUserMessage("plain")), "plain");
  assertEquals(
    messageText(newAssistantMessage([
      { type: "text", text: "a" },
      { type: "thinking", thinking: "hm" },
      { type: "text", text: "b" },
    ])),
    "ab",
  );
  assertEquals(
    toolResultText(newToolResultMessage("c", "bash", "", false)),
    "",
  );
  assertEquals(
    toolResultText(
      newToolResultMessage("c", "bash", "", false),
    ),
    "",
  );
  const rich = newToolResultMessage("c", "bash", "", false);
  rich.contents = [{ type: "image" }];
  assertEquals(toolResultText(rich), "(rich tool result)");
  const multiline = newToolResultMessage(
    "c",
    "bash",
    "first line\nsecond\r\nthird",
    false,
  );
  assertEquals(summarizeToolResult(multiline), "first line");
  const empty = newToolResultMessage("c", "bash", "", false);
  assertEquals(summarizeToolResult(empty), "(empty result)");
});

Deno.test("planFromToolCall validation table", () => {
  assertEquals(planFromToolCall("bash", { command: "ls" }), undefined);
  assertEquals(planFromToolCall("plan", null), undefined);
  assertEquals(planFromToolCall("plan", {}), undefined);
  assertEquals(planFromToolCall("plan", { steps: [] }), undefined);
  assertEquals(
    planFromToolCall("plan", { steps: [{ title: " " }] }),
    undefined,
  );
  const plan = planFromToolCall("plan", {
    title: " T ",
    note: " N ",
    steps: [
      { title: "one", status: "WEIRD" },
      { title: "two", status: "done" },
    ],
  });
  assertEquals(plan?.title, "T");
  assertEquals(plan?.note, "N");
  assertEquals(plan?.steps, [
    { title: "one", status: "pending" },
    { title: "two", status: "done" },
  ]);
});

Deno.test("normalizeSessionPlanStatus table", () => {
  assertEquals(normalizeSessionPlanStatus(" Done "), "done");
  assertEquals(normalizeSessionPlanStatus("pending"), "pending");
  assertEquals(normalizeSessionPlanStatus("running"), "running");
  assertEquals(normalizeSessionPlanStatus("failed"), "failed");
  assertEquals(normalizeSessionPlanStatus("nope"), "");
});

Deno.test("validRawMessage and cloneContentBlocks", () => {
  assertEquals(validRawMessage(null), undefined);
  assertEquals(validRawMessage(undefined), undefined);
  const args = { command: "ls" };
  assertEquals(validRawMessage(args), args);

  const blocks = [
    {
      type: "toolCall",
      toolCall: { id: "1", name: "bash", arguments: args },
      image: { data: "abc", mimeType: "image/png" },
      cache_control: { type: "ephemeral" },
    },
  ];
  const cloned = cloneContentBlocks(blocks);
  assert(cloned[0] !== blocks[0]);
  assert(cloned[0].toolCall !== blocks[0].toolCall);
  assert(cloned[0].image !== blocks[0].image);
  assert(cloned[0].cache_control !== blocks[0].cache_control);
  assertEquals(cloned, blocks);
});

Deno.test("channelLabel table", () => {
  assertEquals(channelLabel("wechat", "wx-1"), "WeChat");
  assertEquals(channelLabel("feishu", "fs-1"), "Feishu");
  assertEquals(channelLabel("", ""), "Local");
  assertEquals(channelLabel("local", ""), "Local");
});
