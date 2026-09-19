// Ported from internal/messaging/wechat/protocol.go

import { createHash } from "node:crypto";

import { current as currentVersion } from "../../version/version.ts";
import { encodeHex, encryptAESECB } from "./crypto.ts";
import {
  APIError,
  type GetConfigResponse,
  type GetUpdatesResponse,
  type GetUploadURLRequest,
  type GetUploadURLResponse,
  ItemFile,
  ItemImage,
  ItemVideo,
  type MessageItem,
  type QRCodeResponse,
  type QRStatusResponse,
} from "./types.ts";

export const DefaultBaseURL = "https://ilinkai.weixin.qq.com";
export const CDNBaseURL = "https://novac2c.cdn.weixin.qq.com/c2c";
const iLinkAppID = "bot";

const maxAPIResponseBytes = 1 << 20;
export const defaultLongPollTimeout = 35 * 1000;
const defaultAPITimeout = 15 * 1000;
export const defaultNotificationTimeout = 10 * 1000;

/**
 * fallbackILinkClientVersion is the encoded form of 0.1.0. It is only used by
 * source builds that do not carry a semver build version; iLink rejects an
 * empty or zero client-version header.
 */
const fallbackILinkClientVersion = 0x00000100;

/** A fetch seam replacing Go's *http.Client. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Client wraps HTTP calls to the iLink API. */
export class Client {
  fetchFn: FetchLike;

  constructor(fetchFn?: FetchLike) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }
}

/** CommonHeaders returns headers for iLink API requests. */
export function commonHeaders(): Headers {
  const h = new Headers();
  h.set("iLink-App-Id", iLinkAppID);
  h.set("iLink-App-ClientVersion", String(iLinkClientVersion()));
  return h;
}

/** AuthHeaders returns the standard iLink POST headers. */
export function authHeaders(token: string): Headers {
  const h = commonHeaders();
  h.set("Content-Type", "application/json");
  h.set("AuthorizationType", "ilink_bot_token");
  h.set("Authorization", "Bearer " + token);
  h.set("X-WECHAT-UIN", randomWechatUIN());
  return h;
}

function randomWechatUIN(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const view = new DataView(buf.buffer);
  const val = view.getUint32(0, false);
  return base64Encode(new TextEncoder().encode(String(val)));
}

function base64Encode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function baseInfo(): Record<string, string> {
  return {
    channel_version: channelVersion(),
    bot_agent: botAgent(),
  };
}

function channelVersion(): string {
  const version = currentVersion().trim();
  if (version !== "" && version !== "unknown") {
    return version;
  }
  return "0.1.0";
}

function botAgent(): string {
  const version = semverComponents(channelVersion());
  if (version !== null) {
    return `MothX/${version[0]}.${version[1]}.${version[2]}`;
  }
  return "MothX";
}

function iLinkClientVersion(): number {
  const version = semverComponents(channelVersion());
  if (version === null) {
    return fallbackILinkClientVersion;
  }
  return ((version[0] & 0xff) << 16) | ((version[1] & 0xff) << 8) |
    (version[2] & 0xff);
}

/**
 * semverComponents extracts the three numeric components iLink encodes into
 * iLink-App-ClientVersion. It accepts release strings such as v1.2.3 and
 * v1.2.3-rc.1 but deliberately rejects source-build hashes.
 */
export function semverComponents(
  version: string,
): [number, number, number] | null {
  let value = version.trim();
  if (value.startsWith("v")) {
    value = value.slice(1);
  }
  const suffix = value.indexOf("-");
  if (suffix >= 0) {
    value = value.slice(0, suffix);
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const result: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === "") {
      return null;
    }
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (num < 0 || num > 0xff) {
      return null;
    }
    result[index] = num;
  }
  return result;
}

/** GetQRCode requests a new QR code for login. */
export async function getQRCode(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
): Promise<QRCodeResponse> {
  const u = endpointURL(baseURL, "/ilink/bot/get_bot_qrcode?bot_type=3");
  const headers = commonHeaders();
  const res = await client.fetchFn(u, { signal, headers });
  return JSON.parse(await textLoose(res)) as QRCodeResponse;
}

