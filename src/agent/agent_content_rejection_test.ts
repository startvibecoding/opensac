//
// Content-rejection recovery strips provider-refused images in two stages,
// records durable overrides so replay never re-sends them, and heals a turn
// that already streamed visible output without duplicating it.

import { assert, assertEquals } from "@std/assert";
import type { Message } from "../provider/types.ts";
import { createManager } from "../session/manager.ts";
import type { Manager } from "../session/manager.ts";
import { type Agent, createAgentWithLoopConfig } from "./agent.ts";
import type { LoopRecoveryState } from "./agent.ts";
import type { Event } from "./events.ts";

function imageMessage(role: string, text: string): Message {
  const msg: Message = {
    role,
    content: text,
    timestamp: new Date(),
    contents: [{
      type: "image",
      image: { data: "AAAA", mimeType: "image/png" },
    }],
  };
  if (role === "toolResult") {
    msg.toolCallId = "call-" + text;
    msg.toolName = "read";
  }
  return msg;
}

function hasImage(msg: Message): boolean {
  for (const block of msg.contents ?? []) {
    if (block.type === "image" || block.image !== undefined) return true;
  }
  return false;
}

function createRecoveryState(): LoopRecoveryState {
  return {
    contextOverflowRetried: false,
    contentRejectionStage: 0,
    streamTimeoutRetries: 0,
    streamFailureRetries: 0,
    recoveryAssistantContents: [],
    toolArgumentNotices: [],
  };
}

function collectSink(): { sink: (ev: Event) => boolean; events: Event[] } {
  const events: Event[] = [];
  return { sink: (ev) => (events.push(ev), true), events };
}

function createContentRejectionAgent(
  messages: Message[],
): { agent: Agent; sess: Manager } {
  const sess = createManager(Deno.makeTempDirSync(), Deno.makeTempDirSync());
  sess.init();
  const ids: string[] = [];
  for (const msg of messages) ids.push(sess.appendMessage(msg));
  const agent = createAgentWithLoopConfig({ session: sess }, undefined);
  agent.loadHistoryState(messages, ids);
  return { agent, sess };
}

function defaultMessages(): Message[] {
  return [
    { role: "user", content: "old question", timestamp: new Date() },
    imageMessage("toolResult", "old"),
    { role: "user", content: "current question", timestamp: new Date() },
    imageMessage("toolResult", "current"),
  ];
}

Deno.test("content rejection recovery strips in two stages", () => {
  const { agent, sess } = createContentRejectionAgent(defaultMessages());
  const { sink } = collectSink();
  const state = createRecoveryState();
  const cause = new Error(
    `API error 400: {"message":"<400> InternalError.Algo.DataInspectionFailed: Input image data may contain inappropriate content."}`,
  );

  assert(agent.tryRecoverContentRejection(sink, state, false, cause));
  assertEquals(state.contentRejectionStage, 1);
  const messages = agent.getMessages();
  assert(!hasImage(messages[3]), "current-turn image was not stripped");
  assert(hasImage(messages[1]), "older historical image must survive stage 1");
  assert(messages[3].content!.includes("image unavailable"));
  assert(messages[3].content!.includes("content filter"));
  assertEquals(messages[3].role, "toolResult");
  assertEquals(messages[3].toolCallId, "call-current");

  assert(agent.tryRecoverContentRejection(sink, state, false, cause));
  assertEquals(state.contentRejectionStage, 2);
  assert(!hasImage(agent.getMessages()[1]));

  assert(!agent.tryRecoverContentRejection(sink, state, false, cause));

  for (const msg of sess.getReplayState().messages) {
    assert(!hasImage(msg), "replayed message still contains an image");
  }
});

Deno.test("content rejection recovery ignores other errors", () => {
  const { agent } = createContentRejectionAgent(defaultMessages());
  const { sink } = collectSink();
  const state = createRecoveryState();
  assert(
    !agent.tryRecoverContentRejection(
      sink,
      state,
      false,
      new Error("API error 400: invalid parameter: model"),
    ),
  );
  assert(hasImage(agent.getMessages()[3]));
});

Deno.test("content rejection recovery heals without retry after partial output", () => {
  const { agent, sess } = createContentRejectionAgent(defaultMessages());
  const { sink } = collectSink();
  const state = createRecoveryState();
  const cause = new Error(
    "Input image data may contain inappropriate content",
  );
  assert(!agent.tryRecoverContentRejection(sink, state, true, cause));
  const messages = agent.getMessages();
  assert(!hasImage(messages[1]) && !hasImage(messages[3]));
  for (const msg of sess.getReplayState().messages) {
    assert(!hasImage(msg), "replayed message still contains an image");
  }
});

Deno.test("content rejection recovery escalates when turn has no images", () => {
  const messages: Message[] = [
    imageMessage("toolResult", "historical"),
    { role: "user", content: "text only current turn", timestamp: new Date() },
  ];
  const { agent } = createContentRejectionAgent(messages);
  const { sink } = collectSink();
  const state = createRecoveryState();
  const cause = new Error(
    "Input image data may contain inappropriate content",
  );
  assert(agent.tryRecoverContentRejection(sink, state, false, cause));
  assertEquals(state.contentRejectionStage, 2);
  assert(!hasImage(agent.getMessages()[0]));
});
