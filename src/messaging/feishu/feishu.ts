// Ported from internal/messaging/feishu/feishu.go
//
// Bot implements messaging.Platform for Feishu (Lark) via the raw-HTTP Open
// Platform API and a Deno WebSocket long-connection receive loop.
//
// Deliberate deviations (documented): the official Feishu Go SDK
// (`oapi-sdk-go/v3` + `gorilla/websocket`) is replaced by the local
// `./api.ts` raw-HTTP client and `./ws.ts` WebSocket client; `context.Context`
// maps to `AbortSignal`; `io.Reader` maps to `Uint8Array`/`ReadableStream`;
// `time.Time` maps to `Date`.

import { createHash } from "node:crypto";

import {
  AttachmentFile,
  AttachmentImage,
  type AttachmentKind,
  type AttachmentStream,
  type DurableDeliveryExecutor,
  type DurableDeliveryRequest,
  type DurableDeliveryResult,
  type InboundMessage,
  type MessageHandler,
  type MessageResponse,
  newProgressBuffer,
  type OutboundAttachment,
  type Platform,
  type PlatformAttachment,
  type Readiness,
  type StatusCallbackSetter,
} from "../mod.ts";
import { FeishuApi, type FeishuApiOptions } from "./api.ts";
import type {
  FeishuEventMessage,
  FeishuEventSender,
  FeishuMessageReceiveV1,
} from "./types.ts";
import { WsClient, type WsEventHandler } from "./ws.ts";

/** The Feishu base domain for the long-connection bootstrap request. */
export const feishuDefaultDomain = "https://open.feishu.cn";

/** backgroundSignal is the never-cancelled analogue of context.Background(). */
const backgroundSignal = new AbortController().signal;

export interface BotOptions {
  appID: string;
  appSecret: string;
  /** Optional injection seams (documented deviation for tests). */
  baseURL?: string;
  domain?: string;
  fetchFn?: typeof fetch;
  logger?: (message: string) => void;
}

/**
 * Bot implements messaging.Platform for Feishu via the Open Platform API and
 * a WebSocket long connection.
 */
