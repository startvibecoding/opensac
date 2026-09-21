// Translated from internal/serve/openaiapi/background_external_test.go —
// SubmitExternalResponsesBackground uses the durable coordinator, and the
// chat-completions x_background branch routes through it with idempotency.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import {
  mockClient,
  type MockRequest,
} from "../../provider/openai/test_helpers.ts";
import { newProviderWithModels } from "../../provider/openai/mod.ts";
import type { ResponsesConfig } from "../../config/settings.ts";
import { getDurableRun } from "../../agentruntime/run_queries.ts";
import { getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { messageText } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { handleChatCompletions } from "./handler_chat.ts";
import { RunManager } from "./run_manager.ts";
import { submitExternalResponsesBackgroundFn } from "./background_external.ts";
import { executeResponsesBackgroundRunFn } from "./background_run_coordinator.ts";
import type { BackgroundRequest } from "../runtime/background.ts";
import type { RunInput } from "../../agentruntime/input_materializer.ts";

function emptySubmission(text: string): RunInput {
  return {
    text,
    resources: [],
    knowledgeBaseReferences: [],
    knowledgeCapsules: [],
    idempotencyKey: "",
  };
}

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function jsonBody(req: MockRequest): Record<string, unknown> {
  try {
    return JSON.parse(req.body || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function installUpstream(
  server: Server,
  handler: (
    method: string,
    path: string,
    body: Record<string, unknown>,
  ) => Response | Promise<Response>,
): void {
  const openai = server.provider as unknown as {
    client: { fetch: unknown };
  };
  openai.client = mockClient((req) => {
    const url = new URL(req.url);
    const method = req.init?.method ?? "GET";
    return handler(method.toUpperCase(), url.pathname, jsonBody(req));
  });
}

function responsesModel(): Model {
  return {
    id: "m1",
    name: "Model 1",
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
    // Go's chat-completions test pins DisableSamplingParams to false so the
    // submitted Responses request carries the sampling controls.
    compat: { disableSamplingParams: false },
  };
}

function newExternalServer(): {
  server: Server;
  sessionDir: string;
  workDir: string;
} {
  const sessionDir = tempDir("openaiapi-ext-sess-");
  const workDir = tempDir("openaiapi-ext-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: {
      defaultMode: "yolo",
      defaultWorkDir: workDir,
      requestTimeoutSecs: 30,
    } as never,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  const model = responsesModel();
  const p = newProviderWithModels("test-key", "https://api.test/v1", [model]);
  server.provider = p as unknown as Provider;
  server.model = model;
  return { server, sessionDir, workDir };
}

function enableResponsesBackground(server: Server): void {
  const p = server.provider as unknown as {
    setUseResponsesAPI(enabled: boolean): void;
    setResponsesConfig(cfg: ResponsesConfig): void;
  };
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ background: true });
  server.responsesRuns = (
    server.provider as unknown as {
      newResponsesRunManager(sessionDir: string): unknown;
    }
  ).newResponsesRunManager(server.sessionDir()) as never;
  server.runManager = new RunManager(server.sessionDir());
  server.executeResponsesBackgroundRun = executeResponsesBackgroundRunFn(
    server,
  );
  server.submitExternalResponsesBackground =
    submitExternalResponsesBackgroundFn(server);
}

async function waitFor(
  predicate: () => boolean,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test("submitExternalResponsesBackgroundUsesDurableCoordinator", async () => {
  const { server, sessionDir } = newExternalServer();
  try {
    installUpstream(server, (method, path) => {
      if (method === "POST" && path === "/v1/responses") {
        return Response.json({ id: "external-response", status: "queued" });
      }
      if (method === "GET" && path === "/v1/responses/external-response") {
        return Response.json({
          id: "external-response",
          status: "completed",
          output: [
            {
              id: "external-message",
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "external completion",
                  annotations: [
                    {
                      type: "url_citation",
                      title: "OpenAI",
                      url: "https://openai.com",
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);

    const sess = await getOrCreateSession(
      server,
      "external-channel",
      getWorkDir(server.cfg!),
    );
    const progressTexts: string[] = [];
    const request: BackgroundRequest = {
      signal: undefined,
      sessionId: sess.id,
      workDir: sess.workDir,
      platform: "wechat",
      modelId: "",
      mode: "",
      runId: "",
      input: emptySubmission("run externally"),
      initialHistory: [],
      systemPrompt: "",
      idempotencyKey: "",
      progress: (text) => progressTexts.push(text),
    };
    const runID = await server.submitExternalResponsesBackground!(request);
    assert(runID !== "");

    await waitFor(
      () => getDurableRun(sessionDir, runID)?.status === "completed",
    );
    await waitFor(() => progressTexts.length > 0);
    assertEquals(
      progressTexts[progressTexts.length - 1],
      "external completion\n\nAttachments:\n- OpenAI: https://openai.com",
    );
    const messages = sess.manager!.getMessages();
    assertEquals(messages.length, 2);
    assertEquals(messages[1].role, "assistant");
    assertEquals(messageText(messages[1]), "external completion");
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});

Deno.test("chatCompletionsXBackgroundUsesDurableCoordinator", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const { server, sessionDir } = newExternalServer();
  try {
    installUpstream(server, (method, path) => {
      if (method === "POST" && path === "/v1/responses") {
        return Response.json({
          id: "chat-background-response",
          status: "queued",
        });
      }
      if (
        method === "GET" &&
        path === "/v1/responses/chat-background-response"
      ) {
        return Response.json({
          id: "chat-background-response",
          status: "completed",
          output: [
            {
              id: "chat-background-message",
              type: "message",
              content: [
                { type: "output_text", text: "chat background complete" },
              ],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    enableResponsesBackground(server);
    installUpstream(server, (method, path, body) => {
      if (method === "POST" && path === "/v1/responses") {
        requestBodies.push(body);
        return Response.json({
          id: "chat-background-response",
          status: "queued",
        });
      }
      if (
        method === "GET" &&
        path === "/v1/responses/chat-background-response"
      ) {
        return Response.json({
          id: "chat-background-response",
          status: "completed",
          output: [
            {
              id: "chat-background-message",
              type: "message",
              content: [
                { type: "output_text", text: "chat background complete" },
              ],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });

    const chatRequest = (body: string, key: string): Request =>
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
      });

    const first = await handleChatCompletions(
      server,
      chatRequest(
        `{"model":"m1","messages":[{"role":"system","content":"answer tersely"},{"role":"user","content":"hello"}],"temperature":0.2,"top_p":0.8,"max_tokens":123,"x_background":true}`,
        "chat-background-key",
      ),
    );
    assertEquals(first.status, 202);
    const accepted = await first.json();
    assert(accepted.runId !== "");

    // The Responses request must carry the chat controls and instructions.
    assert(requestBodies.length > 0, "background request was not submitted");
    const body = requestBodies[0];
    assertEquals(body["background"], true);
    assertEquals(body["stream"], false);
    assertEquals(body["max_output_tokens"], 123);
    assertEquals(body["temperature"], 0.2);
    assertEquals(body["top_p"], 0.8);
    assertStringIncludes(String(body["instructions"]), "answer tersely");

    const second = await handleChatCompletions(
      server,
      chatRequest(
        `{"model":"m1","messages":[{"role":"user","content":"hello"}],"x_background":true}`,
        "chat-background-key",
      ),
    );
    assertEquals(second.status, 202);
    const secondBody = await second.json();
    assertEquals(secondBody.runId, accepted.runId);

    await waitFor(
      () => getDurableRun(sessionDir, accepted.runId)?.status === "completed",
    );
  } finally {
    await server.pool?.stop();
    closeAll();
  }
});
