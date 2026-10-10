// Tests for the provider SSE decode guard (§3.8): the per-provider wire
// decoders must reproduce well-formed payloads exactly (parity with the old
// unchecked cast), keep failure at the boundary for bad JSON and shape
// garbage, and stay open to unknown event types and fields.

import { assert, assertEquals } from "../compat/assert.ts";
import { decodeAnthropicStreamEvent } from "./anthropic/provider.ts";
import { decodeGoogleStreamChunk } from "./google/provider.ts";
import { decodeOpenAIStreamChunk } from "./openai/provider.ts";
import {
  decodeResponsesCompletedObject,
  decodeResponsesEvent,
} from "./openai/responses.ts";
import { test } from "#testing";

test("decodeAnthropicStreamEvent matches a well-formed payload exactly", () => {
  const samples = [
    `{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":1,"cache_read_input_tokens":2}}}`,
    `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"read","input":{"path":"a.ts"}}}`,
    `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`,
    `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
    `{"type":"error","error":{"type":"overloaded_error","message":"slow down"}}`,
  ];
  for (const sample of samples) {
    const decoded = decodeAnthropicStreamEvent(sample);
    assert(decoded !== undefined, sample);
    // Parity: the legacy `JSON.parse(sample) as AnthropicResponse` view.
    assertEquals(decoded, JSON.parse(sample));
  }
});

test("decodeAnthropicStreamEvent keeps failure at the boundary", () => {
  // Bad JSON and non-object payloads are rejected outright.
  assertEquals(decodeAnthropicStreamEvent("{"), undefined);
  assertEquals(decodeAnthropicStreamEvent("42"), undefined);
  assertEquals(decodeAnthropicStreamEvent("null"), undefined);
  // A missing or mistyped discriminant cannot dispatch the switch.
  assertEquals(decodeAnthropicStreamEvent(`{}`), undefined);
  assertEquals(decodeAnthropicStreamEvent(`{"type":7}`), undefined);
  // Shape garbage stops at the boundary: mistyped fields read as `undefined`
  // and the consumption sites' `?? 0` guards keep the zero-value semantics.
  const event = decodeAnthropicStreamEvent(
    `{"type":"message_start","message":{"usage":{"input_tokens":"lots"}}}`,
  );
  assert(event !== undefined);
  assertEquals(event.message?.usage?.input_tokens, undefined);
  const delta = decodeAnthropicStreamEvent(
    `{"type":"content_block_delta","delta":"oops"}`,
  );
  assert(delta !== undefined);
  assertEquals(delta.delta, undefined);
});

test("decodeAnthropicStreamEvent passes unknown event types through", () => {
  const event = decodeAnthropicStreamEvent(
    `{"type":"message_boundary_delta","frobnicate":1}`,
  );
  assert(event !== undefined);
  assertEquals(event.type, "message_boundary_delta");
});

test("decodeGoogleStreamChunk matches a well-formed payload exactly", () => {
  const samples = [
    `{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}`,
    `{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"read","args":{"path":"a.ts"}},"thoughtSignature":"sig"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}`,
    `{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}`,
  ];
  for (const sample of samples) {
    const decoded = decodeGoogleStreamChunk(sample);
    assert(decoded !== undefined, sample);
    assertEquals(decoded, JSON.parse(sample));
  }
});

test("decodeGoogleStreamChunk survives shape garbage", () => {
  assertEquals(decodeGoogleStreamChunk("["), undefined);
  // A candidate without content no longer crashes the parts loop.
  const chunk = decodeGoogleStreamChunk(
    `{"candidates":[{"finishReason":"STOP"}]}`,
  );
  assert(chunk !== undefined);
  assertEquals(chunk.candidates?.[0].content.parts, []);
  assertEquals(chunk.candidates?.[0].finishReason, "STOP");
  // Malformed candidates/parts drop instead of poisoning the stream.
  const dirty = decodeGoogleStreamChunk(
    `{"candidates":["nope",{"content":{"parts":[7,{"text":"ok"}]}}]}`,
  );
  assert(dirty !== undefined);
  assertEquals(dirty.candidates?.length, 1);
  assertEquals(dirty.candidates?.[0].content.parts, [{ text: "ok" }]);
});

test("decodeOpenAIStreamChunk matches a well-formed payload exactly", () => {
  const samples = [
    `{"id":"1","object":"chat.completion.chunk","created":2,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}`,
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"p\\":1}"}}]}}],"usage":null}`,
    `{"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}`,
  ];
  for (const sample of samples) {
    const decoded = decodeOpenAIStreamChunk(sample);
    assert(decoded !== undefined, sample);
    assertEquals(decoded, JSON.parse(sample));
  }
});

