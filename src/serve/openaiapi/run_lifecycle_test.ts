// Translated from the lifecycle halves of internal/serve/openaiapi
// server_test.go / auth_webui_test.go plus the serve-level startup contract
// exercised by process_integration_test.go. Go drives the full Run() only in
// subprocess integration tests; this port starts the same lifecycle
// in-process against an ephemeral loopback listener and asserts the
// middleware/auth-mux stack and graceful shutdown directly.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Config } from "./config.ts";
import { defaultConfig } from "./config.ts";
import {
  buildRunStack,
  loadRunConfig,
  run,
  serveListenOptions,
} from "./lifecycle.ts";
import { newRunSlotLimiter } from "./server.ts";
import type { Settings } from "../../config/settings.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix, dir: Deno.env.get("TMPDIR") });
}

const tempRoots: string[] = [];

function baseSettings(): Settings {
  const sessionDir = tempDir("serve_run_session_");
  tempRoots.push(sessionDir);
  const skillsDir = tempDir("serve_run_skills_");
  tempRoots.push(skillsDir);
  return {
    sessionDir,
    skillsDir,
    defaultProvider: "test-provider",
    defaultModel: "m1",
    providers: {
      "test-provider": {
        apiKey: "test-key",
        baseUrl: "https://example.invalid/v1",
        api: "openai-chat",
        models: [{ id: "m1", name: "M1" }],
      },
    },
  } as unknown as Settings;
}

const stackCleanups: Array<() => Promise<void> | void> = [];
function runStackCleanups(): void {
  while (stackCleanups.length) {
    const cleanup = stackCleanups.pop()!;
    void cleanup();
  }
}

async function newTestStack(
  mutate?: (opts: { settings: Settings; config: Config }) => void,
) {
  const settings = baseSettings();
  const config = defaultConfig();
  config.defaultMode = "yolo";
  if (mutate) mutate({ settings, config });
  const stack = await buildRunStack(
    { settings, config, verbose: false },
    "test",
  );
  stackCleanups.push(() => stack.shutdown());
  return stack;
}

Deno.test("newRunSlotLimiterMatchesTheChannelSemantics", () => {
  assert(newRunSlotLimiter(0) === undefined);
  assert(newRunSlotLimiter(-1) === undefined);
  const limiter = newRunSlotLimiter(2)!;
  assert(limiter.tryAcquire());
  assert(limiter.tryAcquire());
  // Go's non-blocking select on a full buffered channel fails immediately.
  assert(!limiter.tryAcquire());
  limiter.release();
  assert(limiter.tryAcquire());
  limiter.release();
  limiter.release();
});

Deno.test("serveListenOptionsParsesGoListenAddresses", () => {
  assertEquals(serveListenOptions("127.0.0.1:7872"), {
    hostname: "127.0.0.1",
    port: 7872,
  });
  assertEquals(serveListenOptions(":8080"), {
    hostname: undefined,
    port: 8080,
  });
  assertEquals(serveListenOptions("[::]:9000"), {
    hostname: "::",
    port: 9000,
  });
  // A missing port falls back to the config default (Go's malformed address
  // is tolerated the same way getListenAddr defaults it).
  assertEquals(serveListenOptions("localhost"), {
    hostname: undefined,
    port: 7872,
  });
});

Deno.test("buildRunStackAssemblesServerHooksRoutesAndMiddleware", async () => {
  const seen: string[] = [];
  const stack = await newTestStack(({ config }) => {
    config.maxConcurrentReqs = 4;
    config.enableWebSearch = true;
  });
  stack.srv.setRunCompleteObserver((sessionId, runId, status) => {
    seen.push(`${sessionId}/${runId}/${status}`);
  });

  // The assembly built the runtime-owned and hook halves Go implements as
  // concrete methods.
  assert(stack.srv.runManager !== undefined);
  assert(stack.srv.recoveryCoordinator !== undefined);
  assert(stack.srv.runSlots !== undefined);
  assert(stack.srv.handleCommand !== undefined);
  assert(stack.srv.startESM !== undefined);
  assert(stack.srv.setSessionExpert !== undefined);
  assert(stack.srv.executeResponsesBackgroundRun !== undefined);
  assert(stack.srv.submitExternalResponsesBackground !== undefined);
  // A chat-API provider carries no Responses background driver.
  assert(stack.srv.responsesRuns === undefined);
  // The WebSearch config flip propagated into the live settings snapshot.
  assertEquals(stack.srv.settings?.webSearch?.enabled, true);

  // Route table: /health answers publicly, the chat handler is bound (the
  // empty body is rejected by the handler, not the mux), and unknown paths
  // keep Go's plain-text 404.
  const health = await stack.handler(new Request("http://127.0.0.1/health"));
  assertEquals(health.status, 200);
  assertEquals((await health.json()).status, "ok");

  const chat = await stack.handler(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      body: "not json",
    }),
  );
  assertEquals(chat.status, 400);

  const missing = await stack.handler(
    new Request("http://127.0.0.1/nope"),
  );
  assertEquals(missing.status, 404);
  assertEquals(await missing.text(), "404 page not found\n");
  assertEquals(seen, []);

  await stack.shutdown();
  await stack.shutdown(); // idempotent like Go's deferred shutdown path
});

