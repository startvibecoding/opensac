// Ported from internal/messaging/wechat/media_send.go
//
// Outbound media delivery and durable-outbox replay for the WeChat iLink
// transport. The Runtime artifact store performs the authoritative policy
// check; this adapter only bounds an accidental unbounded read.

import { createHash } from "node:crypto";

import {
  AttachmentFile,
  AttachmentImage,
  type AttachmentKind,
  AttachmentVideo,
  type DurableDeliveryRequest,
  type DurableDeliveryResult,
  type OutboundAttachment,
} from "../mod.ts";
import { decodeAESKey, encodeHex, generateAESKey } from "./crypto.ts";
import {
  buildMediaItem,
  buildMediaMessage,
  buildTextMessageWithClientID,
  getUploadURL,
  sendMessage,
  stableClientID,
  uploadCDN,
  type UploadedMedia,
} from "./protocol.ts";
import {
  APIError,
  type GetUploadURLRequest,
  ItemFile,
  ItemImage,
  ItemVideo,
} from "./types.ts";
import type { Bot } from "./wechat.ts";

/**
 * The Runtime artifact store performs the authoritative policy check. This
 * adapter-side bound only prevents an accidental unbounded read before the
 * provider request is assembled.
 */
export const maxOutboundMediaBytes = 100 << 20;

interface WechatUploadState extends UploadedMedia {
  upload_param?: string;
  upload_full_url?: string;
  client_id?: string;
}

function rawUploadState(state: WechatUploadState): string {
  try {
    return JSON.stringify(state);
  } catch {
    return "{}";
  }
}

function parseWechatUploadState(raw: unknown): WechatUploadState {
  const empty: WechatUploadState = {
    filekey: "",
    encrypt_query_param: "",
    aeskey: "",
    rawsize: 0,
    filesize: 0,
  };
  if (raw === null || raw === undefined) {
    return empty;
  }
  let text: string;
  if (raw instanceof Uint8Array) {
    try {
      text = new TextDecoder().decode(raw);
    } catch {
      return empty;
    }
  } else if (typeof raw === "string") {
    text = raw;
  } else if (typeof raw === "object") {
    try {
      text = JSON.stringify(raw);
    } catch {
      return empty;
    }
  } else {
    return empty;
  }
  if (text.trim() === "") {
    return empty;
  }
  try {
    const parsed = JSON.parse(text) as Partial<WechatUploadState>;
    return {
      ...empty,
      ...parsed,
    };
  } catch {
    return empty;
  }
}