export class Bot
  implements
    Platform,
    Readiness,
    DurableDeliveryExecutor,
    StatusCallbackSetter {
  private readonly api: FeishuApi;
  private readonly appID: string;
  private readonly appSecret: string;
  private readonly domain: string;
  private readonly fetchFn?: typeof fetch;
  private readonly logger?: (message: string) => void;
  handler: MessageHandler | null = null;
  private wsClient: WsClient | null = null;
  connected = false;
  cancel: (() => void) | null = null;
  private statusCallback: ((connected: boolean) => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: unknown) => void;
  private readySettled = false;

  constructor(opts: BotOptions) {
    const apiOpts: FeishuApiOptions = {};
    if (opts.baseURL !== undefined) {
      apiOpts.baseURL = opts.baseURL;
    }
    if (opts.fetchFn !== undefined) {
      apiOpts.fetchFn = opts.fetchFn;
    }
    this.api = new FeishuApi(opts.appID, opts.appSecret, apiOpts);
    this.appID = opts.appID;
    this.appSecret = opts.appSecret;
    this.domain = opts.domain ?? feishuDefaultDomain;
    this.fetchFn = opts.fetchFn;
    this.logger = opts.logger;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Readiness is one-shot and may be observed after the fact; swallow the
    // rejection so a failed candidate does not surface as an unhandled error.
    this.readyPromise.catch(() => {});
  }

  /** ready returns the one-shot startup result for the current Bot instance. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** signalReady records the first startup result; later results are dropped. */
  signalReady(err?: unknown): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    if (err !== null && err !== undefined) {
      this.readyReject(err);
    } else {
      this.readyResolve();
    }
  }

  // --- messaging.Platform implementation ---

  name(): string {
    return "feishu";
  }

  isConnected(): boolean {
    return this.connected;
  }

  setStatusCallback(callback: (connected: boolean) => void): void {
    this.statusCallback = callback;
  }

  /**
   * start begins receiving messages via the WebSocket long connection. It
   * resolves when the signal is aborted or the connection is closed.
   */
  async start(signal: AbortSignal, handler: MessageHandler): Promise<void> {
    this.handler = handler;
    const ctl = new AbortController();
    const abortFromParent = () => ctl.abort(signal.reason);
    if (signal.aborted) {
      ctl.abort(signal.reason);
    } else {
      signal.addEventListener("abort", abortFromParent, { once: true });
    }
    this.cancel = () =>
      ctl.abort(new DOMException("feishu receive loop stopped", "AbortError"));

    const eventHandler: WsEventHandler = {
      handleEvent: async (eventType, payload) => {
        if (eventType === "im.message.receive_v1") {
          let envelope: FeishuMessageReceiveV1;
          try {
            envelope = JSON.parse(
              new TextDecoder().decode(payload),
            ) as FeishuMessageReceiveV1;
          } catch (err) {
            this.log(`[feishu] decode message event failed: ${err}`);
            return null;
          }
          await this.onMessage(envelope);
        }
        // im.message.message_read_v1 and unknown events are acknowledged as
        // no-ops so the SDK-equivalent dispatcher does not report an unknown
        // handler for every read receipt.
        return null;
      },
    };

    const wsOpts = {
      appID: this.appID,
      appSecret: this.appSecret,
      domain: this.domain,
      eventHandler,
    } as {
      appID: string;
      appSecret: string;
      domain: string;
      eventHandler: WsEventHandler;
      fetchFn?: typeof fetch;
      logger?: (message: string) => void;
    };
    if (this.fetchFn !== undefined) {
      wsOpts.fetchFn = this.fetchFn;
    }
    if (this.logger !== undefined) {
      wsOpts.logger = this.logger;
    }
    const wsClient = new WsClient(wsOpts);
    this.wsClient = wsClient;
    this.connected = true;
    const cb = this.statusCallback;
    cb?.(true);
    this.log("[feishu] WebSocket long connection started");

    // A config reload can stop the bot while its startup is still being
    // scheduled. Avoid entering the client with an already-cancelled signal.
    if (ctl.signal.aborted) {
      wsClient.close();
      this.signalReady(ctl.signal.reason ?? new Error("feishu start aborted"));
      return;
    }
    this.signalReady();

    let startErr: unknown = null;
    try {
      await wsClient.start(ctl.signal);
    } catch (err) {
      startErr = err;
    }
    this.connected = false;
    const cb2 = this.statusCallback;
    cb2?.(false);

    if (ctl.signal.aborted) {
      return; // normal shutdown
    }
    if (startErr !== null && startErr !== undefined) {
      throw startErr;
    }
  }

  /** stop gracefully shuts down the bot. */
  stop(): void {
    const wsClient = this.wsClient;
    const cancel = this.cancel;
    this.cancel = null;
    this.wsClient = null;
    this.connected = false;
    const cb = this.statusCallback;
    // Close first: this disables auto-reconnect. Cancelling before close makes
    // the reconnect loop call the endpoint with an already-cancelled signal.
    if (wsClient !== null) {
      wsClient.close();
    }
    if (cancel !== null) {
      cancel();
    }
    cb?.(false);
  }

  private log(message: string): void {
    if (this.logger !== undefined) {
      this.logger(message);
    } else {
      console.error(message);
    }
  }

  // --- Message sending ---

  /** sendMessage sends a text message to a chat. */
  sendMessage(
    signal: AbortSignal,
    chatID: string,
    text: string,
  ): Promise<void> {
    return this.sendMessageWithUUID(signal, chatID, text, "");
  }

  private async sendMessageWithUUID(
    signal: AbortSignal,
    chatID: string,
    text: string,
    uuid: string,
  ): Promise<void> {
    const content = JSON.stringify({ text });
    const receiveIDType = chatID.startsWith("ou_") ? "open_id" : "chat_id";
    await this.api.createMessage(
      signal,
      receiveIDType,
      chatID,
      "text",
      content,
      uuid,
    );
  }

  /** sendImage uploads and sends an image message to a Feishu chat. */
  async sendImage(
    signal: AbortSignal,
    chatID: string,
    image: Uint8Array,
  ): Promise<void> {
    const key = await this.uploadImage(signal, image);
    const content = JSON.stringify({ image_key: key });
    await this.sendMediaMessage(signal, chatID, "image", content);
  }

  /** sendFile uploads and sends a file message to a Feishu chat. */
  async sendFile(
    signal: AbortSignal,
    chatID: string,
    filename: string,
    fileType: string,
    file: Uint8Array,
  ): Promise<void> {
    const key = await this.uploadFile(signal, filename, fileType, file);
    const content = JSON.stringify({ file_key: key });
    await this.sendMediaMessage(signal, chatID, "file", content);
  }

  private async uploadImage(
    signal: AbortSignal,
    image: Uint8Array,
  ): Promise<string> {
    const result = await this.api.uploadImage(signal, image);
    return result.key;
  }

  private async uploadFile(
    signal: AbortSignal,
    filename: string,
    fileType: string,
    file: Uint8Array,
  ): Promise<string> {
    let name = filename;
    if (name === "") {
      name = "attachment";
    }
    let type = fileType;
    if (type === "") {
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      type = ext.replace(".", "").toLowerCase();
    }
    const result = await this.api.uploadFile(signal, name, type, file);
    return result.key;
  }

  private sendMediaMessage(
    signal: AbortSignal,
    chatID: string,
    msgType: string,
    content: string,
  ): Promise<void> {
    return this.sendMediaMessageWithUUID(signal, chatID, msgType, content, "");
  }

  private async sendMediaMessageWithUUID(
    signal: AbortSignal,
    chatID: string,
    msgType: string,
    content: string,
    uuid: string,
  ): Promise<void> {
    const receiveIDType = chatID.startsWith("ou_") ? "open_id" : "chat_id";
    await this.api.createMessage(
      signal,
      receiveIDType,
      chatID,
      msgType,
      content,
      uuid,
    );
  }

  /** onMessage dispatches one inbound message event asynchronously. */
  onMessage(event: FeishuMessageReceiveV1 | null): void {
    const handler = this.handler;
    if (handler === null || event === null || event.event === undefined) {
      return;
    }
    const msg = event.event.message;
    const sender = event.event.sender;
    if (msg === undefined || sender === undefined) {
      return;
    }

    const inbound = this.inboundMessage(msg, sender);
    if (inbound === null) {
      this.log(
        `[feishu] Ignoring unsupported message type: ${msg.message_type ?? ""}`,
      );
      return;
    }
    const chatID = inbound.chatID;
    const userID = inbound.userID;

    // Handle message asynchronously (mirrors the Go goroutine).
    void (async () => {
      // Max 7 progress lines per batch, reserving 3 for the summary.
      const progressBuf = newProgressBuffer(7, (text: string) => {
        void this.sendMessage(backgroundSignal, chatID, text).catch((err) => {
          this.log(`[feishu] Progress send error: ${err}`);
        });
      });
      inbound.progressFunc = (text: string) => {
        progressBuf.add(text);
      };

      let response: MessageResponse;
      try {
        response = await handler(backgroundSignal, inbound);
      } catch (err) {
        this.log(`[feishu] Handler error for ${userID}: ${err}`);
        response = { text: `⚠️ Error: ${err}` };
      }

      progressBuf.flush();

      const replyID = msg.message_id ?? "";
      let textDeliveryBlocked = false;
      let textDeliveries = response.textDeliveries ?? [];
      if (textDeliveries.length === 0 && response.textDelivery !== undefined) {
        textDeliveries = [response.textDelivery];
      }
      if (textDeliveries.length > 0) {
        for (const delivery of textDeliveries) {
          let text = delivery.text;
          if (text === "") {
            text = response.text;
          }
          if (delivery.prepare !== undefined) {
            try {
              await delivery.prepare(backgroundSignal);
            } catch (prepareErr) {
              this.log(`[feishu] text delivery claim failed: ${prepareErr}`);
              textDeliveryBlocked = true;
              continue;
            }
          }
          let messageUUID = "";
          if (delivery.id !== "") {
            messageUUID = stableFeishuMessageUUID(delivery.id);
          }
          try {
            await this.replyMessageWithUUID(
              backgroundSignal,
              replyID,
              chatID,
              text,
              messageUUID,
            );
            delivery.complete?.(backgroundSignal, "delivered", "", "");
          } catch (replyErr) {
            this.log(`[feishu] Reply error: ${replyErr}`);
            delivery.complete?.(
              backgroundSignal,
              "uncertain",
              "",
              "send_text_uncertain",
            );
          }
        }
      } else if (response.text !== "") {
        try {
          await this.replyMessageWithUUID(
            backgroundSignal,
            replyID,
            chatID,
            response.text,
            "",
          );
        } catch (replyErr) {
          this.log(`[feishu] Reply error: ${replyErr}`);
        }
      }
      if (textDeliveryBlocked) {
        return;
      }
      for (const attachment of response.attachments ?? []) {
        if (attachment.prepare !== undefined) {
          try {
            await attachment.prepare(backgroundSignal);
          } catch (prepareErr) {
            this.log(`[feishu] media delivery claim failed: ${prepareErr}`);
            completeOutboundAttachment(
              attachment,
              "failed",
              "",
              "delivery_claim_failed",
            );
            continue;
          }
        }
        try {
          await this.replyAttachment(
            backgroundSignal,
            replyID,
            chatID,
            attachment,
          );
        } catch (err) {
          this.log(`[feishu] Media reply error: ${err}`);
          completeOutboundAttachment(
            attachment,
            "failed",
            "",
            "send_media_failed",
          );
          void this.replyMessage(
            backgroundSignal,
            replyID,
            chatID,
            "⚠️ Unable to send generated attachment: " + attachment.filename,
          );
          continue;
        }
        completeOutboundAttachment(attachment, "delivered", "", "");
      }
    })();
  }

  /** inboundMessage maps a raw message event to a Runtime inbound projection. */
  inboundMessage(
    msg: FeishuEventMessage | undefined,
    sender: FeishuEventSender | undefined,
  ): InboundMessage | null {
    if (
      msg === undefined || sender === undefined ||
      msg.message_type === undefined
    ) {
      return null;
    }
    const messageID = stringValue(msg.message_id);
    const chatID = stringValue(msg.chat_id);
    const userID = stringValue(sender.sender_id?.open_id);
    if (messageID === "" || chatID === "" || userID === "") {
      return null;
    }
    const inbound: InboundMessage = {
      platform: "feishu",
      chatID,
      userID,
      messageID,
      userName: "",
      text: "",
      timestamp: eventTimestamp(stringValue(msg.create_time)),
      replyContext: "",
    };
    const content = stringValue(msg.content);
    switch (msg.message_type) {
      case "text": {
        let value: { text?: string };
        try {
          value = JSON.parse(content) as { text?: string };
        } catch {
          return null;
        }
        if (value.text === undefined || value.text === "") {
          return null;
        }
        inbound.text = value.text;
        return inbound;
      }
      case "image": {
        let value: { image_key?: string };
        try {
          value = JSON.parse(content) as { image_key?: string };
        } catch {
          return null;
        }
        if (value.image_key === undefined || value.image_key === "") {
          return null;
        }
        inbound.attachments = [
          this.messageResourceAttachment(
            messageID,
            value.image_key,
            AttachmentImage,
            "image",
          ),
        ];
        return inbound;
      }
      case "file": {
        let value: { file_key?: string; file_name?: string };
        try {
          value = JSON.parse(content) as {
            file_key?: string;
            file_name?: string;
          };
        } catch {
          return null;
        }
        if (value.file_key === undefined || value.file_key === "") {
          return null;
        }
        const attachment = this.messageResourceAttachment(
          messageID,
          value.file_key,
          AttachmentFile,
          "file",
        );
        attachment.filename = value.file_name ?? "";
        inbound.attachments = [attachment];
        return inbound;
      }
      default:
        return null;
    }
  }

  private messageResourceAttachment(
    messageID: string,
    key: string,
    kind: AttachmentKind,
    resourceType: string,
  ): PlatformAttachment {
    return {
      reference: key,
      kind,
      filename: "",
      mediaType: "",
      sizeHint: 0,
      messageID,
      open: async (signal: AbortSignal): Promise<AttachmentStream> => {
        const download = await this.api.downloadMessageResource(
          signal,
          messageID,
          key,
          resourceType,
        );
        return {
          reader: bytesToStream(download.bytes),
          filename: download.filename,
          mediaType: "",
          contentSize: download.bytes.length,
        };
      },
    };
  }

  // --- Reply helpers ---

  private replyMessage(
    signal: AbortSignal,
    messageID: string,
    chatID: string,
    text: string,
  ): Promise<void> {
    return this.replyMessageWithUUID(signal, messageID, chatID, text, "");
  }

  private async replyMessageWithUUID(
    signal: AbortSignal,
    messageID: string,
    chatID: string,
    text: string,
    uuid: string,
  ): Promise<void> {
    const content = JSON.stringify({ text });
    if (messageID !== "") {
      await this.api.replyMessage(signal, messageID, "text", content, uuid);
      return;
    }
    await this.sendMessageWithUUID(signal, chatID, text, uuid);
  }

  private async replyAttachment(
    signal: AbortSignal,
    messageID: string,
    chatID: string,
    attachment: OutboundAttachment,
  ): Promise<void> {
    if (attachment.open === undefined) {
      throw new Error(`attachment ${attachment.id} is not readable`);
    }
    const stream = await attachment.open(signal);
    const bytes = await readStreamFully(stream);
    let msgType: string;
    let content: string;
    let providerAssetID = "";
    switch (attachment.kind) {
      case AttachmentImage: {
        attachment.progressUpload?.(
          signal,
          "uploading",
          "",
          `{"platform":"feishu"}`,
          "",
        );
        let key: string;
        try {
          key = await this.uploadImage(signal, bytes);
        } catch (err) {
          attachment.completeUpload?.(
            signal,
            "retry_wait",
            "",
            `{"platform":"feishu"}`,
            "feishu_upload_failed",
          );
          throw err;
        }
        providerAssetID = key;
        msgType = "image";
        content = JSON.stringify({ image_key: key });
        break;
      }
      case AttachmentFile: {
        attachment.progressUpload?.(
          signal,
          "uploading",
          "",
          `{"platform":"feishu"}`,
          "",
        );
        let key: string;
        try {
          key = await this.uploadFile(signal, attachment.filename, "", bytes);
        } catch (err) {
          attachment.completeUpload?.(
            signal,
            "retry_wait",
            "",
            `{"platform":"feishu"}`,
            "feishu_upload_failed",
          );
          throw err;
        }
        providerAssetID = key;
        msgType = "file";
        content = JSON.stringify({ file_key: key });
        break;
      }
      default:
        attachment.completeSend?.(
          signal,
          "failed",
          "",
          `{"platform":"feishu"}`,
          "unsupported_media_kind",
        );
        throw new Error(
          `unsupported outbound attachment kind ${attachment.kind}`,
        );
    }
    const providerState = JSON.stringify({
      platform: "feishu",
      provider_asset_id: providerAssetID,
    });
    attachment.completeUpload?.(
      signal,
      "uploaded",
      providerAssetID,
      providerState,
      "",
    );
    if (attachment.prepareSend !== undefined) {
      await attachment.prepareSend(signal);
    }
    let messageUUID = "";
    if (attachment.sendOperationID !== "") {
      messageUUID = stableFeishuMessageUUID(attachment.sendOperationID);
    }
    try {
      await this.replyMediaMessageWithUUID(
        signal,
        messageID,
        chatID,
        msgType,
        content,
        messageUUID,
      );
    } catch (err) {
      attachment.completeSend?.(
        signal,
        "retry_wait",
        "",
        providerState,
        "feishu_send_failed",
      );
      throw err;
    }
    attachment.completeSend?.(signal, "delivered", "", providerState, "");
  }

  private replyMediaMessage(
    signal: AbortSignal,
    messageID: string,
    chatID: string,
    msgType: string,
    content: string,
  ): Promise<void> {
    return this.replyMediaMessageWithUUID(
      signal,
      messageID,
      chatID,
      msgType,
      content,
      "",
    );
  }

  private async replyMediaMessageWithUUID(
    signal: AbortSignal,
    messageID: string,
    chatID: string,
    msgType: string,
    content: string,
    uuid: string,
  ): Promise<void> {
    if (messageID === "") {
      await this.sendMediaMessageWithUUID(
        signal,
        chatID,
        msgType,
        content,
        uuid,
      );
      return;
    }
    await this.api.replyMessage(signal, messageID, msgType, content, uuid);
  }

  /**
   * executeDurableDelivery replays one Runtime-owned outbox operation after a
   * process restart. The Runtime has already fenced the operation; this method
   * performs only the Feishu API call and returns an opaque provider checkpoint.
   */
  async executeDurableDelivery(
    signal: AbortSignal,
    request: DurableDeliveryRequest,
  ): Promise<DurableDeliveryResult> {
    const base: DurableDeliveryResult = {
      status: "",
      providerAssetID: "",
      providerMessageID: "",
      providerState: new Uint8Array(),
      failureCode: "",
    };
    switch (request.operation.operationKind) {
      case "send_text":
      case "send_fallback_text": {
        if (request.caption.trim() === "") {
          return {
            ...base,
            status: "failed",
            failureCode: "delivery_caption_missing",
          };
        }
        try {
          await this.replyMessageWithUUID(
            signal,
            request.intent.replyMessageId,
            request.intent.targetId,
            request.caption,
            stableFeishuMessageUUID(request.operation.idempotencyKey),
          );
        } catch {
          return {
            ...base,
            status: "uncertain",
            failureCode: "feishu_send_uncertain",
          };
        }
        return { ...base, status: "delivered" };
      }

      case "upload_artifact": {
        if (request.openArtifact === undefined) {
          return {
            ...base,
            status: "failed",
            failureCode: "artifact_reader_missing",
          };
        }
        let bytes: Uint8Array;
        try {
          const stream = await request.openArtifact(signal);
          bytes = await readStreamFully(stream);
        } catch {
          return {
            ...base,
            status: "failed",
            failureCode: "artifact_open_failed",
          };
        }
        let providerAssetID: string;
        try {
          if (request.artifactKind === AttachmentImage) {
            providerAssetID = await this.uploadImage(signal, bytes);
          } else if (request.artifactKind === AttachmentFile) {
            providerAssetID = await this.uploadFile(
              signal,
              request.artifactFilename,
              "",
              bytes,
            );
          } else {
            return {
              ...base,
              status: "failed",
              failureCode: "unsupported_media_kind",
            };
          }
        } catch {
          return {
            ...base,
            status: "retry_wait",
            failureCode: "feishu_upload_failed",
          };
        }
        return {
          ...base,
          status: "uploaded",
          providerAssetID,
          providerState: new TextEncoder().encode(
            JSON.stringify({
              platform: "feishu",
              provider_asset_id: providerAssetID,
            }),
          ),
        };
      }

      case "send_artifact": {
        if (request.dependency === undefined) {
          return {
            ...base,
            status: "failed",
            failureCode: "delivery_dependency_missing",
          };
        }
        let providerAssetID = request.dependency.providerAssetId.trim();
        if (providerAssetID === "") {
          providerAssetID = parseProviderAssetID(
            request.dependency.providerState,
          );
        }
        if (providerAssetID === "") {
          return {
            ...base,
            status: "retry_wait",
            failureCode: "feishu_upload_checkpoint_missing",
          };
        }
        let msgType: string;
        let content: string;
        if (request.artifactKind === AttachmentImage) {
          msgType = "image";
          content = JSON.stringify({ image_key: providerAssetID });
        } else if (request.artifactKind === AttachmentFile) {
          msgType = "file";
          content = JSON.stringify({ file_key: providerAssetID });
        } else {
          return {
            ...base,
            status: "failed",
            failureCode: "unsupported_media_kind",
          };
        }
        try {
          await this.replyMediaMessageWithUUID(
            signal,
            request.intent.replyMessageId,
            request.intent.targetId,
            msgType,
            content,
            stableFeishuMessageUUID(request.operation.idempotencyKey),
          );
        } catch {
          return {
            ...base,
            status: "uncertain",
            providerAssetID,
            failureCode: "feishu_send_uncertain",
          };
        }
        return { ...base, status: "delivered", providerAssetID };
      }

      default:
        return {
          ...base,
          status: "failed",
          failureCode: "unsupported_delivery_operation",
        };
    }
  }
}

