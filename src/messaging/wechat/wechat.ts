// Ported from internal/messaging/wechat/wechat.go
//
// Bot implements messaging.Platform for WeChat via the iLink protocol.

import { createHash } from "node:crypto";

import {
  AttachmentAudio,
  AttachmentFile,
  AttachmentImage,
  type AttachmentKind,
  type AttachmentStream,
  AttachmentVideo,
  type DurableDeliveryExecutor,
  type DurableDeliveryRequest,
  type DurableDeliveryResult,
  type InboundMessage,
  type MessageHandler,
  type MessageResponse,
  newProgressBuffer,
  type Platform,
  type PlatformAttachment,
  type Readiness,
} from "../mod.ts";
import {
  buildTextMessageWithClientID,
  Client,
  defaultLongPollTimeout,
  defaultNotificationTimeout,
  getConfig,
  getUpdatesWithTimeout,
  notifyStart,
  notifyStop,
  sendMessage,
  sendTyping as sendTypingAPI,
  stableClientID,
} from "./protocol.ts";
import {
  APIError,
  type CDNMedia,
  type Credentials,
  ItemFile,
  ItemImage,
  ItemText,
  ItemVideo,
  ItemVoice,
  type MessageItem,
  MessageTypeBot,
  MessageTypeUser,
  type WireMessage,
} from "./types.ts";
import {
  clearCredentials,
  loadCredentials,
  login,
  type LoginOptions,
  saveCredentials,
  sleepCtx,
} from "./auth.ts";
import { openCDNMedia } from "./media.ts";
import {
  executeWechatDurableDelivery,
  sendMediaAttachment,
  wechatSendFailureStatus,
} from "./media_send.ts";

export const wechatMaxRepliesPerMessage = 10;
export const wechatMessageTextLimit = 4000;

interface PendingReplyState {
  chunks: string[];
  lastProgress: string;
}

class ReplySession {
  private readonly bot: Bot;
  private readonly userID: string;
  private readonly contextToken: string;
  private remaining: number;

  constructor(bot: Bot, userID: string, contextToken: string) {
    this.bot = bot;
    this.userID = userID;
    this.contextToken = contextToken;
    this.remaining = wechatMaxRepliesPerMessage;
  }

  send(signal: AbortSignal, text: string): Promise<void> {
    return this.sendWithClientID(signal, text, "");
  }

  /**
   * sendWithClientID sends a caption using deterministic IDs derived from the
   * Runtime operation. Long captions still split into bounded provider
   * messages, with one stable child ID per chunk.
   */
  sendWithClientID(
    signal: AbortSignal,
    text: string,
    operationID: string,
  ): Promise<void> {
    return this.sendInternal(signal, text, operationID);
  }

  private async sendInternal(
    signal: AbortSignal,
    text: string,
    operationID: string,
  ): Promise<void> {
    if (text.trim() === "") {
      return;
    }
    const chunks = chunkText(text, wechatMessageTextLimit - replyFooterLen(0));
    for (let i = 0; i < chunks.length; i++) {
      if (this.remaining === 0) {
        this.queue(chunks.slice(i));
        return;
      }
      let clientID = "";
      if (operationID.trim() !== "") {
        clientID = stableClientID(`${operationID}:${i}`);
      }
      await this.bot.sendChunkWithClientID(
        signal,
        this.userID,
        chunks[i],
        this.contextToken,
        this.remaining - 1,
        clientID,
      );
      this.remaining--;
    }
  }

  sendProgress(signal: AbortSignal, text: string): Promise<void> {
    const state = this.bot.pendingReply(this.userID);
    state.lastProgress = text;
    return this.send(signal, text);
  }

  private queue(chunks: string[]): void {
    const state = this.bot.pendingReply(this.userID);
    state.chunks.push(...chunks);
  }
}

export function replyFooterLen(remaining: number): number {
  return new TextEncoder().encode(replyFooter(remaining)).length;
}

