// Ported from internal/messaging/feishu/feishu_test.go

import { assertEquals, assertStrictEquals } from "@std/assert";

import type { InboundMessage, MessageResponse } from "../mod.ts";
import { Bot } from "./feishu.ts";
import type { FeishuMessageReceiveV1 } from "./types.ts";
import { AttachmentFile, AttachmentImage } from "../mod.ts";

function newFeishuMessageEvent(
  messageType: string,
  content: string,
  chatID: string,
  userID: string,
): FeishuMessageReceiveV1 {
  return {
    event: {
      sender: { sender_id: { open_id: userID } },
      message: {
        message_id: "om_test_message",
        message_type: messageType,
        content,
        chat_id: chatID,
      },
    },
  };
}

function defer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

Deno.test("OnMessageMapsTextEventToInboundMessage", async () => {
  const bot = new Bot({ appID: "test-app", appSecret: "test-secret" });
  let received: InboundMessage | null = null;
  const done = new Promise<void>((resolve) => {
    bot.handler = (_signal, msg): Promise<MessageResponse> => {
      received = msg;
      resolve();
      return Promise.resolve({ text: "" });
    };
  });

  await bot.onMessage(
    newFeishuMessageEvent(
      "text",
      `{"text":"hello Feishu"}`,
      "oc_test_chat",
      "ou_test_user",
    ),
  );

  await Promise.race([
    done,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for handler")), 1000)
    ),
  ]);

  const msg = received as InboundMessage | null;
  if (msg === null) {
    throw new Error("expected a received message");
  }
  assertEquals(msg.platform, "feishu");
  assertEquals(msg.chatID, "oc_test_chat");
  assertEquals(msg.userID, "ou_test_user");
  assertEquals(msg.text, "hello Feishu");
  if (msg.progressFunc === undefined) {
    throw new Error(
      "expected ProgressFunc to be installed before handler invocation",
    );
  }
});

Deno.test("InboundMessageMapsImageAndFileReferences", () => {
  const bot = new Bot({ appID: "test-app", appSecret: "test-secret" });
  const cases = [
    {
      messageType: "image",
      content: `{"image_key":"img_test"}`,
      kind: AttachmentImage,
      filename: "",
    },
    {
      messageType: "file",
      content: `{"file_key":"file_test","file_name":"notes.pdf"}`,
      kind: AttachmentFile,
      filename: "notes.pdf",
    },
  ];
  for (const tt of cases) {
    const event = newFeishuMessageEvent(
      tt.messageType,
      tt.content,
      "oc_test_chat",
      "ou_test_user",
    );
    const got = bot.inboundMessage(
      event.event?.message,
      event.event?.sender,
    );
    if (got === null) {
      throw new Error("inbound media event was rejected");
    }
    assertEquals(got.messageID, "om_test_message");
    assertEquals(got.text, "");
    assertEquals(got.attachments?.length, 1);
    const attachment = got.attachments![0];
    assertEquals(attachment.kind, tt.kind);
    assertEquals(attachment.messageID, got.messageID);
    if (attachment.open === undefined) {
      throw new Error("attachment open must be defined");
    }
    if (tt.filename !== "") {
      assertEquals(attachment.filename, tt.filename);
    }
  }
});

Deno.test("OnMessageFiltersInvalidEvents", async () => {
  type Mutate = (event: FeishuMessageReceiveV1) => void;
  const tests: { name: string; mutate: Mutate }[] = [
    {
      name: "nil message",
      mutate: (event) => {
        if (event.event !== undefined) {
          event.event.message = undefined;
        }
      },
    },
    {
      name: "nil sender",
      mutate: (event) => {
        if (event.event !== undefined) {
          event.event.sender = undefined;
        }
      },
    },
    {
      name: "missing message type",
      mutate: (event) => {
        if (event.event?.message !== undefined) {
          event.event.message.message_type = undefined;
        }
      },
    },
    {
      name: "non text message",
      mutate: (event) => {
        if (event.event?.message !== undefined) {
          event.event.message.message_type = "image";
        }
      },
    },
    {
      name: "nil content",
      mutate: (event) => {
        if (event.event?.message !== undefined) {
          event.event.message.content = undefined;
        }
      },
    },
    {
      name: "empty text",
      mutate: (event) => {
        if (event.event?.message !== undefined) {
          event.event.message.content = `{"text":""}`;
        }
      },
    },
    {
      name: "invalid content JSON",
      mutate: (event) => {
        if (event.event?.message !== undefined) {
          event.event.message.content = "not-json";
        }
      },
    },
  ];

  for (const tt of tests) {
    let called = false;
    const bot = new Bot({ appID: "test-app", appSecret: "test-secret" });
    bot.handler = (): Promise<MessageResponse> => {
      called = true;
      return Promise.resolve({ text: "" });
    };

    const event = newFeishuMessageEvent(
      "text",
      `{"text":"should be filtered"}`,
      "oc_test_chat",
      "ou_test_user",
    );
    tt.mutate(event);
    await bot.onMessage(event);
    await defer();
    if (called) {
      throw new Error(`filtered event invoked the message handler: ${tt.name}`);
    }
  }
});

Deno.test("OnMessageIgnoresNilEvent", async () => {
  const bot = new Bot({ appID: "test-app", appSecret: "test-secret" });
  let called = false;
  bot.handler = (): Promise<MessageResponse> => {
    called = true;
    return Promise.resolve({ text: "" });
  };
  await bot.onMessage(null);
  await defer();
  if (called) {
    throw new Error("nil event invoked the message handler");
  }
});

Deno.test("OnMessageWithoutHandlerIsIgnored", async () => {
  const bot = new Bot({ appID: "test-app", appSecret: "test-secret" });
  await bot.onMessage(
    newFeishuMessageEvent(
      "text",
      `{"text":"no handler"}`,
      "oc_test_chat",
      "ou_test_user",
    ),
  );
});

Deno.test("ReadyAndStopWithoutNetwork", async () => {
  const bot = new Bot({ appID: "test-app", appSecret: "test-secret" });
  assertEquals(bot.name(), "feishu");
  assertEquals(bot.isConnected(), false);
  const ready = bot.ready();
  assertStrictEquals(ready, bot.ready());

  bot.signalReady();
  bot.signalReady(new Error("second result must be dropped"));
  await ready;

  const status: boolean[] = [];
  bot.setStatusCallback((connected) => status.push(connected));
  const ctl = new AbortController();
  bot.connected = true;
  bot.cancel = () => ctl.abort();

  bot.stop();
  if (!ctl.signal.aborted) {
    throw new Error("Stop did not cancel the local signal");
  }
  assertEquals(bot.isConnected(), false);
  assertEquals(status[0], false);

  bot.stop();
  assertEquals(status[1], false);
});
