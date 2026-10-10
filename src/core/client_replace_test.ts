// Tests for the opt-in replacement of a version-incompatible registered Core.
//
// These live apart from client_test.ts because they need their own server
// fixtures, and the behavior they cover (stopping a Core the client cannot
// talk to) is a distinct policy from ordinary startup.

import { runtime } from "../platform/runtime.ts";
import { assertEquals, assertRejects } from "../compat/assert.ts";
import { type ResolvedCoreConfig } from "./config.ts";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";
import { CoreServer, type CoreServerHandle } from "./server.ts";
import {
  CoreClient,
  type CoreClientOptions,
  type CoreLauncher,
  CoreStartupError,
} from "./client.ts";
import { test } from "#testing";

const TEST_VERSION = "0.1.0-replace-test";
const TEST_PROTOCOL_VERSION = 19;
const FOREIGN_VERSION = "9.9.9-foreign";

function config(): ResolvedCoreConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    auth: false,
    passwords: [],
  };
}

function clientOptions(
  stateDir: string,
  overrides: Partial<CoreClientOptions> = {},
): CoreClientOptions {
  return {
    stateDir,
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    config: config(),
    startTimeoutMs: 500,
    ...overrides,
  };
}

function registration(
  port: number,
  overrides: Partial<CoreRegistration> = {},
): CoreRegistration {
  return {
    id: "core-foreign",
    version: FOREIGN_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    pid: runtime.pid,
    host: "127.0.0.1",
    port,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function withStateDir(
  test: (stateDir: string, paths: CorePaths) => Promise<void>,
): Promise<void> {
  const stateDir = await runtime.makeTempDir({
    prefix: "opensac-core-replace-",
  });
  try {
    await test(stateDir, CorePaths.fromStateDir(stateDir));
  } finally {
    await runtime.remove(stateDir, { recursive: true });
  }
}

async function startServer(
  version: string,
  onShutdown: () => void = () => {},
): Promise<CoreServerHandle> {
  return await new CoreServer({
    config: config(),
    version,
    protocolVersion: TEST_PROTOCOL_VERSION,
    onShutdown,
  }).start();
}

test("ensureStarted refuses an incompatible Core by default", async () => {
  await withStateDir(async (stateDir, paths) => {
    let shutdownCalls = 0;
    const handle = await startServer(FOREIGN_VERSION, () => {
      shutdownCalls++;
    });
    try {
      await new CoreRegistry(paths).write(registration(handle.address.port));
      const client = new CoreClient(clientOptions(stateDir));
      try {
        // Opting out is the default, so the mismatch stays a startup failure
        // and no other process is stopped without being asked to.
        await assertRejects(
          () => client.ensureStarted(),
          CoreStartupError,
          "incompatible",
        );
        assertEquals(shutdownCalls, 0);
      } finally {
        await client.close();
      }
    } finally {
      await handle.stop();
    }
  });
});

test("ensureStarted replaces an incompatible Core when asked", async () => {
  await withStateDir(async (stateDir, paths) => {
    const registry = new CoreRegistry(paths);
    let shutdownCalls = 0;
    // A real Core removes its registration as it exits; without that behavior
    // `waitForRegistrationExit` never observes the replacement complete.
    const foreign = await startServer(FOREIGN_VERSION, () => {
      shutdownCalls++;
      void registry.remove("core-foreign").catch(() => {});
    });
    let replacement: CoreServerHandle | undefined;
    try {
      await registry.write(registration(foreign.address.port));

      const launcher: CoreLauncher = async () => {
        replacement = await startServer(TEST_VERSION);
        await registry.write(
          registration(replacement.address.port, {
            id: "core-replacement",
            version: TEST_VERSION,
          }),
        );
      };
      const replaced: CoreRegistration[] = [];
      const client = new CoreClient(clientOptions(stateDir, { launcher }));
      try {
        const started = await client.ensureStarted(undefined, {
          replaceIncompatible: true,
          onReplacingIncompatible: (value) => replaced.push(value),
        });

        assertEquals(started.status, "ready");
        // The front end is told which Core went away, not just that one did.
        assertEquals(replaced.length, 1);
        assertEquals(replaced[0].id, "core-foreign");
        assertEquals(replaced[0].version, FOREIGN_VERSION);
        // The incompatible Core was asked to stop, and the client ended up
        // talking to the replacement, not the one it just stopped.
        assertEquals(shutdownCalls, 1);
        assertEquals(
          started.status === "ready" &&
            started.url.includes(String(replacement?.address.port)),
          true,
          "the client must not report the replaced endpoint as ready",
        );
      } finally {
        await client.close();
      }
    } finally {
      await replacement?.stop();
      await foreign.stop();
    }
  });
});

test("ensureStarted leaves a compatible Core alone when asked", async () => {
  await withStateDir(async (stateDir, paths) => {
    let shutdownCalls = 0;
    const handle = await startServer(TEST_VERSION, () => {
      shutdownCalls++;
    });
    let launches = 0;
    try {
      await new CoreRegistry(paths).write(
        registration(handle.address.port, { version: TEST_VERSION }),
      );
      const replaced: CoreRegistration[] = [];
      const client = new CoreClient(
        clientOptions(stateDir, {
          launcher: () => {
            launches++;
            return Promise.resolve();
          },
        }),
      );
      try {
        const started = await client.ensureStarted(undefined, {
          replaceIncompatible: true,
          onReplacingIncompatible: (value) => replaced.push(value),
        });
        assertEquals(started.status, "ready");
        // A healthy Core must never be signalled, however the option is set.
        assertEquals(replaced.length, 0);
        assertEquals(shutdownCalls, 0);
        assertEquals(launches, 0);
      } finally {
        await client.close();
      }
    } finally {
      await handle.stop();
    }
  });
});

test("ensureStarted reports a replaced Core that never exits", async () => {
  await withStateDir(async (stateDir, paths) => {
    // The registered Core answers `core.shutdown` but never actually leaves, so
    // racing it for the Core lock would be worse than failing with the mismatch
    // the caller can act on.
    const handle = await startServer(FOREIGN_VERSION);
    try {
      await new CoreRegistry(paths).write(registration(handle.address.port));
      const client = new CoreClient(clientOptions(stateDir));
      try {
        await assertRejects(
          () =>
            client.ensureStarted(undefined, {
              replaceIncompatible: true,
              replaceTimeoutMs: 120,
            }),
          CoreStartupError,
          "did not shut down in time",
        );
      } finally {
        await client.close();
      }
    } finally {
      await handle.stop();
    }
  });
});
