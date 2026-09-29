import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { CoreAuth } from "./auth.ts";
import { type CoreCommandDependencies, startCoreCommand } from "../cli/core.ts";
import { resolveCoreConfig } from "./config.ts";
import {
  registrationMatchesConfiguredEndpoint,
  registrationUrl,
} from "./endpoint.ts";
import {
  CoreClient,
  CoreClientRpcError,
  CoreClientTransportError,
  CoreStartupError,
  defaultLauncherArgs,
} from "./client.ts";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";
import { CORE_METHODS, coreError, coreResult } from "./protocol.ts";
import { CoreServer, type CoreServerHandle } from "./server.ts";

const VERSION = "0.1.0-final-review-test";
const PROTOCOL_VERSION = 91;

function config(
  overrides: Partial<{
    host: string;
    port: number;
    auth: boolean;
    passwords: string[];
  }> = {},
) {
  return {
    host: "127.0.0.1",
    port: 0,
    auth: false,
    passwords: [],
    ...overrides,
  };
}

function registration(
  port: number,
  overrides: Partial<CoreRegistration> = {},
): CoreRegistration {
  return {
    id: "final-review-core",
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
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
    prefix: "opensac-core-final-review-",
  });
  try {
    await test(stateDir, CorePaths.fromStateDir(stateDir));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await Deno.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function startProbe(
  handler: (request: Request) => Response | Promise<Response>,
  hostname = "127.0.0.1",
): Promise<CoreServerHandle> {
  let resolveAddress!: (address: Deno.Addr) => void;
  const addressReady = new Promise<Deno.Addr>((resolve) => {
    resolveAddress = resolve;
  });
  const server = Deno.serve(
    {
      hostname,
      port: 0,
      onListen: (address) => resolveAddress(address),
    },
    handler,
  );
  const address = await addressReady as Deno.NetAddr;
  return {
    address,
    url: `http://${
      hostname.includes(":") ? `[${hostname}]` : hostname
    }:${address.port}`,
    stop: async () => {
      await server.shutdown();
      await server.finished;
    },
  };
}

async function runSourceEntry(
  stateDir: string,
  port: number,
): Promise<{ ok: boolean; message?: string; url?: string; typed: boolean }> {
  const scriptDir = await Deno.makeTempDir({
    prefix: ".opensac-core-source-launcher-",
    dir: Deno.cwd(),
  });
  const resultFile = path.join(scriptDir, "result.json");
  const script = path.join(scriptDir, "entry.ts");
  const clientModule = new URL("./client.ts", import.meta.url).href;
  const commandModule = new URL("../cli/core.ts", import.meta.url).href;
  try {
    await Deno.writeTextFile(
      script,
      [
        `import { CoreClient, CoreLauncherError, CoreStartupError } from ${
          JSON.stringify(clientModule)
        };`,
        `import { startCoreCommand } from ${JSON.stringify(commandModule)};`,
        `const stateDir = Deno.args[0];`,
        `const fixedPort = Deno.args[0] === "core" ? Number(Deno.env.get("OPENSAC_TEST_FIXED_PORT") ?? "0") : Number(Deno.args[1]);`,
        `const resultFile = Deno.args[2];`,
        `const version = ${JSON.stringify(VERSION)};`,
        `const protocolVersion = ${PROTOCOL_VERSION};`,
        `const coreConfig = { host: "127.0.0.1", port: fixedPort, auth: false, passwords: [] };`,
        `if (Deno.args[0] === "core") {`,
        `  const handle = await startCoreCommand({ stateDir: Deno.env.get("OPENSAC_DIR") ?? stateDir, config: coreConfig, version, protocolVersion });`,
        `  let resolveStop;`,
        `  const stopped = new Promise((resolve) => { resolveStop = resolve; });`,
        `  const onSignal = () => resolveStop();`,
        `  Deno.addSignalListener("SIGTERM", onSignal);`,
        `  Deno.addSignalListener("SIGINT", onSignal);`,
        `  await stopped;`,
        `  Deno.removeSignalListener("SIGTERM", onSignal);`,
        `  Deno.removeSignalListener("SIGINT", onSignal);`,
        `  await handle.stop();`,
        `} else {`,
        `  Deno.env.set("OPENSAC_TEST_FIXED_PORT", String(fixedPort));`,
        `  const client = new CoreClient({ stateDir, version, protocolVersion, config: coreConfig, startTimeoutMs: 3000 });`,
        `  try {`,
        `    const result = await client.ensureStarted();`,
        `    if (result.status !== "ready") throw new Error("source launcher did not become ready");`,
        `    const response = await fetch(new URL("/health", result.url));`,
        `    if (!response.ok) throw new Error("source launcher health failed");`,
        `    Deno.kill(result.registration.pid, "SIGTERM");`,
        `    await new Promise((resolve) => setTimeout(resolve, 100));`,
        `    await client.close();`,
        `    await Deno.writeTextFile(resultFile, JSON.stringify({ ok: true, typed: false, url: result.url }));`,
        `  } catch (error) {`,
        `    const typed = error instanceof CoreStartupError && error.cause instanceof CoreLauncherError;`,
        `    await Deno.writeTextFile(resultFile, JSON.stringify({ ok: false, typed, message: error instanceof Error ? error.message : String(error) }));`,
        `  }`,
        `}`,
      ].join("\n"),
    );

    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, stateDir, String(port), resultFile],
      env: {
        ...Deno.env.toObject(),
        OPENSAC_DIR: stateDir,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.status,
    ]);
    assertEquals(status.success, true, `${stdout}\n${stderr}`);
    const result = JSON.parse(await Deno.readTextFile(resultFile)) as {
      ok: boolean;
      typed: boolean;
      message?: string;
      url?: string;
    };
    return result;
  } finally {
    await Deno.remove(scriptDir, { recursive: true });
  }
}

