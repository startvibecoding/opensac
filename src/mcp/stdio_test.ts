// Translated from internal/mcp/mcp_stdio_test.go
//
// Real stdio MCP handshakes against shell fixtures (Unix only), plus the
// command-resolution and environment helpers.

import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { Image } from "imagescript";
import * as path from "@std/path";
import { newNoneSandbox } from "../sandbox/mod.ts";
import { newRegistry, type Tool } from "../tools/mod.ts";
import {
  type Callbacks,
  closeClients,
  connectServers,
  mergeMCPEnvironment,
  resolveMCPCommand,
} from "./mcp.ts";

const isWindows = Deno.build.os === "windows";

function writeExecutable(filePath: string, content: string): void {
  Deno.writeTextFileSync(filePath, content);
  Deno.chmodSync(filePath, 0o755);
}

Deno.test("resolveMCPCommand uses configured PATH", () => {
  if (isWindows) return;
  const dir = Deno.makeTempDirSync();
  const command = path.join(dir, "mcp-test-command");
  writeExecutable(command, "#!/bin/sh\nexit 0\n");
  const resolved = resolveMCPCommand("mcp-test-command", { PATH: dir });
  assertEquals(resolved, command);
});

Deno.test("mergeMCPEnvironment overrides inherited values", () => {
  if (isWindows) return;
  const prev = Deno.env.get("MCP_TEST_INHERITED");
  Deno.env.set("MCP_TEST_INHERITED", "old");
  try {
    const env = mergeMCPEnvironment([
      { name: "MCP_TEST_INHERITED", value: "new" },
      { name: "MCP_TEST_ADDED", value: "added" },
    ]);
    assertEquals(env["MCP_TEST_INHERITED"], "new");
    assertEquals(env["MCP_TEST_ADDED"], "added");
  } finally {
    if (prev === undefined) Deno.env.delete("MCP_TEST_INHERITED");
    else Deno.env.set("MCP_TEST_INHERITED", prev);
  }
});

Deno.test("MCP stdio command from PATH receives configured environment", async () => {
  if (isWindows) return;
  const commandDir = Deno.makeTempDirSync();
  const commandPath = path.join(commandDir, "mcp-stdio-fixture");
  const fixture = String.raw`#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25"}}\n' "$id"
      ;;
    tools/list)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"env_echo","description":"echo configured env","inputSchema":{"type":"object"}}]}}\n' "$id"
      ;;
    tools/call)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"env:%s"}]}}\n' "$id" "$MCP_FIXTURE_VALUE"
      ;;
    resources/list|prompts/list)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      ;;
  esac
done
`;
  writeExecutable(commandPath, fixture);

  const registry = newRegistry(Deno.makeTempDirSync(), newNoneSandbox());
  registry.registerDefaults();
  const sep = ":";
  const clients = await connectServers(
    new AbortController().signal,
    [{
      name: "path-fixture",
      type: "stdio",
      command: path.basename(commandPath),
      env: [
        {
          name: "PATH",
          value: commandDir + sep + (Deno.env.get("PATH") ?? ""),
        },
        { name: "MCP_FIXTURE_VALUE", value: "from-config" },
      ],
    }],
    registry,
    {},
  );
  try {
    const envTool = registry.all().find((t: Tool) =>
      t.name().includes("_env_echo")
    );
    assert(envTool, "stdio command did not register env_echo tool");
    const result = await envTool!.execute({}, {});
    assertEquals(result.text, "env:from-config");
  } finally {
    closeClients(clients);
  }
});

Deno.test("MCP stdio image tool result carries image content", async () => {
  if (isWindows) return;
  const img = new Image(1, 1);
  img.bitmap[0] = 5;
  img.bitmap[1] = 6;
  img.bitmap[2] = 7;
  img.bitmap[3] = 255;
  const payload = encodeBase64(await img.encode());

  const commandDir = Deno.makeTempDirSync();
  const commandPath = path.join(commandDir, "mcp-image-fixture");
  const fixture = String.raw`#!/bin/sh
png=` + payload + String.raw`
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25"}}\n' "$id"
      ;;
    tools/list)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"screenshot","description":"return an image","inputSchema":{"type":"object"}}]}}\n' "$id"
      ;;
    tools/call)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"captured"},{"type":"image","mimeType":"image/png","data":"%s"}]}}\n' "$id" "$png"
      ;;
    resources/list|prompts/list)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      ;;
  esac
done
`;
  writeExecutable(commandPath, fixture);

  const registry = newRegistry(Deno.makeTempDirSync(), newNoneSandbox());
  registry.registerDefaults();
  const clients = await connectServers(
    new AbortController().signal,
    [{
      name: "image-fixture",
      type: "stdio",
      command: path.basename(commandPath),
      env: [
        {
          name: "PATH",
          value: commandDir + ":" + (Deno.env.get("PATH") ?? ""),
        },
      ],
    }],
    registry,
    {},
  );
  try {
    const imageTool = registry.all().find((t: Tool) =>
      t.name().includes("_screenshot")
    );
    assert(imageTool, "stdio fixture did not register its screenshot tool");
    const result = await imageTool!.execute({}, {});
    assert(result.text.includes("captured"), result.text);
    assertEquals(result.contents?.length, 2);
    const image = result.contents![1];
    assertEquals(image.type, "image");
    assertEquals(image.image?.mimeType, "image/png");
    assert(image.image?.data, "projected image must carry a payload");
  } finally {
    closeClients(clients);
  }
});

// Keep the Callbacks type imported for parity coverage.
const _callbacks: Callbacks = {};
void _callbacks;
