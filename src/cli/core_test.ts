import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type CoreCommandDependencies,
  type CoreCommandOptions,
  type CoreLifecycleClient,
  type CoreLifecycleDependencies,
  type CorePairOptions,
  type CoreStopClient,
  type CoreStopDependencies,
  type CoreStopRegistryLike,
  launchCoreCommand,
  pairCoreCommand,
  restartCoreCommand,
  runCoreCommand,
  startCoreCommand,
  statusCoreCommand,
  stopCoreCommand,
} from "./core.ts";
import { defaultSettings, type Settings } from "../config/mod.ts";
import { type ResolvedCoreConfig } from "../core/config.ts";
import {
  CoreAuthenticationError,
  CoreClientRpcError,
  type CoreDiscoveryResult,
  CoreIncompatibleError,
} from "../core/client.ts";
import { CorePaths } from "../core/paths.ts";
import { type CoreRegistration, CoreRegistry } from "../core/registry.ts";
import { CORE_METHODS, type CoreShutdownResult } from "../core/protocol.ts";
import type { CoreRuntimeHost } from "../core/runtime.ts";
import {
  CoreServer,
  type CoreServerHandle,
  CoreServerStartError,
} from "../core/server.ts";
import { CORE_PROTOCOL_VERSION } from "../core/server.ts";
import { current as currentVersion } from "../version/version.ts";

const TEST_VERSION = "0.1.0-core-command-test";
const TEST_PROTOCOL_VERSION = 7;

function config(
  overrides: Partial<ResolvedCoreConfig> = {},
): ResolvedCoreConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    auth: false,
    passwords: [],
    ...overrides,
  };
}

function settingsWithCore(core: ResolvedCoreConfig): Settings {
  return {
    ...defaultSettings(),
    core: { ...core },
  } as Settings;
}

function options(
  overrides: Partial<CoreCommandOptions> = {},
): CoreCommandOptions {
  return {
    config: config(),
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    ...overrides,
  };
}