async function makeCoreLifecycleScript(port = 0): Promise<{
  directory: string;
  script: string;
}> {
  const directory = await Deno.makeTempDir({
    prefix: ".opensac-core-lifecycle-",
    dir: Deno.cwd(),
  });
  const script = path.join(directory, "lifecycle.ts");
  const commandModule = new URL("../cli/core.ts", import.meta.url).href;
  await Deno.writeTextFile(
    script,
    [
      `import { startCoreCommand } from ${JSON.stringify(commandModule)};`,
      `const [mode, stateDir, resultFile] = Deno.args;`,
      `const version = ${JSON.stringify(VERSION)};`,
      `const protocolVersion = ${PROTOCOL_VERSION};`,
      `const config = { host: "127.0.0.1", port: ${port}, auth: false, passwords: [] };`,
      `const handle = await startCoreCommand({ stateDir, config, version, protocolVersion });`,
      `await Deno.writeTextFile(resultFile, JSON.stringify({ url: handle.url }));`,
      `if (mode === "hold") {`,
      `  let resolveStop;`,
      `  const stopped = new Promise((resolve) => { resolveStop = resolve; });`,
      `  const onSignal = () => resolveStop();`,
      `  Deno.addSignalListener("SIGTERM", onSignal);`,
      `  Deno.addSignalListener("SIGINT", onSignal);`,
      `  await stopped;`,
      `  Deno.removeSignalListener("SIGTERM", onSignal);`,
      `  Deno.removeSignalListener("SIGINT", onSignal);`,
      `}`,
      `await handle.stop();`,
    ].join("\n"),
  );
  return { directory, script };
}

async function runLifecycleProcess(
  script: string,
  mode: "reuse" | "start",
  stateDir: string,
  resultFile: string,
): Promise<{ url: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", script, mode, stateDir, resultFile],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.status,
  ]);
  assertEquals(status.success, true, `${stdout}\n${stderr}`);
  return JSON.parse(await Deno.readTextFile(resultFile)) as { url: string };
}

Deno.test("final review: two processes reuse a healthy Core before and after lock acquisition", async () => {
  await withStateDir(async (stateDir, paths) => {
    const lifecycle = await makeCoreLifecycleScript();
    const holdResult = path.join(lifecycle.directory, "hold.json");
    const reuseResult = path.join(lifecycle.directory, "reuse.json");
    const afterResult = path.join(lifecycle.directory, "after.json");
    const hold = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        lifecycle.script,
        "hold",
        stateDir,
        holdResult,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await waitFor(async () => await exists(holdResult), "first Core process");
      const first = JSON.parse(await Deno.readTextFile(holdResult)) as {
        url: string;
      };
      const reused = await runLifecycleProcess(
        lifecycle.script,
        "reuse",
        stateDir,
        reuseResult,
      );
      assertEquals(reused.url, first.url);
      assertEquals(
        (await new CoreRegistry(paths).read())?.id !== undefined,
        true,
      );
      assertEquals((await Deno.lstat(paths.lockFile)).isDirectory, true);

      hold.kill("SIGTERM");
      await hold.status;
      await waitFor(
        async () => (await new CoreRegistry(paths).read()) === undefined,
        "first Core process cleanup",
      );
      const after = await runLifecycleProcess(
        lifecycle.script,
        "start",
        stateDir,
        afterResult,
      );
      assert(after.url !== first.url);
      assertEquals(await new CoreRegistry(paths).read(), undefined);
    } finally {
      try {
        hold.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
      await hold.status.catch(() => undefined);
      await Deno.remove(lifecycle.directory, { recursive: true });
    }
  });
});

