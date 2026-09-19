// Ported from internal/messaging/platform.go
//
// Package messaging defines the messaging platform abstraction for serve
// channels. Each platform (WeChat, Feishu, etc.) implements the Platform
// interface.

import type { DeliveryIntent, DeliveryOperation } from "../session/mod.ts";

/**
 * Platform defines the interface that all messaging platform adapters must
 * implement.
 */
export interface Platform {
  /** Name returns the platform identifier (e.g. "wechat", "feishu"). */
  name(): string;
  /**
   * Start begins receiving messages. Resolves when the signal is aborted or
   * stop is called.
   */
  start(signal: AbortSignal, handler: MessageHandler): Promise<void>;
  /** Stop gracefully shuts down the platform connection. */
  stop(): Promise<void> | void;
  /** SendMessage sends a text message to a specific chat. */
  sendMessage(signal: AbortSignal, chatID: string, text: string): Promise<void>;
  /** IsConnected reports whether the platform is currently connected. */
  isConnected(): boolean;
}

/**
 * Readiness is implemented by transports that can distinguish successful
 * startup from the long-running receive loop. Serve uses it during hot
 * replacement so a failed candidate never takes down the healthy instance.
 * Implementations that do not expose readiness retain the legacy immediate
 * promotion behavior.
 */
export interface Readiness {
  ready(): Promise<void>;
}

/**
 * MessageHandler is called for each incoming message. Its result is a
 * platform-neutral delivery projection: transports render the text and, when
 * their capability permits, execute its opaque media operations.
 */
export type MessageHandler = (
  signal: AbortSignal,
  msg: InboundMessage,
) => Promise<MessageResponse>;

/**
 * MessageResponse is a transport projection of one canonical Agent result.
 * Text remains available to every platform; Attachments carry no local path or
 * provider reference and can only be opened through Runtime-supplied closures.
 */
export interface MessageResponse {
  text: string;
  textDelivery?: OutboundText;
  /**
   * TextDeliveries is the ordered Runtime projection for caption and fallback
   * operations. TextDelivery remains the first-operation compatibility field
   * for older embedders.
   */
  textDeliveries?: OutboundText[];
  attachments?: OutboundAttachment[];
}

/**
 * OutboundText is the Runtime-owned caption/fallback operation projected to a
 * transport. Prepare claims its durable operation(s) before network I/O;
 * Complete reports the transport result through the Runtime fence.
 */
export interface OutboundText {
  id: string;
  runID: string;
  targetID: string;
  replyMessageID: string;
  replyContext: string;
  /**
   * Text is the exact payload for this durable operation. It lets a transport
   * preserve operation boundaries when MessageResponse.text is a compatibility
   * summary containing more than one text operation.
   */
  text: string;
  prepare?: (signal: AbortSignal) => Promise<void>;
  complete?: (
    signal: AbortSignal,
    status: string,
    providerMessageID: string,
    failureCode: string,
  ) => void;
}

/**
 * OutboundAttachment is an already-authorized media delivery operation. The
 * platform calls open only while delivering and reports the terminal outcome
 * through complete so the Runtime-owned delivery record stays canonical.
 */
export interface OutboundAttachment {
  id: string;
  runID: string;
  targetID: string;
  replyContext: string;
  uploadOperationID: string;
  sendOperationID: string;
  providerAssetID: string;
  providerState: Uint8Array;
  kind: AttachmentKind;
  filename: string;
  mediaType: string;
  prepare?: (signal: AbortSignal) => Promise<void>;
  /**
   * progressUpload persists provider state while the upload operation keeps its
   * lease. It is called before the next provider phase.
   */
  progressUpload?: (
    signal: AbortSignal,
    status: string,
    assetID: string,
    state: string,
    failureCode: string,
  ) => void;
  completeUpload?: (
    signal: AbortSignal,
    status: string,
    assetID: string,
    state: string,
    failureCode: string,
  ) => void;
  prepareSend?: (signal: AbortSignal) => Promise<void>;
  completeSend?: (
    signal: AbortSignal,
    status: string,
    providerMessageID: string,
    state: string,
    failureCode: string,
  ) => void;
  open?: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  /**
   * complete remains for transports that perform upload and send in one opaque
   * call. New staged transports should use the phase callbacks above.
   */
  complete?: (
    signal: AbortSignal,
    status: string,
    providerMessageID: string,
    failureCode: string,
  ) => void;
}