export function replyFooter(remaining: number): string {
  if (remaining === 0) {
    return "\n\n剩余推送次数: 0次\n输入 /more 继续接收消息。";
  }
  return `\n\n剩余推送次数: ${remaining}次`;
}

export interface BotOptions {
  credPath?: string;
  autoTyping?: boolean;
}

/** Bot implements messaging.Platform for WeChat via the iLink protocol. */
export class Bot implements Platform, Readiness, DurableDeliveryExecutor {
  readonly client: Client;
  creds: Credentials | null = null;
  credPath: string;
  autoTyping: boolean;
  connected = false;
  stopped = false;
  cancelPoll: (() => void) | null = null;
  contextTokens = new Map<string, string>();
  pendingReplies = new Map<string, PendingReplyState>();
  cursor = "";
  statusCallback: ((connected: boolean) => void) | null = null;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: unknown) => void;
  private readySettled = false;

  constructor(opts: BotOptions, client?: Client) {
    this.client = client ?? newClient();
    this.credPath = opts.credPath ?? "";
    this.autoTyping = opts.autoTyping ?? false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Readiness is one-shot and may be observed after the fact; swallow the
    // rejection so a failed candidate does not surface as an unhandled error.
    this.readyPromise.catch(() => {});
  }

  /** Ready returns the one-shot startup result for the current Bot instance. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private signalReady(err: unknown): void {
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
    return "wechat";
  }

  isConnected(): boolean {
    return this.connected;
  }

  setStatusCallback(callback: (connected: boolean) => void): void {
    this.statusCallback = callback;
  }

  /**
   * setConnected reports the health of the iLink receive loop rather than the
   * mere presence of local credentials. This keeps channel status truthful
   * when a token exists but getupdates cannot be established.
   */
  private setConnected(connected: boolean): void {
    const changed = this.connected !== connected;
    this.connected = connected;
    const callback = this.statusCallback;
    if (changed && callback !== null) {
      callback(connected);
    }
  }

  /**
   * finishReceiveLoop is the single shutdown path for both an explicit stop
   * and a parent signal cancellation. It is intentionally idempotent.
   */
  private async finishReceiveLoop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const cancel = this.cancelPoll;
    const creds = this.creds;
    const wasConnected = this.connected;
    this.connected = false;
    const callback = this.statusCallback;

    if (cancel !== null) {
      cancel();
    }
    if (wasConnected && callback !== null) {
      callback(false);
    }
    if (creds === null) {
      return;
    }
    try {
      await notifyStop(
        this.client,
        AbortSignal.timeout(defaultNotificationTimeout),
        creds.baseUrl,
        creds.token,
      );
    } catch (err) {
      console.error(`[wechat] notify stop failed: ${err}`);
    }
  }

  /** start begins long-poll message receiving. Resolves when aborted. */
  async start(signal: AbortSignal, handler: MessageHandler): Promise<void> {
    // Load credentials
    let creds: Credentials | null;
    try {
      creds = loadCredentials(this.credPath);
    } catch (err) {
      const message = `wechat: load credentials: ${err}`;
      this.signalReady(message);
      throw new Error(message);
    }
    if (creds === null) {
      const message = `wechat: no credentials found at ${this.credPath}`;
      this.signalReady(message);
      throw new Error(message);
    }

    this.creds = creds;
    this.cursor = creds.getUpdatesBuf ?? "";
    this.connected = false;
    this.stopped = false;

    const pollCtl = new AbortController();
    const abortFromParent = () => pollCtl.abort(signal.reason);
    if (signal.aborted) {
      pollCtl.abort(signal.reason);
    } else {
      signal.addEventListener("abort", abortFromParent, { once: true });
    }
    this.cancelPoll = () =>
      pollCtl.abort(
        new DOMException("wechat receive loop stopped", "AbortError"),
      );
    const pollSignal = pollCtl.signal;

    try {
      await notifyStart(this.client, pollSignal, creds.baseUrl, creds.token)
        .catch((err) => {
          if (!pollSignal.aborted) {
            console.error(`[wechat] notify start failed: ${err}`);
          }
        });
      this.signalReady(null);

      console.error(`[wechat] Long-poll loop started (user: ${creds.userId})`);
      let retryDelay = 1000;
      let pollTimeout = defaultLongPollTimeout;

      while (true) {
        if (pollSignal.aborted) {
          console.error("[wechat] Long-poll loop stopped");
          return;
        }

        const currentCreds = this.creds;
        const cursor = this.cursor;
        if (currentCreds === null) {
          throw new Error("wechat: receive loop lost credentials");
        }

        let updates;
        try {
          updates = await getUpdatesWithTimeout(
            this.client,
            pollSignal,
            currentCreds.baseUrl,
            currentCreds.token,
            cursor,
            pollTimeout,
          );
        } catch (err) {
          if (pollSignal.aborted) {
            return;
          }
          this.setConnected(false);
          if (err instanceof APIError && err.isSessionExpired()) {
            console.error("[wechat] Session expired — re-login required");
            try {
              clearCredentials(this.credPath);
            } catch (clearErr) {
              console.error(`[wechat] clear stale credentials: ${clearErr}`);
            }
            this.contextTokens.clear();
            this.cursor = "";
            try {
              const opts: LoginOptions = {
                credPath: this.credPath,
                force: true,
              };
              const newCreds = await login(pollSignal, this.client, opts);
              this.creds = newCreds;
              this.cursor = newCreds.getUpdatesBuf ?? "";
              await notifyStart(
                this.client,
                pollSignal,
                newCreds.baseUrl,
                newCreds.token,
              ).catch((notifyErr) => {
                if (!pollSignal.aborted) {
                  console.error(
                    `[wechat] notify start after re-login failed: ${notifyErr}`,
                  );
                }
              });
              retryDelay = 1000;
              pollTimeout = defaultLongPollTimeout;
              continue;
            } catch (loginErr) {
              console.error(`[wechat] Re-login failed: ${loginErr}`);
              try {
                await sleepCtx(pollSignal, retryDelay);
              } catch {
                return;
              }
              continue;
            }
          }

          console.error(`[wechat] Poll error: ${err}`);
          try {
            await sleepCtx(pollSignal, retryDelay);
          } catch {
            return;
          }
          if (retryDelay < 10_000) {
            retryDelay *= 2;
          }
          continue;
        }

        this.setConnected(true);
        const timeout = longPollTimeout(updates.longpolling_timeout_ms ?? 0);
        if (timeout !== null) {
          pollTimeout = timeout;
        }
        const nextCursor = updates.get_updates_buf ?? "";
        if (nextCursor !== "" && nextCursor !== cursor) {
          this.persistCursor(currentCreds, nextCursor);
        }
        retryDelay = 1000;

        for (const rawMsg of updates.msgs ?? []) {
          const wire = coerceWireMessage(rawMsg);
          if (wire === null) {
            continue;
          }
          this.rememberContext(wire);
          if (wire.message_type !== MessageTypeUser) {
            continue;
          }
          const text = extractText(wire.item_list ?? []);
          const attachments = this.inboundAttachments(wire);
          if (text === "" && attachments.length === 0) {
            continue;
          }
          let messageID = wireMessageID(wire);
          if (messageID === "") {
            messageID = wireMessageIdentity(wire);
          }

          const fromUserID = wire.from_user_id;
          const contextToken = wire.context_token;
          const msg: InboundMessage = {
            platform: "wechat",
            chatID: fromUserID,
            userID: fromUserID,
            messageID,
            userName: "",
            text,
            timestamp: new Date(wire.create_time_ms ?? 0),
            replyContext: contextToken,
            attachments,
          };

          if (this.autoTyping) {
            void this.sendTyping(pollSignal, fromUserID);
          }

          this.dispatchMessage(
            handler,
            msg,
            awaitDetached(),
            contextToken,
          );
        }
      }
    } finally {
      signal.removeEventListener("abort", abortFromParent);
      await this.finishReceiveLoop();
    }
  }

  /** dispatchMessage runs one inbound turn on a detached signal. */
  private dispatchMessage(
    handler: MessageHandler,
    msg: InboundMessage,
    runSignal: AbortSignal,
    contextToken: string,
  ): void {
    void (async () => {
      const reply = this.newReplySession(msg.userID, contextToken);
      if (msg.text.trim() === "/more") {
        try {
          await this.sendMore(runSignal, msg.userID, contextToken);
        } catch (err) {
          console.error(`[wechat] More send error for ${msg.userID}: ${err}`);
        }
        return;
      }

      const progressBuf = newProgressBuffer(7, (text: string) => {
        void reply.sendProgress(runSignal, text).catch((err) => {
          console.error(`[wechat] Progress send error: ${err}`);
        });
      });
      msg.progressFunc = (text: string) => {
        progressBuf.add(text);
      };

      let response: MessageResponse;
      try {
        response = await handler(runSignal, msg);
      } catch (err) {
        console.error(`[wechat] Handler error for ${msg.userID}: ${err}`);
        response = { text: `⚠️ Error: ${err}` };
      }

      progressBuf.flush();

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
              await delivery.prepare(runSignal);
            } catch (err) {
              console.error(`[wechat] text delivery claim failed: ${err}`);
              textDeliveryBlocked = true;
              continue;
            }
          }
          const sendText = delivery.id !== ""
            ? (s: AbortSignal, value: string) =>
              reply.sendWithClientID(s, value, delivery.id)
            : (s: AbortSignal, value: string) => reply.send(s, value);
          try {
            await sendText(runSignal, text);
            console.error(
              `[wechat] Message sent to ${msg.userID} successfully (len=${text.length})`,
            );
            delivery.complete?.(runSignal, "delivered", "", "");
          } catch (err) {
            console.error(`[wechat] Send error for ${msg.userID}: ${err}`);
            delivery.complete?.(
              runSignal,
              wechatSendFailureStatus(err),
              "",
              "send_text_failed",
            );
          }
        }
      } else if (response.text !== "") {
        try {
          await reply.send(runSignal, response.text);
          console.error(
            `[wechat] Message sent to ${msg.userID} successfully (len=${response.text.length})`,
          );
        } catch (err) {
          console.error(`[wechat] Send error for ${msg.userID}: ${err}`);
        }
      } else {
        console.error(`[wechat] Empty response for ${msg.userID}, not sending`);
      }
      if (textDeliveryBlocked) {
        if (this.autoTyping) {
          await this.stopTyping(runSignal, msg.userID);
        }
        return;
      }
      for (const attachment of response.attachments ?? []) {
        if (attachment.prepare !== undefined) {
          try {
            await attachment.prepare(runSignal);
          } catch (err) {
            console.error(`[wechat] media delivery claim failed: ${err}`);
            if (attachment.completeUpload !== undefined) {
              attachment.completeUpload(
                runSignal,
                "failed",
                "",
                "{}",
                "delivery_claim_failed",
              );
            } else {
              attachment.complete?.(
                runSignal,
                "failed",
                "",
                "delivery_claim_failed",
              );
            }
            continue;
          }
        }
        if (
          attachment.sendOperationID !== "" ||
          attachment.completeSend !== undefined
        ) {
          try {
            await sendMediaAttachment(this, runSignal, attachment);
          } catch (err) {
            console.error(
              `[wechat] media delivery failed for ${attachment.id}: ${err}`,
            );
          }
        } else if (attachment.complete !== undefined) {
          attachment.complete(
            runSignal,
            "unsupported",
            "",
            "platform_media_unsupported",
          );
        }
      }
      if (this.autoTyping) {
        await this.stopTyping(runSignal, msg.userID);
      }
    })();
  }

  /** stop gracefully stops the bot. */
  stop(): Promise<void> {
    return this.finishReceiveLoop();
  }

  private persistCursor(creds: Credentials, cursor: string): void {
    if (cursor === "") {
      return;
    }
    if (this.creds !== creds) {
      return;
    }
    this.cursor = cursor;
    creds.getUpdatesBuf = cursor;
    try {
      saveCredentials(creds, this.credPath);
    } catch (err) {
      console.error(`[wechat] save getupdates cursor: ${err}`);
    }
  }

  /** sendMessage sends a text message to a user. */
  sendMessage(
    signal: AbortSignal,
    chatID: string,
    text: string,
  ): Promise<void> {
    const ct = this.contextTokens.get(chatID);
    if (ct === undefined) {
      return Promise.reject(new Error(`no context_token for user ${chatID}`));
    }
    return this.sendText(signal, chatID, text, ct);
  }

  // --- Internal ---

  pendingReply(userID: string): PendingReplyState {
    let state = this.pendingReplies.get(userID);
    if (state === undefined) {
      state = { chunks: [], lastProgress: "" };
      this.pendingReplies.set(userID, state);
    }
    return state;
  }

  newReplySession(userID: string, contextToken: string): ReplySession {
    return new ReplySession(this, userID, contextToken);
  }

  private sendText(
    signal: AbortSignal,
    userID: string,
    text: string,
    contextToken: string,
  ): Promise<void> {
    return this.newReplySession(userID, contextToken).send(signal, text);
  }

  async sendChunkWithClientID(
    signal: AbortSignal,
    userID: string,
    text: string,
    contextToken: string,
    remaining: number,
    clientID: string,
  ): Promise<void> {
    const creds = this.creds;
    if (creds === null) {
      throw new Error("not logged in");
    }
    const msg = buildTextMessageWithClientID(
      creds.userId,
      userID,
      contextToken,
      text + replyFooter(remaining),
      clientID,
    );
    await sendMessage(this.client, signal, creds.baseUrl, creds.token, msg);
  }

  private async sendMore(
    signal: AbortSignal,
    userID: string,
    contextToken: string,
  ): Promise<void> {
    const state = this.pendingReply(userID);
    const chunks = state.chunks.slice();
    state.chunks = [];
    const lastProgress = state.lastProgress;
    state.lastProgress = "";

    const s = this.newReplySession(userID, contextToken);
    if (chunks.length > 0) {
      for (const chunk of chunks) {
        await s.send(signal, chunk);
      }
      return;
    }
    if (lastProgress !== "") {
      await s.send(signal, lastProgress);
    }
  }

  private async sendTyping(signal: AbortSignal, userID: string): Promise<void> {
    const ct = this.contextTokens.get(userID);
    const creds = this.creds;
    if (ct === undefined || creds === null) {
      return;
    }
    try {
      const config = await getConfig(
        this.client,
        signal,
        creds.baseUrl,
        creds.token,
        userID,
        ct,
      );
      const ticket = config.typing_ticket ?? "";
      if (ticket === "") {
        return;
      }
      await sendTypingAPI(
        this.client,
        signal,
        creds.baseUrl,
        creds.token,
        userID,
        ticket,
        1,
      );
    } catch {
      // Best-effort typing indicator.
    }
  }

  private async stopTyping(signal: AbortSignal, userID: string): Promise<void> {
    const ct = this.contextTokens.get(userID);
    const creds = this.creds;
    if (ct === undefined || creds === null) {
      return;
    }
    try {
      const config = await getConfig(
        this.client,
        signal,
        creds.baseUrl,
        creds.token,
        userID,
        ct,
      );
      const ticket = config.typing_ticket ?? "";
      if (ticket === "") {
        return;
      }
      await sendTypingAPI(
        this.client,
        signal,
        creds.baseUrl,
        creds.token,
        userID,
        ticket,
        2,
      );
    } catch {
      // Best-effort typing indicator.
    }
  }

  private rememberContext(wire: WireMessage): void {
    let userID = wire.from_user_id;
    if (wire.message_type === MessageTypeBot) {
      userID = wire.to_user_id;
    }
    if (userID !== "" && wire.context_token !== "") {
      this.contextTokens.set(userID, wire.context_token);
    }
  }

  /**
   * inboundAttachments translates only media references carried by an
   * authenticated iLink getupdates event. The open closures retain the opaque
   * CDN reference and AES key inside the WeChat transport boundary.
   */
  inboundAttachments(wire: WireMessage | null): PlatformAttachment[] {
    if (wire === null) {
      return [];
    }
    const result: PlatformAttachment[] = [];
    const messageIdentity = wireMessageIdentity(wire);
    const itemList = wire.item_list ?? [];
    for (let index = 0; index < itemList.length; index++) {
      const item = itemList[index];
      const candidates: { item: MessageItem; index: number }[] = [
        { item, index },
      ];
      if (item.ref_msg !== undefined) {
        const ref = item.ref_msg;
        const nested = ref.item_list ?? [];
        for (let ni = 0; ni < nested.length; ni++) {
          candidates.push({ item: nested[ni], index: index * 1000 + ni + 1 });
        }
        if (ref.message_item !== undefined) {
          candidates.push({
            item: ref.message_item,
            index: index * 1000 + nested.length + 1,
          });
        }
      }
      for (const candidate of candidates) {
        const current = candidate.item;
        const attachmentIndex = candidate.index;
        let kind: AttachmentKind | null = null;
        let media: CDNMedia | null = null;
        let aesKey = "";
        let filename = "";
        let mediaType = "";
        let sizeHint = 0;
        switch (current.type) {
          case ItemImage: {
            if (
              current.image_item === undefined ||
              current.image_item.media === undefined
            ) {
              continue;
            }
            kind = AttachmentImage;
            media = current.image_item.media;
            aesKey = current.image_item.aeskey ?? "";
            filename = `image-${messageIdentity}`;
            mediaType = "image/png";
            break;
          }
          case ItemVoice: {
            if (
              current.voice_item === undefined ||
              current.voice_item.media === undefined
            ) {
              continue;
            }
            kind = AttachmentAudio;
            media = current.voice_item.media;
            filename = current.voice_item.file_name ?? "";
            if (filename === "") {
              filename = `voice-${messageIdentity}.amr`;
            }
            mediaType = "audio/amr";
            break;
          }
          case ItemFile: {
            if (
              current.file_item === undefined ||
              current.file_item.media === undefined
            ) {
              continue;
            }
            kind = AttachmentFile;
            media = current.file_item.media;
            filename = current.file_item.file_name ?? "";
            sizeHint = parseMediaSize(current.file_item.len ?? "");
            break;
          }
          case ItemVideo: {
            if (
              current.video_item === undefined ||
              current.video_item.media === undefined
            ) {
              continue;
            }
            kind = AttachmentVideo;
            media = current.video_item.media;
            filename = current.video_item.file_name ?? "";
            if (filename === "") {
              filename = `video-${messageIdentity}.mp4`;
            }
            mediaType = "video/mp4";
            break;
          }
          default:
            continue;
        }
        if (kind === null || media === null) {
          continue;
        }
        const mediaCopy = media;
        const aesKeyCopy = aesKey;
        const filenameCopy = filename;
        const mediaTypeCopy = mediaType;
        const sizeHintCopy = sizeHint;
        result.push({
          reference: `wechat:${messageIdentity}:${attachmentIndex}`,
          kind,
          filename: filenameCopy,
          mediaType: mediaTypeCopy,
          sizeHint: sizeHintCopy,
          messageID: wireMessageID(wire),
          open: async (signal: AbortSignal): Promise<AttachmentStream> => {
            const reader = await openCDNMedia(
              this.client,
              signal,
              mediaCopy,
              aesKeyCopy,
            );
            return {
              reader,
              filename: filenameCopy,
              mediaType: mediaTypeCopy,
              contentSize: sizeHintCopy,
            };
          },
        });
      }
    }
    return result;
  }

  /** executeDurableDelivery replays one Runtime-owned outbox operation. */
  executeDurableDelivery(
    signal: AbortSignal,
    request: DurableDeliveryRequest,
  ): Promise<DurableDeliveryResult> {
    return executeWechatDurableDelivery(this, signal, request);
  }
}

