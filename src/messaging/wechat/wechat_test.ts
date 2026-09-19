// Ported from internal/messaging/wechat/wechat_test.go

import { assertEquals } from "@std/assert";
import { createHash } from "node:crypto";

import {
  AttachmentAudio,
  AttachmentFile,
  AttachmentImage,
  AttachmentVideo,
  type OutboundAttachment,
} from "../mod.ts";
import {
  decodeAESKey,
  decryptAESECB,
  encodeAESKeyBase64,
  encodeAESKeyHex,
  encryptAESECB,
  generateAESKey,
} from "./crypto.ts";
import { newAESECBDecryptStream } from "./media.ts";
import { loadCredentials, saveCredentials } from "./auth.ts";
import {
  buildMediaItem,
  Client,
  type FetchLike,
  stableClientID,
} from "./protocol.ts";
import { ItemFile, ItemImage, ItemVideo, type WireMessage } from "./types.ts";
import { sendMediaAttachment, stableFileKey } from "./media_send.ts";
import {
  Bot,
  chunkText,
  replyFooter,
  replyFooterLen,
  wechatMaxRepliesPerMessage,
  wechatMessageTextLimit,
} from "./wechat.ts";

function backgroundSignal(): AbortSignal {
  return new AbortController().signal;
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

Deno.test("ChunkTextKeepsUTF8Boundaries", () => {
  const chunks = chunkText("你好世界", 6);
  assertEquals(chunks.length, 2);
  assertEquals(chunks.join(""), "你好世界");
  for (const chunk of chunks) {
    // JS strings are valid Unicode by construction; assert no replacement chars.
    assertEquals(chunk.includes("\uFFFD"), false);
  }
});

Deno.test("ReplySessionQueuesAfterTenMessages", async () => {
  const sent: string[] = [];
  const fetchFn: FetchLike = (_input, init) => {
    sent.push(String(init?.body ?? ""));
    return Promise.resolve(new Response(`{"ret":0}`));
  };
  const bot = new Bot({}, new Client(fetchFn));
  bot.creds = {
    token: "token",
    baseUrl: "https://example.test",
    accountId: "",
    userId: "bot",
  };

  const session = bot.newReplySession("user", "context");
  const body = "x".repeat(
    (wechatMessageTextLimit - replyFooterLen(0)) *
      (wechatMaxRepliesPerMessage + 1),
  );
  await session.send(backgroundSignal(), body);
  assertEquals(sent.length, wechatMaxRepliesPerMessage);
  assertEquals(sent[sent.length - 1].includes("剩余推送次数: 0次"), true);
  const state = bot.pendingReply("user");
  assertEquals(state.chunks.length > 0, true);
  assertEquals(replyFooter(0).includes("剩余推送次数: 0次"), true);
});

Deno.test("InboundAttachmentsDownloadAndDecryptMedia", async () => {
  const key = new TextEncoder().encode("0123456789abcdef");
  const plaintext = new TextEncoder().encode("iLink attachment bytes");
  const ciphertext = encryptAESECB(plaintext, key);

  const fetchFn: FetchLike = (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("encrypted_query_param") !== "opaque-ref") {
      throw new Error(
        `encrypted_query_param = ${
          url.searchParams.get("encrypted_query_param")
        }`,
      );
    }
    return Promise.resolve(
      new Response(ciphertext as unknown as BodyInit, { status: 200 }),
    );
  };
  const bot = new Bot({}, new Client(fetchFn));

  const fixture = `{
"message_id":42,"message_type":1,"item_list":[
  {"type":2,"image_item":{"media":{"encrypt_query_param":"opaque-ref","aes_key":"not-the-direct-key"},"aeskey":${
    JSON.stringify(encodeAESKeyHex(key))
  }}},
  {"type":4,"file_item":{"media":{"encrypt_query_param":"opaque-ref","aes_key":${
    JSON.stringify(encodeAESKeyBase64(key))
  }},"file_name":"notes.txt","len":"23"}}
]}`;
  const wire = JSON.parse(fixture) as WireMessage;
  const attachments = bot.inboundAttachments(wire);
  assertEquals(attachments.length, 2);
  assertEquals(attachments[0].kind, AttachmentImage);
  assertEquals(attachments[1].kind, AttachmentFile);
  assertEquals(attachments[1].filename, "notes.txt");
  assertEquals(attachments[1].sizeHint, 23);
  for (const attachment of attachments) {
    if (
      attachment.reference.includes("opaque-ref") ||
      attachment.reference.includes(encodeAESKeyHex(key))
    ) {
      throw new Error(
        `transport secret leaked into reference: ${attachment.reference}`,
      );
    }
    const stream = await attachment.open(backgroundSignal());
    const data = await readAll(stream.reader);
    assertEquals(data, plaintext);
  }
});

