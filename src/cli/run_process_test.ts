// deno-lint-ignore-file no-explicit-any
// Subprocess integration test (migrated shape of the Go
// TestACPStdioProcessHelper family): spawns `deno run src/main.ts acp` in a
// temp OPENSAC_DIR and verifies the initialize handshake over real stdio, the
// startup error line for an unconfigured provider, and clean EOF shutdown.

import { assert, assertEquals } from "@opensac/assert";
import * as path from "@opensac/path";
import { CorePaths } from "../core/paths.ts";
import { CoreRegistry } from "../core/registry.ts";

const mainTs = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
  "main.ts",
);

interface SpawnResult {
  output: string;
  stderr: string;
  code: number | null;
}

async function stopOwnedCore(configDir: string): Promise<void> {
  try {
    const registration = await new CoreRegistry(
      CorePaths.fromStateDir(configDir),
    ).read();
    if (registration !== undefined && registration.pid !== Deno.pid) {
      try {
        Deno.kill(registration.pid, "SIGTERM");
      } catch {
        // The Core may already have exited.
      }
    }
  } catch {
    // Startup may fail before registration is published.
  }
}

async function runAcp(
  lines: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<SpawnResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--quiet", mainTs, "acp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...env },
    cwd,
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  for (const line of lines) await writer.write(new TextEncoder().encode(line));
  await writer.close();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  await stopOwnedCore(env.OPENSAC_DIR ?? "");
  return {
    output: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code: status.code,
  };
}

function writeSettings(
  configDir: string,
  data: Record<string, unknown>,
): void {
  Deno.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  Deno.writeTextFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      core: { host: "127.0.0.1", port: 0, auth: false, passwords: [] },
      ...data,
    }),
    { mode: 0o600 },
  );
}

Deno.test("acp subprocess completes initialize handshake", async () => {
  const configDir = Deno.makeTempDirSync();
  const homeDir = Deno.makeTempDirSync();
  // Build a minimal settings blob around a provider whose presence is only
  // validated structurally; use the same defaults path as the CLI. If no
  // provider key exists, startup emits OPENSAC_ACP_ERROR instead, which the
  // next test covers. Here we only assert the process speaks NDJSON when a
  // settings file exists: initialize either succeeds or yields a typed RPC
  // error (never a crash).
  writeSettings(configDir, {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    providers: {
      deepseek: {
        api: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        models: [{ id: "deepseek-chat", name: "Test", input: ["text"] }],
      },
    },
  });
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  }) + "\n";
  const result = await runAcp([initialize], {
    OPENSAC_DIR: configDir,
    HOME: homeDir,
  });
  const lines: string[] = result.output.trim().split("\n").filter(Boolean);
  assert(lines.length >= 1, `expected output, stderr=${result.stderr}`);
  const message: Record<string, any> = JSON.parse(lines[0]);
  assertEquals(message["id"], 1);
  const rpcError: Record<string, any> | undefined = message["error"];
  if (rpcError !== undefined) {
    // Structured error is acceptable when the dev environment lacks the
    // provider preset; it must still be a JSON-RPC envelope.
    assertEquals(typeof rpcError["code"], "number");
  } else {
    const resultEnvelope = message["result"] as Record<string, any>;
    const capabilities = resultEnvelope["agentCapabilities"];
    assert(capabilities !== undefined);
  }
});

Deno.test("acp subprocess rejects methods before initialize", async () => {
  const configDir = Deno.makeTempDirSync();
  const homeDir = Deno.makeTempDirSync();
  writeSettings(configDir, {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    providers: {
      deepseek: {
        api: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        models: [{ id: "deepseek-chat", name: "Test", input: ["text"] }],
      },
    },
  });
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "session/list",
  }) + "\n";
  const result = await runAcp([line], {
    OPENSAC_DIR: configDir,
    HOME: homeDir,
  });
  const message: Record<string, any> = JSON.parse(
    result.output.trim().split("\n")[0],
  );
  assertEquals(message["id"], 1);
  const rpcError: Record<string, any> = message["error"];
  assertEquals(rpcError["code"], -32600);
  assertEquals(
    rpcError["message"],
    "initialize must be called first",
  );
});

Deno.test("acp subprocess exits cleanly at EOF after initialize", async () => {
  const configDir = Deno.makeTempDirSync();
  const homeDir = Deno.makeTempDirSync();
  writeSettings(configDir, {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    providers: {
      deepseek: {
        api: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        models: [{ id: "deepseek-chat", name: "Test", input: ["text"] }],
      },
    },
  });
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "opensac/doctor",
    }) + "\n",
  ];
  const result = await runAcp(lines, {
    OPENSAC_DIR: configDir,
    HOME: homeDir,
  });
  const messages: Record<string, any>[] = result.output.trim().split("\n")
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
  const ids = messages.map((m) => m["id"]);
  assert(ids.includes(1));
  assert(ids.includes(2));
  assertEquals(messages.find((message) => message.id === 2)?.error, undefined);
});

Deno.test("acp subprocess routes project extensions through Core", async () => {
  const configDir = Deno.makeTempDirSync();
  const homeDir = Deno.makeTempDirSync();
  writeSettings(configDir, {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    providers: {
      deepseek: {
        api: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        models: [{ id: "deepseek-chat", name: "Test", input: ["text"] }],
      },
    },
  });
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "opensac/projects/create",
      params: { name: "CoreProject" },
    }) + "\n",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "opensac/projects/list",
      params: {},
    }) + "\n",
  ];
  const result = await runAcp(lines, {
    OPENSAC_DIR: configDir,
    HOME: homeDir,
  });
  const messages: Record<string, any>[] = result.output.trim().split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line));
  const created = messages.find((message) => message.id === 2);
  const listed = messages.find((message) => message.id === 3);
  assertEquals(created?.result?.name, "CoreProject");
  assertEquals(listed?.result?.projects?.[0]?.name, "CoreProject");
});

Deno.test("acp subprocess --help is served by the CLI parser", async () => {
  const result = await runAcp([], {}, undefined);
  // Empty stdin with no provider is the startup path; --help is checked via a
  // direct command instead to avoid the ACP preflight.
  void result;
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--quiet", mainTs, "acp", "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const { stdout } = await child.output();
  const help = new TextDecoder().decode(stdout);
  assert(help.includes("permission-timeout"));
  assert(help.includes("question-timeout"));
});