/** newClient mirrors the protocol NewClient constructor. */
function newClient(): Client {
  return new Client();
}

function coerceWireMessage(raw: unknown): WireMessage | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as WireMessage;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return raw as WireMessage;
  }
  return null;
}

export function extractText(items: MessageItem[]): string {
  const parts: string[] = [];
  const appendItem = (item: MessageItem): void => {
    if (item.type === ItemText && item.text_item !== undefined) {
      parts.push(item.text_item.text);
    }
    if (item.ref_msg !== undefined) {
      const ref = item.ref_msg;
      for (const nested of ref.item_list ?? []) {
        appendItem(nested);
      }
      if (ref.message_item !== undefined) {
        appendItem(ref.message_item);
      }
    }
  };
  for (const item of items) {
    appendItem(item);
  }
  return parts.join("\n");
}

export function wireMessageID(wire: WireMessage | null): string {
  if (wire === null || !wire.message_id) {
    return "";
  }
  return String(wire.message_id);
}

export function wireMessageIdentity(wire: WireMessage | null): string {
  if (wire === null) {
    return "unknown";
  }
  if (wire.message_id) {
    return String(wire.message_id);
  }
  if (wire.seq) {
    return `seq-${wire.seq}`;
  }
  if (wire.create_time_ms) {
    return `time-${wire.create_time_ms}`;
  }
  // A few fixtures and older iLink responses omit every native event ID.
  // Hash only the non-secret envelope and item structure so retries still
  // share a stable identity without persisting context tokens or media keys.
  const payload = JSON.stringify({
    fromUserId: wire.from_user_id,
    toUserId: wire.to_user_id,
    messageType: wire.message_type,
    itemList: wire.item_list ?? [],
  });
  const digest = createHash("sha256").update(payload).digest();
  return "digest-" + digest.subarray(0, 8).toString("hex");
}

