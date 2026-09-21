// Ported from internal/serve/openaiapi/server_test.go (TestUsageEventDataIncludesCacheTokens,
// TestWithContextUsageEventData) plus focused cases for the free half of events.go.
import { assert, assertEquals } from "@std/assert";
import type { ContextUsage } from "../../context/context.ts";
import {
  boundedHostedString,
  capabilitySnapshotFromSession,
  capabilitySnapshotValues,
  cloneRunEventData,
  isIncompleteRunStatus,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  newExecutionIntentID,
  newRunID,
  requestFingerprint,
  retryIdempotencyScope,
  runEventErrorInfo,
  runEventTypeForStatus,
  usageEventData,
  withContextUsageEventData,
} from "./events.ts";
import { APISession } from "./session_mgr.ts";

Deno.test("usageEventData includes cache tokens", () => {
  const data = usageEventData(
    {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cache_read_tokens: 75,
      cache_write_tokens: 10,
    },
    "",
  );
  const usage = data.usage as Record<string, unknown>;
  assertEquals(usage.cache_read_tokens, 75);
  assertEquals(usage.cache_write_tokens, 10);
  assertEquals("error" in data, false);
});

Deno.test("usageEventData carries the error message", () => {
  const data = usageEventData(
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    "boom",
  );
  assertEquals(data.error, "boom");
});

Deno.test("withContextUsageEventData", () => {
  const usage: ContextUsage = {
    tokens: 25000,
    totalTokens: 25000,
    input: 24000,
    cacheRead: 500,
    cacheWrite: 500,
    contextWindow: 100000,
  };
  const data = withContextUsageEventData({}, usage);
  const projected = data.contextUsage as ContextUsage;
  assertEquals(projected.totalTokens, 25000);
  assertEquals(projected.contextWindow, 100000);
  // A zero window leaves the event untouched.
  assertEquals(withContextUsageEventData({}, null), {});
  assertEquals(
    withContextUsageEventData({}, { ...usage, contextWindow: 0 }),
    {},
  );
});

Deno.test("requestFingerprint is stable and digests only", () => {
  const first = requestFingerprint({ messages: ["a"], model: "m" });
  const second = requestFingerprint({ messages: ["a"], model: "m" });
  assertEquals(first, second);
  assert(first.startsWith("sha256:"));
  assertEquals(first.length, "sha256:".length + 64);
  assertEquals(
    requestFingerprint({ a: 1 }) === requestFingerprint({ a: 2 }),
    false,
  );
});

Deno.test("retryIdempotencyScope table", () => {
  assertEquals(retryIdempotencyScope("", ""), "retry");
  assertEquals(retryIdempotencyScope("intent-1", ""), "retry");
  assertEquals(retryIdempotencyScope("", "run-1"), "retry");
  assertEquals(
    retryIdempotencyScope("intent-1", "run-1"),
    "retry:intent-1:run-1",
  );
});

Deno.test("run ID vocabulary", () => {
  const runID = newRunID();
  const intentID = newExecutionIntentID();
  assertEquals(runID.startsWith("run_"), true);
  assertEquals(intentID.startsWith("intent_"), true);
  assertEquals(runID === newRunID(), false);
});

Deno.test("isTerminalRunStatus table", () => {
  for (
    const status of [
      "completed",
      "incomplete",
      "failed",
      "cancelled",
      "canceled",
      "timed_out",
      "expired",
    ]
  ) {
    assertEquals(isTerminalRunStatus(status), true, status);
  }
  for (const status of ["", "running", "terminalizing", "CREATED"]) {
    assertEquals(isTerminalRunStatus(status), false, status);
  }
  assertEquals(isTerminalRunStatus(" Completed "), true);
});

Deno.test("runEventTypeForStatus and Responses status helpers", () => {
  assertEquals(runEventTypeForStatus("failed"), "failed");
  assertEquals(runEventTypeForStatus("canceled"), "canceled");
  assertEquals(runEventTypeForStatus("completed"), "finished");
  assertEquals(isSuccessfulRunStatus(" COMPLETED "), true);
  assertEquals(isSuccessfulRunStatus("incomplete"), false);
  assertEquals(isIncompleteRunStatus("Incomplete"), true);
  assertEquals(isIncompleteRunStatus("completed"), false);
});

Deno.test("boundedHostedString truncates at 512 bytes", () => {
  const short = "x".repeat(512);
  assertEquals(boundedHostedString(short), short);
  const long = "x".repeat(513);
  assertEquals(boundedHostedString(long), short + "...");
});

Deno.test("runEventErrorInfo extracts classified errors", () => {
  assertEquals(runEventErrorInfo(undefined).ok, false);
  assertEquals(runEventErrorInfo({}).ok, false);
  const info = { code: "provider_timeout", message: "timed out" };
  assertEquals(runEventErrorInfo({ errorInfo: info }), { info, ok: true });
  assertEquals(runEventErrorInfo({ error: info }), { info, ok: true });
  // A plain string error has no ErrorInfo code.
  assertEquals(runEventErrorInfo({ error: "boom" }).ok, false);
  // An ErrorInfo-shaped object with an empty code is found but not ok.
  assertEquals(
    runEventErrorInfo({ error: { code: "", message: "x" } }).ok,
    false,
  );
});

Deno.test("cloneRunEventData copies shallowly", () => {
  const data = { a: 1, nested: { b: 2 } };
  const cloned = cloneRunEventData(data);
  assertEquals(cloned, data);
  assert(cloned !== data);
  assert(cloned.nested === data.nested);
});

Deno.test("capability snapshot projects session capability fields", () => {
  assertEquals(capabilitySnapshotFromSession(undefined), {
    mode: "",
    delegateMode: false,
    multiAgent: false,
    workflows: false,
    webSearch: false,
    browser: false,
    a2aMaster: false,
  });
  const sess = new APISession();
  sess.mode = "yolo";
  sess.delegateMode = true;
  sess.multiAgent = true;
  sess.workflows = true;
  sess.webSearch = true;
  sess.browser = true;
  sess.a2aMaster = true;
  const snapshot = capabilitySnapshotFromSession(sess);
  assertEquals(capabilitySnapshotValues(snapshot), {
    mode: "yolo",
    delegateMode: "true",
    multiAgent: "true",
    workflows: "true",
    webSearch: "true",
    browser: "true",
    a2aMaster: "true",
  });
});
