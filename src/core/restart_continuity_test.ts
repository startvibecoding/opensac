// Cross-entry continuity across a Core restart.
//
// TUI, ACP, and CLI are thin projections of one Core. When the Core restarts
// underneath a client, the client still holds the session it was working on:
// the Core client boundary re-opens the persisted session, and every projection
// answers from the same canonical state. This test drives the TUI and ACP
// projections over one restarted Core so only the wire shape differs.

import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import { ACPBridgeClient } from "../acp/bridge_client.ts";
import { SOURCE_ACP } from "../agentruntime/source.ts";
import { defaultSettings } from "../config/settings.ts";
import { closeDatabases } from "../session/mod.ts";
import {
  testWithIsolatedConfig as test,
  withIsolatedConfig,
} from "../test_helpers.ts";
import { createCoreClientTUIService } from "../tui/core_service.ts";
import { CoreClient, CoreClientRpcError } from "./client.ts";
import { type ResolvedCoreConfig } from "./config.ts";
import { CorePaths } from "./paths.ts";
import { CoreRegistry } from "./registry.ts";
import { CoreServer, type CoreServerHandle } from "./server.ts";
import { type CoreRuntimeHost } from "./runtime.ts";
import {
  createCoreRuntimeHost,
  createProductionCoreRuntimeDependencies,
} from "./runtime_host.ts";

const VERSION = "0.1.0-restart-test";
const PROTOCOL_VERSION = 17;

function coreConfig(): ResolvedCoreConfig {
  return { host: "127.0.0.1", port: 0, auth: false, passwords: [] };
}

/** Starts the shared Core listener in front of one Runtime Host. */
async function startCore(host: CoreRuntimeHost): Promise<CoreServerHandle> {
  return await new CoreServer({
    config: coreConfig(),
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    runtime: host,
  }).start();
}

/** Publishes a registration so a plain client can discover this Core. */
async function register(
  stateDir: string,
  handle: CoreServerHandle,
): Promise<void> {
  await new CoreRegistry(CorePaths.fromStateDir(stateDir)).write({
    id: "core-restart",
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    pid: Deno.pid,
    host: "127.0.0.1",
    port: handle.address.port,
    startedAt: 1_700_000_000_000,
  });
}

test("TUI and ACP keep their session when the Core restarts underneath them", async () => {
  await withIsolatedConfig(async () => {
    const settings = defaultSettings();
    const workDir = await Deno.makeTempDir({
      prefix: "opensac-restart-",
    });
    const stateDir = await Deno.makeTempDir({
      prefix: "opensac-restart-state-",
    });
    const hostOptions = {
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "",
      modelID: "",
      dependencies: createProductionCoreRuntimeDependencies(settings),
    };
    // One client lives across the restart, which is what a TUI or a Desktop
    // process does.
    const client = new CoreClient({
      stateDir,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: coreConfig(),
    });
    let first: CoreServerHandle | undefined;
    let second: CoreServerHandle | undefined;
    let before: CoreRuntimeHost | undefined;
    let after: CoreRuntimeHost | undefined;
    try {
      before = await createCoreRuntimeHost(hostOptions);
      first = await startCore(before);
      await register(stateDir, first);
      const session = await before.createSession({ workDir });
      // Both projections keep holding this ID across the restart.
      const held = session.sessionId;
      const tui = createCoreClientTUIService(client, { workDir });
      const capabilitiesBefore = await tui.capabilities({ sessionId: held });
      const agentsBefore = await tui.listAgents({ sessionId: held });
      await before.close();
      before = undefined;
      await first.stop();
      first = undefined;

      // ── the Core restarts: only persisted state carries over ──────────────
      after = await createCoreRuntimeHost(hostOptions);
      second = await startCore(after);
      await register(stateDir, second);
      assertEquals(
        (await after.listSessions()).length,
        0,
        "the restarted Core has no resident session",
      );

      // TUI: the session view it is still holding is no longer resident, and
      // the projection keeps answering from the same canonical state.
      assertEquals(
        await tui.capabilities({ sessionId: held }),
        capabilitiesBefore,
      );
      assertEquals(await tui.listAgents({ sessionId: held }), agentsBefore);

      // ACP: the same session through a bridge that owns no session state and
      // simply forwards the ID it was handed.
      const acp = new ACPBridgeClient({ core: client });
      try {
        await acp.connect();
        assertEquals(
          await acp.replay(held, "run-that-never-ran", 0),
          [],
          "ACP projects the same canonical state",
        );

        // Canonical identity agrees across projections: the session the Core
        // minted before the restart is the one both of them now address.
        const listed = await tui.listPersistedSessions({ workDir });
        assert(
          listed.some((entry) => entry.sessionId === held),
          "the persisted session survives the restart",
        );
        const reopened = await tui.openSession({ sessionId: held });
        assertEquals(reopened.sessionId, held);
        assertEquals(reopened.workDir, workDir);
      } finally {
        await acp.close();
      }
    } finally {
      await client.close();
      await first?.stop();
      await second?.stop();
      await before?.close();
      await after?.close();
      await Deno.remove(workDir, { recursive: true });
      await Deno.remove(stateDir, { recursive: true });
      closeDatabases();
    }
  });
});

test("a session deleted while the client was away fails instead of looping", async () => {
  await withIsolatedConfig(async () => {
    const settings = defaultSettings();
    const workDir = await Deno.makeTempDir({
      prefix: "opensac-restart-gone-",
    });
    const stateDir = await Deno.makeTempDir({
      prefix: "opensac-restart-gone-state-",
    });
    const hostOptions = {
      source: SOURCE_ACP,
      workDir,
      settings,
      providerName: "",
      modelID: "",
      dependencies: createProductionCoreRuntimeDependencies(settings),
    };
    const before = await createCoreRuntimeHost(hostOptions);
    const first = await startCore(before);
    await register(stateDir, first);
    const session = await before.createSession({ workDir });
    await before.close();
    await first.stop();

    const after = await createCoreRuntimeHost(hostOptions);
    const second = await startCore(after);
    await register(stateDir, second);
    const client = new CoreClient({
      stateDir,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: coreConfig(),
    });
    try {
      // The session is gone for good, so the client's re-open cannot succeed.
      // The failure must surface rather than be retried into a loop.
      await after.deleteSession({ sessionId: session.sessionId });
      const error = await assertRejects(
        () =>
          client.call("session.capabilities", {
            sessionId: session.sessionId,
          }),
        CoreClientRpcError,
      );
      assert(
        !error.message.includes("session not found: "),
        `re-open failure must be reported, got ${error.message}`,
      );
    } finally {
      await client.close();
      await second.stop();
      await after.close();
      await Deno.remove(workDir, { recursive: true });
      await Deno.remove(stateDir, { recursive: true });
      closeDatabases();
    }
  });
});
