// (session
// cases). The non-session fallback/diagnostics/hosted-lifecycle cases live in
// responses_test.ts.
//
// Deviation: the Go fixture creates a session through the (not yet ported)
// Manager; foreign-key enforcement is off and a session with no lease row skips
// lease validation, so these tests use a literal session ID.

import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { getResponseTurn } from "../../session/mod.ts";
import { type ResponseRun } from "../../session/mod.ts";
import type { ChatParams, Model } from "../types.ts";
import { newUserMessage } from "../types.ts";
import { newProviderWithModels } from "./provider.ts";
// Side-effect import: registers the OpenAI provider factories.
import "./register.ts";
import { archiveBackgroundResponse } from "./responses_runtime.ts";
import { mockClient, type MockRequest } from "./test_helpers.ts";

function model(id: string): Model {
  return {
    id,
    name: id,
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    messages: [],
    systemPrompt: "",
    thinkingLevel: "",
    maxTokens: 0,
    modelId: "",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-responses-runtime-" });
}

Deno.test("ResponsesRunManagerStartGetAndCancel", async () => {
  let postCount = 0;
  let cancelReceived = false;
  const sessionDir = tempDir();
  try {
    const p = newProviderWithModels("test-key", "https://api.test/v1", [
      model("mock"),
    ]);
    p.client = mockClient((req: MockRequest) => {
      const method = req.init?.method ?? "GET";
      if (method === "POST" && req.url.endsWith("/v1/responses")) {
        postCount++;
        const body = JSON.parse(req.body) as Record<string, unknown>;
        assertEquals(body["background"], true);
        assertEquals(body["stream"], false);
        return jsonResponse({ id: "resp-1", status: "queued" });
      }
      if (method === "GET" && req.url.endsWith("/v1/responses/resp-1")) {
        return jsonResponse({ id: "resp-1", status: "completed" });
      }
      if (
        method === "POST" && req.url.endsWith("/v1/responses/resp-1/cancel")
      ) {
        cancelReceived = true;
        return jsonResponse({ id: "resp-1", status: "cancelling" });
      }
      return new Response("", { status: 404 });
    });
    const manager = p.newResponsesRunManager(sessionDir);
    const sessionId = "session-runtime-1";

    const run = await manager.start(
      sessionId,
      "turn-1",
      params({
        modelId: "mock",
        messages: [newUserMessage("run in background")],
      }),
    );
    assertEquals(run.responseId, "resp-1");
    assertEquals(run.state, "queued");

    const got = await manager.get(sessionId, run.localRunId);
    assert(got !== null);
    assertEquals(got!.state, "completed");

    const second = await manager.start(
      sessionId,
      "turn-2",
      params({ modelId: "mock", messages: [newUserMessage("cancel me")] }),
    );
    await manager.cancel(sessionId, second.localRunId);
    assert(cancelReceived);
    assertEquals(postCount, 2);
  } finally {
    closeAll();
  }
});

Deno.test("ResponsesRunManagerStartUsesConfiguredRetryAndIdempotency", async () => {
  for (
    const tc of [
      {
        name: "enabled",
        retryEnabled: true,
        wantAttempts: 2,
        wantError: false,
      },
      {
        name: "disabled",
        retryEnabled: false,
        wantAttempts: 1,
        wantError: true,
      },
    ]
  ) {
    const sessionDir = tempDir();
    const sessionId = `session-retry-${tc.name}`;
    try {
      let attempts = 0;
      let idempotencyKey = "";
      const p = newProviderWithModels("test-key", "https://api.test/v1", [
        model("mock"),
      ]);
      p.setHeaders({ "Idempotency-Key": "configured-value-must-not-win" });
      p.setRetryConfig({
        enabled: tc.retryEnabled,
        maxRetries: 1,
        baseDelayMs: 1,
      });
      p.client = mockClient((req: MockRequest) => {
        attempts++;
        const gotKey = req.headers.get("Idempotency-Key") ?? "";
        assert(gotKey !== "", "missing Idempotency-Key");
        assert(
          gotKey !== "configured-value-must-not-win",
          "configured header must not win over the stable run id",
        );
        if (idempotencyKey === "") idempotencyKey = gotKey;
        else assertEquals(gotKey, idempotencyKey);
        if (attempts > 1) {
          return jsonResponse({ id: "resp-retried", status: "queued" });
        }
        return jsonResponse({ error: "temporarily unavailable" }, 503);
      });

      const manager = p.newResponsesRunManager(sessionDir);
      let error: Error | null = null;
      let run: ResponseRun | null = null;
      try {
        run = await manager.start(
          sessionId,
          `turn-retry-${tc.name}`,
          params({ modelId: "mock", messages: [newUserMessage("retry")] }),
        );
      } catch (err) {
        error = err as Error;
      }
      if (tc.wantError) {
        assert(error !== null, "expected Start to fail");
      } else {
        assert(error === null, `unexpected error: ${error?.message}`);
        assertEquals(run!.responseId, "resp-retried");
      }
      assertEquals(attempts, tc.wantAttempts);
    } finally {
      closeAll();
    }
  }
});

Deno.test("ArchiveBackgroundResponsePreservesUsageAndAttachments", () => {
  const sessionDir = tempDir();
  try {
    const response = {
      id: "resp-archive",
      status: "completed",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      output: [
        JSON.stringify({
          id: "msg-archive",
          type: "message",
          content: [
            {
              type: "output_text",
              annotations: [
                {
                  type: "url_citation",
                  title: "OpenAI",
                  url: "https://openai.com",
                },
              ],
            },
          ],
        }),
      ],
    };
    const run: ResponseRun = {
      id: 0,
      sessionId: "session-archive",
      localRunId: "run-archive",
      localTurnId: "turn-archive",
      messageId: null,
      responseId: "",
      provider: "openai",
      api: "openai-responses",
      state: "completed",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    archiveBackgroundResponse(sessionDir, run, response);

    const turn = getResponseTurn(sessionDir, run.sessionId, run.localTurnId);
    assert(turn !== null);
    const summary = turn!.responseSummary as {
      usage: { totalTokens: number };
      attachments: Array<{ kind: string; url?: string }>;
    };
    assertEquals(summary.usage.totalTokens, 18);
    assertEquals(summary.attachments.length, 1);
    assertEquals(summary.attachments[0].kind, "citation");
    assertEquals(summary.attachments[0].url, "https://openai.com");
  } finally {
    closeAll();
  }
});