Deno.test("final review: fixed-port processes reuse a healthy Core", async () => {
  await withStateDir(async (stateDir, paths) => {
    let resolveAddress!: (address: Deno.Addr) => void;
    const addressReady = new Promise<Deno.Addr>((resolve) => {
      resolveAddress = resolve;
    });
    const reservation = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen: (address) => resolveAddress(address),
      },
      () => new Response("reservation"),
    );
    const address = await addressReady as Deno.NetAddr;
    await reservation.shutdown();
    await reservation.finished;

    const lifecycle = await makeCoreLifecycleScript(address.port);
    const holdResult = path.join(lifecycle.directory, "hold.json");
    const reuseResult = path.join(lifecycle.directory, "reuse.json");
    const afterResult = path.join(lifecycle.directory, "after.json");
    const hold = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", lifecycle.script, "hold", stateDir, holdResult],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await waitFor(
        async () => await exists(holdResult),
        "fixed-port Core process",
      );
      const first = JSON.parse(await Deno.readTextFile(holdResult)) as {
        url: string;
      };
      const reused = await runLifecycleProcess(
        lifecycle.script,
        "reuse",
        stateDir,
        reuseResult,
      );
      assertEquals(reused.url, first.url);
      hold.kill("SIGTERM");
      await hold.status;
      await waitFor(
        async () => (await new CoreRegistry(paths).read()) === undefined,
        "fixed-port first process cleanup",
      );
      const after = await runLifecycleProcess(
        lifecycle.script,
        "start",
        stateDir,
        afterResult,
      );
      assertEquals(after.url, first.url);
    } finally {
      try {
        hold.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
      await hold.status.catch(() => undefined);
      await Deno.remove(lifecycle.directory, { recursive: true });
    }
  });
});

Deno.test("final review: wildcard listeners expose connectable loopback URLs", async () => {
  for (const hostname of ["0.0.0.0", "::"]) {
    const server = new CoreServer({
      config: config({ host: hostname }),
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
    const handle = await server.start();
    try {
      const url = new URL(handle.url);
      if (hostname === "0.0.0.0") {
        assertEquals(url.hostname, "127.0.0.1");
      } else {
        assertEquals(url.hostname, "[::1]");
      }
      const response = await fetch(new URL("/health", handle.url));
      assertEquals(response.status, 200);
    } finally {
      await handle.stop();
    }
  }
});

Deno.test("final review: source launcher grants the child explicit permissions", () => {
  const args = defaultLauncherArgs(Deno.execPath());
  for (
    const permission of [
      "--allow-read",
      "--allow-write",
      "--allow-net",
      "--allow-env",
      // The child is the runtime host, so it must be able to run the same
      // programs the parent runs (shell tools, git, MCP servers, sandbox).
      "--allow-run",
      "--allow-ffi",
      "--allow-sys",
    ]
  ) {
    assertEquals(args.includes(permission), true, permission);
  }
  assertEquals(args.includes("core"), true);
});

Deno.test("final review: source launcher child can spawn a subprocess", async () => {
  // Regression: the child permissions omitted `--allow-run`, so a globally
  // installed `opensac` reported `Requires run access to "/bin/bash"` for
  // every tool even though the parent shim had full access.
  const args = defaultLauncherArgs(Deno.execPath());
  const script = path.join(
    await Deno.makeTempDir({ prefix: ".opensac-core-run-" }),
    "spawn.ts",
  );
  await Deno.writeTextFile(
    script,
    `const command = new Deno.Command(Deno.execPath(), {
      args: ["eval", "console.log('child-ok')"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    await Deno.writeTextFile(Deno.args[0], new TextDecoder().decode(output.stdout));
    `,
  );
  const resultFile = `${script}.out`;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", ...args.slice(0, -2), script, resultFile],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.status,
  ]);
  assertEquals(status.success, true, `${stdout}\n${stderr}`);
  assertEquals(
    (await Deno.readTextFile(resultFile)).trim(),
    "child-ok",
  );
});

