// Translated tests from internal/acp/acp_mcp_test.go and focused coverage for
// the ACP server-support helpers (startup errors, cursors, titles, paging).

import { assert, assertEquals, assertThrows } from "@opensac/assert";
import type { Message } from "../provider/types.ts";
import type { Manager } from "../session/manager.ts";
import {
  acpConfigValue,
  ACPStartupError,
  classifyACPStartupError,
  decodeTranscriptCursor,
  doctorStartupMessage,
  elicitationRequestForQuestion,
  encodeTranscriptCursor,
  isStartupError,
  messageUpdates,
  normalizeStopReason,
  questionAnswer,
  replayMessageID,
  startupErrorFromDoctor,
  toolRawInput,
  toolTitle,
  ToolTitleRegistry,
  transcriptPage,
  transcriptPageSize,
  truncateTitle,
} from "./support.ts";

Deno.test("classifyACPStartupError does not expose its cause", () => {
  const secret = "do-not-expose-this-value";
  const startup = classifyACPStartupError(
    new Error(`invalid provider config api key=${secret}`),
  );
  assertEquals(startup.code, "provider_unusable");
  assertEquals(startup.message.includes(secret), false);
  assertEquals(startup.fix.includes(secret), false);
  assertEquals(isStartupError(startup), true);
  assertEquals(isStartupError(new Error("x")), false);
});

Deno.test("startupErrorFromDoctor projects the first failing check", () => {
  const error = startupErrorFromDoctor({
    ok: false,
    version: "1",
    summary: "bad",
    checks: [
      { id: "provider.default", status: "warn", title: "p" },
      {
        id: "provider.default",
        status: "error",
        title: "Provider",
        detail: "openai: missing api key",
        fix: "Set the key",
      },
    ],
  });
  assert(error instanceof ACPStartupError);
  assertEquals(error.code, "provider_unusable");
  assertEquals(error.message, "default provider openai has no API key");
  assertEquals(error.fix, "Set the key");
  assertEquals(
    startupErrorFromDoctor({ ok: true, version: "1", summary: "", checks: [] }),
    null,
  );

  assertEquals(doctorStartupMessage(""), "configuration is unusable");
  assertEquals(doctorStartupMessage("Unknown Provider"), "unknown provider");
});

Deno.test("transcript cursors round-trip and reject invalid values", () => {
  const cursor = encodeTranscriptCursor(7);
  assertEquals(decodeTranscriptCursor(cursor), 7);
  assertThrows(() => decodeTranscriptCursor("!!not-base64!!"));
  assertThrows(() => decodeTranscriptCursor(btoa("nope")));
  assertEquals(transcriptPageSize(0), 40);
  assertEquals(transcriptPageSize(5), 5);
  assertEquals(transcriptPageSize(1000), 100);
});

Deno.test("tool titles and stop reasons project faithfully", () => {
  assertEquals(toolTitle("bash", { command: "ls -la" }), "bash: ls -la");
  assertEquals(toolTitle("read", { path: "/a/b" }), "read: path=/a/b");
  assertEquals(
    toolTitle("grep", { pattern: "x", path: "/a" }),
    "grep: pattern=x path=/a",
  );
  assertEquals(toolTitle("bash", {}), "bash");
  assertEquals(
    truncateTitle("x".repeat(200)).length,
    160,
  );
  assertEquals(normalizeStopReason("tool_use"), "end_turn");
  assertEquals(normalizeStopReason("max_tokens"), "max_tokens");
  assertEquals(normalizeStopReason("cancelled"), "cancelled");
  assertEquals(normalizeStopReason("weird"), "refusal");

  const registry = new ToolTitleRegistry();
  assertEquals(
    registry.rememberToolTitle("t1", "bash", { command: "date" }),
    "bash: date",
  );
  assertEquals(registry.toolTitleFor("t1", "fallback"), "bash: date");
  assertEquals(registry.toolTitleFor("t2", "fallback"), "fallback");

  assertEquals(toolRawInput({ a: 1 }), { args: { a: 1 }, a: 1 });
  assertEquals(toolRawInput(undefined), { args: null });
});

