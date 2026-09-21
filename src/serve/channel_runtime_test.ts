// Translated from internal/serve/run.go's lifecycle tests (the portions of the
// run.go test files that cover the channelRuntime core ported here: helpers,
// config-update transaction, platform candidate lifecycle, and shutdown). The
// Go tests exercise these through the HTTP surface; the runtime pieces are
// direct here because the handler cluster lands in a later slice.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { decodeConfigBytes } from "./config_state.ts";
import {
  buildConfigFromServeConfig,
  buildCronStore,
  ChannelRuntime,
  cronStorePath,
  errorFromRun,
  platformTransportChanged,
} from "./channel_runtime.ts";
import type { ServeConfig } from "./config.ts";
import { LogHub } from "./logs.ts";
import type { Platform } from "../messaging/platform.ts";
import { newSQLiteCronStore } from "../cron/mod.ts";

function minimalConfig(): ServeConfig {
  return decodeConfigBytes(JSON.stringify({
    features: { cron: true, webUI: true },
    channels: { wechat: { enabled: true }, feishu: { enabled: true } },
  }));
}

function newRuntime(
  cfg: ServeConfig | null,
  sessionDir = Deno.makeTempDirSync(),
): ChannelRuntime {
  const rt = new ChannelRuntime({
    cfg,
    version: "test",
    dispatcher: null,
    sessionDir,
    identityMux: { withLock: () => Promise.resolve(() => {}) } as never,
    cronStore: null,
  });
  return rt;
}

class FakePlatform implements Platform {
  stopped = false;
  connected = false;
  startError: unknown = null;
  startHangs = false;
  private resolveStart: (() => void) | null = null;

  constructor(
    readonly nameValue: string,
    readonly readyError: unknown = null,
  ) {}

  name(): string {
    return this.nameValue;
  }

  start(): Promise<void> {
    if (this.startHangs) {
      return new Promise((resolve) => {
        this.resolveStart = resolve;
      });
    }
    if (this.startError !== null) {
      return Promise.reject(this.startError);
    }
    return Promise.resolve();
  }

