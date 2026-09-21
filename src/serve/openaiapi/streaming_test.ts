// Translated from internal/serve/openaiapi/server_test.go's SSE writer cases
// (TestSSEWriter_*), using a recording sink in place of httptest.NewRecorder.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SSEWriter, type SSEWriterSink } from "./streaming.ts";
import type { CompletionUsage, ToolStatusEvent } from "./types.ts";

function recorder(): { sink: SSEWriterSink; body: () => string } {
  let output = "";
  return {
    sink: {
      write: (chunk) => {
        output += chunk;
      },
    },
    body: () => output,
  };
}

Deno.test("SSEWriter content delta", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  sse.writeContentDelta("hello");
  const text = body();
  assertStringIncludes(text, '"content":"hello"');
  assert(text.startsWith("data: "), "SSE data should start with 'data: '");
});

Deno.test("SSEWriter done", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  const usage: CompletionUsage = {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  };
  sse.writeDone(usage);
  const text = body();
  assertStringIncludes(text, '"finish_reason":"stop"');
  assertStringIncludes(text, "[DONE]");
});

Deno.test("SSEWriter attachments", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  sse.writeAttachments([
    { kind: "citation", name: "source", url: "https://example.test/source" },
  ]);
  const text = body();
  assert(
    text.includes("event: attachments") &&
      text.includes("https://example.test/source"),
    `attachments SSE = ${JSON.stringify(text)}`,
  );
});

Deno.test("SSEWriter write error is a regular data frame", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  sse.writeError("something broke");
  const text = body();

  assert(
    text.startsWith("data: "),
    `error must be a regular SSE data frame: ${text}`,
  );
  assertStringIncludes(text, '"message":"something broke"');
  assertStringIncludes(text, '"type":"server_error"');
  assert(
    !text.includes("event:") && !text.includes("x_session_id"),
    `extension fields/events must not be emitted: ${text}`,
  );
});

Deno.test("SSEWriter tool status content", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "");
  sse.writeToolStatusContent("🔧 [read] main.go", "running");
  const text = body();
  assertStringIncludes(text, "[running]");
  assertStringIncludes(text, "read");
});

Deno.test("SSEWriter tool status event", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "");
  const event: ToolStatusEvent = {
    tool: "bash",
    toolCallId: "call-1",
    status: "running",
    args: { command: "ls" },
  };
  sse.writeToolStatusEvent(event);
  const text = body();
  assertStringIncludes(text, "event: tool_status");
  assertStringIncludes(text, '"tool":"bash"');
  assertStringIncludes(text, '"toolCallId":"call-1"');
});

Deno.test("SSEWriter hosted item event", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  sse.writeHostedItem({
    id: "search-1",
    type: "web_search_call",
    status: "completed",
    outputIndex: 2,
  });
  const text = body();
  assert(
    text.includes("event: hosted_item") && text.includes('"id":"search-1"') &&
      text.includes('"outputIndex":2'),
    `hosted item SSE = ${JSON.stringify(text)}`,
  );
});

Deno.test("SSEWriter transcript event defaults the session id", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-9");
  sse.writeTranscriptEvent({ type: "assistant_delta" });
  const text = body();
  assertStringIncludes(text, "event: transcript");
  assertStringIncludes(text, '"x_session_id":"sess-9"');
});

Deno.test("SSEWriter nil hosted item writes nothing", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  sse.writeHostedItem(null);
  assertEquals(body(), "");
});

Deno.test("SSEWriter writeDoneReason with a custom finish reason", () => {
  const { sink, body } = recorder();
  const sse = new SSEWriter(sink, "test-model", "sess-1");
  sse.writeDoneReason(null, "length");
  assertStringIncludes(body(), '"finish_reason":"length"');
});
