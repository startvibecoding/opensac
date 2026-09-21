// Ported from internal/serve/mcp_api_test.go plus focused sessionWorkDir
// cases (the session-scoped branch's table lives with the run.go slice).

import { assertEquals } from "@std/assert";

import {
  type ActiveSessionsView,
  handleMCPConfigAtPath,
  sessionWorkDir,
} from "./mcp_api.ts";
import {
  type ActiveSessionInfo,
  ErrActiveSessionIDAmbiguous,
  ErrSessionNotFound,
} from "./openaiapi/session_mgr.ts";

Deno.test("MCP config handler round trip", async () => {
  const path = await Deno.makeTempDir({ prefix: "mothx-mcp-" }) + "/mcp.json";

  const put = new Request("http://localhost/api/mcp", {
    method: "PUT",
    body: `{"mcpServers":[{"name":" local ","command":"server"}]}`,
  });
  const putResult = await handleMCPConfigAtPath(put, path);
  assertEquals(putResult.status, 200);

  const get = new Request("http://localhost/api/mcp", { method: "GET" });
  const getResult = await handleMCPConfigAtPath(get, path);
  assertEquals(getResult.status, 200);
  const body = await getResult.text();
  assertEquals(
    body,
    `{"mcpServers":[{"name":"local","type":"stdio","command":"server"}]}\n`,
  );
});

Deno.test("MCP config handler rejects unknown methods", async () => {
  const result = await handleMCPConfigAtPath(
    new Request("http://localhost/api/mcp", { method: "DELETE" }),
    "/tmp/unused-mcp.json",
  );
  assertEquals(result.status, 405);
});

function info(id: string, workDir: string): ActiveSessionInfo {
  return {
    id,
    workDir,
    active: true,
    lastUsed: new Date(),
    messageCount: 0,
  };
}

Deno.test("sessionWorkDir resolves the single active session", () => {
  const view: ActiveSessionsView = {
    listActiveSessions: () => [info("s1", "/tmp/a"), info("s2", "/tmp/b")],
  };
  assertEquals(sessionWorkDir(view.listActiveSessions(), "s1"), "/tmp/a");
});

Deno.test("sessionWorkDir rejects ambiguous and unknown IDs", () => {
  const items = [info("s1", "/tmp/a"), info("s1", "/tmp/b")];
  let thrown: unknown;
  try {
    sessionWorkDir(items, "s1");
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown, ErrActiveSessionIDAmbiguous);

  thrown = undefined;
  try {
    sessionWorkDir([info("s2", "/tmp/a")], "missing");
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown, ErrSessionNotFound);
});
