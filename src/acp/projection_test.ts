// internal/acp/acp_mcp_test.go plus focused coverage for the pure projection
// helpers (whose Go counterparts are exercised indirectly by the process tests
// that still need the ACP server slice).
//
// Deviations: `json.RawMessage` maps to decoded `unknown`; `nil` slices map to
// empty arrays (both serialize identically under Go's `omitempty`).

import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import {
  type Event,
  EVENT_COMPACTION_END,
  EVENT_COMPACTION_START,
  EVENT_TURN_END,
  EVENT_TURN_START,
  type EventType,
} from "../agent/events.ts";
import {
  acpByteSize,
  acpEventName,
  acpHostedStatus,
  acpOptionalProjectID,
  acpPlanEntries,
  acpPlanMeta,
  acpRetryEvent,
  acpRetryMessage,
  acpRunStatus,
  acpStreamFallbackMessageID,
  acpStreamMessageID,
  acpStructuredRPCError,
  acpToolImageContents,
  acpToolImageMaxBytes,
  acpToolImageMaxCount,
  acpToolKind,
  artifactSessionUpdate,
  decodeSessionCursor,
  encodeSessionCursor,
  extractSamplingInput,
  extractSamplingPrompt,
  formatACPPlan,
  opensacExtensionNamespace,
  parseJSONRawToMap,
  planStatusMarker,
  questionProjectionFor,
  requestQuestionPayloadFor,
  sameStringSlice,
  textToolContent,
  toolCallLocations,
} from "./mod.ts";
import { ToolCallContent } from "./protocol.ts";
import { test } from "#testing";

const unknownEventType: EventType = 999;

function retryEvent(partial: Partial<Event>): Event {
  return { type: unknownEventType, ...partial };
}

test("acpRunStatusProjectionMapsCanonicalStatuses", () => {
  const cases: Record<string, string> = {
    running: "running",
    created: "running",
    queued: "running",
    waiting_for_approval: "running",
    waiting_for_question: "running",
    cancelling: "running",
    terminalizing: "running",
    completed: "completed",
    incomplete: "incomplete",
    failed: "failed",
    timed_out: "failed",
    expired: "failed",
    cancelled: "cancelled",
    canceled: "cancelled",
    "unknown-terminal": "failed",
  };
  for (const [status, want] of Object.entries(cases)) {
    assertEquals(acpRunStatus(status), want, `acpRunStatus(${status})`);
  }
});

test("acpToolImageContentsProjectsWithinLimits", () => {
  const small = btoa("pixel");
  const contents = acpToolImageContents([
    { mimeType: "image/png", data: small },
    { mimeType: "", data: small },
    { mimeType: "image/png", data: "   " },
  ]);
  assertEquals(contents.length, 2);
  for (const content of contents) {
    assertEquals(content.type, "content");
    assert(content.content !== undefined, "image content missing");
    assertEquals(content.content!.type, "image");
    assertEquals(content.content!.data, small);
    assertEquals(content.content!.mimeType, "image/png");
  }
  assertEquals(acpToolImageContents([]).length, 0);
});

test("acpToolImageContentsDegradesOversizedAndExcessImages", () => {
  const oversized = btoa("x".repeat(acpToolImageMaxBytes + 1));
  const small = btoa("pixel");
  const images = [{ mimeType: "image/png", data: oversized }];
  for (let i = 0; i < acpToolImageMaxCount + 2; i++) {
    images.push({ mimeType: "image/jpeg", data: small });
  }
  const contents = acpToolImageContents(images);
  let imagesSeen = 0;
  let notesSeen = 0;
  for (const content of contents) {
    const block = content.content;
    if (block === undefined) continue;
    if (block.type === "image") {
      imagesSeen++;
    } else if (block.type === "text") {
      notesSeen++;
      assert(
        (block.text ?? "").includes("not projected"),
        `degraded note = ${block.text}`,
      );
    }
  }
  assertEquals(imagesSeen, acpToolImageMaxCount);
  assertEquals(notesSeen, 3);
});

test("extractSamplingInputParsesMessagesAndSystemPrompt", () => {
  const { prompt, systemPrompt, maxTokens } = extractSamplingInput({
    maxTokens: 512,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ],
  });
  assertEquals(prompt, "hello");
  assertEquals(systemPrompt, "sys");
  assertEquals(maxTokens, 512);
  assertEquals(extractSamplingPrompt({ maxTokens: 1, messages: [] }), "");
});

test("parseJSONRawToMapDecodesObjectsOnly", () => {
  assertEquals(parseJSONRawToMap({}), {});
  assertEquals(parseJSONRawToMap("bad"), undefined);
  assertEquals(parseJSONRawToMap(undefined), undefined);
});

