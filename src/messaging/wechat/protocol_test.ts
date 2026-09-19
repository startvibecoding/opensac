// Ported from internal/messaging/wechat/protocol_test.go

import { assertEquals } from "@std/assert";

import {
  Client,
  type FetchLike,
  getUpdatesWithTimeout,
  notifyStart,
  notifyStop,
  semverComponents,
} from "./protocol.ts";
import { longPollTimeout } from "./wechat.ts";

function backgroundSignal(): AbortSignal {
  return new AbortController().signal;
}

Deno.test("ClientLifecycleAndGetUpdatesProtocolContract", async () => {
  const paths: string[] = [];
  const fetchFn: FetchLike = (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (init?.method !== "POST") {
      throw new Error(`method = ${init?.method}, want POST`);
    }
    if (headers.get("AuthorizationType") !== "ilink_bot_token") {
      throw new Error(
        `AuthorizationType = ${headers.get("AuthorizationType")}`,
      );
    }
    if (headers.get("Authorization") !== "Bearer token") {
      throw new Error(`Authorization = ${headers.get("Authorization")}`);
    }
    if (headers.get("iLink-App-Id") !== "bot") {
      throw new Error(`iLink-App-Id = ${headers.get("iLink-App-Id")}`);
    }
    const clientVersion = headers.get("iLink-App-ClientVersion") ?? "";
    if (clientVersion === "" || clientVersion === "0") {
      throw new Error(`iLink-App-ClientVersion = ${clientVersion}`);
    }
    const body = JSON.parse(String(init?.body)) as {
      base_info?: Record<string, string>;
      get_updates_buf?: string;
    };
    const baseInfo = body.base_info;
    if (
      baseInfo === undefined || baseInfo.channel_version === undefined ||
      baseInfo.bot_agent === undefined
    ) {
      throw new Error(`base_info = ${JSON.stringify(baseInfo)}`);
    }
    paths.push(url.pathname);

    switch (url.pathname) {
      case "/ilink/bot/msg/notifystart":
      case "/ilink/bot/msg/notifystop":
        return Promise.resolve(new Response(`{"ret":0}`));
      case "/ilink/bot/getupdates":
        if (body.get_updates_buf !== "prior-cursor") {
          throw new Error(`get_updates_buf = ${body.get_updates_buf}`);
        }
        return Promise.resolve(
          new Response(
            `{"ret":0,"msgs":[],"get_updates_buf":"next-cursor","longpolling_timeout_ms":42000}`,
          ),
        );
      default:
        throw new Error(`unexpected path ${url.pathname}`);
    }
  };

  const client = new Client(fetchFn);
  const signal = backgroundSignal();
  await notifyStart(client, signal, "https://ilink.test", "token");
  const updates = await getUpdatesWithTimeout(
    client,
    signal,
    "https://ilink.test",
    "token",
    "prior-cursor",
    3000,
  );
  assertEquals(updates.get_updates_buf, "next-cursor");
  assertEquals(updates.longpolling_timeout_ms, 42000);
  await notifyStop(client, signal, "https://ilink.test", "token");
  assertEquals(paths, [
    "/ilink/bot/msg/notifystart",
    "/ilink/bot/getupdates",
    "/ilink/bot/msg/notifystop",
  ]);
});

Deno.test("GetUpdatesTimeoutIsAnEmptyPoll", async () => {
  const fetchFn: FetchLike = (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      if (signal === null) {
        reject(new Error("missing signal"));
        return;
      }
      const abort = () =>
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  };
  const client = new Client(fetchFn);
  const updates = await getUpdatesWithTimeout(
    client,
    backgroundSignal(),
    "https://ilink.test",
    "token",
    "cursor",
    1,
  );
  assertEquals(updates.ret, 0);
  assertEquals(updates.msgs.length, 0);
  assertEquals(updates.get_updates_buf, "cursor");
});

Deno.test("SemverComponentsAndLongPollTimeout", () => {
  assertEquals(semverComponents("v1.2.95-rc.1"), [1, 2, 95]);
  assertEquals(semverComponents("revision-dirty"), null);
  assertEquals(longPollTimeout(35000), 35000);
  assertEquals(longPollTimeout(0), null);
});
