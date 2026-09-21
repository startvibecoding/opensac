// Focused coverage for the dispatcher core slice: tool catalog projection,
// config invalidation semantics, session leases, and source labeling. The full
// HandleMessage/HandleDelivery suite lands with the delivery slice.

import { assert, assertEquals } from "@std/assert";
import {
  channelRunSource,
  ChannelSession,
  deepEqual,
  Dispatcher,
  isMultiAgentToolName,
  shouldInvalidateSession,
} from "./dispatcher.ts";
import { defaultConfig } from "./config.ts";
import { newIdentityLocks } from "../../session/mod.ts";

function newTestDispatcher(
  overrides: ConstructorParameters<typeof Dispatcher>[0] = {},
): Dispatcher {
  return new Dispatcher({ cfg: defaultConfig(), ...overrides });
}

Deno.test("multi agent tool name classification", () => {
  assert(isMultiAgentToolName("delegate_subagent"));
  assert(isMultiAgentToolName("subagent_spawn"));
  assert(isMultiAgentToolName("workflow_run"));
  assert(!isMultiAgentToolName("bash"));
  assert(!isMultiAgentToolName("subagent"));
});

Deno.test("tool catalog projects defaults and availability", () => {
  const d = newTestDispatcher();
  const catalog = d.toolCatalog("wechat");
  const byName = new Map(catalog.map((item) => [item.name, item]));
  assert(byName.has("browser"));
  assert(byName.has("memory"));
  // cron: no store → unavailable with the Go reason text.
  const cron = byName.get("cron")!;
  assert(!cron.available);
  assertEquals(cron.unavailableReason, "cron scheduler is disabled");
  // a2a: disabled by default.
  const a2a = byName.get("a2a_dispatch")!;
  assert(!a2a.available);
  assertEquals(a2a.unavailableReason, "A2A master is disabled");
  // multi-agent tools stay selectable with multiAgent only deciding defaults.
  const delegate = byName.get("delegate_subagent")!;
  assert(delegate.available);
  assert(!delegate.default);
  // Registry defaults are included and available by default.
  const read = byName.get("read");
  assert(read !== undefined && read.available && read.default);
});

Deno.test("session tool states honor persisted selection over defaults", () => {
  const d = newTestDispatcher();
  d.sessionDir = Deno.makeTempDirSync();
  const catalog = d.toolCatalog("wechat");
  assert(catalog.length > 0);
  const { states } = d.sessionToolStates("sess-missing", "wechat");
  // No persisted config: defaults apply, and nothing is registered yet.
  const defaults = new Map(
    d.toolCatalog("wechat").map((c) => [c.name, c.default]),
  );
  for (const state of states) {
    assertEquals(state.requestedEnabled, defaults.get(state.name) ?? false);
    assertEquals(state.registered, false);
  }
});

Deno.test("deep equal matches Go reflect.DeepEqual on config objects", () => {
  const a = defaultConfig();
  const b = defaultConfig();
  assert(deepEqual(a.security, b.security));
  assert(deepEqual(a.agent, b.agent));
  b.agent.runStaleTimeoutSecs = 1;
  assert(!deepEqual(a.agent, b.agent));
  b.wechat.autoTyping = !b.wechat.autoTyping;
  assert(!deepEqual(a.wechat, b.wechat));
});

Deno.test("should invalidate session respects platform scoping", () => {
  const previous = defaultConfig();
  const next = defaultConfig();
  next.wechat.autoTyping = !next.wechat.autoTyping;
  assert(shouldInvalidateSession(previous, next, "channels/wechat/u1"));
  assert(!shouldInvalidateSession(previous, next, "channels/feishu/u1"));
  // Go's fall-through: any other platform key invalidates unconditionally.
  assert(shouldInvalidateSession(previous, next, "channels/other/u1"));

  const globalNext = defaultConfig();
  globalNext.sandbox = !globalNext.sandbox;
  assert(shouldInvalidateSession(previous, globalNext, "channels/feishu/u1"));
  assert(shouldInvalidateSession(null, next, "channels/wechat/u1"));
});

Deno.test("session lease keeps pending entrants counted until promotion", async () => {
  const d = newTestDispatcher();
  const sess = new ChannelSession();
  sess.id = "channels/wechat/u1";
  sess.platform = "wechat";
  sess.userID = "u1";
  d.sessions.set("channels/wechat/u1", sess);

  const lease = d.acquireSessionLease(
    "channels/wechat/u1",
    "wechat",
    "u1",
    sess,
  );
  assert(lease !== null);
  assertEquals(sess.pendingEntrants, 1);

  // With identity locks installed but no canonical binding for this identity,
  // promotion fails and the lease is released.
  d.setIdentityLocks(newIdentityLocks());
  const promoted = await lease.promoteAfterRuntimeLock();
  assert(!promoted);
  assertEquals(sess.pendingEntrants, 0);
  assertEquals(sess.activeRuns, 0);

  // A second lease whose session was invalidated cleans the entry on release.
  const lease2 = d.acquireSessionLease(
    "channels/wechat/u1",
    "wechat",
    "u1",
    sess,
  );
  assert(lease2 !== null);
  sess.invalidated = true;
  lease2.release();
  assert(
    !d.sessions.has("channels/wechat/u1"),
    "invalidated idle session kept",
  );
});

Deno.test("channel run source falls back to platform label", () => {
  const sess = new ChannelSession();
  sess.platform = "slack";
  assertEquals(channelRunSource(sess), "channel:slack");
  const wechat = new ChannelSession();
  wechat.platform = "wechat";
  assertEquals(channelRunSource(wechat), "wechat");
  assertEquals(channelRunSource(null), "");
});