  releaseStart(): void {
    this.resolveStart?.();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  sendMessage(): Promise<void> {
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ready(): Promise<void> {
    if (this.readyError !== null) {
      return Promise.reject(this.readyError);
    }
    return Promise.resolve();
  }
}

Deno.test("errorFromRun maps terminal statuses and empty messages", () => {
  assertEquals(errorFromRun("completed", ""), null);
  assertEquals(errorFromRun("incomplete", "ignored"), null);
  assertEquals(errorFromRun("failed", "boom")?.message, "boom");
  assertEquals(errorFromRun("failed", "  ")?.message, "failed");
  assertEquals(errorFromRun("", "")?.message, "run failed");
});

Deno.test("platformTransportChanged restarts only identity-affecting changes", () => {
  assert(platformTransportChanged(null, minimalConfig(), "wechat"));
  assert(platformTransportChanged(minimalConfig(), null, "feishu"));

  const old = decodeConfigBytes(JSON.stringify({
    channels: {
      wechat: { enabled: true, credPath: "/a", autoTyping: false },
      feishu: { enabled: true, appId: "x", appSecret: "s" },
    },
  }));
  const same = decodeConfigBytes(JSON.stringify({
    provider: "p",
    channels: {
      wechat: { enabled: true, credPath: "/a", autoTyping: false },
      feishu: { enabled: true, appId: "x", appSecret: "s" },
    },
  }));
  assert(!platformTransportChanged(old, same, "wechat"));
  assert(!platformTransportChanged(old, same, "feishu"));

  const wechatCred = decodeConfigBytes(JSON.stringify({
    channels: {
      wechat: { enabled: true, credPath: "/b", autoTyping: false },
      feishu: { enabled: true, appId: "x", appSecret: "s" },
    },
  }));
  assert(platformTransportChanged(old, wechatCred, "wechat"));
  assert(!platformTransportChanged(old, wechatCred, "feishu"));

  const wechatTyping = decodeConfigBytes(JSON.stringify({
    channels: {
      wechat: { enabled: true, credPath: "/a", autoTyping: true },
      feishu: { enabled: true, appId: "x", appSecret: "s" },
    },
  }));
  assert(platformTransportChanged(old, wechatTyping, "wechat"));

  const feishuSecret = decodeConfigBytes(JSON.stringify({
    channels: {
      wechat: { enabled: true, credPath: "/a", autoTyping: false },
      feishu: { enabled: true, appId: "x", appSecret: "s2" },
    },
  }));
  assert(platformTransportChanged(old, feishuSecret, "feishu"));
  assert(!platformTransportChanged(old, feishuSecret, "wechat"));
});

Deno.test("buildConfigFromServeConfig projects the merged config", () => {
  const hCfg = buildConfigFromServeConfig(minimalConfig());
  assertEquals(hCfg.multiAgent, false);
  assertEquals(hCfg.wechat.enabled, true);
  assertEquals(hCfg.feishu.enabled, true);
  assertEquals(hCfg.cron.enabled, true);
  assertEquals(hCfg.hooks.preToolCall, "");
  assertEquals(hCfg.agent.maxTurns >= 0, true);

  // Null config keeps the channels defaults.
  const defaults = buildConfigFromServeConfig(null);
  assertEquals(defaults.wechat.enabled, false);
  assertEquals(defaults.workDir, ".");

  // Workdir resolution prefers defaultWorkDir, then workingDir.
  const withWorkDir = decodeConfigBytes(JSON.stringify({
    api: { defaultWorkDir: "/srv/default", workingDir: "/srv/working" },
  }));
  assertEquals(buildConfigFromServeConfig(withWorkDir).workDir, "/srv/default");
  const withWorkingDir = decodeConfigBytes(JSON.stringify({
    api: { workingDir: "/srv/working" },
  }));
  assertEquals(
    buildConfigFromServeConfig(withWorkingDir).workDir,
    "/srv/working",
  );
});

Deno.test("buildCronStore and cronStorePath follow the enabled flag", () => {
  const sessionDir = Deno.makeTempDirSync();
  assertEquals(buildCronStore(null, sessionDir), null);

  const disabled = buildConfigFromServeConfig(
    decodeConfigBytes(JSON.stringify({ features: { cron: false } })),
  );
  assertEquals(buildCronStore(disabled, sessionDir), null);

  const enabled = buildConfigFromServeConfig(minimalConfig());
  const store = buildCronStore(enabled, sessionDir);
  assert(store !== null);
  assertEquals(cronStorePath(sessionDir), join(sessionDir, "sessions.db"));
});

Deno.test("channelStatuses projects configured and connected platforms", () => {
  const rt = newRuntime(minimalConfig());
  rt.logHub = new LogHub();
  assertEquals(rt.channelStatuses(), [
    { name: "wechat", enabled: true, connected: false },
    { name: "feishu", enabled: true, connected: false },
  ]);

  const wechat = new FakePlatform("wechat");
  wechat.connected = true;
  rt.platforms.replace("wechat", wechat);
  const statuses = rt.channelStatuses();
  assertEquals(statuses[0].connected, true);

  // Unknown platform names are appended.
  const other = new FakePlatform("slack");
  other.connected = true;
  rt.platforms.replace("slack", other);
  const extended = rt.channelStatuses();
  assertEquals(extended.length, 3);
  assertEquals(extended[2], { name: "slack", enabled: true, connected: true });

  // Null config keeps the disabled pair.
  const bare = newRuntime(null);
  assertEquals(bare.channelStatuses(), [
    { name: "wechat", enabled: false, connected: false },
    { name: "feishu", enabled: false, connected: false },
  ]);
});

Deno.test("publishChannelStatus and publishManagementEvent broadcast on the hub", async () => {
  const rt = newRuntime(minimalConfig());
  const hub = new LogHub();
  rt.logHub = hub;

  const events: { type: string; timestamp?: string; status?: unknown }[] = [];
  const sub = hub.subscribe();
  const done = (async () => {
    for await (const ev of sub.events) {
      events.push(ev);
      if (events.length >= 2) break;
    }
  })();
  rt.publishChannelStatus();
  rt.publishManagementEvent("channel_config_changed", { platform: "wechat" });
  await done;

  assertEquals(events[0].type, "channel_status_changed");
  const status = events[0].status as { channels: unknown[]; features: unknown };
  assertEquals((status.channels as unknown[]).length, 2);
  assert(status.features !== undefined);
  assertEquals(events[1].type, "channel_config_changed");
  assertEquals((events[1] as { data?: unknown }).data, { platform: "wechat" });
});

Deno.test("startPlatformCandidate promotes a ready candidate and retires the previous owner", async () => {
  const rt = newRuntime(minimalConfig());
  rt.logHub = new LogHub();
  const previous = new FakePlatform("wechat");
  const candidate = new FakePlatform("wechat");
  rt.platforms.replace("wechat", previous);

  const events: { data?: unknown }[] = [];
  const sub = rt.logHub!.subscribe();
  const collect = (async () => {
    for await (const ev of sub.events) {
      events.push(ev);
      break;
    }
  })();
  await rt.startPlatformCandidate("wechat", candidate, previous);
  // The candidate's start promise resolves immediately, so finishPlatform
  // retires it from the supervisor (Go: RemoveIf after a clean loop exit).
  await new Promise((resolve) => setTimeout(resolve, 0));
  await collect;
  assertEquals(previous.stopped, true);
  assertEquals(candidate.stopped, true);
  assertEquals(rt.platforms.get("wechat"), undefined);
  assertEquals(
    (events[0].data as Record<string, unknown>)?.state,
    "disconnected",
  );
});

Deno.test("startPlatformCandidate rolls back when readiness fails", async () => {
  const rt = newRuntime(minimalConfig());
  rt.logHub = new LogHub();
  const previous = new FakePlatform("wechat");
  const candidate = new FakePlatform("wechat", new Error("handshake failed"));
  rt.platforms.replace("wechat", previous);

  const events: { data?: unknown }[] = [];
  const sub = rt.logHub.subscribe();
  const collect = (async () => {
    for await (const ev of sub.events) {
      events.push(ev);
      break;
    }
  })();
  await assertRejects(
    () => rt.startPlatformCandidate("wechat", candidate, previous),
    Error,
    "handshake failed",
  );
  await collect;
  assertEquals(rt.platforms.get("wechat"), previous);
  assert(!previous.stopped);
  assertEquals((events[0].data as Record<string, unknown>)?.state, "rollback");
  assertEquals(
    (events[0].data as Record<string, unknown>)?.error,
    "handshake failed",
  );
});

Deno.test("startPlatformCandidate keeps the legacy immediate promotion for platforms without readiness", async () => {
  const rt = newRuntime(minimalConfig());
  rt.logHub = new LogHub();
  const previous = new FakePlatform("slack");
  const candidate = new FakePlatform("slack");
  // Strip readiness so the legacy path runs.
  (candidate as Partial<FakePlatform>).ready = undefined;
  rt.platforms.replace("slack", previous);

  await rt.startPlatformCandidate("slack", candidate, previous);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // finishPlatform retires the candidate once its loop exits cleanly.
  assertEquals(candidate.stopped, true);
  assertEquals(previous.stopped, true);
});

Deno.test("finishPlatform falls back to the previous owner on a failed live run", async () => {
  const rt = newRuntime(minimalConfig());
  rt.logHub = new LogHub();
  const fallback = new FakePlatform("feishu");
  fallback.startHangs = true;
  const candidate = new FakePlatform("feishu");
  rt.platforms.replace("feishu", candidate);

  const events: { data?: unknown }[] = [];
  const sub = rt.logHub.subscribe();
  const collect = (async () => {
    for await (const ev of sub.events) {
      events.push(ev);
      break;
    }
  })();
  await rt.finishPlatform(
    candidate,
    Promise.resolve(new Error("receive loop failed")),
    fallback,
  );
  await collect;
  assertEquals(rt.platforms.get("feishu"), fallback);
  assert(candidate.stopped, "the failed candidate must be stopped");
  assertEquals((events[0].data as Record<string, unknown>)?.state, "rollback");
});

Deno.test("syncCronRuntime tears down and rebuilds the cron runtime with the config", () => {
  const sessionDir = Deno.makeTempDirSync();
  const disabledCfg = decodeConfigBytes(JSON.stringify({
    features: { cron: false },
  }));
  const rt = newRuntime(disabledCfg, sessionDir);
  rt.cron.cronStore = newSQLiteCronStore(sessionDir);
  rt.cron.cronStorePath = cronStorePath(sessionDir);

  rt.syncCronRuntime();
  assertEquals(rt.cron.cronStore, null);
  assertEquals(rt.cron.cronStorePath, "");

  // Enabled cron with no dispatcher cannot start a scheduler but keeps a store.
  rt.setConfig(minimalConfig());
  rt.syncCronRuntime();
  assert(rt.cron.cronStore !== null);
  assertEquals(rt.cron.cronStorePath, cronStorePath(sessionDir));
  assertEquals(rt.cron.cronScheduler, null);
});

Deno.test("stop publishes the terminal event and aborts the recovery worker", async () => {
  const sessionDir = Deno.makeTempDirSync();
  const rt = newRuntime(minimalConfig(), sessionDir);
  rt.logHub = new LogHub();
  rt.startDeliveryRecovery();

  const events: { data?: unknown }[] = [];
  const sub = rt.logHub.subscribe();
  const done = (async () => {
    for await (const ev of sub.events) {
      events.push(ev);
      break;
    }
  })();
  await rt.stop();
  await done;

  assertEquals((events[0].data as Record<string, unknown>)?.state, "stopped");
  assertEquals(rt.deliveryController?.signal.aborted, true);
});