export function parseMediaSize(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") {
    return 0;
  }
  if (!/^\d+$/.test(trimmed)) {
    return 0;
  }
  const size = Number(trimmed);
  if (!Number.isFinite(size) || size < 0) {
    return 0;
  }
  return size;
}

/**
 * chunkText splits text at byte boundaries so multi-byte UTF-8 sequences are
 * never broken, mirroring the Go implementation's byte-oriented cuts.
 */
export function chunkText(text: string, limit: number): string[] {
  const bytes = new TextEncoder().encode(text);
  if (limit <= 0 || bytes.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let remaining = bytes;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(decoder.decode(remaining));
      break;
    }
    let cut = limit;
    const idx2 = lastIndexOfBytes(remaining, limit, [0x0a, 0x0a]);
    const idx1 = lastIndexOfBytes(remaining, limit, [0x0a]);
    const threshold = Math.trunc((limit * 3) / 10);
    if (idx2 > threshold) {
      cut = idx2 + 2;
    } else if (idx1 > threshold) {
      cut = idx1 + 1;
    }
    while (
      cut > 0 && cut < remaining.length && (remaining[cut] & 0xc0) === 0x80
    ) {
      cut--;
    }
    if (cut === 0) {
      cut = utf8RuneSize(remaining[0]);
    }
    chunks.push(decoder.decode(remaining.slice(0, cut)));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

function lastIndexOfBytes(
  data: Uint8Array,
  windowEnd: number,
  pattern: number[],
): number {
  for (let i = windowEnd - pattern.length; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (data[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }
  return -1;
}

function utf8RuneSize(first: number): number {
  if ((first & 0x80) === 0) {
    return 1;
  }
  if ((first & 0xe0) === 0xc0) {
    return 2;
  }
  if ((first & 0xf0) === 0xe0) {
    return 3;
  }
  return 4;
}

export function longPollTimeout(milliseconds: number): number | null {
  if (milliseconds <= 0 || milliseconds > 24 * 60 * 60 * 1000) {
    return null;
  }
  return milliseconds;
}

/** awaitDetached models Go's context.WithoutCancel: a never-aborted signal. */
function awaitDetached(): AbortSignal {
  return new AbortController().signal;
}
