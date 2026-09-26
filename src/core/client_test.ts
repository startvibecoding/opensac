import { assert, assertEquals, assertRejects } from "@std/assert";
import { type ResolvedCoreConfig } from "./config.ts";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";
import {
  CORE_METHODS,
  coreError,
  type CoreInfo,
  coreResult,
} from "./protocol.ts";
import { CoreServer, type CoreServerHandle } from "./server.ts";
import { CORE_RUNTIME_METHODS } from "./runtime_protocol.ts";
import {
  CoreClient,
  type CoreClientOptions,
  CoreClientProtocolError,
  CoreClientRpcError,
  CoreIncompatibleError,
  type CoreLauncher,
  CoreStartupError,
} from "./client.ts";

const TEST_VERSION = "0.1.0-client-test";
const TEST_PROTOCOL_VERSION = 17;
const EXPECTED_INFO: CoreInfo = {
  version: TEST_VERSION,
  protocolVersion: TEST_PROTOCOL_VERSION,
  coreProtocolVersion: 1,
  features: [
    CORE_METHODS.health,
    CORE_METHODS.info,
    CORE_METHODS.shutdown,
    ...Object.values(CORE_RUNTIME_METHODS),
  ],
};

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
  _stateDir: string,
  port: number,
  overrides: Partial<CoreRegistration> = {},
): CoreRegistration {
  return {
    id: "core-test",
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
  const stateDir = await Deno.makeTempDir({ prefix: "opensac-core-client-" });
  try {
    await test(stateDir, CorePaths.fromStateDir(stateDir));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

async function startServer(
  version = TEST_VERSION,
  protocolVersion = TEST_PROTOCOL_VERSION,
  overrides: Partial<ResolvedCoreConfig> = {},
): Promise<CoreServerHandle> {
  return await new CoreServer({
    config: config(overrides),
    version,
    protocolVersion,
  }).start();
}

async function writeRegistration(
  paths: CorePaths,
  value: CoreRegistration,
): Promise<void> {
  await new CoreRegistry(paths).write(value);
}

async function startProbe(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<CoreServerHandle> {
  let resolveAddress!: (address: Deno.NetAddr) => void;
  const addressReady = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddress = resolve;
  });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => resolveAddress(address as Deno.NetAddr),
    },
    handler,
  );
  const address = await addressReady;
  return {
    address,
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await server.shutdown();
      await server.finished;
    },
  };
}

Deno.test("CoreClient discovers a registered live Core and calls core.info", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));

      const discovered = await client.discover();
      assertEquals(discovered.status, "ready");
      if (discovered.status !== "ready") {
        throw new Error("expected ready discovery");
      }
      assertEquals(discovered.registration.id, "core-test");
      assertEquals(discovered.info, EXPECTED_INFO);
      assertEquals(await client.call("core.info"), EXPECTED_INFO);
      assertEquals((await client.health()).healthy, true);
    } finally {
      await handle.stop();
      await new CoreClient(clientOptions(stateDir)).close();
    }
  });
});

