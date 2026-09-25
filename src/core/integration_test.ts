import { assert, assertEquals } from "@std/assert";
import { type ResolvedCoreConfig } from "./config.ts";
import { CoreClient, type CoreLauncher } from "./client.ts";
import { CoreLockBusyError } from "./lock.ts";
import { CorePaths } from "./paths.ts";
import { CoreRegistry } from "./registry.ts";
import { CORE_METHODS, type CoreInfo } from "./protocol.ts";
import {
  CORE_PROTOCOL_VERSION,
  CoreServer,
  type CoreServerOptions,
} from "./server.ts";
import { type CoreCommandHandle, startCoreCommand } from "../cli/core.ts";

const TEST_VERSION = "0.1.0-core-integration-test";
const TEST_PROTOCOL_VERSION = 23;
const PASSWORDS = [
  "integration-password-one",
  "integration-password-two",
];
const EXPECTED_INFO: CoreInfo = {
  version: TEST_VERSION,
  protocolVersion: TEST_PROTOCOL_VERSION,
  coreProtocolVersion: CORE_PROTOCOL_VERSION,
  features: [CORE_METHODS.health, CORE_METHODS.info],
};

// This smoke test covers the infrastructure foundation only. It does not claim
// that TUI, CLI, or ACP have migrated to the Core runtime host.

function coreConfig(): ResolvedCoreConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    auth: true,
    passwords: [...PASSWORDS],
  };
}

function commandOptions(stateDir: string) {
  return {
    stateDir,
    config: coreConfig(),
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
  };
}

function clientOptions(
  stateDir: string,
  overrides: Partial<{
    launcher: CoreLauncher;
    password: string;
    startTimeoutMs: number;
  }> = {},
) {
  return {
    stateDir,
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    config: coreConfig(),
    startTimeoutMs: 3_000,
    ...overrides,
  };
}

async function withStateDir(
  test: (stateDir: string, paths: CorePaths) => Promise<void>,
): Promise<void> {
  const stateDir = await Deno.makeTempDir({
    prefix: "opensac-core-integration-",
  });
  try {
    await test(stateDir, CorePaths.fromStateDir(stateDir));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

async function waitForRegistration(
  paths: CorePaths,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const registration = await new CoreRegistry(paths).read();
    if (registration !== undefined && registration.port > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for Core registration");
}

async function assertLiveCore(
  client: CoreClient,
): Promise<void> {
  assertEquals((await client.health()).healthy, true);
  assertEquals(await client.call<CoreInfo>(CORE_METHODS.info), EXPECTED_INFO);
}

Deno.test("Core foundation exposes the locked, registered, authenticated client path", async () => {
  await withStateDir(async (firstStateDir, firstPaths) => {
    const handle = await startCoreCommand(commandOptions(firstStateDir));
    let client: CoreClient | undefined;

    try {
      client = new CoreClient(
        clientOptions(firstStateDir, { password: PASSWORDS[1] }),
      );
      const registration = await new CoreRegistry(firstPaths).read();
      assert(registration !== undefined);
      assertEquals(registration?.version, TEST_VERSION);
      assertEquals(registration?.protocolVersion, TEST_PROTOCOL_VERSION);
      assertEquals(registration?.port > 0, true);
      assertEquals((await Deno.lstat(firstPaths.lockFile)).isDirectory, true);

      const discovered = await client.discover();
      assertEquals(discovered.status, "ready");
      await assertLiveCore(client);
    } finally {
      try {
        await client?.close();
      } finally {
        await handle.stop();
      }
    }

    assertEquals(await new CoreRegistry(firstPaths).read(), undefined);

    await withStateDir(async (secondStateDir, secondPaths) => {
      let secondHandle: CoreCommandHandle | undefined;
      let secondClient: CoreClient | undefined;
      const launcher: CoreLauncher = async () => {
        secondHandle = await startCoreCommand(commandOptions(secondStateDir));
      };

      try {
        secondClient = new CoreClient(
          clientOptions(secondStateDir, {
            launcher,
            password: PASSWORDS[0],
          }),
        );
        const started = await secondClient.ensureStarted();
        assertEquals(started.status, "ready");
        await assertLiveCore(secondClient);
        assert((await new CoreRegistry(secondPaths).read()) !== undefined);
      } finally {
        try {
          await secondClient?.close();
        } finally {
          await secondHandle?.stop();
        }
      }

      assertEquals(await new CoreRegistry(secondPaths).read(), undefined);
    });
  });
});

Deno.test("concurrent Core clients share one locked registration and server", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handles: CoreCommandHandle[] = [];
    let serverStarts = 0;

    const launch: CoreLauncher = async () => {
      try {
        const handle = await startCoreCommand(commandOptions(stateDir), {
          createServer: (serverOptions: CoreServerOptions) => {
            serverStarts++;
            return new CoreServer(serverOptions);
          },
        });
        handles.push(handle);
      } catch (error) {
        if (!(error instanceof CoreLockBusyError)) throw error;
        await waitForRegistration(paths);
      }
    };

    let firstClient: CoreClient | undefined;
    let secondClient: CoreClient | undefined;

    try {
      firstClient = new CoreClient(
        clientOptions(stateDir, {
          launcher: launch,
          password: PASSWORDS[0],
        }),
      );
      secondClient = new CoreClient(
        clientOptions(stateDir, {
          launcher: launch,
          password: PASSWORDS[1],
        }),
      );
      const [first, second] = await Promise.all([
        firstClient.ensureStarted(),
        secondClient.ensureStarted(),
      ]);
      assertEquals(first.status, "ready");
      assertEquals(second.status, "ready");
      assertEquals(serverStarts, 1);

      const registration = await new CoreRegistry(paths).read();
      assert(registration !== undefined);
      assertEquals(await new CoreRegistry(paths).isCurrent(registration), true);
      assertEquals(registration.port > 0, true);

      await assertLiveCore(firstClient);
      await assertLiveCore(secondClient);
    } finally {
      try {
        await firstClient?.close();
      } finally {
        try {
          await secondClient?.close();
        } finally {
          for (const handle of handles) await handle.stop();
        }
      }
    }

    assertEquals(await new CoreRegistry(paths).read(), undefined);
  });
});