/** sendMediaAttachment uploads then sends one Runtime-owned media delivery. */
export async function sendMediaAttachment(
  bot: Bot,
  signal: AbortSignal,
  attachment: OutboundAttachment,
): Promise<void> {
  if (bot === null || bot.client === null) {
    throw new Error("wechat media bot is not configured");
  }
  if (
    attachment.kind !== AttachmentImage &&
    attachment.kind !== AttachmentVideo &&
    attachment.kind !== AttachmentFile
  ) {
    throw new Error(
      `unsupported outbound WeChat media kind ${attachment.kind}`,
    );
  }

  let state: WechatUploadState;
  try {
    state = await uploadMediaAttachment(bot, signal, attachment);
  } catch (err) {
    let failed: WechatUploadState;
    try {
      failed = parseWechatUploadState(attachment.providerState);
    } catch {
      failed = parseWechatUploadState(undefined);
    }
    const status = wechatUploadFailureStatus(err);
    if (attachment.completeUpload !== undefined) {
      attachment.completeUpload(
        signal,
        status,
        failed.filekey,
        rawUploadState(failed),
        wechatErrorCode(err),
      );
    } else if (attachment.complete !== undefined) {
      attachment.complete(signal, status, "", wechatErrorCode(err));
    }
    throw err;
  }
  if (attachment.completeUpload !== undefined) {
    attachment.completeUpload(
      signal,
      "uploaded",
      state.filekey,
      rawUploadState(state),
      "",
    );
  }
  if (attachment.prepareSend !== undefined) {
    await attachment.prepareSend(signal);
  }

  let item;
  try {
    item = buildMediaItem(
      wechatItemType(attachment.kind),
      state,
      attachment.filename,
    );
  } catch (err) {
    if (attachment.completeSend !== undefined) {
      attachment.completeSend(
        signal,
        "failed",
        "",
        rawUploadState(state),
        "media_item_invalid",
      );
    } else if (attachment.complete !== undefined) {
      attachment.complete(signal, "failed", "", "media_item_invalid");
    }
    throw err;
  }
  const creds = bot.creds;
  if (creds === null) {
    if (attachment.completeSend !== undefined) {
      attachment.completeSend(
        signal,
        "failed",
        "",
        rawUploadState(state),
        "not_logged_in",
      );
    }
    throw new Error("not logged in");
  }
  let clientSeed = attachment.sendOperationID.trim();
  if (clientSeed === "") {
    clientSeed = attachment.id;
  }
  const clientID = stableClientID(clientSeed);
  state.client_id = clientID;
  const message = buildMediaMessage(
    creds.userId,
    attachment.targetID,
    attachment.replyContext,
    attachment.runID,
    clientID,
    item,
  );
  try {
    await sendMessage(bot.client, signal, creds.baseUrl, creds.token, message);
  } catch (err) {
    const status = wechatSendFailureStatus(err);
    if (attachment.completeSend !== undefined) {
      attachment.completeSend(
        signal,
        status,
        clientID,
        rawUploadState(state),
        wechatErrorCode(err),
      );
    } else if (attachment.complete !== undefined) {
      attachment.complete(
        signal,
        status,
        clientID,
        wechatErrorCode(err),
      );
    }
    throw err;
  }
  if (attachment.completeSend !== undefined) {
    attachment.completeSend(
      signal,
      "delivered",
      clientID,
      rawUploadState(state),
      "",
    );
  } else if (attachment.complete !== undefined) {
    attachment.complete(signal, "delivered", clientID, "");
  }
}

/**
 * executeWechatDurableDelivery replays one Runtime-owned outbox operation after
 * a process restart. The operation is already claimed by the Runtime worker;
 * this function only performs the iLink call and returns the next checkpoint.
 */