Deno.test("InboundAttachmentsIncludesVoiceVideoAndQuotedMedia", async () => {
  const plaintext = new TextEncoder().encode("media");
  const key = generateAESKey();
  const ciphertext = encryptAESECB(plaintext, key);
  const fetchFn: FetchLike = () =>
    Promise.resolve(
      new Response(ciphertext as unknown as BodyInit, { status: 200 }),
    );
  const bot = new Bot({}, new Client(fetchFn));
  const encoded = JSON.stringify(encodeAESKeyBase64(key));
  const fixture = `{"message_id":77,"item_list":[
{"type":3,"voice_item":{"media":{"encrypt_query_param":"voice-ref","aes_key":${encoded}}}},
{"type":5,"video_item":{"media":{"encrypt_query_param":"video-ref","aes_key":${encoded}},"file_name":"clip.mp4"}},
{"type":6,"ref_msg":{"item_list":[{"type":4,"file_item":{"media":{"encrypt_query_param":"quoted-ref","aes_key":${encoded}},"file_name":"quoted.txt"}}]}}
]}`;
  const wire = JSON.parse(fixture) as WireMessage;
  const attachments = bot.inboundAttachments(wire);
  assertEquals(attachments.length, 3);
  assertEquals(
    [attachments[0].kind, attachments[1].kind, attachments[2].kind],
    [AttachmentAudio, AttachmentVideo, AttachmentFile],
  );
  assertEquals(attachments[0].mediaType, "audio/amr");
  assertEquals(attachments[1].mediaType, "video/mp4");
  for (const attachment of attachments) {
    if (
      attachment.reference.includes("voice-ref") ||
      attachment.reference.includes(encodeAESKeyBase64(key))
    ) {
      throw new Error(`opaque media reference leaked: ${attachment.reference}`);
    }
    const stream = await attachment.open(backgroundSignal());
    const data = await readAll(stream.reader);
    assertEquals(data, plaintext);
  }
});