/**
 * DurableDeliveryRequest is the Runtime-owned durable outbox projection given
 * to a platform when a process restart or background worker replays one
 * operation. The platform receives only the frozen target/context and an
 * authorized artifact reader; it never opens the session database itself.
 */
export interface DurableDeliveryRequest {
  intent: DeliveryIntent;
  operation: DeliveryOperation;
  dependency?: DeliveryOperation;
  caption: string;
  artifactKind: AttachmentKind;
  artifactFilename: string;
  artifactMediaType: string;
  openArtifact?: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * DurableDeliveryResult is the transport result for one claimed operation.
 * providerState is an opaque checkpoint that the Runtime persists before the
 * next operation or retry. A send whose result is not trustworthy must return
 * uncertain so recovery does not blindly duplicate it.
 */
export interface DurableDeliveryResult {
  status: string;
  providerAssetID: string;
  providerMessageID: string;
  providerState: Uint8Array;
  failureCode: string;
  nextAttemptAt?: Date;
}

/**
 * DurableDeliveryExecutor is implemented by platforms with native durable
 * delivery support. It is deliberately separate from Platform so lightweight
 * or third-party adapters remain text-only without implementing recovery.
 */
export interface DurableDeliveryExecutor {
  executeDurableDelivery(
    signal: AbortSignal,
    request: DurableDeliveryRequest,
  ): Promise<DurableDeliveryResult>;
}

/**
 * StatusCallbackSetter is an optional interface platforms can implement to
 * receive connection status change notifications.
 */
export interface StatusCallbackSetter {
  setStatusCallback(callback: (connected: boolean) => void): void;
}

/** InboundMessage represents a message received from a messaging platform. */
export interface InboundMessage {
  /** "wechat", "feishu", etc. */
  platform: string;
  /** Conversation/chat identifier. */
  chatID: string;
  /** Sender user ID. */
  userID: string;
  /**
   * MessageID is an optional provider-native event/message identifier. It is
   * used only for durable background idempotency when a platform supplies one.
   */
  messageID: string;
  /** Sender display name. */
  userName: string;
  /** Message text content. */
  text: string;
  /** When the message was sent. */
  timestamp: Date;
  /**
   * Attachments contains opaque, platform-authenticated media references. The
   * channel dispatcher turns these into Runtime-owned attachments before any
   * Agent is constructed. Transport adapters must not put a public URL or
   * credential in reference.
   */
  attachments?: PlatformAttachment[];
  /**
   * ReplyContext is an opaque platform-owned value (for example WeChat's
   * context_token) captured at ingress and frozen by Runtime delivery plans.
   */
  replyContext: string;

  /**
   * ProgressFunc is called to send intermediate progress updates during agent
   * execution. If undefined, no progress updates are sent.
   */
  progressFunc?: (text: string) => void;
}

/**
 * AttachmentKind identifies the media class exposed by a transport. It stays
 * transport-neutral and is converted to agentruntime.AttachmentKind only at the
 * shared Runtime boundary.
 */
export type AttachmentKind = "image" | "file" | "audio" | "video";

export const AttachmentImage: AttachmentKind = "image";
export const AttachmentFile: AttachmentKind = "file";
export const AttachmentAudio: AttachmentKind = "audio";
export const AttachmentVideo: AttachmentKind = "video";

/**
 * AttachmentStream is a one-shot authenticated download supplied by a
 * transport adapter. The Runtime owns copying it into its private session
 * store and cancels reader after use.
 */
export interface AttachmentStream {
  reader: ReadableStream<Uint8Array>;
  filename: string;
  mediaType: string;
  contentSize: number;
}

/**
 * PlatformAttachment is an inbound transport reference, not a persisted
 * attachment or provider input. open must authenticate against the platform's
 * own API and may only use the opaque reference from the event that created
 * this value.
 */
export interface PlatformAttachment {
  reference: string;
  kind: AttachmentKind;
  filename: string;
  mediaType: string;
  sizeHint: number;
  messageID: string;
  open: (signal: AbortSignal) => Promise<AttachmentStream>;
}