Deno.test("CoreClient returns an incompatible result for a version or protocol mismatch", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer(
      "other-version",
      TEST_PROTOCOL_VERSION + 1,
    );
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      const discovered = await client.discover();

      assertEquals(discovered.status, "incompatible");
      if (discovered.status !== "incompatible") {
        throw new Error("expected incompatible discovery");
      }
      assert(discovered.error instanceof CoreIncompatibleError);
      assertEquals(discovered.error.expectedVersion, TEST_VERSION);
      assertEquals(discovered.error.actualVersion, "other-version");
      assertEquals(
        discovered.error.expectedProtocolVersion,
        TEST_PROTOCOL_VERSION,
      );
      assertEquals(
        discovered.error.actualProtocolVersion,
        TEST_PROTOCOL_VERSION + 1,
      );
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient does not contact a demonstrably dead registration", async () => {
  await withStateDir(async (stateDir, paths) => {
    let requests = 0;
    const handle = await startProbe(() => {
      requests++;
      return new Response(JSON.stringify({}), { status: 500 });
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port, { pid: 999_999_99 }),
      );
      const client = new CoreClient(clientOptions(stateDir));
      const discovered = await client.discover();

      assertEquals(discovered.status, "stale");
      assertEquals(requests, 0);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient validates the endpoint even when a registration PID was reused", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port, {
          id: "old-registration-with-reused-pid",
          pid: Deno.pid,
        }),
      );
      const client = new CoreClient(clientOptions(stateDir));
      const discovered = await client.discover();

      assertEquals(discovered.status, "ready");
      if (discovered.status !== "ready") {
        throw new Error("expected ready discovery");
      }
      assertEquals(
        discovered.registration.id,
        "old-registration-with-reused-pid",
      );
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient selects one configured password and never retries a call", async () => {
  await withStateDir(async (stateDir, paths) => {
    const requests: Array<{ method: string; authorization: string | null }> =
      [];
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      const authorization = request.headers.get("authorization");
      requests.push({ method: body.method, authorization });
      if (
        body.method === CORE_METHODS.info &&
        authorization === "Bearer server-second"
      ) {
        return new Response(
          JSON.stringify(coreResult(body.id, EXPECTED_INFO)),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (
        body.method === CORE_METHODS.health &&
        authorization === "Bearer server-second"
      ) {
        return new Response(
          JSON.stringify(coreResult(body.id, {
            healthy: true,
            version: TEST_VERSION,
            protocolVersion: TEST_PROTOCOL_VERSION,
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(coreError(body.id, -32001, "authentication required")),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(
        clientOptions(stateDir, {
          password: "server-second",
          config: config({
            auth: true,
            passwords: ["client-first", "server-second"],
          }),
        }),
      );
      const discovered = await client.discover();
      assertEquals(discovered.status, "ready");
      assertEquals(requests.length, 2);
      assertEquals(requests[0].authorization, "Bearer server-second");

      requests.length = 0;
      const error = await assertRejects(
        () => client.call("test.method"),
        CoreClientRpcError,
      );
      assertEquals(error.code, -32001);
      assertEquals(requests.length, 1);
      assertEquals(requests[0].authorization, "Bearer server-second");
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient uses a deterministic default password until explicitly changed", async () => {
  await withStateDir(async (stateDir, paths) => {
    const requests: string[] = [];
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      const authorization = request.headers.get("authorization") ?? "";
      requests.push(authorization);
      if (authorization !== "Bearer right") {
        return new Response(
          JSON.stringify(coreError(body.id, -32001, "authentication required")),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const result = body.method === CORE_METHODS.info ? EXPECTED_INFO : {
        healthy: true,
        version: TEST_VERSION,
        protocolVersion: TEST_PROTOCOL_VERSION,
      };
      return new Response(
        JSON.stringify(coreResult(body.id, result)),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(
        clientOptions(stateDir, {
          config: config({ auth: true, passwords: ["wrong", "right"] }),
        }),
      );
      assertEquals((await client.discover()).status, "unauthenticated");
      assertEquals(requests, ["Bearer wrong"]);

      client.setPassword("right");
      assertEquals((await client.discover()).status, "ready");
      assertEquals(requests.slice(1), ["Bearer right", "Bearer right"]);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient reports an unauthenticated registration without leaking passwords", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer(
      TEST_VERSION,
      TEST_PROTOCOL_VERSION,
      { auth: true, passwords: ["server-secret"] },
    );
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(
        clientOptions(stateDir, {
          config: config({ auth: true, passwords: ["wrong-secret"] }),
        }),
      );
      const discovered = await client.discover();
      assertEquals(discovered.status, "unauthenticated");
      assertEquals(
        JSON.stringify(discovered).includes("wrong-secret"),
        false,
      );
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient reports malformed registration as stale", async () => {
  await withStateDir(async (stateDir, paths) => {
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(paths.registrationFile, "{not-json");
    const client = new CoreClient(clientOptions(stateDir));
    const discovered = await client.discover();
    assertEquals(discovered.status, "stale");
  });
});

Deno.test("CoreClient uses the configured Bearer header for authenticated discovery", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer(
      TEST_VERSION,
      TEST_PROTOCOL_VERSION,
      { auth: true, passwords: ["client-secret"] },
    );
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(
        clientOptions(stateDir, {
          config: config({ auth: true, passwords: ["client-secret"] }),
        }),
      );
      const discovered = await client.discover();
      assertEquals(discovered.status, "ready");
      assertEquals(
        (await client.call<CoreInfo>("core.info")).version,
        TEST_VERSION,
      );
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient surfaces JSON-RPC errors as a typed call error", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      const error = await assertRejects(
        () => client.call("core.missing"),
        CoreClientRpcError,
      );
      if (!(error instanceof CoreClientRpcError)) {
        throw new Error("expected a typed Core RPC error");
      }
      assertEquals(error.code, -32601);
      assertEquals(error.message, "Method not found");
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient rejects a response whose JSON-RPC ID does not match", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startProbe(async (request) => {
      await request.json();
      return new Response(
        JSON.stringify(coreResult("different-id", { ok: true })),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      await assertRejects(
        () => client.call("test.method"),
        Error,
        "ID",
      );
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient allows a null auth ID but rejects a non-null mismatch", async () => {
  await withStateDir(async (stateDir, paths) => {
    let authId: string | null = null;
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      if (body.method === CORE_METHODS.info) {
        return new Response(
          JSON.stringify(coreResult(body.id, EXPECTED_INFO)),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === CORE_METHODS.health) {
        return new Response(
          JSON.stringify(coreResult(body.id, {
            healthy: true,
            version: TEST_VERSION,
            protocolVersion: TEST_PROTOCOL_VERSION,
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(coreError(authId, -32001, "authentication required")),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      assertEquals((await client.discover()).status, "ready");

      authId = null;
      await assertRejects(
        () => client.call("test.method"),
        CoreClientRpcError,
      );
      authId = "wrong-id";
      await assertRejects(
        () => client.call("test.method"),
        CoreClientProtocolError,
        "ID",
      );
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient sends one non-batched JSON-RPC request", async () => {
  await withStateDir(async (stateDir, paths) => {
    const bodies: unknown[] = [];
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      bodies.push(body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: body.method === CORE_METHODS.info
            ? EXPECTED_INFO
            : body.method === CORE_METHODS.health
            ? {
              healthy: true,
              version: TEST_VERSION,
              protocolVersion: TEST_PROTOCOL_VERSION,
            }
            : { accepted: true },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      assertEquals((await client.discover()).status, "ready");
      bodies.length = 0;
      assertEquals(
        await client.call("test.method", { value: 3 }),
        { accepted: true },
      );
      assertEquals(bodies.length, 1);
      assert(Array.isArray(bodies[0]) === false);
      assertEquals((bodies[0] as { method: string }).method, "test.method");
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient reports malformed core.info without inventing actual values", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      assertEquals(body.method, CORE_METHODS.info);
      return new Response(
        JSON.stringify(coreResult(body.id, { malformed: true })),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      const discovered = await client.discover();
      assertEquals(discovered.status, "incompatible");
      if (discovered.status !== "incompatible") {
        throw new Error("expected incompatible malformed info");
      }
      assertEquals(discovered.error.actualVersion, undefined);
      assertEquals(discovered.error.actualProtocolVersion, undefined);
      assertEquals(discovered.actualVersion, undefined);
      assertEquals(discovered.actualProtocolVersion, undefined);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient rechecks registration currency before caching discovery", async () => {
  await withStateDir(async (stateDir, paths) => {
    let requests = 0;
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      requests++;
      if (body.method === CORE_METHODS.info) {
        await writeRegistration(
          paths,
          registration(stateDir, handle.address.port, { id: "replacement" }),
        );
        return new Response(
          JSON.stringify(coreResult(body.id, EXPECTED_INFO)),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(coreResult(body.id, {
          healthy: true,
          version: TEST_VERSION,
          protocolVersion: TEST_PROTOCOL_VERSION,
        })),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port, { id: "original" }),
      );
      const client = new CoreClient(clientOptions(stateDir));
      const discovered = await client.discover();
      assertEquals(discovered.status, "stale");
      assertEquals(requests, 2);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient ensureStarted coalesces concurrent launches and reuses a healthy Core", async () => {
  await withStateDir(async (stateDir, paths) => {
    let launches = 0;
    let handle: CoreServerHandle | undefined;
    const launcher: CoreLauncher = async () => {
      launches++;
      handle = await startServer();
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
    };
    const client = new CoreClient(clientOptions(stateDir, { launcher }));

    const first = client.ensureStarted();
    const second = client.ensureStarted();
    const results = await Promise.all([first, second]);
    assertEquals(results[0].status, "ready");
    assertEquals(results[1].status, "ready");
    assertEquals(launches, 1);

    const reused = await client.ensureStarted();
    assertEquals(reused.status, "ready");
    assertEquals(launches, 1);
    await handle?.stop();
  });
});

Deno.test("CoreClient polls after a launcher resolves before registration is ready", async () => {
  await withStateDir(async (stateDir, paths) => {
    let launches = 0;
    let handle: CoreServerHandle | undefined;
    const launcher: CoreLauncher = () => {
      launches++;
      setTimeout(async () => {
        handle = await startServer();
        await writeRegistration(
          paths,
          registration(stateDir, handle.address.port),
        );
      }, 5);
      return Promise.resolve();
    };
    const client = new CoreClient(
      clientOptions(stateDir, { launcher, startTimeoutMs: 250 }),
    );

    const result = await client.ensureStarted();
    assertEquals(result.status, "ready");
    assertEquals(launches, 1);
    await handle?.stop();
  });
});

Deno.test("CoreClient bounds a response body that never completes", async () => {
  await withStateDir(async (stateDir, paths) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({
            jsonrpc: "2.0",
            id: "ignored",
            result: EXPECTED_INFO,
          })),
        );
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            // The request may have been aborted by the client timeout.
          }
        }, 250);
      },
    });
    const handle = await startProbe(() =>
      new Response(body, {
        headers: { "content-type": "application/json" },
      })
    );
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(
        clientOptions(stateDir, {
          launcher: () => Promise.resolve(),
          startTimeoutMs: 20,
        }),
      );
      const started = Date.now();
      await assertRejects(() => client.ensureStarted(), CoreStartupError);
      assert(Date.now() - started < 150);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient aborts a late launcher and ignores its completion", async () => {
  await withStateDir(async (stateDir) => {
    let launchSignal: AbortSignal | undefined;
    let resolveLate!: () => void;
    let launchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      launchStarted = resolve;
    });
    const launcher: CoreLauncher = (signal) => {
      launchSignal = signal;
      launchStarted();
      return new Promise<void>((resolve) => {
        resolveLate = resolve;
      });
    };
    const client = new CoreClient(
      clientOptions(stateDir, { launcher, startTimeoutMs: 20 }),
    );

    const pending = client.ensureStarted();
    await started;
    await assertRejects(() => pending, CoreStartupError);
    assertEquals(launchSignal?.aborted, true);
    resolveLate();
    await Promise.resolve();
    assertEquals((await client.discover()).status, "missing");
  });
});

Deno.test("CoreClient clears the request timer after fetch failure", async () => {
  await withStateDir(async (stateDir, paths) => {
    await writeRegistration(paths, registration(stateDir, 4096));
    const client = new CoreClient(clientOptions(stateDir));
    const originalFetch = globalThis.fetch;
    const originalClearTimeout = globalThis.clearTimeout;
    let clearedTimers = 0;
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("offline"))) as typeof fetch;
    globalThis.clearTimeout = ((timer: number) => {
      clearedTimers++;
      originalClearTimeout(timer);
    }) as typeof clearTimeout;
    try {
      const discovered = await client.discover();
      assertEquals(discovered.status, "stale");
      assert(clearedTimers > 0);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

Deno.test("CoreClient bounds a launcher that never resolves", async () => {
  await withStateDir(async (stateDir) => {
    const launcher: CoreLauncher = () => new Promise<void>(() => {});
    const client = new CoreClient(
      clientOptions(stateDir, { launcher, startTimeoutMs: 20 }),
    );
    const error = await assertRejects(
      () => client.ensureStarted(),
      CoreStartupError,
    );
    assertEquals(error.timeoutMs, 20);
  });
});

Deno.test("CoreClient clears a failed startup so a later ensureStarted can retry", async () => {
  await withStateDir(async (stateDir) => {
    let launches = 0;
    const launcher: CoreLauncher = () => {
      launches++;
      return Promise.resolve();
    };
    const client = new CoreClient(
      clientOptions(stateDir, { launcher, startTimeoutMs: 20 }),
    );

    await assertRejects(() => client.ensureStarted(), CoreStartupError);
    await assertRejects(() => client.ensureStarted(), CoreStartupError);
    assertEquals(launches, 2);
  });
});

Deno.test("CoreClient close clears discovered state without stopping the server", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startServer();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      assertEquals((await client.discover()).status, "ready");
      await client.close();
      const rediscovered = await client.discover();
      assertEquals(rediscovered.status, "ready");
    } finally {
      await handle.stop();
    }
  });
});

function shutdownServer(): { server: CoreServer; calls: () => number } {
  let shutdownCalls = 0;
  const server = new CoreServer({
    config: config(),
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
    onShutdown: () => {
      shutdownCalls++;
    },
  });
  return { server, calls: () => shutdownCalls };
}

async function waitForShutdownCall(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the core.shutdown hook");
}

Deno.test("CoreClient shutdown sends core.shutdown and validates the acknowledgement", async () => {
  await withStateDir(async (stateDir, paths) => {
    const { server, calls } = shutdownServer();
    const handle = await server.start();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      try {
        assertEquals(await client.shutdown(), { ok: true });
      } finally {
        await client.close();
      }
      await waitForShutdownCall(() => calls() === 1);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient shutdown works against a version-incompatible registered Core", async () => {
  await withStateDir(async (stateDir, paths) => {
    const { server, calls } = shutdownServer();
    const handle = await server.start();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      // A different expected version makes discovery report `incompatible`,
      // which is exactly the upgrade path `core stop` must still be able to
      // shut down gracefully.
      const client = new CoreClient(
        clientOptions(stateDir, { version: "9.9.9-incompatible" }),
      );
      try {
        const discovered = await client.discover();
        assertEquals(discovered.status, "incompatible");
        assertEquals(await client.shutdown(), { ok: true });
      } finally {
        await client.close();
      }
      await waitForShutdownCall(() => calls() === 1);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient shutdown surfaces a method-not-found RPC error", async () => {
  await withStateDir(async (stateDir, paths) => {
    // A Core server without a shutdown hook behaves like an older build.
    const handle = await startServer();
    try {
      await writeRegistration(
        paths,
        registration(stateDir, handle.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      try {
        const error = await assertRejects(
          () => client.shutdown(),
          CoreClientRpcError,
        );
        assertEquals((error as CoreClientRpcError).code, -32601);
      } finally {
        await client.close();
      }
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("CoreClient shutdown rejects an invalid acknowledgement shape", async () => {
  await withStateDir(async (stateDir, paths) => {
    const probe = await startProbe(async (request) => {
      const body = await request.json() as { id?: unknown };
      return new Response(
        JSON.stringify(
          coreResult((body.id ?? null) as string | number | null, {
            ok: false,
          }),
        ),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await writeRegistration(
        paths,
        registration(stateDir, probe.address.port),
      );
      const client = new CoreClient(clientOptions(stateDir));
      try {
        await assertRejects(
          () => client.shutdown(),
          CoreClientProtocolError,
          "invalid shape",
        );
      } finally {
        await client.close();
      }
    } finally {
      await probe.stop();
    }
  });
});

Deno.test("CoreClient shutdown fails when no Core is registered", async () => {
  await withStateDir(async (stateDir) => {
    const client = new CoreClient(clientOptions(stateDir));
    try {
      await assertRejects(
        () => client.shutdown(),
        Error,
        "no Core is registered",
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test("CoreEventConnection correlates WebSocket requests with their responses", async () => {
  await withStateDir(async (stateDir, paths) => {
    // Regression: the pending map once stored raw ids but matched responses
    // through JSON.stringify(message.id), so subscribe/replay hung forever.
    const seen: string[] = [];
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
        const pathname = new URL(request.url).pathname;
        if (pathname === "/rpc") {
          const body = await request.json() as {
            id?: unknown;
            method?: unknown;
          };
          const result = body.method === CORE_METHODS.info ? EXPECTED_INFO : {
            healthy: true,
            version: TEST_VERSION,
            protocolVersion: TEST_PROTOCOL_VERSION,
          };
          return new Response(
            JSON.stringify(coreResult(body.id ?? null, result)),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (pathname === "/events") {
          const { socket, response } = Deno.upgradeWebSocket(request);
          socket.onmessage = (message) => {
            const body = JSON.parse(String(message.data)) as {
              id?: unknown;
              method?: unknown;
            };
            if (typeof body.method === "string") seen.push(body.method);
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? null,
              result: { ok: true },
            }));
          };
          return response;
        }
        return new Response("not found", { status: 404 });
      },
    );
    const port = await portReady;
    try {
      await writeRegistration(paths, registration(stateDir, port));
      const client = new CoreClient(clientOptions(stateDir));
      try {
        const events = await client.connectEvents();
        const bounded = <T>(operation: Promise<T>): Promise<T> =>
          Promise.race([
            operation,
            new Promise<never>((_resolve, reject) =>
              setTimeout(
                () => reject(new Error("event request timed out")),
                2_000,
              )
            ),
          ]);
        await bounded(events.subscribe("session-1", "run-1", 0));
        const replay = await bounded(events.replay("session-1", "run-1", 0));
        assertEquals(seen, ["run.events.subscribe", "run.events.replay"]);
        assertEquals(replay, { ok: true });
        await events.close();
      } finally {
        await client.close();
      }
    } finally {
      await server.shutdown();
      await server.finished;
    }
  });
});