export async function executeWechatDurableDelivery(
  bot: Bot,
  signal: AbortSignal,
  request: DurableDeliveryRequest,
): Promise<DurableDeliveryResult> {
  const emptyResult: DurableDeliveryResult = {
    status: "",
    providerAssetID: "",
    providerMessageID: "",
    providerState: new Uint8Array(),
    failureCode: "",
  };
  if (bot === null || bot.client === null) {
    throw new Error("wechat media bot is not configured");
  }
  const creds = bot.creds;
  if (creds === null) {
    return {
      ...emptyResult,
      status: "retry_wait",
      failureCode: "not_logged_in",
    };
  }

  switch (request.operation.operationKind) {
    case "send_text":
    case "send_fallback_text": {
      if (request.caption.trim() === "") {
        return {
          ...emptyResult,
          status: "failed",
          failureCode: "delivery_caption_missing",
        };
      }
      const clientID = stableClientID(request.operation.idempotencyKey);
      const message = buildTextMessageWithClientID(
        creds.userId,
        request.intent.targetId,
        wechatReplyContext(request.intent.transportContext),
        request.caption,
        clientID,
      );
      try {
        await sendMessage(
          bot.client,
          signal,
          creds.baseUrl,
          creds.token,
          message,
        );
      } catch (err) {
        return {
          ...emptyResult,
          status: wechatSendFailureStatus(err),
          providerMessageID: clientID,
          failureCode: wechatErrorCode(err),
        };
      }
      return {
        ...emptyResult,
        status: "delivered",
        providerMessageID: clientID,
      };
    }

    case "upload_artifact": {
      const kind = request.artifactKind;
      if (
        kind !== AttachmentImage &&
        kind !== AttachmentVideo &&
        kind !== AttachmentFile
      ) {
        return {
          ...emptyResult,
          status: "failed",
          failureCode: "unsupported_media_kind",
        };
      }
      const attachment: OutboundAttachment = {
        id: request.operation.artifactId,
        runID: request.intent.runId,
        targetID: request.intent.targetId,
        replyContext: "",
        uploadOperationID: request.operation.id,
        sendOperationID: "",
        providerAssetID: "",
        providerState: coerceUint8(request.operation.providerState),
        kind,
        filename: request.artifactFilename,
        mediaType: request.artifactMediaType,
        open: request.openArtifact,
      };
      try {
        const state = await uploadMediaAttachment(bot, signal, attachment);
        return {
          ...emptyResult,
          status: "uploaded",
          providerAssetID: state.filekey,
          providerState: new TextEncoder().encode(rawUploadState(state)),
        };
      } catch (err) {
        const state = parseWechatUploadState(request.operation.providerState);
        return {
          ...emptyResult,
          status: wechatUploadFailureStatus(err),
          providerAssetID: state.filekey,
          providerState: new TextEncoder().encode(rawUploadState(state)),
          failureCode: wechatErrorCode(err),
        };
      }
    }

    case "send_artifact": {
      if (request.dependency === undefined) {
        return {
          ...emptyResult,
          status: "failed",
          failureCode: "delivery_dependency_missing",
        };
      }
      const state = parseWechatUploadState(request.dependency.providerState);
      if (state.encrypt_query_param === "") {
        return {
          ...emptyResult,
          status: "retry_wait",
          providerState: new TextEncoder().encode(rawUploadState(state)),
          failureCode: "wechat_upload_checkpoint_missing",
        };
      }
      let item;
      try {
        item = buildMediaItem(
          wechatItemType(request.artifactKind),
          state,
          request.artifactFilename,
        );
      } catch {
        return {
          ...emptyResult,
          status: "failed",
          providerState: new TextEncoder().encode(rawUploadState(state)),
          failureCode: "media_item_invalid",
        };
      }
      const clientID = stableClientID(request.operation.idempotencyKey);
      const message = buildMediaMessage(
        creds.userId,
        request.intent.targetId,
        wechatReplyContext(request.intent.transportContext),
        request.intent.runId,
        clientID,
        item,
      );
      try {
        await sendMessage(
          bot.client,
          signal,
          creds.baseUrl,
          creds.token,
          message,
        );
      } catch (err) {
        return {
          ...emptyResult,
          status: wechatSendFailureStatus(err),
          providerMessageID: clientID,
          providerState: new TextEncoder().encode(rawUploadState(state)),
          failureCode: wechatErrorCode(err),
        };
      }
      state.client_id = clientID;
      return {
        ...emptyResult,
        status: "delivered",
        providerMessageID: clientID,
        providerState: new TextEncoder().encode(rawUploadState(state)),
      };
    }

    default:
      return {
        ...emptyResult,
        status: "failed",
        failureCode: "unsupported_delivery_operation",
      };
  }
}

function coerceUint8(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw);
  }
  if (raw !== null && raw !== undefined && typeof raw === "object") {
    try {
      return new TextEncoder().encode(JSON.stringify(raw));
    } catch {
      return new Uint8Array();
    }
  }
  return new Uint8Array();
}

function wechatReplyContext(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "object" && !(raw instanceof Uint8Array)) {
    const ctx = (raw as { replyContext?: unknown }).replyContext;
    return typeof ctx === "string" ? ctx : "";
  }
  let text: string;
  if (raw instanceof Uint8Array) {
    try {
      text = new TextDecoder().decode(raw);
    } catch {
      return "";
    }
  } else if (typeof raw === "string") {
    text = raw;
  } else {
    return "";
  }
  if (text.trim() === "") {
    return "";
  }
  try {
    const transport = JSON.parse(text) as { replyContext?: unknown };
    return typeof transport.replyContext === "string"
      ? transport.replyContext
      : "";
  } catch {
    return "";
  }
}

async function readAllLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
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
      total += value.length;
      if (total > limit) {
        throw new Error(`WeChat artifact exceeds ${limit}-byte adapter bound`);
      }
      chunks.push(value);
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