/** PollQRStatus polls the QR code scan status. */
export async function pollQRStatus(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const u = endpointURL(
    baseURL,
    "/ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode),
  );
  const headers = commonHeaders();
  const res = await client.fetchFn(u, { signal, headers });
  return JSON.parse(await textLoose(res)) as QRStatusResponse;
}

/** apiPost sends a POST to the iLink API and parses the response. */
export async function apiPost(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  endpoint: string,
  token: string,
  body: unknown,
  timeout: number,
): Promise<unknown> {
  const data = JSON.stringify(body);
  const u = endpointURL(baseURL, endpoint);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const res = await client.fetchFn(u, {
    method: "POST",
    headers: authHeaders(token),
    body: data,
    signal: requestSignal,
  });
  const raw = await readBounded(res, maxAPIResponseBytes);
  if (res.status >= 400) {
    throw new APIError(textDecode(raw), res.status, 0);
  }
  const parsed = JSON.parse(textDecode(raw)) as {
    ret?: number;
    errcode?: number;
    errmsg?: string;
  };
  const ret = parsed.ret ?? 0;
  const errCode = parsed.errcode ?? 0;
  if (ret !== 0 || errCode !== 0) {
    const code = errCode !== 0 ? errCode : ret;
    let msg = parsed.errmsg ?? "";
    if (msg === "") {
      msg = `ret=${ret}`;
    }
    throw new APIError(msg, res.status, code);
  }
  return parsed;
}

/**
 * GetUpdatesWithTimeout performs one iLink long-poll using the current
 * server-recommended timeout. A local timeout is an expected empty poll, not a
 * transport failure, so callers can retry it without exponential backoff.
 */
export async function getUpdatesWithTimeout(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
  cursor: string,
  timeout: number,
): Promise<GetUpdatesResponse> {
  const effective = timeout > 0 ? timeout : defaultLongPollTimeout;
  const body = {
    get_updates_buf: cursor,
    base_info: baseInfo(),
  };
  let raw: unknown;
  try {
    raw = await apiPost(
      client,
      signal,
      baseURL,
      "/ilink/bot/getupdates",
      token,
      body,
      effective,
    );
  } catch (err) {
    if (!signal.aborted && isTimeoutError(err)) {
      return { ret: 0, msgs: [], get_updates_buf: cursor };
    }
    throw err;
  }
  return raw as GetUpdatesResponse;
}

/** sendMessage sends a message through the iLink API. */
export async function sendMessage(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
  msg: unknown,
): Promise<void> {
  await apiPost(
    client,
    signal,
    baseURL,
    "/ilink/bot/sendmessage",
    token,
    { msg, base_info: baseInfo() },
    defaultAPITimeout,
  );
}

/** GetUploadURL asks iLink for the pre-signed CDN parameters. */
export async function getUploadURL(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
  request: GetUploadURLRequest,
): Promise<GetUploadURLResponse> {
  const raw = await apiPost(
    client,
    signal,
    baseURL,
    "/ilink/bot/getuploadurl",
    token,
    {
      filekey: request.filekey,
      media_type: request.media_type,
      to_user_id: request.to_user_id,
      rawsize: request.rawsize,
      rawfilemd5: request.rawfilemd5,
      filesize: request.filesize,
      thumb_rawsize: request.thumb_rawsize,
      thumb_rawfilemd5: request.thumb_rawfilemd5,
      thumb_filesize: request.thumb_filesize,
      no_need_thumb: request.no_need_thumb,
      aeskey: request.aeskey,
      base_info: baseInfo(),
    },
    defaultAPITimeout,
  );
  return raw as GetUploadURLResponse;
}

/**
 * UploadCDN encrypts one immutable artifact with AES-128-ECB and uploads it to
 * the iLink CDN. The returned header is the opaque download reference used by
 * the subsequent sendmessage operation.
 */