function parseProviderAssetID(state: unknown): string {
  if (state === null || state === undefined) {
    return "";
  }
  let text: string;
  if (state instanceof Uint8Array) {
    try {
      text = new TextDecoder().decode(state);
    } catch {
      return "";
    }
  } else if (typeof state === "string") {
    text = state;
  } else if (typeof state === "object") {
    const direct = (state as { provider_asset_id?: unknown }).provider_asset_id;
    return typeof direct === "string" ? direct.trim() : "";
  } else {
    return "";
  }
  if (text.trim() === "") {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as { provider_asset_id?: unknown };
    return typeof parsed.provider_asset_id === "string"
      ? parsed.provider_asset_id.trim()
      : "";
  } catch {
    return "";
  }
}

function stringValue(value: string | undefined): string {
  return value ?? "";
}

/** eventTimestamp parses a millisecond epoch string, defaulting to now. */
export function eventTimestamp(raw: string): Date {
  const ms = Number.parseInt(raw, 10);
  if (Number.isNaN(ms) || ms <= 0) {
    return new Date();
  }
  return new Date(ms);
}

/**
 * stableFeishuMessageUUID derives a deterministic UUID from an operation ID so
 * Feishu's uuid dedup applies across retries.
 */
export function stableFeishuMessageUUID(operationID: string): string {
  const digest = createHash("sha256").update(operationID.trim()).digest();
  const buf = digest.subarray(0, 16);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

function completeOutboundAttachment(
  attachment: OutboundAttachment,
  status: string,
  providerMessageID: string,
  failureCode: string,
): void {
  if (attachment.completeSend !== undefined) {
    attachment.completeSend(
      backgroundSignal,
      status,
      providerMessageID,
      "{}",
      failureCode,
    );
  } else if (attachment.complete !== undefined) {
    attachment.complete(
      backgroundSignal,
      status,
      providerMessageID,
      failureCode,
    );
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readStreamFully(
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
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
