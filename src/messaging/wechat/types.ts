// Ported from internal/messaging/wechat/types.go
//
// Package wechat implements the WeChat iLink Bot messaging platform adapter.
// iLink media compatibility follows the locked Tencent npm release and local
// protocol fixtures. Zero external dependencies - uses only the runtime's
// standard library.

/** MessageType indicates who sent the message. */
export const MessageTypeUser = 1;
export const MessageTypeBot = 2;

/** MessageItemType indicates the content type. */
export const ItemText = 1;
export const ItemImage = 2;
export const ItemVoice = 3;
export const ItemFile = 4;
export const ItemVideo = 5;

/** UploadMediaType is the iLink getuploadurl media discriminator. */
export const UploadMediaImage = 1;
export const UploadMediaVideo = 2;
export const UploadMediaFile = 3;
export const UploadMediaVoice = 4;

/** WireMessage is the raw message from the iLink API. */
export interface WireMessage {
  seq?: number;
  message_id?: number;
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  create_time_ms: number;
  message_type: number;
  context_token: string;
  item_list?: MessageItem[];
}

/** MessageItem is a single content item within a message. */
export interface MessageItem {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}

/** TextItem holds text content. */
export interface TextItem {
  text: string;
}

/**
 * CDNMedia is the opaque WeChat CDN reference returned in a media message. The
 * reference and AES key only live in the transport closure that downloads the
 * content; neither is persisted as an Agent input or exposed to users.
 *
 * iLink has no public protocol document for these fields. Their layout follows
 * the locked Tencent release and is covered by fixture tests in this package.
 */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

/**
 * ImageItem describes one inbound image. aeskey is a direct hexadecimal AES-128
 * key that takes precedence over media.aes_key when present.
 */
export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  hd_size?: number;
}

/**
 * VoiceItem describes an inbound voice message. The CDN media fields are
 * intentionally opaque and are consumed only by the transport open closure.
 */
export interface VoiceItem {
  media?: CDNMedia;
  file_name?: string;
  duration?: number;
}

/**
 * FileItem describes one inbound file. len is supplied as a decimal string by
 * observed iLink implementations and is only a hint for Runtime limits.
 */
export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

/** VideoItem describes an inbound video message. */
export interface VideoItem {
  media?: CDNMedia;
  file_name?: string;
  duration?: number;
  video_size?: number;
}

/**
 * RefMessage is the optional quoted-message envelope used by iLink. Different
 * clients have emitted either one nested message_item or an item_list; both are
 * accepted and normalized by the transport adapter.
 */
export interface RefMessage {
  message_item?: MessageItem;
  item_list?: MessageItem[];
}

/** QRCodeResponse from get_bot_qrcode. */
export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/** QRStatusResponse from get_qrcode_status. */
export interface QRStatusResponse {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

/** GetUpdatesResponse from getupdates. */
export interface GetUpdatesResponse {
  ret: number;
  msgs: unknown[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
  errcode?: number;
  errmsg?: string;
}

/** GetConfigResponse from getconfig. */
export interface GetConfigResponse {
  typing_ticket?: string;
}

/**
 * GetUploadURLRequest contains the plaintext/ciphertext metadata required by
 * iLink before a CDN upload. Thumbnail fields are optional when no_need_thumb
 * is true, which is the behavior used by the locked 2.4.6 package.
 */
export interface GetUploadURLRequest {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

/** GetUploadURLResponse is the pre-signed CDN upload response. */
export interface GetUploadURLResponse {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

/** Credentials holds login credentials. */
export interface Credentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  getUpdatesBuf?: string;
  savedAt?: string;
}

/** IncomingMessage is a parsed incoming user message. */
export interface IncomingMessage {
  userID: string;
  text: string;
  timestamp: Date;
  contextToken: string;
}

/** APIError is returned when the iLink API returns a non-zero ret or HTTP error. */
export class APIError extends Error {
  readonly httpStatus: number;
  readonly errCode: number;

  constructor(message: string, httpStatus: number, errCode: number) {
    super(
      `ilink api: ${message} (http=${httpStatus}, errcode=${errCode})`,
    );
    this.name = "APIError";
    this.httpStatus = httpStatus;
    this.errCode = errCode;
  }

  /** isSessionExpired returns true if this error indicates session timeout. */
  isSessionExpired(): boolean {
    return this.errCode === -14;
  }
}
