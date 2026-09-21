// Translated from internal/serve/channels/dispatcher_test.go (the pure helper
// cases: channelRunState, effectiveChannelMode) plus focused coverage for the
// idempotency-key and progress-formatting helpers.

import { assert, assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import {
  EventError,
  EventRunFinished,
  TaskError,
  TaskSuccess,
} from "../../agent/events.ts";
import {
  RunStateCancelled,
  RunStateCompleted,
  RunStateFailed,
  RunStateIncomplete,
  RunStateTimedOut,
} from "../../agentruntime/mod.ts";
import {
  channelDeliveryCapability,
  channelFailureInfo,
  channelMessageIdempotencyKey,
  ChannelRunFailure,
  channelRunState,
  channelSafeSubAgentEvent,
  effectiveChannelMode,
  formatRetryProgress,
  formatToolProgress,
  IncompleteRunError,
  newChannelRunFailure,
} from "./run_helpers.ts";

function abortError(): Error {
  const err = new Error("canceled");
  err.name = "AbortError";
  return err;
}

function timeoutError(): Error {
  const err = new Error("deadline exceeded");
  err.name = "TimeoutError";
  return err;
}

Deno.test("channelRunState", () => {
  assertEquals(channelRunState(null), RunStateCompleted);
  assertEquals(channelRunState(abortError()), RunStateCancelled);
  assertEquals(channelRunState(timeoutError()), RunStateTimedOut);
  assertEquals(channelRunState(new Error("provider failed")), RunStateFailed);
  assertEquals(channelRunState(new IncompleteRunError()), RunStateIncomplete);
});

Deno.test("effectiveChannelMode defaults to yolo", () => {
  assertEquals(effectiveChannelMode("telegram", ""), "yolo");
  assertEquals(effectiveChannelMode("telegram", "agent"), "agent");
});

Deno.test("channelDeliveryCapability", () => {
  const wechat = channelDeliveryCapability("wechat");
  assert(
    wechat.text && wechat.sendImage && wechat.sendFile && wechat.sendVideo,
  );

  const feishu = channelDeliveryCapability("Feishu");
  assert(feishu.text && feishu.sendImage && feishu.sendFile);
  assert(!feishu.sendVideo);

  const other = channelDeliveryCapability("telegram");
  assert(other.text);
  assert(!other.sendImage && !other.sendFile && !other.sendVideo);
});

Deno.test("channelMessageIdempotencyKey prefers native message id", () => {
  const key = channelMessageIdempotencyKey({
    platform: " wechat ",
    chatID: "chat",
    userID: " user1 ",
    messageID: " evt-9 ",
    userName: "",
    text: "hello",
    timestamp: new Date(0),
    replyContext: "",
  });
  assertEquals(key, "channel:wechat:user1:evt-9");
});

Deno.test("channelMessageIdempotencyKey hashes stable envelope without native id", () => {
  const base = {
    platform: "feishu",
    chatID: "chat-1",
    userID: "u1",
    messageID: "",
    userName: "",
    text: "hello",
    timestamp: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    replyContext: "",
  };
  const first = channelMessageIdempotencyKey(base);
  const second = channelMessageIdempotencyKey({ ...base });
  assertEquals(first, second);
  assert(first.startsWith("channel:feishu:u1:fallback:"));

  const expected = "channel:feishu:u1:fallback:" +
    createHash("sha256")
      .update(
        ["feishu", "u1", "chat-1", "hello", base.timestamp.toISOString()].join(
          "\0",
        ),
      )
      .digest("hex");
  assertEquals(first, expected);

  // A different envelope hashes differently.
  assert(
    channelMessageIdempotencyKey({ ...base, text: "other" }) !== first,
  );

  // A fully empty envelope has no key (Go's zero time maps to an unset/NaN date).
  assertEquals(
    channelMessageIdempotencyKey({
      platform: "",
      chatID: "",
      userID: "",
      messageID: "",
      userName: "",
      text: "",
      timestamp: new Date(NaN),
      replyContext: "",
    }),
    "",
  );
});

Deno.test("formatRetryProgress", () => {
  assertEquals(formatRetryProgress({ type: 0 }), "↻ Retrying...");
  assertEquals(
    formatRetryProgress({ type: 0, retryContinue: true }),
    "↻ Continuing response...",
  );
  assertEquals(
    formatRetryProgress({
      type: 0,
      retryAttempt: 2,
      retryMaxAttempts: 5,
    }),
    "↻ Retrying (2/5)...",
  );
  assertEquals(
    formatRetryProgress({
      type: 0,
      retryAttempt: 1,
      retryMaxAttempts: 3,
      retryAfterMs: 30_000,
    }),
    "↻ Retrying (1/3); waiting 30s...",
  );
});

Deno.test("formatToolProgress", () => {
  assertEquals(
    formatToolProgress({ type: 0, toolName: "read" }, { path: "/tmp/a" }),
    "[read]: /tmp/a ✅",
  );
  assertEquals(
    formatToolProgress(
      { type: 0, toolName: "bash", toolError: new Error("boom") },
      { command: "x".repeat(80) },
    ),
    `[bash]: ${"x".repeat(60)}... ❌`,
  );
  assertEquals(
    formatToolProgress({ type: 0, toolName: "grep" }, { pattern: "foo" }),
    "[grep]: foo ✅",
  );
  assertEquals(
    formatToolProgress({ type: 0, toolName: "unknown_tool" }, {}),
    "[unknown_tool] ✅",
  );
  assertEquals(formatToolProgress({ type: 0 }, {}), "");
});

Deno.test("channelSafeSubAgentEvent projects safe errors", () => {
  const raw = "internal provider secret detail";
  const errEvent = channelSafeSubAgentEvent({
    type: EventError,
    error: new Error(raw),
  });
  assert(errEvent.error !== undefined);
  // The projected message is a fresh error carrying the Runtime-classified
  // display message, not the original error object.
  assert(errEvent.error!.message.length > 0);
  const failFinished = channelSafeSubAgentEvent({
    type: EventRunFinished,
    status: TaskError,
    error: new Error("raw failure"),
  });
  assert(failFinished.error !== undefined);
  assert(failFinished.error!.message.length > 0);

  const okFinished = channelSafeSubAgentEvent({
    type: EventRunFinished,
    status: TaskSuccess,
  });
  assertEquals(okFinished.error, undefined);
});

Deno.test("channelRunFailure keeps safe message and cause", () => {
  const cause = new Error("raw provider error");
  const failure = newChannelRunFailure(cause, undefined, "model");
  assert(failure instanceof ChannelRunFailure);
  // The message is the classified display message from the Runtime
  // ErrorInfo contract; the cause is preserved for lifecycle checks.
  assert(failure.message.length > 0);
  assertEquals(failure.info.phase, "model");
  assertEquals(failure.cause, cause);

  // An observed ErrorInfo with a display message wins over reclassification.
  const info = channelFailureInfo(
    failure,
    { code: "x", message: "safe display message" },
    "model",
  );
  assertEquals(info.message, "safe display message");
});
