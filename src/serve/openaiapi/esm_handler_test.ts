// Translated from internal/serve/openaiapi/esm_handler_test.go — the ESM HTTP
// control lifecycle, the active-foreground-run conflict, and the stale-version
// conflict.
//
// Deviations: Go's httptest recorder maps to awaiting the handler with a
// standard Request and inspecting the Response; srv.esmStore().Get maps to the
// synchronous store.get.
import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { newMockProvider } from "../../provider/mock.ts";
import {
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/mod.ts";
import { type Config, getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { ErrESMControlRequiresIdle } from "./esm_api.ts";
import { clearESM, createESM, pauseESM, resumeESM } from "./esm_api.ts";
import { handleESMAPI } from "./esm_handler.ts";
import { esmStore, getOrCreateSession } from "./handler_chat_session.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function testModel(): Model {
  return {
    id: "m1",
    name: "Model 1",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };
}

function newTestServer(): Server {
  const sessionDir = tempDir("openaiapi-esm-hdl-sess-");
  const workDir = tempDir("openaiapi-esm-hdl-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: { defaultWorkDir: workDir } as Config,
  });
  server.pool = new SessionPool(0, 0);
  const p = newMockProvider("mock", [testModel()], [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "ok" },
    { type: streamDone, stopReason: "stop" },
  ]);
  server.provider = p as unknown as Provider;
  server.model = p.models()[0];
  return server;
}

function jsonRequest(
  method: string,
  path: string,
  body?: string,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    body: body === undefined ? undefined : body,
  });
}

async function readJSON(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.clone().text());
}

Deno.test("handleESMAPIControlLifecycle", async () => {
  const server = newTestServer();
  try {
    const id = "webui-esm";
    await getOrCreateSession(server, id, getWorkDir(server.cfg as Config));

    let response = await handleESMAPI(
      server,
      jsonRequest(
        "POST",
        `/api/sessions/${id}/esm`,
        `{"objective":"run tests","tokenBudget":100}`,
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    const created = await readJSON(response);
    assertEquals(created.status, "active");
    assertEquals(created.objective, "run tests");
    // tokenBudget is no longer part of the ESM contract; legacy payloads must
    // be accepted and ignored.
    assertEquals(created.tokensUsed, 0);
    assertEquals(created.timeUsedMs, 0);

    response = await handleESMAPI(
      server,
      jsonRequest(
        "POST",
        `/api/sessions/${id}/esm/guidance`,
        `{"guidance":"prioritize focused tests","version":"${created.version}"}`,
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    const guided = await readJSON(response);
    const guidance = guided.guidance as Array<Record<string, unknown>>;
    assertEquals(guidance.length, 1);
    assertEquals(guidance[0].guidance, "prioritize focused tests");

    response = await handleESMAPI(
      server,
      jsonRequest("POST", `/api/sessions/${id}/esm/pause`),
    );
    assertEquals(response.status, 200, await response.clone().text());

    response = await handleESMAPI(
      server,
      jsonRequest("POST", `/api/sessions/${id}/esm/resume`),
    );
    assertEquals(response.status, 200, await response.clone().text());

    response = await handleESMAPI(
      server,
      jsonRequest("DELETE", `/api/sessions/${id}/esm`),
    );
    assertEquals(response.status, 200, await response.clone().text());
    const cleared = await readJSON(response);
    assertEquals(cleared.status, "none");
  } finally {
    closeAll();
  }
});

Deno.test("esmLifecycleControlsRejectActiveForegroundRun", async () => {
  const server = newTestServer();
  try {
    const id = "webui-esm-active-control";
    const sess = await getOrCreateSession(
      server,
      id,
      getWorkDir(server.cfg as Config),
    );
    createESM(server, id, "finish the objective");
    sess.setRunning(true);

    const response = await handleESMAPI(
      server,
      jsonRequest("POST", `/api/sessions/${id}/esm/pause`),
    );
    assertEquals(
      response.status,
      409,
      `active-run pause HTTP status, body: ${await response.clone().text()}`,
    );

    let err = "";
    try {
      await pauseESM(server, id);
    } catch (e) {
      err = (e as Error).message;
      assertEquals(e, ErrESMControlRequiresIdle);
    }
    assert(err !== "", "PauseESM error = nil");
    try {
      await resumeESM(server, id);
    } catch (e) {
      assertEquals(e, ErrESMControlRequiresIdle);
    }
    try {
      await clearESM(server, id);
    } catch (e) {
      assertEquals(e, ErrESMControlRequiresIdle);
    }
    const obj = esmStore(server)!.get(id);
    assertEquals(
      obj.status,
      "active",
      "lifecycle control changed active objective",
    );
    sess.setRunning(false);
  } finally {
    closeAll();
  }
});

Deno.test("handleESMAPIRejectsStaleVersion", async () => {
  const server = newTestServer();
  try {
    const id = "webui-esm-version";
    await getOrCreateSession(server, id, getWorkDir(server.cfg as Config));
    const created = createESM(server, id, "old");
    const response = await handleESMAPI(
      server,
      jsonRequest(
        "PATCH",
        `/api/sessions/${id}/esm`,
        `{"objective":"new","version":"stale"}`,
      ),
    );
    assertEquals(response.status, 409, await response.clone().text());
    assertEquals(created.status, "active");
  } finally {
    closeAll();
  }
});