Deno.test("final review: real source launcher starts and stops a Core child", async () => {
  await withStateDir(async (stateDir, paths) => {
    const result = await runSourceEntry(stateDir, 0);
    assertEquals(result.ok, true, result.message);
    assert((result.url ?? "").startsWith("http://127.0.0.1:"));
    await waitFor(
      async () => (await new CoreRegistry(paths).read()) === undefined,
      "source child cleanup",
    );
  });
});

Deno.test("final review: default launcher reports a typed fixed-port child failure", async () => {
  let resolveAddress!: (address: Deno.Addr) => void;
  const addressReady = new Promise<Deno.Addr>((resolve) => {
    resolveAddress = resolve;
  });
  const occupied = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => resolveAddress(address),
    },
    () => new Response("occupied"),
  );
  const address = await addressReady as Deno.NetAddr;
  try {
    await withStateDir(async (stateDir) => {
      const result = await runSourceEntry(stateDir, address.port);
      assertEquals(result.ok, false);
      assertEquals(result.typed, true);
      assert(
        result.message?.includes(String(address.port)) === true,
        result.message ?? "missing child error",
      );
      assertEquals(result.message?.includes("password"), false);
    });
  } finally {
    await occupied.shutdown();
    await occupied.finished;
  }
});

Deno.test("final review: CoreClient maps wildcard registrations to reachable hosts", async () => {
  await withStateDir(async (stateDir, paths) => {
    for (const hostname of ["0.0.0.0", "::"]) {
      const handle = await new CoreServer({
        config: config({ host: hostname }),
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
      }).start();
      try {
        await new CoreRegistry(paths).write(
          registration(handle.address.port, { host: hostname }),
        );
        const client = new CoreClient({
          stateDir,
          version: VERSION,
          protocolVersion: PROTOCOL_VERSION,
          config: config({ host: hostname }),
        });
        const result = await client.discover();
        assertEquals(result.status, "ready");
        if (result.status === "ready") {
          assertEquals(
            new URL(result.url).hostname,
            hostname === "::" ? "[::1]" : "127.0.0.1",
          );
        }
      } finally {
        await handle.stop();
      }
    }
  });
});

