import { assert, assertEquals } from "@opensac/assert";
import {
  createResponsesNormalizer,
  decodeResponsesOutputItem,
  decodeResponsesSSE,
  responsesArgumentsText,
  type ResponsesSSEFrame,
  safeResponsesAttachmentURL,
} from "./responses_codec.ts";
import type { ResponsesSSEEvent } from "./responses.ts";

function readResponsesFixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/responses/${name}`, import.meta.url),
  );
}

Deno.test("DecodeResponsesSSESupportsFieldsMultilineDataAndDone", async () => {
  const input = "event: response.output_text.delta\r\n" +
    "id: evt_1\r\n" +
    'data: {"type":"response.output_text.delta",\r\n' +
    'data: "delta":"hello"}\r\n' +
    "\r\n" +
    ": keep-alive\r\n" +
    "data: [DONE]\r\n";

  const frames: ResponsesSSEFrame[] = [];
  const err = await decodeResponsesSSE(input, (frame) => {
    frames.push(frame);
    return undefined;
  });
  assertEquals(err, undefined);
  assertEquals(frames.length, 2);
  assertEquals(frames[0].sequence, 1);
  assertEquals(frames[0].event, "response.output_text.delta");
  assertEquals(frames[0].id, "evt_1");
  assertEquals(
    frames[0].data,
    '{"type":"response.output_text.delta",\n"delta":"hello"}',
  );
  assertEquals(frames[1].sequence, 2);
  assertEquals(frames[1].data, "[DONE]");
});

Deno.test("DecodeResponsesSSEAcceptsLineDelimitedGatewayEvents", async () => {
  const input = 'data: {"type":"response.created"}\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n' +
    "data: [DONE]\n";
  const types: string[] = [];
  const err = await decodeResponsesSSE(input, (frame) => {
    types.push(frame.data);
    return undefined;
  });
  assertEquals(err, undefined);
  assertEquals(types.length, 3);
});

Deno.test("ResponsesProtocolFixtures", async (t) => {
  await t.step("custom tool SSE", async () => {
    const n = createResponsesNormalizer();
    const err = await decodeResponsesSSE(
      readResponsesFixture("custom_tool_call.sse"),
      (frame) => {
        const event = JSON.parse(frame.data) as ResponsesSSEEvent;
        return n.apply(event, frame.data);
      },
    );
    assertEquals(err, undefined);
    const calls = n.toolCalls();
    assertEquals(calls.length, 1);
    assertEquals(calls[0].kind, "custom");
    assertEquals(calls[0].id, "call_fixture_1");
    assertEquals(calls[0].input, "echo fixture");
  });

  await t.step("hosted output items", () => {
    const rawItems = JSON.parse(
      readResponsesFixture("hosted_items.json"),
    ) as unknown[];
    const n = createResponsesNormalizer();
    for (let index = 0; index < rawItems.length; index++) {
      const item = decodeResponsesOutputItem(
        JSON.stringify(rawItems[index]),
        index,
      );
      assert(item !== undefined);
      n.upsertDecodedItem(item!);
    }
    const attachments = n.attachments();
    assertEquals(attachments.length, 4);
    assertEquals(attachments[0].providerRef, "file_fixture_1");
    assertEquals(attachments[1].providerRef, "container_fixture_1");
    assertEquals(attachments[2].url, "https://files.example.test/plot.png");
    assertEquals(attachments[3].providerRef, "image_fixture_1");
  });

  await t.step("annotation without URL retains provenance", () => {
    const raw =
      `{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"see source","annotations":[{"type":"url_citation","title":"Source","start_index":4,"end_index":10}]}]}`;
    const item = decodeResponsesOutputItem(raw, 0);
    assert(item !== undefined);
    const n = createResponsesNormalizer();
    n.response.items = [item!];
    const attachments = n.attachments();
    assertEquals(attachments.length, 1);
    assertEquals(attachments[0].kind, "citation");
    assertEquals(attachments[0].metadata?.["annotationType"], "url_citation");
    assertEquals(attachments[0].metadata?.["start_index"], 4);
  });

  await t.step("computer use rejected", () => {
    const raw = readResponsesFixture("computer_use_item.json");
    const event = JSON.parse(raw) as ResponsesSSEEvent;
    const n = createResponsesNormalizer();
    assertEquals(n.apply(event, raw), undefined);
    const err = n.unsupportedError();
    assert(err !== undefined);
    assert(err!.message.includes("computer use"));
    assertEquals(n.response.items.length, 1);
    assert(!(n.response.items[0].canonical ?? "").includes("redact-me"));
  });

  await t.step("incomplete terminal", async () => {
    const n = createResponsesNormalizer();
    const err = await decodeResponsesSSE(
      readResponsesFixture("incomplete_terminal.sse"),
      (frame) => {
        const event = JSON.parse(frame.data) as ResponsesSSEEvent;
        return n.apply(event, frame.data);
      },
    );
    assertEquals(err, undefined);
    assertEquals(n.response.id, "resp_incomplete_fixture");
    assertEquals(n.response.status, "incomplete");
    assertEquals(n.response.previousResponseID, "resp_previous_fixture");
    assertEquals(n.response.conversationID, "conv_fixture");
    assertEquals(n.response.incompleteReason, "max_output_tokens");
    assertEquals(n.response.items.length, 1);
    assertEquals(n.response.items[0].id, "msg_incomplete_1");
  });
});

Deno.test("ResponsesNormalizerInterleavesFunctionArgumentsByItemIdentity", () => {
  const n = createResponsesNormalizer();
  const events: ResponsesSSEEvent[] = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_a",
        type: "function_call",
        call_id: "call_a",
        name: "read",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "item_b",
        type: "function_call",
        call_id: "call_b",
        name: "write",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_a",
      output_index: 0,
      delta: `{"path":`,
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_b",
      output_index: 1,
      delta: `{"path":`,
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_a",
      output_index: 0,
      delta: `"a"}`,
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_b",
      output_index: 1,
      delta: `"b"}`,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_a",
        type: "function_call",
        call_id: "call_a",
        name: "read",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "item_b",
        type: "function_call",
        call_id: "call_b",
        name: "write",
      },
    },
  ];
  for (const event of events) {
    assertEquals(
      n.apply(event, `{"type":"${event.type}"}`),
      undefined,
    );
  }
  const calls = n.toolCalls();
  assertEquals(calls.length, 2);
  assertEquals(calls[0].id, "call_a");
  assertEquals(responsesArgumentsText(calls[0].arguments), `{"path":"a"}`);
  assertEquals(calls[1].id, "call_b");
  assertEquals(responsesArgumentsText(calls[1].arguments), `{"path":"b"}`);
});

Deno.test("ResponsesNormalizerMergesIDlessCompletedOutput", () => {
  const n = createResponsesNormalizer();
  const added: ResponsesSSEEvent = {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      id: "item_1",
      type: "function_call",
      call_id: "call_1",
      name: "read",
    },
  };
  assertEquals(
    n.apply(added, `{"type":"response.output_item.added"}`),
    undefined,
  );
  n.applyResponse({
    output: [
      `{"type":"message"}`,
      `{"type":"function_call","call_id":"call_1","name":"read","arguments":"{}"}`,
    ],
  });
  const calls = n.toolCalls();
  assertEquals(calls.length, 1);
  assertEquals(calls[0].id, "call_1");
  assertEquals(calls[0].itemID, "item_1");
  assertEquals(n.response.items.length, 2);
});

Deno.test("ResponsesNormalizerCollectsCustomToolInput", () => {
  const n = createResponsesNormalizer();
  const events: ResponsesSSEEvent[] = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "custom_1",
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "shell_script",
      },
    },
    {
      type: "response.custom_tool_call_input.delta",
      item_id: "custom_1",
      output_index: 0,
      delta: "echo ",
    },
    {
      type: "response.custom_tool_call_input.done",
      item_id: "custom_1",
      output_index: 0,
      input: "echo hello",
    },
  ];
  for (const event of events) {
    assertEquals(n.apply(event, `{"type":"${event.type}"}`), undefined);
  }
  const calls = n.toolCalls();
  assertEquals(calls.length, 1);
  assertEquals(calls[0].id, "call_custom");
  assertEquals(calls[0].kind, "custom");
  assertEquals(calls[0].input, "echo hello");
  assertEquals(
    responsesArgumentsText(calls[0].arguments),
    `{"input":"echo hello"}`,
  );
});

Deno.test("ResponsesNormalizerPreservesUnknownItemWithSanitizedCanonicalJSON", () => {
  const n = createResponsesNormalizer();
  const event: ResponsesSSEEvent = {
    type: "response.output_item.done",
    output_index: 3,
    item: { id: "future_1", type: "future_item", status: "completed" },
  };
  const raw =
    `{"type":"response.output_item.done","output_index":3,"item":{"id":"future_1","type":"future_item","secret":"do-not-store"}}`;
  assertEquals(n.apply(event, raw), undefined);
  assertEquals(n.response.unknownItems, 1);
  assertEquals(n.response.items.length, 1);
  const canonical = n.response.items[0].canonical ?? "";
  assert(!canonical.includes("do-not-store"));
  assert(canonical.includes("[REDACTED]"));
});

Deno.test("ResponsesNormalizerRecordsUnknownEventType", () => {
  const n = createResponsesNormalizer();
  assertEquals(
    n.apply(
      { type: "response.future_event" },
      `{"type":"response.future_event"}`,
    ),
    undefined,
  );
  assertEquals(
    n.apply(
      { type: "response.output_text.delta", delta: "ok" },
      `{"type":"response.output_text.delta","delta":"ok"}`,
    ),
    undefined,
  );
  const metadata = n.metadata();
  const events = metadata?.["unknownEventTypes"] as string[];
  assertEquals(events.length, 1);
  assertEquals(events[0], "response.future_event");
});

Deno.test("ResponsesNormalizerRejectsComputerUseItem", () => {
  const n = createResponsesNormalizer();
  const event: ResponsesSSEEvent = {
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "computer_1", type: "computer_call", status: "completed" },
  };
  const raw =
    `{"type":"response.output_item.done","item":{"id":"computer_1","type":"computer_call","action":{"type":"screenshot","secret":"redact-me"}}}`;
  assertEquals(n.apply(event, raw), undefined);
  const err = n.unsupportedError();
  assert(err !== undefined);
  assert(err!.message.includes("computer use is not supported"));
  assertEquals(n.response.unknownItems, 1);
  assertEquals(n.response.items.length, 1);
  assertEquals(n.metadata()?.["computerUseRejected"], true);
  assert(!(n.response.items[0].canonical ?? "").includes("redact-me"));
});

Deno.test("ResponsesNormalizerExtractsSafeHostedToolAttachments", () => {
  const n = createResponsesNormalizer();
  const events: Array<{ event: ResponsesSSEEvent; raw: string }> = [
    {
      event: {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg_1", type: "message", status: "completed" },
      },
      raw:
        `{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[{"type":"url_citation","title":"OpenAI","url":"https://openai.com","start_index":2,"end_index":8}]}]}}`,
    },
    {
      event: {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "file_1",
          type: "code_interpreter_call",
          status: "completed",
        },
      },
      raw:
        `{"type":"response.output_item.done","output_index":1,"item":{"id":"file_1","type":"code_interpreter_call","status":"completed","container_id":"container_123","result":{"type":"container_file_citation","file_id":"file_123","filename":"report.csv"}}}`,
    },
    {
      event: {
        type: "response.output_item.done",
        output_index: 2,
        item: { id: "mcp_1", type: "mcp_call" },
      },
      raw:
        `{"type":"response.output_item.done","output_index":2,"item":{"id":"mcp_1","type":"mcp_call","server_url":"https://private.example/mcp","result":{"type":"image","url":"https://untrusted.example/payload.png"}}}`,
    },
    {
      event: {
        type: "response.output_item.done",
        output_index: 3,
        item: { id: "image_1", type: "image_generation_call" },
      },
      raw:
        `{"type":"response.output_item.done","output_index":3,"item":{"id":"image_1","type":"image_generation_call","result":"aW1n"}}`,
    },
    {
      event: {
        type: "response.output_item.done",
        output_index: 4,
        item: { id: "search_1", type: "file_search_call", status: "completed" },
      },
      raw:
        `{"type":"response.output_item.done","output_index":4,"item":{"id":"search_1","type":"file_search_call","status":"completed","results":[{"file_id":"file_search_1","filename":"guide.md","score":0.92,"text":"matching content"}]}}`,
    },
    {
      event: {
        type: "response.output_item.done",
        output_index: 5,
        item: { id: "unsafe_1", type: "message", status: "completed" },
      },
      raw:
        `{"type":"response.output_item.done","output_index":5,"item":{"id":"unsafe_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[{"type":"url_citation","title":"unsafe","url":"javascript:alert(1)"}]}]}}`,
    },
  ];
  for (const entry of events) {
    assertEquals(n.apply(entry.event, entry.raw), undefined);
  }
  const attachments = n.attachments();
  assertEquals(attachments.length, 5);
  assertEquals(attachments[0].kind, "citation");
  assertEquals(attachments[0].url, "https://openai.com");
  assertEquals(attachments[0].metadata?.["responseItemId"], "msg_1");
  assertEquals(attachments[0].metadata?.["responseItemType"], "message");
  assertEquals(attachments[0].metadata?.["status"], "completed");
  assertEquals(attachments[0].metadata?.["start_index"], 2);
  assertEquals(attachments[0].metadata?.["end_index"], 8);
  assertEquals(attachments[1].kind, "artifact");
  assertEquals(attachments[1].providerRef, "container_123");
  assertEquals(attachments[1].metadata?.["tool"], "code_interpreter");
  assertEquals(attachments[2].kind, "file");
  assertEquals(attachments[2].providerRef, "file_123");
  assertEquals(attachments[2].metadata?.["responseItemId"], "file_1");
  assertEquals(attachments[2].metadata?.["containerId"], "container_123");
  assertEquals(attachments[3].kind, "image");
  assertEquals(attachments[3].providerRef, "image_1");
  assertEquals(attachments[3].metadata?.["encodedBytes"], 4);
  assertEquals(attachments[4].kind, "file");
  assertEquals(attachments[4].providerRef, "file_search_1");
  assertEquals(attachments[4].metadata?.["responseItemId"], "search_1");
  assertEquals(
    attachments[4].metadata?.["responseItemType"],
    "file_search_call",
  );
  assertEquals(attachments[4].metadata?.["score"], 0.92);
});

Deno.test("SafeResponsesAttachmentURLRejectsPrivateTargets", () => {
  for (
    const raw of [
      "https://localhost/file",
      "https://api.localhost/file",
      "https://127.0.0.1/file",
      "https://10.0.0.1/file",
      "https://[::1]/file",
      "https://[fe80::1]/file",
    ]
  ) {
    assertEquals(safeResponsesAttachmentURL(raw), "");
  }
  assertEquals(
    safeResponsesAttachmentURL("https://files.example.com/report.pdf"),
    "https://files.example.com/report.pdf",
  );
});

Deno.test("DecodeResponsesSSEReportsMalformedEventSequence", async () => {
  const errWant = new Error("stop");
  const err = await decodeResponsesSSE("data: {not-json}\n", () => errWant);
  assertEquals(err, errWant);
});
