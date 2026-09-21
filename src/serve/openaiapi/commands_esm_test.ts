// Translated from internal/serve/openaiapi/commands_esm_test.go — the /esm
// slash-command lifecycle through the shared Server ESM operations and the
// submit-path slash-command interception.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { Model } from "../../provider/types.ts";
import {
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/mod.ts";
import { newMockProvider } from "../../provider/mock.ts";
import type { Provider } from "../../provider/provider.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { handleSubmitRun } from "./handler_run_submit.ts";
import { handleCommandFn } from "./commands.ts";
import { cmdESM } from "./commands_esm.ts";
import { getESM } from "./esm_api.ts";
import { esmStore } from "./handler_chat_session.ts";
import { getWorkDir } from "./config.ts";

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

function newTestServer(): {
  server: Server;
  sessionDir: string;
  workDir: string;
} {
  const sessionDir = tempDir("openaiapi-cmd-esm-sess-");
  const workDir = tempDir("openaiapi-cmd-esm-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: { defaultWorkDir: workDir } as never,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  const p = newMockProvider("mock", [testModel()], [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "ok" },
    { type: streamDone, stopReason: "stop" },
  ]);
  server.provider = p as unknown as Provider;
  server.model = p.models()[0];
  return { server, sessionDir, workDir };
}

Deno.test("cmdESMLifecycle", async () => {
  const { server } = newTestServer();
  try {
    const sess = await getOrCreateSession(
      server,
      "cmd-esm-session",
      getWorkDir(server.cfg!),
    );

    let res = await cmdESM(server, sess, "/esm");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "Status: none");

    res = await cmdESM(
      server,
      sess,
      "/esm finish the migration and keep tests green",
    );
    assertEquals(res.error, false);
    assertStringIncludes(
      res.message,
      "finish the migration and keep tests green",
    );

    res = await cmdESM(server, sess, "/esm another objective");
    assertEquals(res.error, true);
    assertStringIncludes(res.message, "already exists");

    res = await cmdESM(server, sess, "/esm guide prioritize failing tests");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "Guidance queued");
    const pending = esmStore(server)!.pendingGuidance("cmd-esm-session");
    assertEquals(pending.length, 1);
    assertEquals(pending[0].guidance, "prioritize failing tests");

    res = await cmdESM(server, sess, "/esm pause");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "paused");

    res = await cmdESM(server, sess, "/esm resume");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "active");

    res = await cmdESM(server, sess, "/esm edit ship the new objective text");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "ship the new objective text");

    res = await cmdESM(server, sess, "/esm");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "ship the new objective text");
    assertStringIncludes(res.message, "/esm guide");

    res = await cmdESM(server, sess, "/esm clear");
    assertEquals(res.error, false);
    assertStringIncludes(res.message.toLowerCase(), "cleared");

    res = await cmdESM(server, sess, "/esm");
    assertEquals(res.error, false);
    assertStringIncludes(res.message, "Status: none");

    const handle = handleCommandFn(server);
    const plain = await handle(sess, "plain message");
    assertEquals(plain, null);
  } finally {
    closeAll();
  }
});

Deno.test("submitRunInterceptsSlashCommands", async () => {
  const { server } = newTestServer();
  server.handleCommand = handleCommandFn(server);
  try {
    await getOrCreateSession(server, "cmd-esm-submit", getWorkDir(server.cfg!));

    const response = await handleSubmitRun(
      server,
      new Request("http://localhost/api/sessions/cmd-esm-submit/runs", {
        method: "POST",
        body: JSON.stringify({
          message: "/esm start background work",
          model: "default",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.command, true);
    assertEquals(body.sessionId, "cmd-esm-submit");
    assertStringIncludes(body.message as string, "start background work");

    // The command never creates a durable Run.
    const snap = getESM(server, "cmd-esm-submit");
    assertEquals(snap.status, "active");
  } finally {
    closeAll();
  }
});