Deno.test("replayMessageID is stable and messageUpdates matches roles", () => {
  const first = replayMessageID("s1", "message", "hello");
  assertEquals(first, replayMessageID("s1", "message", "hello"));
  assert(first.startsWith("acp_replay_message_"));

  const registry = new ToolTitleRegistry();
  const assistant: Message = {
    role: "assistant",
    timestamp: new Date(),
    contents: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi" },
      {
        type: "toolCall",
        toolCall: { id: "t1", name: "bash", arguments: { command: "ls" } },
      },
    ],
  };
  const updates = messageUpdates(registry, "s1", assistant, "e1");
  assertEquals(updates.map((update) => update.sessionUpdate), [
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
  ]);
  assertEquals(updates[2].toolCallId, "t1");
  assertEquals(updates[2].title, "bash: ls");

  const user: Message = {
    role: "user",
    content: "hello",
    timestamp: new Date(),
  };
  const userUpdates = messageUpdates(registry, "s1", user, "");
  assertEquals(userUpdates[0].sessionUpdate, "user_message_chunk");
  assertEquals(userUpdates[0].content, { type: "text", text: "hello" });

  const result: Message = {
    role: "toolResult",
    content: "out",
    toolCallId: "t1",
    toolName: "bash",
    isError: true,
    timestamp: new Date(),
  };
  const resultUpdates = messageUpdates(registry, "s1", result, "");
  assertEquals(resultUpdates[0].sessionUpdate, "tool_call_update");
  assertEquals(resultUpdates[0].status, "failed");
  assertEquals(resultUpdates[0].title, "bash: ls");
});

Deno.test("transcriptPage windows canonical messages", () => {
  const messages: Message[] = [];
  const entryIDs: string[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: "user", content: `m${i}`, timestamp: new Date() });
    entryIDs.push(`e${i}`);
  }
  const manager = {
    getReplayState: () => ({ messages, entryIDs }),
  } as unknown as Manager;
  const registry = new ToolTitleRegistry();

  const page = transcriptPage("s1", manager, "", 2, registry);
  assertEquals(page.sessionId, "s1");
  assertEquals(page.updates.length, 2);
  assertEquals(page.nextCursor, encodeTranscriptCursor(3));
  assertEquals(
    (page.updates[0].content as { text: string }).text,
    "m3",
  );

  const first = transcriptPage("s1", manager, "", 0, registry);
  assertEquals(first.updates.length, 5);
  assertEquals(first.nextCursor, undefined);

  assertThrows(() =>
    transcriptPage("s1", manager, encodeTranscriptCursor(99), 2, registry)
  );
});

Deno.test("acpConfigValue decodes strings and booleans", () => {
  assertEquals(acpConfigValue("model-a", false), "model-a");
  assertEquals(acpConfigValue(true, false), "true");
  assertEquals(acpConfigValue(false, false), "false");
  assertEquals(acpConfigValue("", true), "");
  assertThrows(() => acpConfigValue("", false));
  assertThrows(() => acpConfigValue(5, false));
});

Deno.test("elicitation and question projections", () => {
  const request = elicitationRequestForQuestion({
    sessionId: "s1",
    question: "Pick",
    options: ["a", "b"],
    explanation: "hint",
    timeoutMs: 1000,
  });
  assertEquals(request.mode, "form");
  const schema = request.requestedSchema as {
    properties: { answer: { enum: string[] } };
  };
  assertEquals(schema.properties.answer.enum, ["a", "b"]);

  assertEquals(
    questionAnswer({ action: "accept", content: { answer: "yes" } }, true),
    { answer: "yes", status: "resolved" },
  );
  assertEquals(
    questionAnswer({ answer: "legacy" }, true),
    { answer: "legacy", status: "resolved" },
  );
  assertEquals(
    questionAnswer({ action: "cancel" }, true),
    { answer: "", status: "cancelled" },
  );
  assertEquals(
    questionAnswer({ ok: true, answer: " yes " }, false),
    { answer: "yes", status: "resolved" },
  );
  assertEquals(
    questionAnswer({ ok: true, answers: ["two"] }, false),
    { answer: "two", status: "resolved" },
  );
  assertEquals(
    questionAnswer({ cancelled: true }, false),
    { answer: "", status: "cancelled" },
  );
});
