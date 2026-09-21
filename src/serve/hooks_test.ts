// Translated from internal/serve/hooks/hooks_test.go.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { HookManager } from "./hooks.ts";

async function createTestScript(content: string): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "hook.sh");
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o700);
  return path;
}

Deno.test("newManager", () => {
  const m = new HookManager("", "");
  assert(!m.hasPreHook(), "expected no pre hook");
  assert(!m.hasPostHook(), "expected no post hook");

  const m2 = new HookManager("/path/pre", "/path/post");
  assert(m2.hasPreHook(), "expected pre hook");
  assert(m2.hasPostHook(), "expected post hook");
});

Deno.test("preToolCallNoHook", async () => {
  const m = new HookManager("", "");
  const { allowed, reason } = await m.preToolCall(
    new AbortController().signal,
    "bash",
    { command: "ls" },
    "ws",
    "user1",
  );
  assert(allowed, "expected allowed when no hook");
  assertEquals(reason, "");
});

Deno.test("preToolCallAllow", async () => {
  const script = await createTestScript(`#!/bin/sh
echo '{"action": "allow"}'
`);
  const m = new HookManager(script, "");
  const { allowed, reason } = await m.preToolCall(
    new AbortController().signal,
    "bash",
    { command: "ls" },
    "ws",
    "user1",
  );
  assert(allowed, "expected allowed");
  assertEquals(reason, "");
});

Deno.test("preToolCallBlock", async () => {
  const script = await createTestScript(`#!/bin/sh
echo '{"action": "block", "reason": "destructive command"}'
`);
  const m = new HookManager(script, "");
  const { allowed, reason } = await m.preToolCall(
    new AbortController().signal,
    "bash",
    { command: "rm -rf /" },
    "ws",
    "user1",
  );
  assert(!allowed, "expected blocked");
  assertEquals(reason, "destructive command");
});

Deno.test("preToolCallScriptNotFound", async () => {
  const m = new HookManager("/nonexistent/script", "");
  let err: unknown;
  try {
    await m.preToolCall(
      new AbortController().signal,
      "bash",
      {},
      "ws",
      "user1",
    );
  } catch (e) {
    err = e;
  }
  assert(err !== undefined, "expected error for missing script");
  // Fail-open is handled by the caller; the hook itself surfaces the error.
});

Deno.test("preToolCallInvalidJSON", async () => {
  const script = await createTestScript(`#!/bin/sh
echo 'not json'
`);
  const m = new HookManager(script, "");
  let err: unknown;
  try {
    await m.preToolCall(
      new AbortController().signal,
      "bash",
      {},
      "ws",
      "user1",
    );
  } catch (e) {
    err = e;
  }
  assert(err !== undefined, "expected error for invalid JSON");
});

Deno.test("postToolCallNoHook", () => {
  const m = new HookManager("", "");
  // Should not throw
  m.postToolCall(
    new AbortController().signal,
    "bash",
    {},
    "result",
    "",
    "ws",
    "user1",
  );
});

Deno.test("postToolCallWithHook", async () => {
  const script = await createTestScript(`#!/bin/sh
# Read stdin and log it
cat > /dev/null
echo "logged"
`);
  const m = new HookManager("", script);
  // Should not throw
  m.postToolCall(
    new AbortController().signal,
    "bash",
    { command: "ls" },
    "result",
    "",
    "ws",
    "user1",
  );
  // Give the fire-and-forget task a moment; a crash would surface as an
  // unhandled rejection and fail the test run.
  await new Promise((r) => setTimeout(r, 250));
});