test("acpEventNameMapsCompactionAndTurnEvents", () => {
  assertEquals(acpEventName(EVENT_COMPACTION_START), "compaction_started");
  assertEquals(acpEventName(EVENT_COMPACTION_END), "compaction_finished");
  assertEquals(acpEventName(EVENT_TURN_START), "turn_started");
  assertEquals(acpEventName(EVENT_TURN_END), "turn_finished");
  assertEquals(acpEventName(unknownEventType), "unknown");
});

test("acpToolKindMapsToolVocabulary", () => {
  assertEquals(acpToolKind("read"), "read");
  assertEquals(acpToolKind("ls"), "read");
  assertEquals(acpToolKind("write"), "edit");
  assertEquals(acpToolKind("edit"), "edit");
  assertEquals(acpToolKind("grep"), "search");
  assertEquals(acpToolKind("find"), "search");
  assertEquals(acpToolKind("bash"), "execute");
  assertEquals(acpToolKind("plan"), "think");
  assertEquals(acpToolKind("other-tool"), "other");
});

test("acpHostedStatusNormalizesTerminalValues", () => {
  assertEquals(acpHostedStatus("completed"), "completed");
  assertEquals(acpHostedStatus("failed"), "failed");
  assertEquals(acpHostedStatus("canceled"), "canceled");
  assertEquals(acpHostedStatus("queued"), "in_progress");
  assertEquals(acpHostedStatus(""), "in_progress");
});

test("textToolContentWrapsNonEmptyText", () => {
  assertEquals(textToolContent("").length, 0);
  const contents = textToolContent("hello");
  assertEquals(contents.length, 1);
  assertEquals(contents[0].type, "content");
  assertEquals(contents[0].content!.type, "text");
  assertEquals(contents[0].content!.text, "hello");
});

test("acpPlanEntriesMapsStepStatuses", () => {
  const entries = acpPlanEntries({
    title: "Plan",
    note: "",
    steps: [
      { title: "a", status: "pending" },
      { title: "b", status: "running" },
      { title: "c", status: "done" },
      { title: "d", status: "failed" },
    ],
  });
  assertEquals(entries, [
    { content: "a", priority: "medium", status: "pending" },
    { content: "b", priority: "medium", status: "in_progress" },
    { content: "c", priority: "medium", status: "completed" },
    { content: "d", priority: "medium", status: "completed" },
  ]);
  assertEquals(acpPlanMeta({ title: "", note: "", steps: [] }), undefined);
  assertEquals(acpPlanMeta({ title: "T", note: "N", steps: [] }), {
    [opensacExtensionNamespace]: { title: "T", note: "N" },
  });
});

test("formatACPPlanRendersStepsAndNote", () => {
  assertEquals(formatACPPlan(undefined), "Plan updated.");
  assertEquals(
    formatACPPlan({ title: "", note: "", steps: [] }),
    "Plan updated.",
  );
  assertEquals(planStatusMarker("running"), ">");
  assertEquals(planStatusMarker("done"), "x");
  assertEquals(planStatusMarker("failed"), "!");
  assertEquals(planStatusMarker("pending"), "-");
  assertEquals(
    formatACPPlan({
      title: "Goal",
      note: "careful",
      steps: [
        { title: "one", status: "running" },
        { title: "two", status: "done" },
      ],
    }),
    "Goal\n> one\nx two\nnote: careful",
  );
});

test("acpStreamMessageIDsAreStable", () => {
  assertEquals(acpStreamMessageID("s", "p", "message", 2), "acp_s_p_message_2");
  const first = acpStreamFallbackMessageID("session", false);
  const second = acpStreamFallbackMessageID("session", false);
  assertEquals(first, second);
  assert(first.startsWith("acp_message_"), `unexpected id ${first}`);
  assertEquals(first.length, "acp_message_".length + 16);
  assert(
    acpStreamFallbackMessageID("session", true).startsWith("acp_thought_"),
  );
});

test("acpRetryEventUsesStructuredFields", () => {
  assertEquals(acpRetryMessage(retryEvent({})), "Retrying...");
  const ev = retryEvent({
    retryAttempt: 2,
    retryMaxAttempts: 5,
    retryAfterMs: 1500,
  });
  assertEquals(acpRetryMessage(ev), "Retrying (attempt 2/5); waiting 1.5s...");
  const payload = acpRetryEvent("session-1", ev);
  assertEquals(payload, {
    sessionId: "session-1",
    event: "retrying",
    message: "Retrying (attempt 2/5); waiting 1.5s...",
    attempt: 2,
    maxAttempts: 5,
    retryAfterMs: 1500,
  });
});

