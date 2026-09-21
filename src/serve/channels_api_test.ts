// Translated from the wechat-login portions of internal/serve's lifecycle HTTP
// tests (channels_api.go ships no dedicated test file; its QR decode/projection
// helpers are covered here, and the login handler surface over a null runtime).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CookieJar,
  decodeInlineQR,
  decodeQRDataURL,
  detectContentType,
  errorString,
  handleWechatLogin,
  handleWechatLoginQR,
  isHTMLResponse,
  qrOpenURL,
  resolveQRCodeImageURL,
  WechatLoginSession,
  wechatLoginSnapshot,
  type WechatLoginStatus,
} from "./channels_api.ts";
import { ChannelRuntime } from "./channel_runtime.ts";
import { decodeConfigBytes } from "./config_state.ts";
import { extractQRCodeImageURL } from "./channels_api.ts";
import { newIdentityLocks } from "../session/mod.ts";

function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    1,
    2,
    3,
  ]);
}

function newRuntime(): ChannelRuntime {
  return new ChannelRuntime({
    cfg: decodeConfigBytes(
      JSON.stringify({ channels: { wechat: { enabled: false } } }),
    ),
    version: "test",
    dispatcher: null,
    sessionDir: Deno.makeTempDirSync(),
    identityMux: newIdentityLocks(),
    cronStore: null,
  });
}

Deno.test("errorString renders errors and empty values", () => {
  assertEquals(errorString(null), "");
  assertEquals(errorString(undefined), "");
  assertEquals(errorString(new Error("boom")), "boom");
  assertEquals(errorString("plain"), "plain");
});

Deno.test("wechatLoginSession tracks phases, QR projection, and cancellation", () => {
  const idle: WechatLoginStatus = WechatLoginSession.idle(true);
  assertEquals(idle, { state: "idle", enabled: true, loggedIn: false });

  const sess = new WechatLoginSession();
  assert(sess.active(), "a fresh session is active");
  sess.update("pending", () => {
    sess.qrURL = "https://example.org/qr.png";
  });
  const view = sess.snapshot(true);
  assertEquals(view.state, "pending");
  assertEquals(view.enabled, true);
  assertEquals(view.loggedIn, false);
  assertEquals(
    view.qrUrl?.startsWith("/api/channels/wechat/login/qr?ts="),
    true,
  );
  assertEquals(view.qrOpenUrl, "https://example.org/qr.png");
  assert(view.startedAt !== undefined);
  assert(view.updatedAt !== undefined);

  sess.update("confirmed", () => {
    sess.userID = "wx-user";
    sess.err = "";
  });
  const confirmed = sess.snapshot(true);
  assertEquals(confirmed.loggedIn, true);
  assertEquals(confirmed.userId, "wx-user");
  assert(!sess.active(), "a confirmed session is inactive");

  const cancelled = new WechatLoginSession();
  cancelled.cancelLogin();
  assertEquals(cancelled.state, "cancelled");
  assert(!cancelled.active());
});

Deno.test("qrOpenURL normalizes every supported QR source", () => {
  assertEquals(qrOpenURL("", "/proxy"), "/proxy");
  assertEquals(qrOpenURL("//host/qr", "/proxy"), "https://host/qr");
  assertEquals(qrOpenURL("http://host/qr", "/proxy"), "http://host/qr");
  assertEquals(
    qrOpenURL("data:image/png;base64,AAA", "/proxy"),
    "data:image/png;base64,AAA",
  );
  const png = pngBytes();
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  const raw = btoa(binary);
  assertEquals(qrOpenURL(raw, "/proxy"), `data:image/png;base64,${raw}`);
  assertEquals(qrOpenURL("not-base64!!!", "/proxy"), "/proxy");
});

Deno.test("decodeInlineQR and decodeQRDataURL handle data URLs and errors", () => {
  const png = pngBytes();
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);

  const [inlineData, inlineType] = decodeInlineQR(
    `data:image/svg+xml;base64,${encoded}`,
  );
  assertEquals(inlineType, "image/svg+xml");
  assertEquals(inlineData, png);

  const [plainData, plainType] = decodeInlineQR(encoded);
  assertEquals(plainType, "image/png");
  assertEquals(plainData, png);

  assertThrows(
    () => decodeInlineQR("data:noseparator"),
    Error,
    "invalid QR data URL",
  );

  const [qrData, qrType] = decodeQRDataURL(`data:image/jpeg;base64,${encoded}`);
  assertEquals(qrType, "image/jpeg");
  assertEquals(qrData, png);
});