function registration(
  port: number,
  overrides: Partial<CoreRegistration> = {},
): CoreRegistration {
  return {
    id: "existing-core",
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    pid: Deno.pid,
    host: "127.0.0.1",
    port,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function withStateDir(
  test: (stateDir: string, paths: CorePaths) => Promise<void>,
): Promise<void> {
  const stateDir = await Deno.makeTempDir({
    prefix: "opensac-core-command-",
  });
  let testFailed = false;
  let testError: unknown;
  let cleanupError: unknown;
  try {
    await test(stateDir, CorePaths.fromStateDir(stateDir));
  } catch (error) {
    testFailed = true;
    testError = error;
  } finally {
    try {
      await Deno.remove(stateDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) cleanupError = error;
    }
  }
  if (testFailed) throw testError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function waitForRegistration(
  paths: CorePaths,
  predicate: (registration: CoreRegistration) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const registration = await new CoreRegistry(paths).read();
    if (registration !== undefined && predicate(registration)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for Core registration");
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function fakeServerHandle(
  port: number,
  stop: () => Promise<void> = () => Promise.resolve(),
): CoreServerHandle {
  return {
    address: {
      transport: "tcp",
      hostname: "127.0.0.1",
      port,
    },
    url: `http://127.0.0.1:${port}`,
    stop,
  };
}

Deno.test("root command registers core while serve and a2a remain absent", async () => {
  const { createRootCommand } = await import("./command.ts");
  const root = createRootCommand(TEST_VERSION);
  // deno-lint-ignore no-explicit-any
  const names = (root as any).getCommands().map((command: any) =>
    command.getName()
  );
  assert(names.includes("core"));
  assertEquals(names.includes("serve"), false);
  assertEquals(names.includes("a2a"), false);
});

Deno.test("runCoreCommand starts, registers, and awaits complete cleanup", async () => {
  await withStateDir(async (stateDir, paths) => {
    let signalHandler: (() => void) | undefined;
    let stopped = false;
    const lifecycle = runCoreCommand(
      options({ stateDir }),
      {
        addSignalListener: (_signal, handler) => {
          signalHandler ??= handler;
        },
        removeSignalListener: () => {},
      },
    );
    void lifecycle.catch(() => undefined);

    try {
      await waitForRegistration(paths, (registration) => registration.port > 0);
      const registration = await new CoreRegistry(paths).read();
      assert(registration !== undefined);
      assertEquals(registration?.version, TEST_VERSION);
      assertEquals(registration?.protocolVersion, TEST_PROTOCOL_VERSION);
      assertEquals(registration?.host, "127.0.0.1");
      assertEquals(registration?.pid, Deno.pid);
      assertEquals(
        (await (await fetch(
          new URL(
            "/health",
            `http://${registration?.host}:${registration?.port}`,
          ),
        )).json()).healthy,
        true,
      );

      assert(signalHandler !== undefined);
      signalHandler();
      stopped = true;
      assertEquals(await lifecycle, 0);
      assertEquals(await new CoreRegistry(paths).read(), undefined);
      try {
        await Deno.lstat(paths.lockFile);
        throw new Error("Core lock was not removed");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    } finally {
      if (!stopped) signalHandler?.();
      await lifecycle.catch(() => undefined);
    }
  });
});

Deno.test("runCoreCommand treats a post-registration abort as normal shutdown", async () => {
  await withStateDir(async (stateDir, paths) => {
    const realRegistry = new CoreRegistry(paths);
    let signalHandler: (() => void) | undefined;
    let abortTriggered = false;
    const lifecycle = runCoreCommand(
      options({ stateDir }),
      {
        registry: () => ({
          write: async (value: CoreRegistration, signal?: AbortSignal) => {
            await realRegistry.write(value, signal);
            abortTriggered = true;
            if (signalHandler === undefined) {
              throw new Error("signal handler was not installed");
            }
            signalHandler();
          },
          remove: (id: string, signal?: AbortSignal) =>
            realRegistry.remove(id, signal),
        }),
        addSignalListener: (_signal, handler) => {
          signalHandler ??= handler;
        },
        removeSignalListener: () => {},
      },
    );

    try {
      assertEquals(await lifecycle, 0);
      assertEquals(abortTriggered, true);
      assertEquals(await realRegistry.read(), undefined);
      await assertRejects(
        () => Deno.lstat(paths.lockFile),
        Deno.errors.NotFound,
      );
    } finally {
      signalHandler?.();
      await lifecycle.catch(() => undefined);
    }
  });
});

Deno.test("lazy production Core host exposes the production extension handler", async () => {
  await withStateDir(async (stateDir) => {
    let runtime: CoreRuntimeHost | undefined;
    const handle = await startCoreCommand(options({ stateDir }), {
      createServer: (serverOptions) => {
        runtime = serverOptions.runtime;
        return new CoreServer(serverOptions);
      },
    });
    try {
      assert(runtime?.extension !== undefined);
    } finally {
      await handle.stop();
      await handle.done;
    }
  });
});

Deno.test("startCoreCommand stop is idempotent and done waits for cleanup", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startCoreCommand(options({ stateDir }));
    try {
      let doneSettled = false;
      void handle.done.then(() => {
        doneSettled = true;
      });
      assertEquals(doneSettled, false);
      assertEquals(
        ((await new CoreRegistry(paths).read())?.port ?? 0) > 0,
        true,
      );

      await handle.stop();
      await handle.stop();
      assertEquals(await handle.done, 0);
      assertEquals(await new CoreRegistry(paths).read(), undefined);
      try {
        await Deno.lstat(paths.lockFile);
        throw new Error("Core lock was not removed");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    } finally {
      await handle.stop().catch(() => undefined);
      await handle.done;
    }
  });
});

Deno.test("Core command performs one server, registration, and lock cleanup", async () => {
  await withStateDir(async (stateDir) => {
    let acquired = 0;
    let released = 0;
    let writes = 0;
    let removes = 0;
    let serverStops = 0;
    const fakeHandle = {
      address: {
        transport: "tcp" as const,
        hostname: "127.0.0.1",
        port: 4310,
      },
      url: "http://127.0.0.1:4310",
      stop: () => {
        serverStops++;
        return Promise.resolve();
      },
    };
    const handle = await startCoreCommand(options({ stateDir }), {
      acquireLock: () => {
        acquired++;
        return {
          release: () => {
            released++;
          },
        };
      },
      registry: {
        write: () => {
          writes++;
        },
        remove: () => {
          removes++;
        },
      },
      server: {
        start: () => fakeHandle,
      },
    });

    await Promise.all([handle.stop(), handle.stop()]);
    assertEquals(acquired, 1);
    assertEquals(writes, 1);
    assertEquals(serverStops, 1);
    assertEquals(removes, 1);
    assertEquals(released, 1);
    assertEquals(await handle.done, 0);
  });
});

Deno.test("Core command loads settings and writes the configured port", async () => {
  await withStateDir(async (stateDir, paths) => {
    let loadCalls = 0;
    const handle = await startCoreCommand(
      {
        stateDir,
        version: TEST_VERSION,
        protocolVersion: TEST_PROTOCOL_VERSION,
      },
      {
        loadSettings: () => {
          loadCalls++;
          return settingsWithCore(config({ host: "127.0.0.1", port: 0 }));
        },
      },
    );
    try {
      assertEquals(loadCalls, 1);
      assertEquals(
        ((await new CoreRegistry(paths).read())?.port ?? 0) > 0,
        true,
      );
      assertEquals(handle.url.startsWith("http://127.0.0.1:"), true);
    } finally {
      await handle.stop();
      await handle.done;
    }
  });
});

Deno.test("Core command rejects auth without a password before acquiring resources", async () => {
  await withStateDir(async (stateDir, paths) => {
    await assertRejects(
      () =>
        startCoreCommand(
          options({ stateDir, config: config({ auth: true, passwords: [] }) }),
        ),
      Error,
      "password",
    );
    try {
      await Deno.lstat(paths.lockFile);
      throw new Error("Core lock was unexpectedly acquired");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  });
});

Deno.test("Core command reports a fixed-port conflict and releases its lock", async () => {
  const stateDir = await Deno.makeTempDir({
    prefix: "opensac-core-port-conflict-",
  });
  let conflictingServer: Deno.HttpServer | undefined;
  try {
    let resolveAddress!: (address: Deno.Addr) => void;
    const addressReady = new Promise<Deno.Addr>((resolve) => {
      resolveAddress = resolve;
    });
    conflictingServer = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen: (address) => resolveAddress(address),
      },
      () => new Response("conflict"),
    );
    const address = await addressReady as Deno.NetAddr;

    const paths = CorePaths.fromStateDir(stateDir);
    await assertRejects(
      () =>
        startCoreCommand(
          options({ stateDir, config: config({ port: address.port }) }),
        ),
      Error,
      String(address.port),
    );
    try {
      await Deno.lstat(paths.lockFile);
      throw new Error("Core lock was not released after port conflict");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } finally {
    await conflictingServer?.shutdown();
    if (conflictingServer !== undefined) await conflictingServer.finished;
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("Core command dependency failure is surfaced to the caller", async () => {
  await withStateDir(async (stateDir) => {
    const error = new Error("injected Core lock failure");
    await assertRejects(
      () =>
        startCoreCommand(
          options({ stateDir }),
          {
            acquireLock: () => Promise.reject(error),
          } satisfies Partial<CoreCommandDependencies>,
        ),
      Error,
      "injected Core lock failure",
    );
  });
});

Deno.test("stop retains ownership when server shutdown is uncertain", async () => {
  await withStateDir(async (stateDir) => {
    const shutdownError = new Error("listener shutdown failed");
    let removes = 0;
    let releases = 0;
    const handle = await startCoreCommand(options({ stateDir }), {
      acquireLock: () => ({
        release: () => {
          releases++;
        },
      }),
      registry: {
        write: () => {},
        remove: () => {
          removes++;
        },
      },
      server: {
        start: () =>
          fakeServerHandle(4310, () => Promise.reject(shutdownError)),
      },
    });

    const error = await assertRejects(() => handle.stop(), AggregateError);
    assert(error instanceof AggregateError);
    assert(error.errors.includes(shutdownError));
    assertEquals(await handle.done, 1);
    assertEquals(removes, 0);
    assertEquals(releases, 0);
  });
});

Deno.test("stop aggregates lock release failures after clean server cleanup", async () => {
  await withStateDir(async (stateDir) => {
    const releaseError = new Error("lock release failed");
    let removes = 0;
    let releases = 0;
    const handle = await startCoreCommand(options({ stateDir }), {
      acquireLock: () => ({
        release: () => {
          releases++;
          return Promise.reject(releaseError);
        },
      }),
      registry: {
        write: () => {},
        remove: () => {
          removes++;
        },
      },
      server: {
        start: () => fakeServerHandle(4310),
      },
    });

    const error = await assertRejects(() => handle.stop(), AggregateError);
    assert(error instanceof AggregateError);
    assert(error.errors.includes(releaseError));
    assertEquals(await handle.done, 1);
    assertEquals(removes, 1);
    assertEquals(releases, 1);
  });
});

Deno.test("startup cleanup retains the lock when server shutdown fails", async () => {
  await withStateDir(async (stateDir) => {
    const writeError = new Error("registration write failed");
    const shutdownError = new Error("server shutdown failed");
    let releases = 0;
    const error = await assertRejects(
      () =>
        startCoreCommand(options({ stateDir }), {
          acquireLock: () => ({
            release: () => {
              releases++;
            },
          }),
          registry: {
            write: () => Promise.reject(writeError),
            remove: () => {},
          },
          server: {
            start: () =>
              fakeServerHandle(4310, () => Promise.reject(shutdownError)),
          },
        }),
      AggregateError,
    );
    assert(error instanceof AggregateError);
    assert(error.errors.includes(writeError));
    assert(error.errors.includes(shutdownError));
    assertEquals(releases, 0);
  });
});

Deno.test("partial CoreServer start cleanup failure retains the lock", async () => {
  await withStateDir(async (stateDir, paths) => {
    const cleanupError = new Error("partial listener cleanup failed");
    let partialListener: Deno.HttpServer | undefined;

    try {
      let resolveAddress!: (address: Deno.Addr) => void;
      const addressReady = new Promise<Deno.Addr>((resolve) => {
        resolveAddress = resolve;
      });
      const error = await assertRejects(
        () =>
          startCoreCommand(options({ stateDir }), {
            server: {
              start: async () => {
                partialListener = Deno.serve(
                  {
                    hostname: "127.0.0.1",
                    port: 0,
                    onListen: (address) => resolveAddress(address),
                  },
                  () => new Response("partial"),
                );
                await addressReady;
                throw new CoreServerStartError(
                  "partial listener startup failed",
                  { cleanupError },
                );
              },
            },
          }),
        AggregateError,
      );
      assert(error instanceof AggregateError);
      assert(error.errors.includes(cleanupError));
      assertEquals((await Deno.lstat(paths.lockFile)).isDirectory, true);
      assertEquals(await new CoreRegistry(paths).read(), undefined);
    } finally {
      await partialListener?.shutdown();
      if (partialListener !== undefined) await partialListener.finished;
    }
  });
});

Deno.test("registration write failure releases ownership after server stops", async () => {
  await withStateDir(async (stateDir) => {
    const writeError = new Error("registration write failed");
    let removes = 0;
    let releases = 0;
    const error = await assertRejects(
      () =>
        startCoreCommand(options({ stateDir }), {
          acquireLock: () => ({
            release: () => {
              releases++;
            },
          }),
          registry: {
            write: () => Promise.reject(writeError),
            remove: () => {
              removes++;
            },
          },
          server: {
            start: () => fakeServerHandle(4310),
          },
        }),
      Error,
      "registration write failed",
    );
    assertEquals(error, writeError);
    assertEquals(removes, 1);
    assertEquals(releases, 1);
  });
});

Deno.test("runCoreCommand aborts a blocked startup and removes listeners", async () => {
  await withStateDir(async (stateDir) => {
    let signalHandler: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    let removedSignals = 0;
    const lifecycle = runCoreCommand(options({ stateDir }), {
      acquireLock: (_paths, signal?: AbortSignal) => {
        receivedSignal = signal;
        if (signal === undefined) {
          return Promise.reject(new Error("startup signal was not propagated"));
        }
        return new Promise((_resolve, reject) => {
          const abort = () =>
            reject(new DOMException("startup aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
      addSignalListener: (_signal, handler) => {
        signalHandler ??= handler;
      },
      removeSignalListener: () => {
        removedSignals++;
      },
    });
    void lifecycle.catch(() => undefined);

    try {
      await waitFor(
        () => receivedSignal !== undefined,
        "the startup dependency to receive a signal",
      );
      assert(signalHandler !== undefined);
      signalHandler();
      assertEquals(await lifecycle, 1);
      assertEquals(receivedSignal?.aborted, true);
      assertEquals(removedSignals, 2);
    } finally {
      if (receivedSignal !== undefined && !receivedSignal.aborted) {
        signalHandler?.();
      }
      await lifecycle.catch(() => undefined);
    }
  });
});

Deno.test("startCoreCommand reuses a compatible healthy registration", async () => {
  await withStateDir(async (stateDir, paths) => {
    const existing = await new CoreServer({
      config: config(),
      version: TEST_VERSION,
      protocolVersion: TEST_PROTOCOL_VERSION,
    }).start();
    await new CoreRegistry(paths).write(
      registration(existing.address.port, { pid: 999_999_99 }),
    );
    let serverStarts = 0;
    let writes = 0;
    let removes = 0;
    let releases = 0;

    try {
      const handle = await startCoreCommand(options({ stateDir }), {
        acquireLock: () => ({
          release: () => {
            releases++;
          },
        }),
        registry: {
          write: () => {
            writes++;
          },
          remove: () => {
            removes++;
          },
        },
        server: {
          start: () => {
            serverStarts++;
            return fakeServerHandle(4999);
          },
        },
      });

      assertEquals(handle.url, existing.url);
      assertEquals(serverStarts, 0);
      assertEquals(writes, 0);
      await handle.stop();
      assertEquals(removes, 0);
      assertEquals(releases, 1);
      assertEquals(
        (await (await fetch(new URL("/health", existing.url))).json()).healthy,
        true,
      );
    } finally {
      await existing.stop();
    }
  });
});

Deno.test("a replaced registration is not accepted as the current Core", async () => {
  await withStateDir(async (stateDir, paths) => {
    const original = registration(4310);
    const replacement = registration(4310, { id: "replacement-core" });
    await new CoreRegistry(paths).write(original);
    await new CoreRegistry(paths).write(replacement);
    let serverStarts = 0;
    let releases = 0;

    await assertRejects(
      () =>
        startCoreCommand(options({ stateDir }), {
          acquireLock: () => ({
            release: () => {
              releases++;
            },
          }),
          discoverCore: () => ({
            status: "ready",
            registration: original,
            info: {
              version: TEST_VERSION,
              protocolVersion: TEST_PROTOCOL_VERSION,
              coreProtocolVersion: CORE_PROTOCOL_VERSION,
              features: [],
            },
            health: {
              healthy: true,
              version: TEST_VERSION,
              protocolVersion: TEST_PROTOCOL_VERSION,
            },
            url: "http://127.0.0.1:4310",
          }),
          registry: {
            write: () => {},
            remove: () => {},
          },
          server: {
            start: () => {
              serverStarts++;
              return fakeServerHandle(4310);
            },
          },
        }),
      Error,
      "changed during discovery",
    );
    assertEquals(serverStarts, 0);
    assertEquals(releases, 1);
  });
});

Deno.test("a version-mismatched registered Core is not reused or overwritten", async () => {
  await withStateDir(async (stateDir, paths) => {
    let probe: Deno.HttpServer | undefined;
    try {
      let resolveAddress!: (address: Deno.Addr) => void;
      const addressReady = new Promise<Deno.Addr>((resolve) => {
        resolveAddress = resolve;
      });
      probe = Deno.serve(
        {
          hostname: "127.0.0.1",
          port: 0,
          onListen: (address) => resolveAddress(address),
        },
        async (request) => {
          if (new URL(request.url).pathname === "/health") {
            return new Response(JSON.stringify({ healthy: true }), {
              headers: { "content-type": "application/json" },
            });
          }
          const body = await request.json() as {
            id: string | number | null;
            method: string;
          };
          const result = body.method === CORE_METHODS.info
            ? {
              version: "wrong-version",
              protocolVersion: TEST_PROTOCOL_VERSION,
              coreProtocolVersion: CORE_PROTOCOL_VERSION,
              features: [],
            }
            : {
              healthy: true,
              version: TEST_VERSION,
              protocolVersion: TEST_PROTOCOL_VERSION,
            };
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
            { headers: { "content-type": "application/json" } },
          );
        },
      );
      const address = await addressReady as Deno.NetAddr;
      await new CoreRegistry(paths).write(registration(address.port));
      let serverStarts = 0;
      let writes = 0;
      let releases = 0;

      await assertRejects(
        () =>
          startCoreCommand(
            options({ stateDir, config: config({ port: address.port }) }),
            {
              acquireLock: () => ({
                release: () => {
                  releases++;
                },
              }),
              registry: {
                write: () => {
                  writes++;
                },
                remove: () => {},
              },
              server: {
                start: () => {
                  serverStarts++;
                  return fakeServerHandle(4999);
                },
              },
            },
          ),
        Error,
        "incompatible",
      );
      assertEquals(serverStarts, 0);
      assertEquals(writes, 0);
      assertEquals(releases, 1);
    } finally {
      await probe?.shutdown();
      if (probe !== undefined) await probe.finished;
    }
  });
});

Deno.test("fixed-port classification ignores a healthy Core on another port", async () => {
  await withStateDir(async (stateDir, paths) => {
    const configuredPort = 4311;
    const healthyPort = 4312;
    const healthyRegistration = registration(healthyPort);
    await new CoreRegistry(paths).write(healthyRegistration);
    let discoveryCalls = 0;
    let serverStarts = 0;
    let releases = 0;

    const error = await assertRejects(
      () =>
        startCoreCommand(
          options({ stateDir, config: config({ port: configuredPort }) }),
          {
            acquireLock: () => ({
              release: () => {
                releases++;
              },
            }),
            discoverCore: () => {
              discoveryCalls++;
              if (discoveryCalls === 1) {
                return {
                  status: "stale",
                  registration: healthyRegistration,
                  reason: "startup discovery raced registration",
                };
              }
              return {
                status: "ready",
                registration: healthyRegistration,
                info: {
                  version: TEST_VERSION,
                  protocolVersion: TEST_PROTOCOL_VERSION,
                  coreProtocolVersion: CORE_PROTOCOL_VERSION,
                  features: [],
                },
                health: {
                  healthy: true,
                  version: TEST_VERSION,
                  protocolVersion: TEST_PROTOCOL_VERSION,
                },
                url: `http://127.0.0.1:${healthyPort}`,
              };
            },
            registry: {
              write: () => {},
              remove: () => {},
            },
            server: {
              start: () => {
                serverStarts++;
                throw new Deno.errors.AddrInUse();
              },
            },
          },
        ),
      Error,
    );
    assertEquals(error.message.includes("healthy registered Core"), false);
    assertEquals(error.message.includes("unrelated process"), true);
    assertEquals(discoveryCalls, 2);
    assertEquals(serverStarts, 1);
    assertEquals(releases, 1);
  });
});

Deno.test("fixed-port classification rejects redirects as unrelated", async () => {
  await withStateDir(async (stateDir, paths) => {
    let probe: Deno.HttpServer | undefined;
    try {
      let resolveAddress!: (address: Deno.Addr) => void;
      const addressReady = new Promise<Deno.Addr>((resolve) => {
        resolveAddress = resolve;
      });
      probe = Deno.serve(
        {
          hostname: "127.0.0.1",
          port: 0,
          onListen: (address) => resolveAddress(address),
        },
        (request) => {
          if (new URL(request.url).pathname === "/health") {
            return new Response(JSON.stringify({ healthy: true }), {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:1/redirected" },
          });
        },
      );
      const address = await addressReady as Deno.NetAddr;
      await new CoreRegistry(paths).write(registration(address.port));

      const error = await assertRejects(
        () =>
          startCoreCommand(
            options({ stateDir, config: config({ port: address.port }) }),
          ),
        Error,
      );
      assertEquals(error.message.includes("healthy registered Core"), false);
      assertEquals(error.message.includes("unrelated process"), true);
    } finally {
      await probe?.shutdown();
      if (probe !== undefined) await probe.finished;
    }
  });
});

// Keep the imported production version visible in this focused suite: the
// command must use the same version source as the process entry point unless
// a test explicitly supplies a deterministic override.
Deno.test("Core command defaults use the process version source", () => {
  assert(currentVersion().trim().length > 0);
  assertEquals(CORE_PROTOCOL_VERSION, 1);
});

// ---------------------------------------------------------------------------
// `opensac core stop`
// ---------------------------------------------------------------------------

function stopOptions(
  overrides: Partial<CoreCommandOptions & { stopTimeoutMs: number }> = {},
): CoreCommandOptions & { stopTimeoutMs?: number } {
  return {
    config: config(),
    stateDir: "core-stop-test",
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    ...overrides,
  };
}

function stopDeps(init: {
  discovery: CoreDiscoveryResult;
  shutdown?: () => Promise<CoreShutdownResult>;
  registry?: CoreStopRegistryLike;
  kills?: Array<[number, string]>;
}): CoreStopDependencies {
  const kills = init.kills ?? [];
  return {
    createClient: (): CoreStopClient => ({
      discover: () => Promise.resolve(init.discovery),
      shutdown: init.shutdown ?? (() => Promise.resolve({ ok: true })),
      close: () => Promise.resolve(),
    }),
    registry: init.registry ?? {
      read: () => Promise.resolve(undefined),
      isCurrent: () => Promise.resolve(true),
    },
    kill: (pid, signalName) => {
      kills.push([pid, signalName]);
    },
    sleep: () => Promise.resolve(),
  };
}

function readyDiscovery(reg: CoreRegistration): CoreDiscoveryResult {
  return {
    status: "ready",
    registration: reg,
    info: {
      version: TEST_VERSION,
      protocolVersion: TEST_PROTOCOL_VERSION,
      coreProtocolVersion: CORE_PROTOCOL_VERSION,
      features: [],
    },
    health: {
      healthy: true,
      version: TEST_VERSION,
      protocolVersion: TEST_PROTOCOL_VERSION,
    },
    url: "http://127.0.0.1:1",
  };
}

function incompatibleDiscovery(reg: CoreRegistration): CoreDiscoveryResult {
  return {
    status: "incompatible",
    registration: reg,
    expectedVersion: "9.9.9",
    expectedProtocolVersion: TEST_PROTOCOL_VERSION,
    error: new CoreIncompatibleError("version mismatch", {
      expectedVersion: "9.9.9",
      expectedProtocolVersion: TEST_PROTOCOL_VERSION,
    }),
  };
}

function methodNotFound(): CoreClientRpcError {
  return new CoreClientRpcError(
    { code: -32601, message: "Method not found" },
    1,
  );
}

async function deadPid(): Promise<number> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", ""],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  await child.status;
  return child.pid;
}

Deno.test("stopCoreCommand reports absent when no Core is registered", async () => {
  const outcome = await stopCoreCommand(
    stopOptions(),
    stopDeps({ discovery: { status: "missing" } }),
  );
  assertEquals(outcome, { status: "absent", exited: true, signalled: false });
});

Deno.test("stopCoreCommand reports absent for a stale registration whose process is gone", async () => {
  const reg = registration(4096, { pid: await deadPid() });
  const outcome = await stopCoreCommand(
    stopOptions(),
    stopDeps({
      discovery: {
        status: "stale",
        registration: reg,
        reason: "registered Core process is not running",
      },
    }),
  );
  assertEquals(outcome, { status: "absent", exited: true, signalled: false });
});

Deno.test("stopCoreCommand refuses to signal a stale Core it cannot verify", async () => {
  const kills: Array<[number, string]> = [];
  const reg = registration(4096, { pid: Deno.pid });
  await assertRejects(
    () =>
      stopCoreCommand(
        stopOptions(),
        stopDeps({
          discovery: {
            status: "stale",
            registration: reg,
            reason: "registered Core endpoint is unreachable",
          },
          kills,
        }),
      ),
    Error,
    "not answering",
  );
  assertEquals(kills, []);
});

Deno.test("stopCoreCommand refuses to signal a Core with foreign authentication", async () => {
  const kills: Array<[number, string]> = [];
  const reg = registration(4096, { pid: Deno.pid });
  await assertRejects(
    () =>
      stopCoreCommand(
        stopOptions(),
        stopDeps({
          discovery: {
            status: "unauthenticated",
            registration: reg,
            error: new CoreAuthenticationError(),
          },
          kills,
        }),
      ),
    Error,
    "different authentication",
  );
  assertEquals(kills, []);
});

Deno.test("stopCoreCommand stops a ready Core through core.shutdown", async () => {
  const kills: Array<[number, string]> = [];
  let shutdownCalls = 0;
  const reg = registration(4096, { pid: Deno.pid });
  const outcome = await stopCoreCommand(
    stopOptions(),
    stopDeps({
      discovery: readyDiscovery(reg),
      shutdown: () => {
        shutdownCalls++;
        return Promise.resolve({ ok: true });
      },
      kills,
    }),
  );
  assertEquals(outcome, { status: "stopped", exited: true, signalled: false });
  assertEquals(shutdownCalls, 1);
  assertEquals(kills, []);
});

Deno.test("stopCoreCommand reports a requested stop that is still exiting", async () => {
  const reg = registration(4096, { pid: Deno.pid });
  const outcome = await stopCoreCommand(
    stopOptions({ stopTimeoutMs: 0 }),
    stopDeps({
      discovery: readyDiscovery(reg),
      registry: {
        read: () => Promise.resolve(reg),
        isCurrent: () => Promise.resolve(true),
      },
    }),
  );
  assertEquals(outcome, { status: "stopped", exited: false, signalled: false });
});

Deno.test("stopCoreCommand signals an older Core that predates core.shutdown", async () => {
  const kills: Array<[number, string]> = [];
  const reg = registration(4096, { pid: Deno.pid });
  const outcome = await stopCoreCommand(
    stopOptions(),
    stopDeps({
      discovery: incompatibleDiscovery(reg),
      shutdown: () => Promise.reject(methodNotFound()),
      registry: {
        read: () => Promise.resolve(undefined),
        isCurrent: () => Promise.resolve(true),
      },
      kills,
    }),
  );
  assertEquals(outcome, { status: "stopped", exited: true, signalled: true });
  assertEquals(kills, [[reg.pid, "SIGTERM"]]);
});

Deno.test("stopCoreCommand fails closed when registration identity cannot be proven", async () => {
  const kills: Array<[number, string]> = [];
  const reg = registration(4096, { pid: Deno.pid });
  await assertRejects(
    () =>
      stopCoreCommand(
        stopOptions(),
        stopDeps({
          discovery: incompatibleDiscovery(reg),
          shutdown: () => Promise.reject(methodNotFound()),
          registry: {
            read: () => Promise.resolve(reg),
            isCurrent: () => Promise.resolve(false),
          },
          kills,
        }),
      ),
    CoreClientRpcError,
  );
  assertEquals(kills, []);
});

Deno.test("stopCoreCommand stops a real Core through the graceful path", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startCoreCommand(options({ stateDir }));
    try {
      await waitForRegistration(paths, () => true);
      const outcome = await stopCoreCommand({
        ...options({ stateDir }),
        stopTimeoutMs: 5_000,
      });
      assertEquals(outcome, {
        status: "stopped",
        exited: true,
        signalled: false,
      });
      assertEquals(await handle.done, 0);
    } finally {
      await handle.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// `opensac core status` / `start` / `restart` / `pair`
// ---------------------------------------------------------------------------

interface LifecycleProbe {
  discoverCalls: number;
  ensureStartedCalls: number;
  selectedPasswords: Array<string | undefined>;
  closeCalls: number;
}

function lifecycleProbe(): LifecycleProbe {
  return {
    discoverCalls: 0,
    ensureStartedCalls: 0,
    selectedPasswords: [],
    closeCalls: 0,
  };
}

/** Builds an injected lifecycle client draining `discoveries` in order. */
function lifecycleClient(
  probe: LifecycleProbe,
  discoveries: CoreDiscoveryResult[],
  started?: CoreDiscoveryResult,
): CoreLifecycleClient {
  const queue = [...discoveries];
  let last: CoreDiscoveryResult = { status: "missing" };
  return {
    discover: () => {
      probe.discoverCalls++;
      const next = queue.shift();
      if (next !== undefined) last = next;
      return Promise.resolve(last);
    },
    ensureStarted: () => {
      probe.ensureStartedCalls++;
      return Promise.resolve(started ?? last);
    },
    setPassword: (password) => void probe.selectedPasswords.push(password),
    close: () => {
      probe.closeCalls++;
      return Promise.resolve();
    },
  };
}

function lifecycleOptions(
  overrides: Partial<CorePairOptions> = {},
): CorePairOptions {
  return {
    config: config(),
    stateDir: "core-lifecycle-test",
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    ...overrides,
  };
}

function lifecycleDeps(
  probe: LifecycleProbe,
  init: {
    discoveries: CoreDiscoveryResult[];
    started?: CoreDiscoveryResult;
    now?: () => number;
  },
): CoreLifecycleDependencies {
  return {
    createClient: () => lifecycleClient(probe, init.discoveries, init.started),
    ...(init.now === undefined ? {} : { now: init.now }),
  };
}

Deno.test("statusCoreCommand reports a running Core with its uptime", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const outcome = await statusCoreCommand(
    lifecycleOptions({ config: config({ auth: true, passwords: ["pw"] }) }),
    lifecycleDeps(probe, {
      discoveries: [readyDiscovery(reg)],
      now: () => reg.startedAt + 65_000,
    }),
  );
  assertEquals(outcome, {
    status: "ready",
    running: true,
    auth: true,
    url: "http://127.0.0.1:1",
    pid: reg.pid,
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    startedAt: reg.startedAt,
    uptimeMs: 65_000,
  });
  assertEquals(probe.ensureStartedCalls, 0);
  assertEquals(probe.closeCalls, 1);
});

Deno.test("statusCoreCommand reports a missing Core without starting one", async () => {
  const probe = lifecycleProbe();
  const outcome = await statusCoreCommand(
    lifecycleOptions(),
    lifecycleDeps(probe, { discoveries: [{ status: "missing" }] }),
  );
  assertEquals(outcome, {
    status: "missing",
    running: false,
    auth: false,
    reason: "no registered Core",
  });
  assertEquals(probe.ensureStartedCalls, 0);
  assertEquals(probe.closeCalls, 1);
});

Deno.test("statusCoreCommand projects a stale registration as not running", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096, { pid: await deadPid() });
  const outcome = await statusCoreCommand(
    lifecycleOptions(),
    lifecycleDeps(probe, {
      discoveries: [{
        status: "stale",
        registration: reg,
        reason: "registered Core process is not running",
      }],
    }),
  );
  assertEquals(outcome, {
    status: "stale",
    running: false,
    auth: false,
    pid: reg.pid,
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    startedAt: reg.startedAt,
    reason: "registered Core process is not running",
  });
});

Deno.test("launchCoreCommand reuses a healthy Core instead of launching a second one", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const outcome = await launchCoreCommand(
    lifecycleOptions(),
    lifecycleDeps(probe, { discoveries: [readyDiscovery(reg)] }),
  );
  assertEquals(outcome, {
    status: "running",
    url: "http://127.0.0.1:1",
    pid: reg.pid,
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
  });
  assertEquals(probe.ensureStartedCalls, 0);
  assertEquals(probe.closeCalls, 1);
});

Deno.test("launchCoreCommand starts a missing Core exactly once", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const outcome = await launchCoreCommand(
    lifecycleOptions(),
    lifecycleDeps(probe, {
      discoveries: [{ status: "missing" }],
      started: readyDiscovery(reg),
    }),
  );
  assertEquals(outcome.status, "started");
  assertEquals(outcome.pid, reg.pid);
  assertEquals(probe.ensureStartedCalls, 1);
});

Deno.test("launchCoreCommand refuses to replace an incompatible registered Core", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  await assertRejects(
    () =>
      launchCoreCommand(
        lifecycleOptions(),
        lifecycleDeps(probe, { discoveries: [incompatibleDiscovery(reg)] }),
      ),
    Error,
    "incompatible",
  );
  assertEquals(probe.ensureStartedCalls, 0);
});

Deno.test("restartCoreCommand stops the running Core before starting a replacement", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const stopped: string[] = [];
  const outcome = await restartCoreCommand(lifecycleOptions(), {
    ...lifecycleDeps(probe, {
      discoveries: [{ status: "missing" }],
      started: readyDiscovery(reg),
    }),
    stop: (stoppedOptions) => {
      stopped.push(stoppedOptions.version ?? "");
      return Promise.resolve({
        status: "stopped" as const,
        exited: true,
        signalled: false,
      });
    },
  });
  assertEquals(stopped, [TEST_VERSION]);
  assertEquals(outcome.stopped, {
    status: "stopped",
    exited: true,
    signalled: false,
  });
  assertEquals(outcome.started.status, "started");
  assertEquals(probe.ensureStartedCalls, 1);
});

Deno.test("restartCoreCommand starts a Core when none was running", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const outcome = await restartCoreCommand(lifecycleOptions(), {
    ...lifecycleDeps(probe, {
      discoveries: [{ status: "missing" }],
      started: readyDiscovery(reg),
    }),
    stop: () =>
      Promise.resolve({
        status: "absent" as const,
        exited: true,
        signalled: false,
      }),
  });
  assertEquals(outcome.stopped.status, "absent");
  assertEquals(outcome.started.status, "started");
});

Deno.test("restartCoreCommand refuses to start while the old Core is still exiting", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  await assertRejects(
    () =>
      restartCoreCommand(lifecycleOptions(), {
        ...lifecycleDeps(probe, {
          discoveries: [{ status: "missing" }],
          started: readyDiscovery(reg),
        }),
        stop: () =>
          Promise.resolve({
            status: "stopped" as const,
            exited: false,
            signalled: false,
          }),
      }),
    Error,
    "did not exit",
  );
  assertEquals(probe.ensureStartedCalls, 0);
});

Deno.test("pairCoreCommand reports the paired endpoint without a password", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const outcome = await pairCoreCommand(
    lifecycleOptions(),
    lifecycleDeps(probe, { discoveries: [readyDiscovery(reg)] }),
  );
  assertEquals(outcome, {
    url: "http://127.0.0.1:1",
    pid: reg.pid,
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    auth: false,
    verified: false,
  });
  assertEquals(probe.selectedPasswords, []);
  assertEquals(probe.closeCalls, 1);
});

Deno.test("pairCoreCommand verifies a candidate password against the Core", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  const outcome = await pairCoreCommand(
    lifecycleOptions({
      config: config({ auth: true, passwords: ["secret"] }),
      password: "secret",
    }),
    lifecycleDeps(probe, {
      discoveries: [readyDiscovery(reg), readyDiscovery(reg)],
    }),
  );
  assertEquals(outcome.verified, true);
  assertEquals(probe.selectedPasswords, ["secret"]);
});

Deno.test("pairCoreCommand rejects a candidate password the Core refuses", async () => {
  const probe = lifecycleProbe();
  const reg = registration(4096);
  await assertRejects(
    () =>
      pairCoreCommand(
        lifecycleOptions({
          config: config({ auth: true, passwords: ["secret"] }),
          password: "wrong",
        }),
        lifecycleDeps(probe, {
          discoveries: [
            readyDiscovery(reg),
            {
              status: "unauthenticated",
              registration: reg,
              error: new CoreAuthenticationError(),
            },
          ],
        }),
      ),
    Error,
    "rejected",
  );
  assertEquals(probe.selectedPasswords, ["wrong"]);
});

Deno.test("pairCoreCommand refuses a password when core auth is disabled", async () => {
  const probe = lifecycleProbe();
  await assertRejects(
    () =>
      pairCoreCommand(
        lifecycleOptions({ password: "secret" }),
        lifecycleDeps(probe, { discoveries: [] }),
      ),
    Error,
    "core.auth is disabled",
  );
  assertEquals(probe.closeCalls, 0);
});

Deno.test("pairCoreCommand explains how to start a Core that is not running", async () => {
  const probe = lifecycleProbe();
  await assertRejects(
    () =>
      pairCoreCommand(
        lifecycleOptions(),
        lifecycleDeps(probe, { discoveries: [{ status: "missing" }] }),
      ),
    Error,
    "opensac core start",
  );
  assertEquals(probe.closeCalls, 1);
});

Deno.test("status, start, and pair project a real running Core", async () => {
  await withStateDir(async (stateDir) => {
    const handle = await startCoreCommand(options({ stateDir }));
    try {
      const deps = { stateDir };
      const status = await statusCoreCommand(options({ stateDir }), deps);
      assertEquals(status.running, true);
      assertEquals(status.url, handle.url);
      assertEquals(status.uptimeMs !== undefined && status.uptimeMs >= 0, true);

      const start = await launchCoreCommand(options({ stateDir }), deps);
      assertEquals(start.status, "running");
      assertEquals(start.url, handle.url);

      const pair = await pairCoreCommand(options({ stateDir }), deps);
      assertEquals(pair.url, handle.url);
      assertEquals(pair.auth, false);
      assertEquals(pair.verified, false);
    } finally {
      await handle.stop();
    }
  });
});