export async function uploadCDN(
  client: Client,
  signal: AbortSignal,
  uploadFullURL: string,
  uploadParam: string,
  fileKey: string,
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<string> {
  if (client === null || client.fetchFn === null) {
    throw new Error("wechat media client is not configured");
  }
  if (fileKey.trim() === "") {
    throw new Error("wechat CDN filekey is required");
  }
  const ciphertext = encryptAESECB(plaintext, key);
  const uploadURL = buildCDNUploadURL(uploadFullURL, uploadParam, fileKey);
  const requestSignal = withMediaTimeout(signal);
  const res = await client.fetchFn(uploadURL, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext as unknown as BodyInit,
    signal: requestSignal,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`wechat CDN upload: HTTP ${res.status}`);
  }
  const param = (res.headers.get("x-encrypted-param") ?? "").trim();
  if (param === "") {
    throw new Error("wechat CDN upload response missing x-encrypted-param");
  }
  return param;
}

/** buildCDNUploadURL mirrors buildCDNUploadURL. */
export function buildCDNUploadURL(
  uploadFullURL: string,
  uploadParam: string,
  fileKey: string,
): string {
  const full = uploadFullURL.trim();
  if (full !== "") {
    let parsed: URL;
    try {
      parsed = new URL(full);
    } catch {
      throw new Error("invalid WeChat CDN upload URL");
    }
    if (parsed.protocol !== "https:" || parsed.host === "") {
      throw new Error("invalid WeChat CDN upload URL");
    }
    return parsed.toString();
  }
  if (uploadParam.trim() === "") {
    throw new Error("wechat CDN upload parameters are missing");
  }
  return CDNBaseURL + "/upload?encrypted_query_param=" +
    encodeURIComponent(uploadParam) + "&filekey=" + encodeURIComponent(fileKey);
}

/** GetConfig gets the typing ticket for a user. */
export async function getConfig(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
  userID: string,
  contextToken: string,
): Promise<GetConfigResponse> {
  const raw = await apiPost(
    client,
    signal,
    baseURL,
    "/ilink/bot/getconfig",
    token,
    {
      ilink_user_id: userID,
      context_token: contextToken,
      base_info: baseInfo(),
    },
    defaultAPITimeout,
  );
  return raw as GetConfigResponse;
}

/** SendTyping sends or cancels the typing indicator. */
export async function sendTyping(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
  userID: string,
  ticket: string,
  status: number,
): Promise<void> {
  await apiPost(
    client,
    signal,
    baseURL,
    "/ilink/bot/sendtyping",
    token,
    {
      ilink_user_id: userID,
      typing_ticket: ticket,
      status,
      base_info: baseInfo(),
    },
    defaultAPITimeout,
  );
}

/** NotifyStart tells iLink that this account's receive loop is online. */
export async function notifyStart(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
): Promise<void> {
  await apiPost(
    client,
    signal,
    baseURL,
    "/ilink/bot/msg/notifystart",
    token,
    { base_info: baseInfo() },
    defaultNotificationTimeout,
  );
}

/** NotifyStop tells iLink that this account's receive loop is offline. */
export async function notifyStop(
  client: Client,
  signal: AbortSignal,
  baseURL: string,
  token: string,
): Promise<void> {
  await apiPost(
    client,
    signal,
    baseURL,
    "/ilink/bot/msg/notifystop",
    token,
    { base_info: baseInfo() },
    defaultNotificationTimeout,
  );
}

function endpointURL(baseURL: string, endpoint: string): string {
  let base: URL;
  try {
    base = new URL(baseURL.trim());
  } catch {
    throw new Error("invalid iLink base URL: missing scheme or host");
  }
  if (base.protocol === "" || base.host === "") {
    throw new Error("invalid iLink base URL: missing scheme or host");
  }
  const path = new URL(endpoint, "https://placeholder.invalid");
  base.pathname = base.pathname.replace(/\/+$/, "") + "/" +
    path.pathname.replace(/^\/+/, "");
  base.search = path.search;
  return base.toString();
}

/** BuildTextMessage creates a text message payload. */
export function buildTextMessage(
  fromUserID: string,
  toUserID: string,
  contextToken: string,
  text: string,
): Record<string, unknown> {
  return buildTextMessageWithClientID(
    fromUserID,
    toUserID,
    contextToken,
    text,
    newUUID(),
  );
}

/**
 * BuildTextMessageWithClientID builds a text payload with a caller-owned
 * idempotency/client ID. Runtime delivery operations use this form so retrying
 * a caption does not mint a new provider identity.
 */
