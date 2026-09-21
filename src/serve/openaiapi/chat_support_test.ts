// Translated from internal/serve/openaiapi/server_test.go's pure chat-input
// cases (TestParseMessages, TestParseMessages_NoUser,
// TestRequestMessageMultimodalContent) and TestHostedItemEventUsesSafeProjection.

import { assertEquals } from "@std/assert";
import { decodeRequestMessage } from "./types.ts";
import {
  hostedItemEvent,
  parseMessages,
  requestRunInput,
  sameWorkDir,
  subAgentStatusForTaskStatus,
} from "./chat_support.ts";
import {
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
} from "../../agent/events.ts";

Deno.test("parseMessages splits system/last-user/history", () => {
  const msgs = [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "user", content: "explain main.go" },
  ];
  const { lastUser, systemMsgs, history } = parseMessages(msgs);
  assertEquals(lastUser.content, "explain main.go");
  assertEquals(systemMsgs, ["you are helpful"]);
  assertEquals(history.length, 2); // "hello" and "hi there"
});

Deno.test("parseMessages without a user message", () => {
  const msgs = [{ role: "system", content: "test" }];
  const { lastUser } = parseMessages(msgs);
  assertEquals(lastUser.content, "");
});

Deno.test("requestMessage multimodal content", async () => {
  const body =
    `{"role":"user","content":[{"type":"text","text":"describe this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aW1n","detail":"auto"}}]}`;
  const msg = decodeRequestMessage(JSON.parse(body));
  assertEquals(msg.content, "describe this");

  const { input, ingresses } = requestRunInput(msg);
  assertEquals(input.text, "describe this");
  assertEquals(ingresses.length, 1);
  assertEquals(ingresses[0].kind, "image");

  const stream = await ingresses[0].open(undefined);
  assertEquals(stream.mediaType, "image/png");
  assertEquals(new TextDecoder().decode(stream.bytes!), "img");
  assertEquals(stream.contentSize, 3);
});

Deno.test("decodeRequestMessage rejects non string/array content", () => {
  let failed = false;
  try {
    decodeRequestMessage(JSON.parse(`{"role":"user","content":42}`));
  } catch (err) {
    failed =
      (err as Error).message === "content must be a string or content array";
  }
  assertEquals(failed, true);
});

Deno.test("hosted item event uses the safe projection", () => {
  const item = hostedItemEvent({
    id: "search-1",
    type: "web_search_call",
    status: "completed",
    metadata: {
      title: "Source",
      secret: "should-not-be-live",
      url: "https://example.test/private",
    },
  });
  assertEquals(item?.metadata?.["title"], "Source");
  assertEquals(item?.metadata && "secret" in item.metadata, false);
  assertEquals(item?.metadata && "url" in item.metadata, false);
});

Deno.test("hosted item event is nil for a nil item", () => {
  assertEquals(hostedItemEvent(null), null);
});

Deno.test("subAgentStatusForTaskStatus maps terminal states", () => {
  assertEquals(subAgentStatusForTaskStatus(TaskFailed), "error");
  assertEquals(subAgentStatusForTaskStatus(TaskIncomplete), "incomplete");
  assertEquals(subAgentStatusForTaskStatus(TaskCanceled), "canceled");
  assertEquals(subAgentStatusForTaskStatus("done"), "done");
});

Deno.test("sameWorkDir compares cleaned paths", () => {
  assertEquals(sameWorkDir("", ""), true);
  assertEquals(sameWorkDir("", "/x"), false);
  assertEquals(sameWorkDir("/x", ""), false);
  assertEquals(sameWorkDir("/a/b/../c", "/a/c"), true);
  assertEquals(sameWorkDir("/a/b", "/a/c"), false);
});