async function uploadMediaAttachment(
  bot: Bot,
  signal: AbortSignal,
  attachment: OutboundAttachment,
): Promise<WechatUploadState> {
  const state = parseWechatUploadState(attachment.providerState);
  if (state.filekey === "") {
    let seed = attachment.uploadOperationID.trim();
    if (seed === "") {
      seed = attachment.id;
    }
    state.filekey = stableFileKey(seed);
  }
  if (attachment.open === undefined) {
    throw new Error(`WeChat attachment ${attachment.id} is not readable`);
  }
  const stream = await attachment.open(signal);
  const plaintext = await readAllLimited(stream, maxOutboundMediaBytes + 1);
  if (plaintext.length > maxOutboundMediaBytes) {
    throw new Error(
      `WeChat artifact exceeds ${maxOutboundMediaBytes}-byte adapter bound`,
    );
  }
  state.rawsize = plaintext.length;
  state.filesize = (Math.floor(plaintext.length / 16) + 1) * 16;
  if (state.aeskey === "") {
    state.aeskey = encodeHex(generateAESKey());
  }
  const key = decodeAESKey(state.aeskey);
  if (attachment.progressUpload !== undefined) {
    attachment.progressUpload(
      signal,
      "uploading",
      state.filekey,
      rawUploadState(state),
      "",
    );
  }
  if (state.encrypt_query_param === "") {
    const checksum = createHash("md5").update(plaintext).digest("hex");
    const request: GetUploadURLRequest = {
      filekey: state.filekey,
      media_type: wechatUploadType(attachment.kind),
      to_user_id: attachment.targetID,
      rawsize: state.rawsize,
      rawfilemd5: checksum,
      filesize: state.filesize,
      no_need_thumb: true,
      aeskey: state.aeskey,
    };
    const creds = bot.creds;
    if (creds === null) {
      throw new Error("not logged in");
    }
    if (
      (state.upload_param ?? "") === "" && (state.upload_full_url ?? "") === ""
    ) {
      const response = await getUploadURL(
        bot.client,
        signal,
        creds.baseUrl,
        creds.token,
        request,
      );
      state.upload_param = (response.upload_param ?? "").trim();
      state.upload_full_url = (response.upload_full_url ?? "").trim();
      if (
        (state.upload_param ?? "") === "" &&
        (state.upload_full_url ?? "") === ""
      ) {
        throw new Error("getuploadurl returned no upload URL");
      }
      if (attachment.progressUpload !== undefined) {
        attachment.progressUpload(
          signal,
          "uploading",
          state.filekey,
          rawUploadState(state),
          "",
        );
      }
    }
    const param = await uploadCDN(
      bot.client,
      signal,
      state.upload_full_url ?? "",
      state.upload_param ?? "",
      state.filekey,
      plaintext,
      key,
    );
    state.encrypt_query_param = param;
  }
  return state;
}

/** wechatItemType maps an attachment kind to the iLink message item type. */
export function wechatItemType(kind: AttachmentKind): number {
  switch (kind) {
    case AttachmentImage:
      return ItemImage;
    case AttachmentVideo:
      return ItemVideo;
    default:
      return ItemFile;
  }
}

/** wechatUploadType maps an attachment kind to the getuploadurl media type. */
export function wechatUploadType(kind: AttachmentKind): number {
  switch (kind) {
    case AttachmentImage:
      return 1; // UploadMediaImage
    case AttachmentVideo:
      return 2; // UploadMediaVideo
    default:
      return 3; // UploadMediaFile
  }
}

/** stableFileKey derives a deterministic iLink file key from an operation ID. */
export function stableFileKey(operationID: string): string {
  const digest = createHash("sha256").update(operationID.trim()).digest();
  return digest.subarray(0, 16).toString("hex");
}

/** wechatUploadFailureStatus mirrors the Go upload failure classification. */
export function wechatUploadFailureStatus(err: unknown): string {
  if (
    err instanceof APIError && err.httpStatus >= 400 && err.httpStatus < 500 &&
    err.httpStatus !== 429
  ) {
    return "failed";
  }
  return "retry_wait";
}

/** wechatSendFailureStatus mirrors the Go send failure classification. */
export function wechatSendFailureStatus(err: unknown): string {
  if (
    err instanceof APIError && err.httpStatus >= 400 && err.httpStatus < 500
  ) {
    return "failed";
  }
  // A timeout or connection loss after sendmessage may have delivered the
  // message; the Runtime must diagnose it instead of blindly retrying.
  return "uncertain";
}

/** wechatErrorCode maps an error to a stable iLink failure code. */
export function wechatErrorCode(err: unknown): string {
  if (err === null || err === undefined) {
    return "";
  }
  if (err instanceof APIError && err.errCode !== 0) {
    return `ilink_${err.errCode}`;
  }
  return "transport_error";
}