Deno.test("AESECBDecryptStreamRejectsTruncatedCiphertext", async () => {
  const key = generateAESKey();
  const stream = newAESECBDecryptStream(
    toStream(new TextEncoder().encode("truncated")),
    key,
  );
  let message = "";
  try {
    await readAll(stream);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertEquals(message.includes("multiple"), true);
});

Deno.test("BuildMediaItemSupportsVideoAndFile", () => {
  const uploaded = {
    filekey: "",
    encrypt_query_param: "download",
    aeskey: "30313233343536373839616263646566",
    rawsize: 23,
    filesize: 32,
  };
  const video = buildMediaItem(ItemVideo, uploaded, "clip.mp4");
  assertEquals(video.video_item?.video_size, 32);
  assertEquals(video.video_item?.file_name, "clip.mp4");
  const file = buildMediaItem(ItemFile, uploaded, "notes.txt");
  assertEquals(file.file_item?.len, "23");
  assertEquals(file.file_item?.file_name, "notes.txt");
});

Deno.test("OutboundMediaUsesLockedCDNAndMessageContract", async () => {
  const plaintext = new TextEncoder().encode("generated artifact");
  let uploadKey: Uint8Array | null = null;
  const calls: { method: string; path: string; body: string }[] = [];
  const fetchFn: FetchLike = (_input, init) => {
    const url = new URL(String(_input));
    const body = String(init?.body ?? "");
    calls.push({ method: init?.method ?? "", path: url.pathname, body });
    switch (url.pathname) {
      case "/ilink/bot/getuploadurl": {
        const request = JSON.parse(body) as Record<string, unknown>;
        if (
          request.media_type !== 1 || request.to_user_id !== "target-user" ||
          request.no_need_thumb !== true
        ) {
          throw new Error(`unexpected getuploadurl request: ${body}`);
        }
        uploadKey = decodeAESKey(String(request.aeskey));
        return Promise.resolve(
          new Response(`{"ret":0,"upload_param":"signed-upload"}`),
        );
      }
      case "/c2c/upload": {
        const ciphertext = init?.body as Uint8Array;
        const decoded = decryptAESECB(ciphertext, uploadKey!);
        assertEquals(decoded, plaintext);
        return Promise.resolve(
          new Response("ok", {
            status: 200,
            headers: { "x-encrypted-param": "signed-download" },
          }),
        );
      }
      case "/ilink/bot/sendmessage": {
        const request = JSON.parse(body) as {
          msg: {
            to_user_id: string;
            context_token: string;
            run_id: string;
            client_id: string;
            item_list: Array<{
              type: number;
              image_item?: {
                media?: { encrypt_query_param?: string };
                mid_size?: number;
              };
            }>;
          };
        };
        const msg = request.msg;
        assertEquals(msg.to_user_id, "target-user");
        assertEquals(msg.context_token, "frozen-context");
        assertEquals(msg.run_id, "run-1");
        assertEquals(msg.item_list.length, 1);
        assertEquals(msg.item_list[0].type, ItemImage);
        assertEquals(msg.client_id, stableClientID("send-op"));
        assertEquals(
          msg.item_list[0].image_item?.media?.encrypt_query_param,
          "signed-download",
        );
        assertEquals(
          msg.item_list[0].image_item?.mid_size,
          (Math.floor(plaintext.length / 16) + 1) * 16,
        );
        return Promise.resolve(new Response(`{"ret":0}`));
      }
      default:
        throw new Error(`unexpected request path ${url.pathname}`);
    }
  };

  const bot = new Bot({}, new Client(fetchFn));
  bot.creds = {
    token: "token",
    baseUrl: "https://ilink.test",
    accountId: "",
    userId: "bot-user",
  };

  const phases: string[] = [];
  const attachment: OutboundAttachment = {
    id: "artifact-1",
    runID: "run-1",
    targetID: "target-user",
    replyContext: "frozen-context",
    uploadOperationID: "upload-op",
    sendOperationID: "send-op",
    providerAssetID: "",
    providerState: new Uint8Array(),
    kind: AttachmentImage,
    filename: "image.png",
    mediaType: "",
    open: () => Promise.resolve(toStream(plaintext)),
    progressUpload: (_s, status, assetID, state, failure) => {
      phases.push(`progress:${status}:${assetID}:${failure}`);
      JSON.parse(state);
    },
    completeUpload: (_s, status, assetID, state, failure) => {
      phases.push(`upload:${status}:${assetID}:${failure}`);
      JSON.parse(state);
    },
    prepareSend: () => {
      phases.push("prepare-send");
      return Promise.resolve();
    },
    completeSend: (_s, status, messageID, state, failure) => {
      phases.push(`send:${status}:${messageID}:${failure}`);
      JSON.parse(state);
    },
  };
  await sendMediaAttachment(bot, backgroundSignal(), attachment);

  assertEquals(phases.length, 5);
  assertEquals(phases[0], `progress:uploading:${stableFileKey("upload-op")}:`);
  assertEquals(phases[1], phases[0]);
  assertEquals(phases[2], `upload:uploaded:${stableFileKey("upload-op")}:`);
  assertEquals(phases[3], "prepare-send");
  assertEquals(
    phases[4].startsWith(`send:delivered:${stableClientID("send-op")}:`),
    true,
  );
  assertEquals(calls.length, 3);
  assertEquals(calls[0].path, "/ilink/bot/getuploadurl");
  assertEquals(calls[1].path, "/c2c/upload");
  assertEquals(calls[2].path, "/ilink/bot/sendmessage");
  const upload = JSON.parse(calls[0].body) as Record<string, unknown>;
  const checksum = createHash("md5").update(plaintext).digest("hex");
  assertEquals(upload.rawfilemd5, checksum);
});

Deno.test("BotStartReportsHealthyOnlyAfterSuccessfulPollAndPersistsCursor", async () => {
  const paths: string[] = [];
  let firstPoll = true;
  let releaseFirstPoll!: () => void;
  const firstPollRelease = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });
  let releaseLongPoll!: () => void;
  const longPollRelease = new Promise<void>((resolve) => {
    releaseLongPoll = resolve;
  });
  let signalSecondPoll!: () => void;
  const secondPollArrived = new Promise<void>((resolve) => {
    signalSecondPoll = resolve;
  });
  let secondPollSeen = false;

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (req) => {
      const url = new URL(req.url);
      paths.push(url.pathname);
      switch (url.pathname) {
        case "/ilink/bot/msg/notifystart":
        case "/ilink/bot/msg/notifystop":
          return new Response(`{"ret":0}`);
        case "/ilink/bot/getupdates":
          if (firstPoll) {
            firstPoll = false;
            await firstPollRelease;
            return new Response(
              `{"ret":0,"get_updates_buf":"saved-cursor","longpolling_timeout_ms":1200,"msgs":[{"message_id":7,"from_user_id":"wx-user","create_time_ms":1,"message_type":1,"context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}`,
            );
          }
          if (!secondPollSeen) {
            secondPollSeen = true;
            signalSecondPoll();
          }
          await longPollRelease;
          return new Response(`{"ret":0,"msgs":[]}`);
        default:
          throw new Error(`unexpected path ${url.pathname}`);
      }
    },
  );

  const { hostname, port } = server.addr;
  const baseURL = `http://${hostname}:${port}`;
  const credPath = `${Deno.makeTempDirSync()}/wechat-credentials.json`;
  saveCredentials(
    {
      token: "token",
      baseUrl: baseURL,
      accountId: "bot",
      userId: "owner",
    },
    credPath,
  );

  const bot = new Bot({ credPath });
  const status: boolean[] = [];
  bot.setStatusCallback((connected) => status.push(connected));
  const ctl = new AbortController();
  let received: { text: string; userID: string } | null = null;
  const receivedResolve = Promise.withResolvers<void>();
  const done = bot.start(ctl.signal, (_signal, message) => {
    received = { text: message.text, userID: message.userID };
    receivedResolve.resolve();
    return Promise.resolve({ text: "" });
  });

  try {
    await withTimeout(bot.ready(), 2000, "bot readiness");
    assertEquals(bot.isConnected(), false);
    releaseFirstPoll();

    await withTimeout(receivedResolve.promise, 2000, "inbound message");
    const got = received as { text: string; userID: string } | null;
    assertEquals(got?.text, "hello");
    assertEquals(got?.userID, "wx-user");
    assertEquals(bot.isConnected(), true);

    const loaded = loadCredentials(credPath);
    assertEquals(loaded?.getUpdatesBuf, "saved-cursor");

    await withTimeout(secondPollArrived, 2000, "post-message long-poll");
    ctl.abort();
    releaseLongPoll();
    await withTimeout(done, 2000, "bot stop");
    assertEquals(bot.isConnected(), false);

    assertEquals(
      paths[0],
      "/ilink/bot/msg/notifystart",
    );
    assertEquals(paths[paths.length - 1], "/ilink/bot/msg/notifystop");
    const gotConnected = status.includes(true);
    const gotDisconnected = status.includes(false);
    assertEquals(gotConnected, true);
    assertEquals(gotDisconnected, true);
  } finally {
    ctl.abort();
    releaseFirstPoll();
    releaseLongPoll();
    await server.shutdown();
  }
});

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
    ),
  ]);
}
