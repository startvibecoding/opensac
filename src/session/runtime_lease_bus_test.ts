// Adapted from internal/session/runtime_lease_bus_test.go
//
// The Go suite spawns the test binary itself as the peer process; here the peer
// is src/session/testdata/runtime_lease_bus_helper.ts spawned with Deno.execPath
// so the same UDP broadcast path is exercised across a real process boundary.

import { assert, assertEquals, assertFalse } from "@std/assert";
import * as path from "@std/path";
import {
  publishRuntimeLeaseNotification,
  rememberRuntimeLeaseMessage,
  runtimeLeaseBusDatabaseRebuilt,
  runtimeLeaseBusListening,
  runtimeLeaseBusLogf,
  type RuntimeLeaseNotification,
  subscribeRuntimeLeaseLogs,
  subscribeRuntimeLeaseNotifications,
  validRuntimeLeaseNotification,
  waitForRuntimeLeaseBusListener,
  waitForRuntimeLeaseBusStopped,
} from "./runtime_lease_bus.ts";

async function freeUdpPort(): Promise<number> {
  const { default: dgram } = await import("node:dgram");
  return await new Promise<number>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.on("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

class LineStream {
  #lines: string[] = [];
  #waiters: Array<(line: string) => void> = [];
  #closed = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            this.#push(buffer.slice(0, index).trim());
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
          }
        }
      } finally {
        this.#closed = true;
        while (this.#waiters.length > 0) this.#waiters.shift()!("");
      }
    })();
  }

  #push(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.#lines.push(line);
  }

  next(timeoutMs = 5000): Promise<string> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift()!);
    if (this.#closed) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(""), timeoutMs);
      this.#waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }
}

interface Helper {
  child: Deno.ChildProcess;
  lines: LineStream;
  stop: () => void;
}

function spawnHelper(
  port: number,
  mode?: string,
  extraEnv?: Record<string, string>,
): Helper {
  const helper = new URL(
    "./testdata/runtime_lease_bus_helper.ts",
    import.meta.url,
  );
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    MOTHX_RUNTIME_BUS_PORT: String(port),
    ...(mode !== undefined ? { MOTHX_RUNTIME_BUS_HELPER_MODE: mode } : {}),
    ...(extraEnv ?? {}),
  };
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", helper.pathname],
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  });
  const child = command.spawn();
  return {
    child,
    lines: new LineStream(child.stdout),
    stop: () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
}

Deno.test("runtime lease notification validation", () => {
  const valid: RuntimeLeaseNotification = {
    version: 2,
    messageId: "m1",
    originInstanceId: "origin-1",
    type: "state_changed",
    sessionId: "session-1",
  };
  assert(validRuntimeLeaseNotification(valid));
  assertFalse(validRuntimeLeaseNotification({ ...valid, version: 1 }));
  assertFalse(validRuntimeLeaseNotification({ ...valid, messageId: "" }));
  assertFalse(
    validRuntimeLeaseNotification({ ...valid, originInstanceId: "" }),
  );
  assertFalse(validRuntimeLeaseNotification({ ...valid, sessionId: "" }));
  assertFalse(validRuntimeLeaseNotification({ ...valid, type: "unknown" }));
  // A rebuild notice is database-scoped.
  assert(
    validRuntimeLeaseNotification({
      version: 2,
      messageId: "m2",
      originInstanceId: "origin-1",
      type: runtimeLeaseBusDatabaseRebuilt,
      path: "/tmp/sessions.db",
    }),
  );
  assertFalse(
    validRuntimeLeaseNotification({
      version: 2,
      messageId: "m3",
      originInstanceId: "origin-1",
      type: runtimeLeaseBusDatabaseRebuilt,
      path: "",
    }),
  );
});

Deno.test("runtime lease message dedupe expires", () => {
  const now = Date.now();
  assert(rememberRuntimeLeaseMessage("dedupe-a", now));
  assertFalse(rememberRuntimeLeaseMessage("dedupe-a", now));
  // Go returns false while the id is still recorded, even past its TTL.
  assertFalse(rememberRuntimeLeaseMessage("dedupe-a", now + 11_000));
  // Admitting a new id sweeps expired entries, so the first id is gone.
  assert(rememberRuntimeLeaseMessage("dedupe-b", now + 11_001));
  assert(rememberRuntimeLeaseMessage("dedupe-a", now + 11_002));
});

