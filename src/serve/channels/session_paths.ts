// Ported from internal/serve/channels/dispatcher.go — the pure session-path
// and key helpers shared by the channel dispatcher and its tests.
//
// Deviation: Go's filepath.Join maps to @std/path join; base64 uses the
// standard URL-safe alphabet without padding (RawURLEncoding).

import { join } from "@std/path";

/**
 * safeSessionPathComponent maps an arbitrary platform/user value to a single
 * filesystem-safe path component. Values containing anything outside
 * [A-Za-z0-9-_@.] (and the degenerate "", ".", "..") are base64-url encoded
 * behind a `b64_` marker so a hostile identity cannot traverse out of the
 * channels session root.
 */
export function safeSessionPathComponent(s: string): string {
  if (s === "" || s === "." || s === "..") {
    return "b64_" + base64UrlEncode(s);
  }
  for (const r of s) {
    if (/[a-zA-Z0-9]/.test(r)) {
      continue;
    }
    switch (r) {
      case "-":
      case "_":
      case ".":
      case "@":
        continue;
      default:
        return "b64_" + base64UrlEncode(s);
    }
  }
  return s;
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** sessionKey builds a session pool key. */
export function sessionKey(platform: string, userID: string): string {
  return `channels/${platform}/${userID}`;
}

/**
 * channelRouteID returns the stable conversation identity used for channel
 * sessions and outbound delivery. Feishu provides both an open_id (sender)
 * and a chat_id (conversation); bindings must use the latter because the
 * Feishu API sends with receive_id_type=chat_id. WeChat currently uses the
 * same value for both fields, and other transports retain their user ID.
 */
export function channelRouteID(
  msg: { platform: string; chatID: string; userID: string },
): string {
  if ((msg.platform === "feishu" || msg.platform === "wechat") && msg.chatID) {
    return msg.chatID;
  }
  return msg.userID;
}

/** Builds the per-channel-user session directory under the session root. */
export function channelSessionDir(
  sessionDir: string,
  platform: string,
  userID: string,
): string {
  return join(
    sessionDir,
    "channels",
    safeSessionPathComponent(platform),
    safeSessionPathComponent(userID),
  );
}
