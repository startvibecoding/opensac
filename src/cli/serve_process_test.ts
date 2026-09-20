// Subprocess test for `mothx serve` HTTP bootstrap: spawns `deno run
// src/main.ts serve --port 0 --config <file>`, reads the chosen port from the
// startup banner, and verifies /api/status responds over real HTTP.

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";

const mainTs = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
  "main.ts",
);

Deno.test("serve subprocess answers /api/status on the bound port", async () => {
  const dir = Deno.makeTempDirSync();
  const configFile = path.join(dir, "serve.json");
  Deno.writeTextFileSync(
    configFile,
    JSON.stringify({
      features: {
        webUI: false,
        openAIAPI: false,
        cron: false,
        memory: false,
      },
    }),
  );
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--quiet",
      mainTs,
      "serve",
      "--config",
      configFile,
      "--port",
      "0",
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), MOTHX_DIR: dir },
  });
  const child = command.spawn();
  let boundPort = 0;
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    const reader = child.stderr.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/Listen: http:\/\/[^:/]+:(\d+)/) ||
        buffer.match(/OpenAI API: http:\/\/[^:/]+:(\d+)\//) ||
        buffer.match(/Web UI: http:\/\/[^:/]+:(\d+)\//) ||
        buffer.match(/Listening on http:\/\/[^:]+:(\d+)\//);
      if (match) boundPort = Number(match[1]);
    }
  })();
  try {
    const deadline = Date.now() + 15_000;
    while (boundPort === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(boundPort > 0, "serve did not print a bound port");
    const response = await fetch(`http://127.0.0.1:${boundPort}/api/status`);
    assertEquals(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assertEquals(body["status"], "ok");
    const features = body["features"] as Record<string, unknown>;
    assertEquals(features["webUI"], false);
    // Unknown route with Web UI disabled → 404
    const missing = await fetch(`http://127.0.0.1:${boundPort}/nope`);
    assertEquals(missing.status, 404);
  } finally {
    child.kill("SIGTERM");
    await pump;
    try {
      await child.status;
    } catch {
      // already reaped
    }
  }
});
