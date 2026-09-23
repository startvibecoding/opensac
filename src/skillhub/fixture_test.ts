import { assertEquals, assertStringIncludes } from "@std/assert";
import { createClawHubClient } from "./clawhub.ts";
import { clientsForSettings } from "./factory.ts";
import { jsonResponse, startServer } from "./test_helpers.ts";

Deno.test("ConfiguredClientsUseURLAndBearerToken", async () => {
  const server = await startServer((request) => {
    assertEquals(request.headers.get("authorization"), "Bearer secret");
    assertEquals(new URL(request.url).pathname, "/api/v1/search");
    return jsonResponse(`{"results":[]}`);
  });
  try {
    const clients = clientsForSettings({
      markets: [
        {
          id: "skillhub.cn",
          apiURL: server.url,
          enabled: true,
          apiToken: "secret",
        },
      ],
    });
    assertEquals(clients.length, 1);
    await clients[0].search(undefined, { query: "fixture" });
  } finally {
    await server.close();
  }
});

Deno.test("ClawHubFileContentFixture", async () => {
  const server = await startServer((request) => {
    assertStringIncludes(new URL(request.url).pathname, "/files/SKILL.md");
    return jsonResponse(`{"content":"# Fixture Skill"}`);
  });
  try {
    const content = await createClawHubClient(server.url).fileContent(
      undefined,
      { market: "clawhub.ai", id: "org/demo" },
      "1.0.0",
      "SKILL.md",
    );
    assertEquals(content, "# Fixture Skill");
  } finally {
    await server.close();
  }
});
