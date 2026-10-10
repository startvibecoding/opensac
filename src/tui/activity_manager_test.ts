// Focused tests for the ActivityManager: the live per-turn activity timeline
// fed by the AppController (tools, thinking, nesting, interruption) plus its
// module-level singleton helpers.

import { assert, assertEquals } from "../compat/assert.ts";
import {
  ActivityManager,
  formatElapsed,
  getActivityManager,
  getToolDisplayName,
  isParentTool,
  resetActivityManager,
} from "./activity_manager.ts";
import { test } from "#testing";

test("ActivityManager tracks tool executions with timing", () => {
  const am = new ActivityManager();
  const before = Date.now();
  am.startToolExecution("t1", "bash", { command: "ls" });
  am.completeToolExecution("t1", "ok");
  const items = am.buildTimeline();
  assertEquals(items.length, 1);
  assertEquals(items[0].type, "tool");
  assertEquals(items[0].status, "completed");
  assertEquals(items[0].toolName, "bash");
  assertEquals(items[0].content, "ok");
  assertEquals(items[0].timestamp >= before, true);
  assertEquals(typeof items[0].elapsedMs, "number");
});

test("ActivityManager marks errored and interrupted tools", () => {
  const am = new ActivityManager();
  am.startToolExecution("t1", "bash");
  am.completeToolExecution("t1", undefined, "boom");
  am.startToolExecution("t2", "grep");
  am.interruptToolExecution("t2");
  const items = am.buildTimeline();
  assertEquals(items.find((i) => i.id === "t1")?.status, "error");
  assertEquals(items.find((i) => i.id === "t1")?.error, "boom");
  assertEquals(items.find((i) => i.id === "t2")?.status, "interrupted");
  // getActiveTools reports only running tools.
  am.startToolExecution("t3", "ls");
  assertEquals(am.getActiveTools().map((t) => t.id), ["t3"]);
  assertEquals(am.hasRunningActivities(), true);
});

test("ActivityManager honors canonical tool state without an Error", () => {
  const am = new ActivityManager();
  am.startToolExecution("failed", "read");
  am.completeToolExecution("failed", "failed", undefined, "failed");
  am.startToolExecution("stopped", "write");
  am.completeToolExecution("stopped", "stopped", undefined, "interrupted");
  const items = am.buildTimeline();
  assertEquals(items.find((i) => i.id === "failed")?.status, "error");
  assertEquals(items.find((i) => i.id === "stopped")?.status, "interrupted");
});

test("ActivityManager tracks thinking blocks and clears per turn", () => {
  const am = new ActivityManager();
  am.startThinking("turn");
  am.appendThinking("turn", "why?");
  // While streaming, thinking should appear in timeline
  let items = am.buildTimeline();
  const think = items.find((i) => i.type === "thinking");
  assertEquals(think?.content, "why?");
  assertEquals(think?.status, "running");
  assertEquals(items.length, 1);
  assertEquals(items[0].type, "thinking");

  // After completion, thinking should NOT appear in timeline (it's now in transcript)
  am.completeThinking("turn");
  am.startToolExecution("t1", "bash");
  items = am.buildTimeline();
  assertEquals(items.find((i) => i.type === "thinking"), undefined);
  assertEquals(items.length, 1); // only the tool
  assertEquals(items[0].type, "tool");

  am.clear();
  assertEquals(am.buildTimeline().length, 0);
  assertEquals(am.hasRunningActivities(), false);
});

test("ActivityManager nesting tracks parent depth", () => {
  const am = new ActivityManager();
  am.startToolExecution("parent", "task");
  am.startToolExecution("child", "bash", undefined, undefined, "parent");
  const items = am.buildTimeline();
  assertEquals(items.find((i) => i.id === "child")?.depth, 1);
  assertEquals(items.find((i) => i.id === "child")?.parentId, "parent");
});

test("singleton accessor returns a stable instance; reset replaces it", () => {
  const first = getActivityManager();
  assertEquals(getActivityManager(), first);
  resetActivityManager();
  assert(getActivityManager() !== first);
});

test("format helpers render compact labels", () => {
  assertEquals(formatElapsed(500), "<1s");
  assertEquals(formatElapsed(5000), "5s");
  assertEquals(formatElapsed(125000), "2m5s");
  assertEquals(isParentTool("task"), true);
  assertEquals(isParentTool("spawn_agent"), true);
  assertEquals(isParentTool("bash"), false);
  assertEquals(getToolDisplayName("bash", { command: "ls -la" }), "ls -la");
  assertEquals(
    getToolDisplayName("read", { file_path: "/tmp/a.txt" }),
    "Read a.txt",
  );
  // Windows backslash paths render their file name, not the whole path.
  assertEquals(
    getToolDisplayName("read", { file_path: "C:\\Users\\dev\\a.txt" }),
    "Read a.txt",
  );
  assertEquals(
    getToolDisplayName("write", { file_path: "/tmp/b.txt" }),
    "Write b.txt",
  );
  assertEquals(
    getToolDisplayName("edit", { file_path: "/tmp/c.txt" }),
    "Edit c.txt",
  );
  assertEquals(getToolDisplayName("grep"), "grep");
});
