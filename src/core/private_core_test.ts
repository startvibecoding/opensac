import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import { basename, join } from "../compat/path.ts";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";
import { coreResult, type CoreRpcRequest } from "./protocol.ts";
import { CORE_PROTOCOL_VERSION } from "./server.ts";
import { privateCoreConfig, startPrivateCore } from "./private_core.ts";
import { type CoreCommandHandle, startCoreCommand } from "../cli/core.ts";
import { test } from "#testing";

const TEST_VERSION = "0.1.0-private-core-test";
const TEST_PROTOCOL_VERSION = 3;

async function withParentDir(
  test: (parentDir: string) => Promise<void>,
): Promise<void> {
  const parentDir = await Deno.makeTempDir({
    prefix: "opensac-private-core-",
  });
  try {
    await test(parentDir);
  } finally {
    await Deno.remove(parentDir, { recursive: true });
  }
}

async function directoryEntries(directory: string): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    entries.push(entry.name);
  }
  return entries;
}

function stubRegistration(port: number): CoreRegistration {
  return {
    id: "stub-private-core",
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    pid: Deno.pid,
    host: "127.0.0.1",
    port,
    startedAt: Date.now(),
  };
}

/** A minimal Core endpoint that acknowledges shutdown but never exits. */
async function startStubCore(): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  let resolvePort!: (port: number) => void;
  const portReady = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => resolvePort(address.port),
    },
    async (request) => {
      const body = await request.json() as CoreRpcRequest;
      switch (body.method) {
        case "core.info":
          return Response.json(
            coreResult(body.id, {
              version: TEST_VERSION,
              protocolVersion: TEST_PROTOCOL_VERSION,
              coreProtocolVersion: CORE_PROTOCOL_VERSION,
              features: [],
            }),
          );
        case "core.health":
          return Response.json(
            coreResult(body.id, {
              healthy: true,
              version: TEST_VERSION,
              protocolVersion: TEST_PROTOCOL_VERSION,
            }),
          );
        default:
          return Response.json(coreResult(body.id, { ok: true }));
      }
    },
  );
  return {
    port: await portReady,
    stop: async () => {
      await server.shutdown();
      await server.finished;
    },
  };
}

/** Starts one in-process Core against the private state directory. */
function inProcessCoreLauncher(): {
  launcher: (stateDir: string) => () => Promise<void>;
  owned: () => Promise<CoreCommandHandle> | undefined;
} {
  let ownedPromise: Promise<CoreCommandHandle> | undefined;
  return {
    launcher: (stateDir) => () => {
      ownedPromise = startCoreCommand({
        stateDir,
        config: privateCoreConfig(),
        version: TEST_VERSION,
        protocolVersion: TEST_PROTOCOL_VERSION,
      });
      // Match the production launcher contract: a successful launch promise
      // never resolves, it only rejects when the Core cannot start.
      return new Promise<void>(() => {});
    },
    owned: () => ownedPromise,
  };
}

test("startPrivateCore owns an isolated Core that close() shuts down and cleans up", async () => {
  await withParentDir(async (parentDir) => {
    const { launcher, owned } = inProcessCoreLauncher();
    const handle = await startPrivateCore({
      version: TEST_VERSION,
      protocolVersion: TEST_PROTOCOL_VERSION,
      parentDir,
      createLauncher: launcher,
    });
    try {
      const core = await owned();
      assert(core !== undefined);

      // The private Core registers only inside its own state directory.
      const paths = CorePaths.fromStateDir(handle.stateDir);
      assert(await new CoreRegistry(paths).read() !== undefined);
      assertEquals(await directoryEntries(parentDir), [
        basename(handle.stateDir),
      ]);

      const discovered = await handle.client.discover();
      assertEquals(discovered.status, "ready");

      const outcome = await handle.close();
      assertEquals(outcome, { exited: true, cleaned: true });

      // The owned Core ran the full cleanup path: registration removed and
      // the lifecycle exited cleanly.
      assertEquals(await core.done, 0);
      assertEquals(await new CoreRegistry(paths).read(), undefined);
      await assertRejects(() => Deno.stat(handle.stateDir));

      // close() is idempotent and reports the same outcome.
      assertEquals(await handle.close(), { exited: true, cleaned: true });
    } finally {
      const core = await owned();
      if (core !== undefined) await core.stop();
    }
  });
});

test("startPrivateCore cleans up its state directory when the Core never becomes ready", async () => {
  await withParentDir(async (parentDir) => {
    const error = await assertRejects(
      () =>
        startPrivateCore({
          version: TEST_VERSION,
          protocolVersion: TEST_PROTOCOL_VERSION,
          parentDir,
          startTimeoutMs: 50,
          createLauncher: () => () => new Promise<void>(() => {}),
        }),
      Error,
    );
    // The readiness timeout and the startup cancellation race; both are the
    // documented "never became ready" failures.
    assert(
      error.message.includes("ready") || error.message.includes("readiness"),
      `unexpected startup failure: ${error.message}`,
    );
    assertEquals(await directoryEntries(parentDir), []);
  });
});

test("startPrivateCore keeps the private state directory when the Core exit cannot be observed", async () => {
  await withParentDir(async (parentDir) => {
    // A stub Core that acknowledges core.shutdown but never exits and never
    // removes its registration: the exit can never be observed.
    const stub = await startStubCore();
    try {
      const handle = await startPrivateCore({
        version: TEST_VERSION,
        protocolVersion: TEST_PROTOCOL_VERSION,
        parentDir,
        stopTimeoutMs: 0,
        createStateDir: async (parent) => {
          const stateDir = join(parent, "stub-private-core");
          await Deno.mkdir(stateDir, { recursive: true });
          const paths = CorePaths.fromStateDir(stateDir);
          await new CoreRegistry(paths).write(
            stubRegistration(stub.port),
          );
          return stateDir;
        },
      });
      try {
        const outcome = await handle.close();
        // The shutdown request was accepted, but with the Core still current
        // the directory must be kept, not deleted underneath a live process.
        assertEquals(outcome, { exited: false, cleaned: false });
        assert((await directoryEntries(parentDir)).length === 1);
      } finally {
        await Deno.remove(handle.stateDir, { recursive: true });
      }
    } finally {
      await stub.stop();
    }
  });
});
