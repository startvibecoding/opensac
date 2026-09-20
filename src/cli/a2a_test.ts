// Focused tests for the ported `mothx a2a` command surface that does not
// require the Runtime agent factory: config resolution/override, init-config,
// and the status health probe (with an injected fetch).

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  defaultA2AStartOptions,
  executeA2AInit,
  executeA2AStatus,
  resolveA2AConfig,
} from "./a2a.ts";
import { configPath } from "../a2a/config.ts";

async function withEnv<T>(
  key: string,
  value: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = Deno.env.get(key);
  Deno.env.set(key, value);
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
}

Deno.test("resolveA2AConfig falls back to defaults without a file", async () => {
  const dir = Deno.makeTempDirSync();
  await withEnv("MOTHX_DIR", dir, () => {
    const { config, path } = resolveA2AConfig(defaultA2AStartOptions());
    assertEquals(path, configPath());
    assertEquals(config.enabled, false);
    assertEquals(config.port, 8093);
    assert(path.includes(dir));
  });
});

Deno.test("resolveA2AConfig applies CLI overrides", async () => {
  const dir = Deno.makeTempDirSync();
  await withEnv("MOTHX_DIR", dir, () => {
    const opts = defaultA2AStartOptions();
    opts.port = 9999;
    opts.workDir = "/srv/work";
    opts.authToken = "token-1";
    const { config } = resolveA2AConfig(opts);
    assertEquals(config.port, 9999);
    assertEquals(config.work_dir, "/srv/work");
    assertEquals(config.auth_token, "token-1");
  });
});

Deno.test("resolveA2AConfig reads a written global config", async () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(
    path.join(dir, "a2a.json"),
    JSON.stringify({
      enabled: false,
      port: 8123,
      host: "0.0.0.0",
      work_dir: "/x",
      auth_token: "secret",
    }),
  );
  await withEnv("MOTHX_DIR", dir, () => {
    const { config } = resolveA2AConfig(defaultA2AStartOptions());
    assertEquals(config.enabled, false);
    assertEquals(config.port, 8123);
    assertEquals(config.host, "0.0.0.0");
    assertEquals(config.auth_token, "secret");
  });
});

Deno.test("executeA2AInit writes the template and refuses overwrite", async () => {
  const dir = Deno.makeTempDirSync();
  await withEnv("MOTHX_DIR", dir, async () => {
    const written = await executeA2AInit(false, () => {});
    assert(written.endsWith("a2a.json"));
    const text = Deno.readTextFileSync(written);
    const parsed = JSON.parse(text);
    // Template = DefaultConfig() + placeholder token/work_dir/card (Go L89–99)
    assertEquals(parsed.enabled, false);
    assertEquals(parsed.port, 8093);
    assertEquals(parsed.auth_token, "change-me-to-a-random-secret");
    assert(String(parsed.work_dir).endsWith("projects"));
    await assertRejects(
      () => executeA2AInit(false, () => {}),
      Error,
      "already exists",
    );
    // --force overwrites
    await executeA2AInit(true, () => {});
  });
});

Deno.test("executeA2AStatus reports running when the agent card is reachable", async () => {
  const view = await executeA2AStatus({
    fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
    timeoutMs: 500,
  });
  assertEquals(view.running, true);
  assert(view.listen.length > 0);
});

Deno.test("executeA2AStatus reports not running on fetch failure", async () => {
  const view = await executeA2AStatus({
    fetchImpl: () => Promise.reject(new Error("connection refused")),
  });
  assertEquals(view.running, false);
  assert(view.detail.includes("connection refused"));
});
