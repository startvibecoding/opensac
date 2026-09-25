import { assertEquals, assertRejects } from "@std/assert";
import { type ResolvedCoreConfig } from "./config.ts";
import { CoreAuth } from "./auth.ts";
import { CORE_METHODS } from "./protocol.ts";
import { CoreServer, type CoreServerHandle } from "./server.ts";
import { CORE_RUNTIME_METHODS } from "./runtime_protocol.ts";

const TEST_VERSION = "0.1.0-test";
const TEST_PROTOCOL_VERSION = 7;

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

async function startServer(
  overrides: Partial<ResolvedCoreConfig> = {},
): Promise<CoreServerHandle> {
  const server = new CoreServer({
    config: config(overrides),
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
  });
  return await server.start();
}

async function stopServer(handle: CoreServerHandle): Promise<void> {
  try {
    await handle.stop();
  } finally {
    await handle.stop();
  }
}

Deno.test("CoreServer exposes unauthenticated health on an ephemeral port", async () => {
  const handle = await startServer();
  try {
    const response = await fetch(new URL("/health", handle.url));
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { healthy: true });
    assertEquals(handle.address.transport, "tcp");
    assertEquals((handle.address as Deno.NetAddr).port > 0, true);
    assertEquals(
      handle.url.includes(String((handle.address as Deno.NetAddr).port)),
      true,
    );
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer keeps health public when authentication is enabled", async () => {
  const handle = await startServer({
    auth: true,
    passwords: ["health-secret", "other-secret"],
  });
  try {
    const response = await fetch(
      new URL("/health?password=health-secret", handle.url),
    );
    assertEquals(response.status, 200);
    const text = await response.text();
    assertEquals(JSON.parse(text), { healthy: true });
    assertEquals(text.includes("health-secret"), false);
    assertEquals(text.includes("other-secret"), false);
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer serves core.health and core.info without private configuration", async () => {
  const handle = await startServer({
    auth: true,
    passwords: ["rpc-secret"],
  });
  try {
    const health = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: {
        authorization: "Bearer rpc-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: CORE_METHODS.health,
      }),
    });
    assertEquals(health.status, 200);
    const healthBody = await health.json();
    assertEquals(healthBody, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        healthy: true,
        version: TEST_VERSION,
        protocolVersion: TEST_PROTOCOL_VERSION,
      },
    });

    const info = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: { authorization: "Bearer rpc-secret" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "info-1",
        method: CORE_METHODS.info,
      }),
    });
    assertEquals(info.status, 200);
    const infoBody = await info.json();
    assertEquals(infoBody, {
      jsonrpc: "2.0",
      id: "info-1",
      result: {
        version: TEST_VERSION,
        protocolVersion: TEST_PROTOCOL_VERSION,
        coreProtocolVersion: 1,
        features: [
          CORE_METHODS.health,
          CORE_METHODS.info,
          ...Object.values(CORE_RUNTIME_METHODS),
        ],
      },
    });
    const text = JSON.stringify(infoBody);
    for (
      const secret of [
        "rpc-secret",
        "127.0.0.1",
        "pid",
        "passwords",
        "provider",
      ]
    ) {
      assertEquals(text.includes(secret), false, secret);
    }
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer allows unauthenticated RPC when auth is disabled", async () => {
  const handle = await startServer({ passwords: ["ignored-secret"] });
  try {
    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: CORE_METHODS.health,
      }),
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).result.healthy, true);
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer accepts any configured Bearer password", async () => {
  const handle = await startServer({
    auth: true,
    passwords: ["one-secret", "two-secret"],
  });
  try {
    for (const password of ["one-secret", "two-secret"]) {
      const response = await fetch(new URL("/rpc", handle.url), {
        method: "POST",
        headers: { authorization: `Bearer ${password}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: CORE_METHODS.health,
        }),
      });
      assertEquals(response.status, 200, password);
      assertEquals((await response.json()).result.healthy, true, password);
    }
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer rejects missing or wrong passwords only from the auth header", async () => {
  const handle = await startServer({
    auth: true,
    passwords: ["header-secret"],
  });
  try {
    const calls = [
      fetch(new URL("/rpc", handle.url), {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: CORE_METHODS.health,
        }),
      }),
      fetch(new URL("/rpc?password=header-secret", handle.url), {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: CORE_METHODS.health,
          params: { password: "header-secret" },
        }),
      }),
      fetch(new URL("/rpc", handle.url), {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: CORE_METHODS.health,
        }),
      }),
      fetch(new URL("/rpc", handle.url), {
        method: "POST",
        headers: { authorization: "Basic header-secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: CORE_METHODS.health,
        }),
      }),
      fetch(new URL("/rpc", handle.url), {
        method: "POST",
        headers: { authorization: "Bearer " },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: CORE_METHODS.health,
        }),
      }),
    ];
    for (const call of calls) {
      const response = await call;
      assertEquals(response.status, 401);
      const body = await response.json();
      assertEquals(body.jsonrpc, "2.0");
      assertEquals(typeof body.error.code, "number");
      assertEquals(typeof body.error.message, "string");
      assertEquals(JSON.stringify(body).includes("header-secret"), false);
    }
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer returns JSON-RPC errors for malformed and unknown RPC input", async () => {
  const handle = await startServer();
  try {
    const invalidJson = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      body: "{not-json",
    });
    assertEquals(invalidJson.status, 400);
    assertEquals(await invalidJson.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const invalidRequest = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: CORE_METHODS.health,
      }),
    });
    assertEquals(invalidRequest.status, 400);
    const invalidBody = await invalidRequest.json();
    assertEquals(invalidBody.jsonrpc, "2.0");
    assertEquals(invalidBody.error.code, -32600);

    const unknown = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unknown",
        method: "core.missing",
      }),
    });
    assertEquals(unknown.status, 200);
    assertEquals((await unknown.json()).error.code, -32601);
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer returns a JSON-RPC error for unknown routes", async () => {
  const handle = await startServer();
  try {
    const response = await fetch(new URL("/does-not-exist", handle.url));
    assertEquals(response.status, 404);
    assertEquals(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "Not found" },
    });
  } finally {
    await stopServer(handle);
  }
});

Deno.test("CoreServer refuses authentication with no configured passwords", async () => {
  const server = new CoreServer({
    config: config({ auth: true, passwords: [] }),
    version: TEST_VERSION,
    protocolVersion: TEST_PROTOCOL_VERSION,
  });
  await assertRejects(() => server.start(), Error, "password");
});

Deno.test("CoreAuth ignores URL and JSON-RPC params and uses only Bearer auth", () => {
  const protectedConfig = config({ auth: true, passwords: ["header-only"] });
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc?password=header-only", {
        method: "POST",
        body: JSON.stringify({ password: "header-only" }),
      }),
      protectedConfig,
    ),
    false,
  );
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc", {
        headers: { authorization: "Bearer header-only" },
      }),
      protectedConfig,
    ),
    true,
  );
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc", {
        headers: { authorization: "bearer header-only" },
      }),
      protectedConfig,
    ),
    true,
  );
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc", {
        headers: { authorization: "Bearer " },
      }),
      protectedConfig,
    ),
    false,
  );
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc", {
        headers: { authorization: "Basic header-only" },
      }),
      protectedConfig,
    ),
    false,
  );
  assertEquals(
    CoreAuth.authenticate(
      new Request("http://core.test/rpc"),
      config({ auth: false, passwords: [] }),
    ),
    true,
  );
});