Deno.test("runtime lease bus logs use dedicated subscribers", async () => {
  const logs: string[] = [];
  const stop = subscribeRuntimeLeaseLogs((message) => logs.push(message));
  try {
    runtimeLeaseBusLogf("[udp] sent type=%s", "state_changed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(logs, ["[udp] sent type=state_changed"]);
  } finally {
    stop();
  }
});

Deno.test("runtime lease bus stops when last handler unsubscribes", async () => {
  const port = await freeUdpPort();
  const previous = Deno.env.get("MOTHX_RUNTIME_BUS_PORT");
  Deno.env.set("MOTHX_RUNTIME_BUS_PORT", String(port));
  try {
    const stop = subscribeRuntimeLeaseNotifications(() => {});
    assert(
      await waitForRuntimeLeaseBusListener(5000),
      "listener did not start",
    );
    stop();
    assert(
      await waitForRuntimeLeaseBusStopped(5000),
      "listener did not stop after the last handler unsubscribed",
    );
    assertFalse(runtimeLeaseBusListening());
  } finally {
    if (previous === undefined) Deno.env.delete("MOTHX_RUNTIME_BUS_PORT");
    else Deno.env.set("MOTHX_RUNTIME_BUS_PORT", previous);
  }
});

Deno.test("runtime lease bus broadcast reaches another process", async () => {
  const port = await freeUdpPort();
  const previous = Deno.env.get("MOTHX_RUNTIME_BUS_PORT");
  Deno.env.set("MOTHX_RUNTIME_BUS_PORT", String(port));
  const received: RuntimeLeaseNotification[] = [];
  const stop = subscribeRuntimeLeaseNotifications((n) => received.push(n));
  const helpers: Helper[] = [];
  try {
    assert(
      await waitForRuntimeLeaseBusListener(5000),
      "parent listener did not start",
    );
    for (let i = 0; i < 2; i++) {
      const helper = spawnHelper(port);
      helpers.push(helper);
      assertEquals(await helper.lines.next(), "ready");
    }

    publishRuntimeLeaseNotification({
      type: "state_changed",
      sessionId: "broadcast-session",
      origin: "cli",
    });
    for (const helper of helpers) {
      const line = await helper.lines.next();
      assert(
        line.startsWith("received state_changed cli "),
        `helper receipt = ${JSON.stringify(line)}`,
      );
    }
  } finally {
    for (const helper of helpers) helper.stop();
    stop();
    await waitForRuntimeLeaseBusStopped(5000);
    if (previous === undefined) Deno.env.delete("MOTHX_RUNTIME_BUS_PORT");
    else Deno.env.set("MOTHX_RUNTIME_BUS_PORT", previous);
  }
});

Deno.test("runtime lease bus database rebuilt reaches another process", async () => {
  const port = await freeUdpPort();
  const previous = Deno.env.get("MOTHX_RUNTIME_BUS_PORT");
  Deno.env.set("MOTHX_RUNTIME_BUS_PORT", String(port));
  const notifications: RuntimeLeaseNotification[] = [];
  const stop = subscribeRuntimeLeaseNotifications((n) => notifications.push(n));
  const dbPath = path.join(Deno.makeTempDirSync(), "sessions.db");
  let helper: Helper | null = null;
  try {
    assert(
      await waitForRuntimeLeaseBusListener(5000),
      "parent listener did not start",
    );
    helper = spawnHelper(port, "publish_database_rebuilt", {
      MOTHX_RUNTIME_BUS_HELPER_PATH: dbPath,
    });
    const deadline = Date.now() + 5000;
    while (notifications.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(notifications.length, 1);
    assertEquals(notifications[0].type, runtimeLeaseBusDatabaseRebuilt);
    assertEquals(notifications[0].path, dbPath);
    assertEquals(notifications[0].origin, "db");
  } finally {
    helper?.stop();
    stop();
    await waitForRuntimeLeaseBusStopped(5000);
    if (previous === undefined) Deno.env.delete("MOTHX_RUNTIME_BUS_PORT");
    else Deno.env.set("MOTHX_RUNTIME_BUS_PORT", previous);
  }
});