export function buildTextMessageWithClientID(
  fromUserID: string,
  toUserID: string,
  contextToken: string,
  text: string,
  clientID: string,
): Record<string, unknown> {
  let id = clientID.trim();
  if (id === "") {
    id = newUUID();
  }
  return {
    from_user_id: fromUserID,
    to_user_id: toUserID,
    client_id: id,
    message_type: 2,
    message_state: 2,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

/**
 * UploadedMedia is the provider state needed to construct a media item after
 * CDN upload. AESKeyHex is encoded as base64(hex) in the wire item, matching
 * the 2.4.6 package.
 */
export interface UploadedMedia {
  filekey: string;
  encrypt_query_param: string;
  aeskey: string;
  rawsize: number;
  filesize: number;
}

/**
 * BuildMediaItem builds the single-item image/video/file payload used by iLink
 * sendmessage. Voice is intentionally excluded from outbound support.
 */
export function buildMediaItem(
  kind: number,
  uploaded: UploadedMedia,
  filename: string,
): MessageItem {
  if (
    uploaded.encrypt_query_param.trim() === "" || uploaded.aeskey.trim() === ""
  ) {
    throw new Error("wechat media provider state is incomplete");
  }
  const media = {
    encrypt_query_param: uploaded.encrypt_query_param,
    aes_key: encodeAESKeyBase64FromHex(uploaded.aeskey),
    encrypt_type: 1,
  };
  switch (kind) {
    case ItemImage:
      return {
        type: ItemImage,
        image_item: { media, mid_size: uploaded.filesize },
      };
    case ItemVideo:
      return {
        type: ItemVideo,
        video_item: {
          media,
          file_name: filename,
          video_size: uploaded.filesize,
        },
      };
    case ItemFile:
      return {
        type: ItemFile,
        file_item: {
          media,
          file_name: filename,
          len: String(uploaded.rawsize),
        },
      };
    default:
      throw new Error(`unsupported outbound WeChat media kind ${kind}`);
  }
}

/** BuildMediaMessage wraps one media item in the bot's structured message. */
export function buildMediaMessage(
  fromUserID: string,
  toUserID: string,
  contextToken: string,
  runID: string,
  clientID: string,
  item: MessageItem,
): Record<string, unknown> {
  return {
    from_user_id: fromUserID,
    to_user_id: toUserID,
    client_id: clientID.trim(),
    message_type: 2,
    message_state: 2,
    context_token: contextToken,
    run_id: runID,
    item_list: [item],
  };
}

/**
 * EncodeAESKeyBase64FromHex encodes the provider's hex key in the CDNMedia
 * representation used by the locked Tencent package.
 */
export function encodeAESKeyBase64FromHex(hexKey: string): string {
  return base64Encode(new TextEncoder().encode(hexKey.trim()));
}

/**
 * StableClientID maps a Runtime operation ID to a UUID-shaped stable provider
 * client ID. It is deterministic across retries and process restarts.
 */
export function stableClientID(operationID: string): string {
  const digest = sha256Bytes(new TextEncoder().encode(operationID.trim()));
  const buf = digest.slice(0, 16);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  return formatUUID(buf);
}

function newUUID(): string {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  return formatUUID(buf);
}

function formatUUID(buf: Uint8Array): string {
  const hex = encodeHex(buf);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  // Deno's crypto.subtle is async; node:crypto gives the sync digest this port
  // needs to stay close to Go's sha256.Sum256.
  const hash = createHash("sha256");
  hash.update(data);
  return new Uint8Array(hash.digest());
}

/** withMediaTimeout mirrors withMediaTimeout from media.go. */
export function withMediaTimeout(signal: AbortSignal): AbortSignal {
  if (signal.aborted) {
    return signal;
  }
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(wechatMediaDownloadTimeout),
  ]);
}

/** wechatMediaDownloadTimeout matches wechatMediaDownloadTimeout (1 minute). */
export const wechatMediaDownloadTimeout = 60 * 1000;

/** isTimeoutError reports whether err is an AbortSignal.timeout failure. */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

async function readBounded(
  res: Response,
  limit: number,
): Promise<Uint8Array> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > limit ? buf.slice(0, limit) : buf;
}

async function textLoose(res: Response): Promise<string> {
  return await res.text();
}

function textDecode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}