test("toolCallLocationsOnlyProjectsAbsolutePaths", () => {
  assertEquals(toolCallLocations(undefined), []);
  assertEquals(
    toolCallLocations({
      path: "relative/x.ts",
      added: 0,
      deleted: 0,
      addedLines: [],
      deletedLines: [],
      unified: "",
      oldText: null,
      newText: "",
      truncated: false,
    }),
    [],
  );
  const abs = "/tmp/x.ts";
  assertEquals(
    toolCallLocations({
      path: abs,
      added: 1,
      deleted: 0,
      addedLines: [1],
      deletedLines: [],
      unified: "",
      oldText: null,
      newText: "x",
      truncated: false,
    }),
    [{ path: abs }],
  );
});

test("sessionCursorRoundTripsAndRejectsInvalid", () => {
  assertEquals(decodeSessionCursor(encodeSessionCursor(0)), 0);
  assertEquals(decodeSessionCursor(encodeSessionCursor(1234)), 1234);
  assertThrows(() => decodeSessionCursor("not-a-cursor"), Error);
  assertThrows(() => decodeSessionCursor(""), Error);
});

test("sameStringSliceComparesOrderSensitively", () => {
  assert(sameStringSlice([], []));
  assert(sameStringSlice(["a", "b"], ["a", "b"]));
  assert(!sameStringSlice(["a", "b"], ["b", "a"]));
  assert(!sameStringSlice(["a"], ["a", "b"]));
});

test("acpStructuredRPCErrorCarriesStableCode", () => {
  const err = acpStructuredRPCError(-32602, "invalid_params", "bad", {
    field: "set",
    index: 1,
  });
  assertEquals(err.code, -32602);
  assertEquals(err.message, "bad");
  assertEquals(err.data, { code: "invalid_params", field: "set", index: 1 });
});

test("requestQuestionPayloadForTrimsOptions", () => {
  const payload = requestQuestionPayloadFor({
    question: "Choose",
    options: ["a", "  ", "b"],
    explanation: "why",
  });
  assertEquals(payload, {
    prompt: "Choose",
    options: [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ],
    multi: false,
    title: "OpenSAC",
    placeholder: "why",
  });
});

test("questionProjectionForKeepsLegacyAndV1Methods", () => {
  const request = { question: "Q", options: ["a"], explanation: "" };
  const legacy = questionProjectionFor(false, request);
  assertEquals(legacy.method, "_opensac/request_question");
  assertEquals((legacy.params as Record<string, unknown>).question, "Q");
  const v1 = questionProjectionFor(true, request);
  assertEquals(v1.method, "opensac/requestQuestion");
  assertEquals((v1.params as Record<string, unknown>).prompt, "Q");
});

test("artifactSessionUpdateCarriesCanonicalIdentity", () => {
  assertEquals(
    artifactSessionUpdate("art-1", "a.png", "image", "image/png", 4, "run-1"),
    {
      sessionUpdate: "artifact",
      artifactId: "art-1",
      filename: "a.png",
      kind: "image",
      mediaType: "image/png",
      size: 4,
      runId: "run-1",
      status: "generated",
    },
  );
});

test("acpByteSizeFormatsBinaryPrefixes", () => {
  assertEquals(acpByteSize(0), "0B");
  assertEquals(acpByteSize(1023), "1023B");
  assertEquals(acpByteSize(1024), "1.0KB");
  assertEquals(acpByteSize(1536), "1.5KB");
  assertEquals(acpByteSize(2 << 20), "2.0MB");
});

test("acpOptionalProjectIDHandlesAbsentNullAndString", () => {
  assertEquals(acpOptionalProjectID(undefined), { present: false, value: "" });
  assertEquals(acpOptionalProjectID(null), { present: true, value: "" });
  assertEquals(acpOptionalProjectID("  proj  "), {
    present: true,
    value: "proj",
  });
  assertThrows(() => acpOptionalProjectID(5), Error);
});

test("toolCallContentJSONKeepsStrictUnion", () => {
  const diff = new ToolCallContent({
    type: "diff",
    path: "/tmp/a.ts",
    oldText: null,
    newText: "x",
  });
  assertEquals(JSON.parse(JSON.stringify(diff)), {
    type: "diff",
    path: "/tmp/a.ts",
    oldText: null,
    newText: "x",
  });
  const text = new ToolCallContent({
    type: "content",
    content: { type: "text", text: "hi" },
  });
  assertEquals(JSON.parse(JSON.stringify(text)), {
    type: "content",
    content: { type: "text", text: "hi" },
  });
});
