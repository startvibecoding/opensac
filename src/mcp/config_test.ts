import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { type MCPServer, saveMCPConfig } from "../config/mcp.ts";
import { isTemplateServer, loadConfiguredServers } from "./config.ts";

Deno.test("isTemplateServer", () => {
  const cases: Array<{ name: string; srv: MCPServer; want: boolean }> = [
    {
      name: "real stdio",
      srv: {
        name: "local",
        type: "stdio",
        command: "/usr/local/bin/mcp-server",
      },
      want: false,
    },
    {
      name: "empty name",
      srv: { name: "", type: "stdio", command: "/usr/local/bin/mcp-server" },
      want: true,
    },
    {
      name: "placeholder command",
      srv: {
        name: "example",
        type: "stdio",
        command: "/absolute/path/to/mcp-server",
      },
      want: true,
    },
    {
      name: "placeholder url",
      srv: { name: "example", type: "http", url: "https://mcp.example.com" },
      want: true,
    },
  ];

  for (const tc of cases) {
    assertEquals(isTemplateServer(tc.srv), tc.want, tc.name);
  }
});

Deno.test("loadConfiguredServers skips disabled entries", () => {
  const configDir = Deno.makeTempDirSync();
  const projectDir = Deno.makeTempDirSync();
  const prev = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", configDir);
  try {
    saveMCPConfig(path.join(configDir, "mcp.json"), {
      mcpServers: [
        {
          name: "disabled",
          type: "stdio",
          command: "disabled-command",
          enabled: false,
        },
        {
          name: "enabled",
          type: "stdio",
          command: "enabled-command",
          enabled: true,
        },
      ],
    });
    const projectConfigPath = path.join(projectDir, ".opensac", "mcp.json");
    Deno.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    Deno.writeTextFileSync(
      projectConfigPath,
      `{"mcpServers":[{"name":"legacy","type":"stdio","command":"legacy-command"}]}`,
    );
    const servers = loadConfiguredServers(projectDir);
    assertEquals(servers.length, 2);
    assertEquals(servers[0].name, "enabled");
    assertEquals(servers[1].name, "legacy");
    assert(true);
  } finally {
    if (prev === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", prev);
  }
});