Deno.test("final review: client rejects a fixed endpoint port mismatch before probing", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startProbe(() => new Response("wrong endpoint"));
    try {
      await new CoreRegistry(paths).write(
        registration(handle.address.port),
      );
      const mismatchPort = handle.address.port === 65_535
        ? handle.address.port - 1
        : handle.address.port + 1;
      const client = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config({ port: mismatchPort }),
      });
      const result = await client.discover();
      assertEquals(result.status, "stale");
      if (result.status === "stale") {
        assertEquals(result.reason.includes("port"), true);
      }
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("final review: CoreClient rejects a specific registration for wildcard config", async () => {
  await withStateDir(async (stateDir, paths) => {
    let requests = 0;
    const handle = await startProbe(() => {
      requests++;
      return new Response("unexpected");
    });
    try {
      await new CoreRegistry(paths).write(
        registration(handle.address.port, { host: "127.0.0.1" }),
      );
      const client = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config({ host: "0.0.0.0" }),
      });
      const result = await client.discover();
      assertEquals(result.status, "stale");
      if (result.status === "stale") {
        assertEquals(
          result.reason.includes("does not match the configured endpoint"),
          true,
        );
      }
      assertEquals(requests, 0);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("final review: endpoint compatibility separates wildcard bind policy", () => {
  const fixed = (host: string) => config({ host, port: 4096 });
  for (
    const [registrationHost, configuredHost] of [
      ["127.0.0.1", "0.0.0.0"],
      ["::1", "::"],
      ["0.0.0.0", "::1"],
      ["::", "127.0.0.1"],
    ] as const
  ) {
    assertEquals(
      registrationMatchesConfiguredEndpoint(
        registration(4096, { host: registrationHost }),
        fixed(configuredHost),
      ),
      false,
      `${registrationHost} must not satisfy configured ${configuredHost}`,
    );
  }

  for (
    const [registrationHost, configuredHost] of [
      ["0.0.0.0", "127.0.0.1"],
      ["::", "::1"],
      ["0.0.0.0", "0.0.0.0"],
      ["::", "::"],
    ] as const
  ) {
    assertEquals(
      registrationMatchesConfiguredEndpoint(
        registration(4096, { host: registrationHost }),
        fixed(configuredHost),
      ),
      true,
      `${registrationHost} should satisfy configured ${configuredHost}`,
    );
  }

  assertEquals(
    registrationMatchesConfiguredEndpoint(
      registration(4096, { host: "0.0.0.0" }),
      config({ host: "0.0.0.0", port: 4097 }),
    ),
    false,
  );
  assertEquals(
    registrationUrl(
      registration(4096, {
        host: "0.0.0.0",
        connectHost: "127.0.0.1",
      }),
      config({ host: "192.0.2.10", port: 4096 }),
    ),
    "http://192.0.2.10:4096",
  );
});

Deno.test("final review: production registration records a connect host", async () => {
  for (
    const [host, connectHost] of [
      ["0.0.0.0", "127.0.0.1"],
      ["::", "::1"],
    ] as const
  ) {
    await withStateDir(async (stateDir, paths) => {
      const handle = await startCoreCommand({
        stateDir,
        config: config({ host }),
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
      });
      try {
        const current = await new CoreRegistry(paths).read();
        assertEquals(current?.host, host);
        assertEquals(current?.connectHost, connectHost);
      } finally {
        await handle.stop();
        await handle.done;
      }
    });
  }
});

Deno.test("final review: command refuses wildcard reuse of a specific Core", async () => {
  for (
    const [specificHost, wildcardHost] of [
      ["127.0.0.1", "0.0.0.0"],
      ["::1", "::"],
    ] as const
  ) {
    await withStateDir(async (stateDir) => {
      const first = await startCoreCommand({
        stateDir,
        config: config({ host: specificHost }),
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
      });
      try {
        await assertRejects(
          () =>
            startCoreCommand({
              stateDir,
              config: config({ host: wildcardHost }),
              version: VERSION,
              protocolVersion: PROTOCOL_VERSION,
            }),
          Error,
        );
        assertEquals(
          (await new CoreRegistry(CorePaths.fromStateDir(stateDir)).read())
            ?.host,
          specificHost,
        );
      } finally {
        await first.stop();
        await first.done;
      }
    });
  }
});

Deno.test("final review: a dead old-version registration is stale before endpoint probing", async () => {
  await withStateDir(async (stateDir, paths) => {
    let requests = 0;
    const handle = await startProbe(() => {
      requests++;
      return new Response("unexpected", { status: 500 });
    });
    try {
      await new CoreRegistry(paths).write(
        registration(handle.address.port, {
          version: "old-version",
          pid: 999_999_99,
        }),
      );
      const client = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config(),
      });
      assertEquals((await client.discover()).status, "stale");
      assertEquals(requests, 0);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("final review: a dead old-version registration is stale even with liveness shortcut disabled", async () => {
  await withStateDir(async (stateDir, paths) => {
    await new CoreRegistry(paths).write(
      registration(1, {
        version: "old-version",
        pid: 999_999_99,
      }),
    );
    const client = new CoreClient({
      stateDir,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: config(),
      ignoreProcessLiveness: true,
    });
    const result = await client.discover();
    assertEquals(result.status, "stale");
  });
});

Deno.test("final review: late launcher registration is identity-cleaned after startup cancellation", async () => {
  await withStateDir(async (stateDir, paths) => {
    let resolveLate!: () => void;
    let lateWritten!: () => void;
    let launchStarted!: () => void;
    const written = new Promise<void>((resolve) => {
      lateWritten = resolve;
    });
    const started = new Promise<void>((resolve) => {
      launchStarted = resolve;
    });
    const client = new CoreClient({
      stateDir,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: config(),
      startTimeoutMs: 20,
      launcher: async (signal) => {
        launchStarted();
        await new Promise<void>((resolve) => {
          resolveLate = resolve;
        });
        if (signal.aborted) {
          await new CoreRegistry(paths).write(
            registration(1, { pid: 999_999_99 }),
          );
          lateWritten();
        }
      },
    });

    const pending = client.ensureStarted();
    await started;
    await assertRejects(() => pending, CoreStartupError);
    resolveLate();
    await written;
    assert((await new CoreRegistry(paths).read()) !== undefined);
    await client.close();
    await waitFor(
      async () => (await new CoreRegistry(paths).read()) === undefined,
      "late launcher registration cleanup",
    );
  });
});

Deno.test("final review: close does not wait forever for an uncooperative launcher", async () => {
  await withStateDir(async (stateDir) => {
    const client = new CoreClient({
      stateDir,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: config(),
      startTimeoutMs: 20,
      launcher: () => new Promise<void>(() => {}),
    });
    await assertRejects(() => client.ensureStarted(), CoreStartupError);
    const started = Date.now();
    await client.close();
    assert(Date.now() - started < 300);
  });
});

Deno.test("final review: external abort reaches the launcher signal", async () => {
  await withStateDir(async (stateDir) => {
    const controller = new AbortController();
    let launcherSignal: AbortSignal | undefined;
    let launchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      launchStarted = resolve;
    });
    const client = new CoreClient({
      stateDir,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: config(),
      signal: controller.signal,
      startTimeoutMs: 500,
      launcher: (signal) => {
        launcherSignal = signal;
        launchStarted();
        return new Promise<void>(() => {});
      },
    });

    const pending = client.ensureStarted();
    await started;
    controller.abort();
    const outcome = await Promise.race([
      pending.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still-pending"), 100)
      ),
    ]);
    assertEquals(outcome, "settled");
    assertEquals(launcherSignal?.aborted, true);
    await pending.catch(() => undefined);
  });
});

Deno.test("final review: CoreClient classifies valid and malformed 403 bodies", async () => {
  await withStateDir(async (stateDir, paths) => {
    let mode: "forbid" | "ready" | "malformed" = "forbid";
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      if (mode === "forbid") {
        return new Response(
          JSON.stringify(coreError(body.id, -32001, "forbidden")),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === CORE_METHODS.info) {
        return new Response(
          JSON.stringify(coreResult(body.id, {
            version: VERSION,
            protocolVersion: PROTOCOL_VERSION,
            coreProtocolVersion: 1,
            features: [],
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === CORE_METHODS.health) {
        return new Response(
          JSON.stringify(coreResult(body.id, {
            healthy: true,
            version: VERSION,
            protocolVersion: PROTOCOL_VERSION,
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (mode === "malformed") {
        return new Response("not-json", { status: 403 });
      }
      return new Response(
        JSON.stringify(coreError(body.id, -32001, "forbidden")),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    });
    try {
      await new CoreRegistry(paths).write(registration(handle.address.port));
      const first = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config(),
      });
      const forbidden = await first.discover();
      assertEquals(forbidden.status, "unauthenticated");
      if (forbidden.status === "unauthenticated") {
        assertEquals(forbidden.error.httpStatus, 403);
      }

      mode = "ready";
      const second = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config(),
      });
      assertEquals((await second.discover()).status, "ready");
      mode = "malformed";
      const error = await assertRejects(
        () => second.call("test.forbidden"),
        CoreClientRpcError,
      );
      assertEquals(error.httpStatus, 403);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("final review: stored abort cancels a response while JSON is decoding", async () => {
  await withStateDir(async (stateDir, paths) => {
    const controller = new AbortController();
    const handle = await startProbe(async (request) => {
      const body = await request.json() as {
        id: string | number | null;
        method: string;
      };
      if (body.method === CORE_METHODS.info) {
        return new Response(
          JSON.stringify(coreResult(body.id, {
            version: VERSION,
            protocolVersion: PROTOCOL_VERSION,
            coreProtocolVersion: 1,
            features: [],
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === CORE_METHODS.health) {
        return new Response(
          JSON.stringify(coreResult(body.id, {
            healthy: true,
            version: VERSION,
            protocolVersion: PROTOCOL_VERSION,
          })),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"jsonrpc":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await new CoreRegistry(paths).write(registration(handle.address.port));
      const client = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config(),
        signal: controller.signal,
      });
      assertEquals((await client.discover()).status, "ready");
      const pending = client.call("test.method");
      setTimeout(() => controller.abort(), 10);
      const error = await assertRejects(
        () => pending,
        CoreClientTransportError,
      );
      assertEquals(error.message.includes("aborted"), true);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("final review: malformed JSON after headers clears the request timer", async () => {
  await withStateDir(async (stateDir, paths) => {
    const handle = await startProbe(async (request) => {
      await request.json();
      return new Response("{not-json", {
        headers: { "content-type": "application/json" },
      });
    });
    const originalClearTimeout = globalThis.clearTimeout;
    let clearedTimers = 0;
    globalThis.clearTimeout = ((timer: number) => {
      clearedTimers++;
      originalClearTimeout(timer);
    }) as typeof clearTimeout;
    try {
      await new CoreRegistry(paths).write(registration(handle.address.port));
      const client = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config(),
      });
      const result = await client.discover();
      assertEquals(result.status, "stale");
      assert(clearedTimers > 0);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
      await handle.stop();
    }
  });
});

Deno.test("final review: stalled response bodies are bounded and cleaned up", async () => {
  await withStateDir(async (stateDir, paths) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":'));
      },
    });
    const handle = await startProbe(() =>
      new Response(body, { headers: { "content-type": "application/json" } })
    );
    try {
      await new CoreRegistry(paths).write(registration(handle.address.port));
      const client = new CoreClient({
        stateDir,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        config: config(),
        startTimeoutMs: 25,
        launcher: () => Promise.resolve(),
      });
      await assertRejects(() => client.ensureStarted(), CoreStartupError);
    } finally {
      await handle.stop();
    }
  });
});

Deno.test("final review: whitespace-edge passwords are rejected rather than trimmed", () => {
  const protectedConfig = config({
    auth: true,
    passwords: [" secret "],
  });
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc", {
        headers: { authorization: "Bearer secret" },
      }),
      protectedConfig,
    ),
    false,
  );
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc", {
        headers: { authorization: "Bearer  secret " },
      }),
      protectedConfig,
    ),
    false,
  );
  assertThrows(
    () =>
      resolveCoreConfig({
        core: {
          auth: true,
          passwords: [" secret "],
        },
      } as never),
    Error,
    "whitespace",
  );
});

Deno.test("final review: an owned Core stops when registration ownership is replaced", async () => {
  await withStateDir(async (stateDir, paths) => {
    const dependencies = {
      ownershipMonitorIntervalMs: 10,
    } as unknown as CoreCommandDependencies;
    const handle = await startCoreCommand(
      {
        stateDir,
        config: config(),
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
      },
      dependencies,
    );
    try {
      const current = await new CoreRegistry(paths).read();
      assert(current !== undefined);
      await new CoreRegistry(paths).write({
        ...current!,
        id: "foreign-registration",
      });
      await waitFor(async () => {
        const done = await Promise.race([
          handle.done,
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 5)
          ),
        ]);
        return done !== undefined;
      }, "ownership monitor shutdown");
      assertEquals(await handle.done, 0);
      assertEquals(
        (await new CoreRegistry(paths).read())?.id,
        "foreign-registration",
      );
      await assertRejects(() => fetch(handle.url), Error);
    } finally {
      await handle.stop().catch(() => undefined);
      await handle.done.catch(() => undefined);
    }
  });
});

Deno.test("final review: registration loss stops even when lock read is unreadable", async () => {
  await withStateDir(async (stateDir, paths) => {
    const realRegistry = new CoreRegistry(paths);
    let lockReleases = 0;
    const lock = {
      isCurrent: () => {
        throw new Error("lock metadata is unreadable");
      },
      release: () => {
        lockReleases++;
      },
    };
    const registry = {
      write: (value: CoreRegistration, signal?: AbortSignal) =>
        realRegistry.write(value, signal),
      remove: (id: string, signal?: AbortSignal) =>
        realRegistry.remove(id, signal),
      isCurrent: () => false,
    };
    const handle = await startCoreCommand(
      {
        stateDir,
        config: config(),
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        acquireLock: () => lock,
        registry: () => registry,
        ownershipMonitorIntervalMs: 10,
      } as unknown as CoreCommandDependencies,
    );
    try {
      await waitFor(async () => {
        const done = await Promise.race([
          handle.done,
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 5)
          ),
        ]);
        return done !== undefined;
      }, "registration-loss ownership monitor shutdown");
      assertEquals(await handle.done, 0);
      assertEquals(lockReleases, 1);
      assertEquals(await realRegistry.read(), undefined);
      await assertRejects(() => fetch(handle.url), Error);
    } finally {
      await handle.stop().catch(() => undefined);
      await handle.done.catch(() => undefined);
    }
  });
});

Deno.test("final review: an owned Core stops when lock ownership is replaced", async () => {
  await withStateDir(async (stateDir, paths) => {
    const dependencies = {
      ownershipMonitorIntervalMs: 10,
    } as unknown as CoreCommandDependencies;
    const handle = await startCoreCommand(
      {
        stateDir,
        config: config(),
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
      },
      dependencies,
    );
    const oldLock = path.join(path.dirname(paths.lockFile), ".old-core.lock");
    try {
      await Deno.rename(paths.lockFile, oldLock);
      await Deno.mkdir(paths.lockFile, { mode: 0o700 });
      await Deno.writeTextFile(
        path.join(paths.lockFile, "meta.json"),
        JSON.stringify({
          token: "foreign-lock-token",
          pid: Deno.pid,
          hostname: Deno.hostname(),
          timestamp: Date.now(),
        }),
      );
      await waitFor(async () => {
        const done = await Promise.race([
          handle.done,
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 5)
          ),
        ]);
        return done !== undefined;
      }, "lock ownership monitor shutdown");
      assertEquals(await handle.done, 0);
      assertEquals((await Deno.lstat(paths.lockFile)).isDirectory, true);
    } finally {
      await handle.stop().catch(() => undefined);
      await handle.done.catch(() => undefined);
      await Deno.remove(oldLock, { recursive: true }).catch(() => undefined);
    }
  });
});

Deno.test("final review: registry recovers an incomplete transition marker", async () => {
  await withStateDir(async (stateDir, paths) => {
    const scriptDir = await Deno.makeTempDir({
      prefix: "opensac-core-incomplete-transition-",
    });
    const script = path.join(scriptDir, "crash.ts");
    try {
      await Deno.writeTextFile(
        script,
        [
          "const stateDir = Deno.args[0];",
          "const intent = `${stateDir}/.core-registry-transition.intent`;",
          "const transition = `${stateDir}/.core-registry-transition.lock`;",
          "await Deno.writeTextFile(intent, JSON.stringify({",
          '  token: "crashed-transition-intent",',
          "  pid: Deno.pid,",
          "  hostname: Deno.hostname(),",
          "  timestamp: Date.now(),",
          "}));",
          "await Deno.mkdir(transition, { recursive: true, mode: 0o700 });",
          'Deno.kill(Deno.pid, "SIGKILL");',
        ].join("\n"),
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", script, stateDir],
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const stderr = await new Response(child.stderr).text();
      const status = await child.status;
      assertEquals(status.success, false, stderr);
      assertEquals(
        (await Deno.lstat(
          path.join(stateDir, ".core-registry-transition.lock"),
        )).isDirectory,
        true,
      );

      await new CoreRegistry(paths).write(registration(4321));
      assertEquals(
        (await new CoreRegistry(paths).read())?.id,
        "final-review-core",
      );
    } finally {
      await Deno.remove(scriptDir, { recursive: true });
    }
  });
});

Deno.test("final review: live incomplete transition ownership remains fail-closed", async () => {
  await withStateDir(async (stateDir, paths) => {
    const transitionDir = path.join(
      stateDir,
      ".core-registry-transition.lock",
    );
    const intentPath = path.join(
      stateDir,
      ".core-registry-transition.intent",
    );
    await Deno.mkdir(transitionDir, { mode: 0o700 });
    await Deno.writeTextFile(
      intentPath,
      JSON.stringify({
        token: "live-transition-intent",
        pid: Deno.pid,
        hostname: Deno.hostname(),
        timestamp: Date.now(),
      }),
    );
    try {
      await assertRejects(
        () => new CoreRegistry(paths).write(registration(4321)),
        Error,
        "busy",
      );
      assertEquals((await Deno.lstat(transitionDir)).isDirectory, true);
    } finally {
      await Deno.remove(intentPath);
      await Deno.remove(transitionDir, { recursive: true });
    }
  });
});

Deno.test("final review: registry recovers a transition marker left by a crashed subprocess", async () => {
  await withStateDir(async (stateDir, paths) => {
    const scriptDir = await Deno.makeTempDir({
      prefix: "opensac-core-transition-crash-",
    });
    const script = path.join(scriptDir, "crash.ts");
    try {
      await Deno.writeTextFile(
        script,
        [
          "const stateDir = Deno.args[0];",
          "const transition = `${stateDir}/.core-registry-transition.lock`;",
          "await Deno.mkdir(transition, { recursive: true, mode: 0o700 });",
          "await Deno.writeTextFile(`${transition}/owner.json`, JSON.stringify({",
          '  token: "crashed-transition",',
          "  pid: Deno.pid,",
          "  hostname: Deno.hostname(),",
          "  timestamp: Date.now(),",
          "}));",
          'Deno.kill(Deno.pid, "SIGKILL");',
        ].join("\n"),
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", script, stateDir],
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const stderr = await new Response(child.stderr).text();
      const status = await child.status;
      assertEquals(status.success, false, stderr);
      assertEquals(
        (await Deno.lstat(
          path.join(stateDir, ".core-registry-transition.lock"),
        )).isDirectory,
        true,
      );

      await new CoreRegistry(paths).write(registration(4321));
      assertEquals(
        (await new CoreRegistry(paths).read())?.id,
        "final-review-core",
      );
    } finally {
      await Deno.remove(scriptDir, { recursive: true });
    }
  });
});
