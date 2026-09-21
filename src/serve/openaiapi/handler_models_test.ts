// Translated from internal/serve/openaiapi handler_health.go, handler_models.go,
// and handler_provider_tools.go test cases (server_test.go / pure handler
// assertions), adapted to the Response-returning handler projection.
import { assert, assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import { handleHealth } from "./handler_health.ts";
import { handleModelCatalog, handleModels } from "./handler_models.ts";
import {
  handleProviderModels,
  handleProviderModelTest,
} from "./handler_provider_tools.ts";
import { SessionPool } from "./session_mgr.ts";
import type { Provider } from "../../provider/provider.ts";
import type { Model } from "../../provider/types.ts";

function fakeModel(id: string, provider: string): Model {
  return {
    id,
    name: id,
    provider,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function fakeProvider(models: Model[]): Provider {
  return {
    name: () => "fake",
    api: () => "openai-chat",
    models: () => models,
    getModel: (id: string) => models.find((m) => m.id === id),
    chat: () => {
      throw new Error("not used");
    },
  } as unknown as Provider;
}

function postRequest(payload: unknown): Request {
  return new Request("http://localhost/api/provider/models", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

Deno.test("handleHealth reports version and pool size", () => {
  const pool = new SessionPool(0, 0);
  const server = new Server({ pool, version: "vTest" });
  const resp = handleHealth(server, new Request("http://x/health"));
  assertEquals(resp.status, 200);
  resp.json().then((payload) => {
    assertEquals(payload, { status: "ok", version: "vTest", sessions: 0 });
  });
  assertEquals(
    handleHealth(
      server,
      new Request("http://x/health", {
        method: "POST",
      }),
    ).status,
    405,
  );
});

Deno.test("handleModels projects the provider's model list", async () => {
  const server = new Server({
    provider: fakeProvider([
      fakeModel("m1", "alpha"),
      fakeModel("m2", "alpha"),
    ]),
  });
  const resp = handleModels(server, new Request("http://x/v1/models"));
  assertEquals(resp.status, 200);
  const payload = await resp.json() as {
    object: string;
    data: Record<string, unknown>[];
  };
  assertEquals(payload.object, "list");
  assertEquals(payload.data.length, 2);
  assertEquals(payload.data[0].id, "m1");
  assertEquals(payload.data[0].object, "model");
  assertEquals(payload.data[0].owned_by, "vibecoding");
  assertEquals(payload.data[0].provider, "alpha");
  assertEquals(payload.data[0].input, ["text"]);
  assertEquals(
    handleModels(server, new Request("http://x/v1/models", { method: "POST" }))
      .status,
    405,
  );
});

Deno.test("handleModelCatalog resolves the shared factory catalog", async () => {
  const server = new Server({
    providerName: "current",
    provider: fakeProvider([fakeModel("m1", "current")]),
    model: fakeModel("m1", "current"),
    settings: {
      providers: {
        current: {
          api: "openai-chat",
          baseUrl: "https://current.example",
          models: [{ id: "m1", name: "m1", input: ["text"] }],
        },
        zeta: {
          api: "openai-chat",
          baseUrl: "https://zeta.example",
          models: [
            { id: "z1", name: "z1", input: ["text"] },
            { id: "z2", name: "z2", input: ["text", "image"] },
          ],
        },
      },
    } as unknown as Server["settings"],
  });
  const resp = handleModelCatalog(
    server,
    new Request("http://x/api/models/catalog"),
  );
  assertEquals(resp.status, 200);
  const payload = await resp.json() as {
    object: string;
    defaultProvider: string;
    defaultModel: string;
    providers: string[];
    data: { id: string; provider: string }[];
  };
  assertEquals(payload.object, "list");
  assertEquals(payload.defaultProvider, "current");
  assertEquals(payload.defaultModel, "m1");
  // The active provider is always selectable even without settings entries.
  assert(payload.providers.includes("current"));
  assert(payload.providers.includes("zeta"));
  assert(payload.data.some((m) => m.id === "z1" && m.provider === "zeta"));
});

Deno.test("handleProviderModels rejects invalid probes and non-POST methods", async () => {
  const server = new Server();
  assertEquals(
    (await handleProviderModels(
      server,
      new Request("http://x", { method: "GET" }),
    ))
      .status,
    405,
  );
  const badJSON = await handleProviderModels(
    server,
    new Request("http://x", { method: "POST", body: "{oops" }),
  );
  assertEquals(badJSON.status, 400);
  const missing = await handleProviderModels(
    server,
    postRequest({ api: "openai-chat" }),
  );
  assertEquals(missing.status, 400);
  assert(
    ((await missing.json()) as { error: { message: string } }).error.message
      .includes("api and baseUrl are required"),
  );
});

Deno.test("handleProviderModelTest requires a model and fails closed on bad providers", async () => {
  const server = new Server();
  const noModel = await handleProviderModelTest(
    server,
    postRequest({ api: "openai-chat", baseUrl: "https://x.example" }),
  );
  assertEquals(noModel.status, 400);
  assert(
    ((await noModel.json()) as { error: { message: string } }).error.message
      .includes("model is required"),
  );
  const unknownVendor = await handleProviderModelTest(
    server,
    postRequest({
      api: "no-such-protocol",
      baseUrl: "https://x.example",
      model: "m1",
    }),
  );
  // An unusable provider draft fails closed without persisting anything.
  assert(unknownVendor.status === 400 || unknownVendor.status === 502);
  const payload = (await unknownVendor.json()) as {
    ok?: boolean;
    error?: { message: string } | string;
  };
  assert(payload.ok === undefined || payload.ok === false);
});
