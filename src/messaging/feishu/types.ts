// Event types for the Feishu im/v1 message receive/read events. These replace
// the larksuite/oapi-sdk-go generated `larkim` event structs with the same JSON
// shape (documented deviation: the Feishu SDK is replaced by raw HTTP + Deno
// WebSocket).

/** FeishuUserId mirrors larkim.UserId (open_id/user_id/union_id). */
export interface FeishuUserId {
  user_id?: string;
  open_id?: string;
  union_id?: string;
}

/** FeishuEventSender mirrors larkim.EventSender. */
export interface FeishuEventSender {
  sender_id?: FeishuUserId;
  sender_type?: string;
  tenant_key?: string;
}

/** FeishuEventMessage mirrors the subset of larkim.EventMessage the adapter uses. */
export interface FeishuEventMessage {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  update_time?: string;
  chat_id?: string;
  message_type?: string;
  content?: string;
}

/** FeishuMessageReceiveV1Data mirrors larkim.P2MessageReceiveV1Data. */
export interface FeishuMessageReceiveV1Data {
  sender?: FeishuEventSender;
  message?: FeishuEventMessage;
}

/**
 * FeishuMessageReceiveV1 mirrors larkim.P2MessageReceiveV1: the event envelope
 * (`header`/`event`) with the typed `event` body.
 */
export interface FeishuMessageReceiveV1 {
  schema?: string;
  header?: { event_type?: string; event_id?: string };
  event?: FeishuMessageReceiveV1Data;
}