Deno.test("buildRunStackDisableAPISkipsTheAPISurfaceButKeepsHealth", async () => {
  const settings = baseSettings();
  const disabled = await buildRunStack(
    { settings, config: defaultConfig(), disableAPI: true },
    "test",
  );
  stackCleanups.push(() => disabled.shutdown());
  const chat = await disabled.handler(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }),
  );
  assertEquals(chat.status, 404);
  const health = await disabled.handler(
    new Request("http://127.0.0.1/health"),
  );
  assertEquals(health.status, 200);
  await disabled.shutdown();
});

Deno.test("buildRunStackAuthMuxKeepsHealthPublicAndProtectsTheAPI", async () => {
  const settings = baseSettings();
  const config = defaultConfig();
  config.auth = { enabled: true, tokens: ["tok-1"] };
  const stack = await buildRunStack({ settings, config }, "test");
  stackCleanups.push(() => stack.shutdown());

  const health = await stack.handler(new Request("http://127.0.0.1/health"));
  assertEquals(health.status, 200);

  const unauthorized = await stack.handler(
    new Request("http://127.0.0.1/v1/models"),
  );
  assertEquals(unauthorized.status, 401);

  const wrongToken = await stack.handler(
    new Request("http://127.0.0.1/v1/models", {
      headers: { authorization: "Bearer nope" },
    }),
  );
  assertEquals(wrongToken.status, 401);

  const authorized = await stack.handler(
    new Request("http://127.0.0.1/v1/models", {
      headers: { authorization: "Bearer tok-1" },
    }),
  );
  assertEquals(authorized.status, 200);
  await stack.shutdown();
});

Deno.test("buildRunStackRejectsPublicListenWithoutAuth", async () => {
  const settings = baseSettings();
  const config = defaultConfig();
  config.listen = "0.0.0.0:8899";
  await assertRejects(
    () => buildRunStack({ settings, config }, "test"),
    Error,
    "requires at least one configured API token",
  );
});

Deno.test("buildRunStackWrapsUnknownProvider", async () => {
  const settings = baseSettings();
  const opts = { settings, config: defaultConfig(), provider: "ghost" };
  const cfg = loadRunConfig(opts);
  assert(cfg !== undefined);
  await assertRejects(
    () => buildRunStack(opts, "test"),
    Error,
    "create provider: unknown provider: ghost",
  );
});

Deno.test("runServesHealthAndTerminatesGracefullyOnShutdown", async () => {
  // Mirror Go's reserveProcessTestAddress: bind a throwaway listener to pick
  // a free loopback port.
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const addr = (probe.addr as Deno.NetAddr).port;
  probe.close();

  const settings = baseSettings();
  const workDir = tempDir("serve_run_workdir_");
  tempRoots.push(workDir);
  const shutdown = new AbortController();
  let readySrv: unknown;
  const serving = run(
    {
      settings,
      port: `127.0.0.1:${addr}`,
      workDir,
      shutdown: shutdown.signal,
      onReady: (srv) => {
        readySrv = srv;
      },
    },
    "test",
  );

  // Poll /health exactly like waitServeHealth.
  let healthy = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${addr}/health`);
      if (resp.status === 200) {
        const body = await resp.json();
        assertEquals(body.status, "ok");
        healthy = true;
        break;
      }
    } catch {
      // The listener is not up yet.
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert(healthy, "serve never reported healthy");
  assert(readySrv !== undefined);

  shutdown.abort();
  await serving; // graceful termination without error
});

Deno.test("runRejectsWhenTheListenAddressIsTaken", async () => {
  const blocker = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const addr = (blocker.addr as Deno.NetAddr).port;
  const settings = baseSettings();
  await assertRejects(
    () =>
      run(
        { settings, port: `127.0.0.1:${addr}`, workDir: tempDir("srv_wd_") },
        "test",
      ),
    Error,
    "server error",
  );
  blocker.close();
});

// Registered last so it runs after every test above (Deno runs tests in
// registration order); @std/testing's bdd hooks are not a project dependency.
Deno.test("runLifecycleTeardownSafetyNet", () => {
  runStackCleanups();
  for (const dir of tempRoots) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});