test("decodeOpenAIStreamChunk keeps nulls and rejects garbage", () => {
  assertEquals(decodeOpenAIStreamChunk("{"), undefined);
  const chunk = decodeOpenAIStreamChunk(
    `{"usage":null,"choices":[{"finish_reason":null,"delta":{"reasoning_content":null}}]}`,
  );
  assert(chunk !== undefined);
  // `null` stays `null`: consumers branch on `!== null`.
  assertEquals(chunk.usage, null);
  assertEquals(chunk.choices?.[0].finish_reason, null);
  assertEquals(chunk.choices?.[0].delta?.reasoning_content, null);
  const garbage = decodeOpenAIStreamChunk(
    `{"usage":{"prompt_tokens":"many"},"choices":[{"delta":"oops"}]}`,
  );
  assert(garbage !== undefined);
  assertEquals(garbage.usage?.prompt_tokens, 0);
  assertEquals(garbage.choices?.[0].delta, undefined);
});

test("decodeResponsesEvent matches a well-formed payload exactly", () => {
  const samples = [
    `{"type":"response.output_text.delta","delta":"hi","item_id":"i1","output_index":0}`,
    `{"type":"response.output_item.done","output_index":1,"item":{"id":"i2","type":"function_call","status":"completed","call_id":"c1","name":"read","arguments":"{}"}}`,
    `{"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"i3","type":"message"}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`,
    `{"type":"response.failed","error":{"message":"boom","code":"bad"}}`,
  ];
  for (const sample of samples) {
    const decoded = decodeResponsesEvent(JSON.parse(sample));
    assert(decoded !== undefined, sample);
    assertEquals(decoded, JSON.parse(sample));
  }
});

test("decodeResponsesEvent tolerates unknown events and shape garbage", () => {
  // Non-object payloads are rejected at the boundary (the legacy cast threw
  // a TypeError on the `type` fill-in instead).
  assertEquals(decodeResponsesEvent(42), undefined);
  assertEquals(decodeResponsesEvent(null), undefined);
  // An absent `type` stays empty for the SSE `event:` frame-name fill-in.
  const event = decodeResponsesEvent({});
  assert(event !== undefined);
  assertEquals(event.type, "");
  // Unknown event types pass through for the normalizer's bookkeeping. The
  // decoders take already-parsed values, matching the stream parser contract.
  const unknown = decodeResponsesEvent(
    JSON.parse(`{"type":"response.boundary.novel","delta":7}`),
  );
  assert(unknown !== undefined);
  assertEquals(unknown.type, "response.boundary.novel");
  assertEquals(unknown.delta, undefined);
  // `null`-able fields keep their `null`.
  const nulled = decodeResponsesEvent(
    JSON.parse(`{"type":"x","item":null,"error":null}`),
  );
  assert(nulled !== undefined);
  assertEquals(nulled.item, null);
  assertEquals(nulled.error, null);
});

test("decodeResponsesCompletedObject decodes output and usage shapes", () => {
  const decoded = decodeResponsesCompletedObject({
    id: "r1",
    status: "completed",
    conversation: { id: "conv_1" },
    output: ["legacy", { id: "i1", type: "message" }, 7],
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
    incomplete_details: { reason: "max_output_tokens" },
  });
  assert(decoded !== undefined);
  // Malformed output entries drop; valid ones keep their shape.
  assertEquals(decoded.output, ["legacy", { id: "i1", type: "message" }]);
  assertEquals(decoded.conversation, { id: "conv_1" });
  assertEquals(decoded.usage?.input_tokens_details?.cached_tokens, 4);
  assertEquals(decoded.usage?.output_tokens_details?.reasoning_tokens, 5);
  assertEquals(decoded.incomplete_details?.reason, "max_output_tokens");
  assertEquals(decodeResponsesCompletedObject("nope"), undefined);
});