Deno.test("detectContentType sniffs the QR content types", () => {
  assertEquals(detectContentType(pngBytes()), "image/png");
  assertEquals(
    detectContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assertEquals(
    detectContentType(new TextEncoder().encode("GIF89a")),
    "image/gif",
  );
  assertEquals(
    detectContentType(new TextEncoder().encode("<!doctype html><html>")),
    "text/html; charset=utf-8",
  );
  assertEquals(
    detectContentType(new TextEncoder().encode("<svg xmlns='...'>")),
    "image/svg+xml",
  );
  assertEquals(
    detectContentType(new Uint8Array([1, 2, 3])),
    "application/octet-stream",
  );
});

Deno.test("isHTMLResponse detects HTML by header or body sniffing", () => {
  assert(isHTMLResponse("text/html; charset=utf-8", new Uint8Array(0)));
  assert(isHTMLResponse("application/xhtml+xml", new Uint8Array(0)));
  assert(
    isHTMLResponse("", new TextEncoder().encode("<!DOCTYPE HTML><html>")),
  );
  assert(!isHTMLResponse("image/png", pngBytes()));
});

Deno.test("extractQRCodeImageURL collects and resolves candidate images", () => {
  const base = "https://login.example.com/wx?k=1";
  const html = `<!doctype html><html><head>
    <meta property="og:image" content="/og.png">
    <link rel="shortcut icon" href="/favicon.ico">
    </head><body>
    <img class="qr" SRC='  ' data-src="/static/qr.img.png">
    <img src="javascript:void(0)">
    <img src="https://cdn.example.com/pixel.gif">
    </body></html>`;
  // og:image comes first in document order and resolves against the base.
  const resolved = extractQRCodeImageURL(new TextEncoder().encode(html), base);
  assertEquals(resolved, "https://login.example.com/og.png");

  const onlyRelative = new TextEncoder().encode(
    `<html><body><img data-url="img/qr.png"></body></html>`,
  );
  assertEquals(
    extractQRCodeImageURL(onlyRelative, base),
    "https://login.example.com/img/qr.png",
  );

  const none = new TextEncoder().encode("<html><body>hello</body></html>");
  assertThrows(
    () => extractQRCodeImageURL(none, base),
    Error,
    "no QR image found",
  );

  assertEquals(
    resolveQRCodeImageURL("data:image/png;base64,AAA", base),
    "data:image/png;base64,AAA",
  );
  assertEquals(resolveQRCodeImageURL("javascript:void(0)", base), null);
  assertEquals(resolveQRCodeImageURL("  ", base), null);
});

Deno.test("CookieJar stores cookies and renders the cookie header", () => {
  const jar = new CookieJar();
  const response = new Response(null, {
    headers: new Headers([
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2"],
    ]),
  });
  jar.storeFrom(response, "https://example.org/");
  assertEquals(jar.cookiesFor("https://example.org/wx"), "a=1; b=2");
  jar.storeFrom(
    new Response(null, { headers: { "set-cookie": "a=" } }),
    "https://example.org/",
  );
  assertEquals(jar.cookiesFor("https://example.org/"), "b=2");
});

Deno.test("handleWechatLogin GET/POST project the runtime snapshot and 503", async () => {
  // GET with no runtime: idle projection.
  const getResponse = await handleWechatLogin(null, "")(
    new Request("http://s/api/channels/wechat/login"),
  );
  assertEquals(getResponse.status, 200);
  assertEquals(await getResponse.json(), {
    state: "idle",
    enabled: false,
    loggedIn: false,
  });

  // POST with no runtime: 503.
  const postResponse = await handleWechatLogin(null, "")(
    new Request("http://s/api/channels/wechat/login", { method: "POST" }),
  );
  assertEquals(postResponse.status, 503);

  // DELETE with no runtime: idle projection.
  const deleteResponse = await handleWechatLogin(null, "")(
    new Request("http://s/api/channels/wechat/login", { method: "DELETE" }),
  );
  assertEquals(deleteResponse.status, 200);

  // Unknown method: bare 405.
  const putResponse = await handleWechatLogin(null, "")(
    new Request("http://s/api/channels/wechat/login", { method: "PUT" }),
  );
  assertEquals(putResponse.status, 405);
});

Deno.test("handleWechatLogin POST starts a login session on the runtime", async () => {
  const rt = newRuntime();
  const response = await handleWechatLogin(rt, "/tmp/serve.json")(
    new Request("http://s/api/channels/wechat/login", { method: "POST" }),
  );
  assertEquals(response.status, 202);
  const body = await response.json();
  assertEquals(body.state, "starting");
  assertEquals(body.enabled, false);
  assert(rt.wechatLogin !== null);
  assert(rt.wechatLogin!.active());
  rt.wechatLogin!.cancelLogin();
});

Deno.test("handleWechatLoginQR serves and guards the QR proxy", async () => {
  const rt = newRuntime();
  // No active session: 404.
  const missing = await handleWechatLoginQR(rt)(
    new Request("http://s/api/channels/wechat/login/qr"),
  );
  assertEquals(missing.status, 404);

  // Method guard.
  rt.wechatLogin = new WechatLoginSession();
  const notGet = await handleWechatLoginQR(rt)(
    new Request("http://s/api/channels/wechat/login/qr", { method: "POST" }),
  );
  assertEquals(notGet.status, 405);

  // Inline base64 QR in base64 format returns the JSON projection.
  const png = pngBytes();
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  rt.wechatLogin!.qrURL = `data:image/png;base64,${encoded}`;
  const base64 = await handleWechatLoginQR(rt)(
    new Request("http://s/api/channels/wechat/login/qr?format=base64"),
  );
  assertEquals(base64.status, 200);
  const body = await base64.json();
  assertEquals(body.contentType, "image/png");
  assertEquals(body.base64, encoded);
  assertEquals(body.dataUrl, `data:image/png;base64,${encoded}`);

  // Inline QR without format returns raw bytes.
  const inline = await handleWechatLoginQR(rt)(
    new Request("http://s/api/channels/wechat/login/qr"),
  );
  assertEquals(inline.status, 200);
  assertEquals(inline.headers.get("cache-control"), "no-store");
  const data = new Uint8Array(await inline.arrayBuffer());
  assertEquals(data, png);
});

Deno.test("wechatLoginSnapshot prefers an active session, then stored credentials", () => {
  const rt = newRuntime();
  // No credentials on disk: idle.
  assertEquals(wechatLoginSnapshot(rt), {
    state: "idle",
    enabled: false,
    loggedIn: false,
  });

  // An in-flight session wins over the credential probe.
  rt.wechatLogin = new WechatLoginSession();
  rt.wechatLogin.update("scanned");
  const view = wechatLoginSnapshot(rt);
  assertEquals(view.state, "scanned");
  assertEquals(view.loggedIn, false);
});
