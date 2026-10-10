//
// Deviation: the Go tests inject a custom http.RoundTripper via `p.client`.
// This port injects a fake `HttpClient` and builds plain Response-like objects
// (the provider only reads `status`, `body`, and `text()`).

import { assert, assertEquals } from "../../compat/assert.ts";
import { type HttpClient } from "../http_client.ts";
import {
  type ChatParams,
  type ContentBlock,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type Model,
  type ModelPricing,
  streamDone,
  streamError,
  type StreamEvent,
  streamRetry,
  streamTextDelta,
  streamThinkDelta,
  streamThinkSignature,
  streamToolCall,
  streamUsage,
  thinkingHigh,
  type ToolCallBlock,
  type Usage,
} from "../types.ts";
import {
  apiKindGemini,
  apiKindVertex,
  createGeminiProvider,
  createGoogleProviderWithHTTPClient,
  createVertexProvider,
  type Provider,
  vertexAPIKeyBaseURL,
} from "./provider.ts";
import { resolveAPIKey } from "./register.ts";
import { test } from "#testing";

const emptyCost: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function m(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "google-gemini",
    reasoning: false,
    input: ["text"],
    cost: emptyCost,
    contextWindow: 0,
    maxTokens: 0,
    ...extra,
  };
}

interface CapturedRequest {
  url: URL;
  headers: Headers;
  body: string;
}

function fakeResponse(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  text = "",
): Response {
  return {
    status,
    body,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function sseBody(text: string, err?: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stage = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        stage = 1;
        if (text.length > 0) controller.enqueue(encoder.encode(text));
        return;
      }
      if (stage === 1) {
        stage = 2;
        if (err !== undefined) {
          setTimeout(() => controller.error(err), 1);
        } else {
          controller.close();
        }
      }
    },
  });
}

function mockClient(
  sse: string,
  bodies?: CapturedRequest[],
  check?: (req: CapturedRequest) => void,
): HttpClient {
  return {
    fetch(input, init) {
      const headers = init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers);
      const captured: CapturedRequest = {
        url: new URL(input.toString()),
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      };
      if (check !== undefined) check(captured);
      if (bodies !== undefined) bodies.push(captured);
      return Promise.resolve(fakeResponse(200, sseBody(sse)));
    },
    close() {},
  };
}

function createMockGoogleProvider(
  p: Provider,
  sse: string,
  bodies?: CapturedRequest[],
  check?: (req: CapturedRequest) => void,
): Provider {
  p.client = mockClient(sse, bodies, check);
  return p;
}

async function chatAndCollect(
  p: Provider,
  params: ChatParams,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of p.chat(params)) events.push(e);
  return events;
}

async function captureBody(
  p: Provider,
  params: ChatParams,
  bodies: CapturedRequest[],
): Promise<Record<string, unknown>> {
  await chatAndCollect(p, params);
  if (bodies.length === 0) throw new Error("no request body captured");
  return JSON.parse(bodies[0].body) as Record<string, unknown>;
}

function abortParams(): ChatParams {
  return {
    messages: [createUserMessage("hi")],
    systemPrompt: "",
    thinkingLevel: "off",
    maxTokens: 0,
    modelId: "",
    abort: new AbortController().signal,
  };
}

const okSSE =
  'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n';

// ─── retry / transport ───────────────────────────────────────────────────────

test("GoogleRetriesEarlyStreamReadError", async () => {
  const streamErr = new Error(
    "stream error: stream ID 19; INTERNAL_ERROR; received from peer",
  );
  let attempts = 0;
  const p = createGeminiProvider(
    "fake-key",
    "https://generativelanguage.googleapis.com/v1beta/models",
    [m("mock")],
  );
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = {
    fetch() {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(fakeResponse(200, sseBody("", streamErr)));
      }
      return Promise.resolve(fakeResponse(200, sseBody("data: [DONE]\n")));
    },
    close() {},
  };

  const events = await chatAndCollect(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("hi")],
  });
  assertEquals(attempts, 2);
  let retryEvent: StreamEvent | undefined;
  let sawDone = false;
  for (const e of events) {
    if (e.type === streamRetry) retryEvent = e;
    if (e.type === streamDone) sawDone = true;
    if (e.type === streamError) {
      throw new Error(`unexpected STREAM_ERROR: ${e.error}`);
    }
  }
  assert(retryEvent !== undefined && sawDone);
  assertEquals(retryEvent!.retryAttempt, 1);
  assertEquals(retryEvent!.retryMaxAttempts, 1);
  assertEquals(retryEvent!.retryMax, 1);
  assertEquals(retryEvent!.retryAfterMs, 1);
});

test("GoogleDoesNotRetryStreamReadErrorAfterVisibleOutput", async () => {
  const streamErr = new Error(
    "stream error: stream ID 19; INTERNAL_ERROR; received from peer",
  );
  let attempts = 0;
  const p = createGeminiProvider(
    "fake-key",
    "https://generativelanguage.googleapis.com/v1beta/models",
    [m("mock")],
  );
  p.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
  p.client = {
    fetch() {
      attempts++;
      return Promise.resolve(fakeResponse(
        200,
        sseBody(
          'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n',
          streamErr,
        ),
      ));
    },
    close() {},
  };

  const events = await chatAndCollect(p, {
    ...abortParams(),
    modelId: "mock",
    messages: [createUserMessage("hi")],
  });
  assertEquals(attempts, 1);
  let sawText = false;
  let sawError = false;
  for (const e of events) {
    if (e.type === streamTextDelta) sawText = e.textDelta === "hello";
    if (e.type === streamRetry) throw new Error("unexpected StreamRetry");
    if (e.type === streamError) {
      sawError = true;
      assert(
        e.error !== undefined && e.error.message.includes("INTERNAL_ERROR"),
      );
    }
  }
  assert(sawText && sawError);
});

test("GoogleProviderHTTPProxy", () => {
  const p = createGeminiProvider(
    "fake-key",
    "https://generativelanguage.googleapis.com/v1beta/models",
    [m("m1")],
    { proxyUrl: "http://127.0.0.1:7890" },
  );
  try {
    assertEquals(p.client.proxyUrl, "http://127.0.0.1:7890");
  } finally {
    p.client.close();
  }
});

test("ResolveAPIKeyShellCommandRequiresOptIn", () => {
  const prev = Deno.env.get("VIBECODING_ALLOW_SHELL_CONFIG");
  try {
    Deno.env.set("VIBECODING_ALLOW_SHELL_CONFIG", "");
    assertEquals(
      resolveAPIKey({ models: [], apiKey: "!printf secret" }),
      "!printf secret",
    );
    Deno.env.set("VIBECODING_ALLOW_SHELL_CONFIG", "1");
    assertEquals(
      resolveAPIKey({ models: [], apiKey: "!printf secret" }),
      "secret",
    );
  } finally {
    if (prev === undefined) {
      Deno.env.delete("VIBECODING_ALLOW_SHELL_CONFIG");
    } else {
      Deno.env.set("VIBECODING_ALLOW_SHELL_CONFIG", prev);
    }
  }
});

// ─── convertMessages ─────────────────────────────────────────────────────────

function bareProvider(): Provider {
  return createGoogleProviderWithHTTPClient(
    "google-gemini",
    apiKindGemini,
    "",
    "",
    "",
    [],
    { fetch: () => Promise.reject(new Error("unused")), close() {} },
  );
}

test("ConvertMessagesToolResultUsesTextContents", () => {
  const p = bareProvider();
  const contents = p.convertMessages({
    messages: [{
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      contents: [{
        type: "text",
        text: "bash output from content block",
        cache_control: { type: "ephemeral" },
      }],
      timestamp: new Date(),
    }],
  } as ChatParams);
  assertEquals(contents.length, 1);
  assertEquals(contents[0].parts.length, 1);
  const fr = contents[0].parts[0].functionResponse!;
  assert(fr !== undefined);
  assertEquals(fr.response.content, "bash output from content block");
});

test("ConvertMessagesGroupsConsecutiveToolResults", () => {
  const p = bareProvider();
  const contents = p.convertMessages({
    messages: [
      createAssistantMessage([
        {
          type: "toolCall",
          toolCall: {
            id: "call_1",
            name: "read",
            arguments: { path: "main.go" },
          },
        },
        {
          type: "toolCall",
          toolCall: { id: "call_2", name: "bash", arguments: { cmd: "pwd" } },
        },
      ]),
      createToolResultMessage("call_1", "read", "file content", false),
      createToolResultMessage("call_2", "bash", "workdir", false),
      createUserMessage("next"),
    ],
  } as ChatParams);
  assertEquals(contents.length, 3);
  assertEquals(contents[1].role, "user");
  assertEquals(contents[1].parts.length, 2);
  const first = contents[1].parts[0].functionResponse!;
  const second = contents[1].parts[1].functionResponse!;
  assertEquals(first.name, "read");
  assertEquals(first.response.content, "file content");
  assertEquals(second.name, "bash");
  assertEquals(second.response.content, "workdir");
  assertEquals(contents[2].parts[0].text, "next");
});

test("ConvertMessagesPreservesGoogleFunctionCallIDs", () => {
  const p = bareProvider();
  const contents = p.convertMessages({
    messages: [
      createAssistantMessage([
        {
          type: "toolCall",
          toolCall: { id: "call-1", name: "lookup", arguments: { key: "a" } },
        },
        {
          type: "toolCall",
          toolCall: { id: "call-2", name: "lookup", arguments: { key: "b" } },
        },
      ]),
      createToolResultMessage("call-1", "lookup", "value", false),
      createToolResultMessage("call-2", "lookup", "value", false),
    ],
  } as ChatParams);
  assertEquals(contents[0].parts[0].functionCall?.id, "call-1");
  assertEquals(contents[0].parts[1].functionCall?.id, "call-2");
  assertEquals(contents[1].parts[0].functionResponse?.id, "call-1");
  assertEquals(contents[1].parts[1].functionResponse?.id, "call-2");

  const fallback = p.convertMessages({
    messages: [
      createAssistantMessage([{
        type: "toolCall",
        toolCall: { id: "google_toolcall_9", name: "lookup", arguments: {} },
      }]),
      createToolResultMessage("google_toolcall_9", "lookup", "value", false),
    ],
  } as ChatParams);
  assert(!fallback[0].parts[0].functionCall?.id);
  assert(!fallback[1].parts[0].functionResponse?.id);
});

test("GoogleAssistantToolCallIncludesThoughtSignature", () => {
  const p = bareProvider();
  const contents = p.convertMessages({
    messages: [
      createAssistantMessage([
        { type: "thinking", thinking: "thinking", signature: "think-sig" },
        {
          type: "toolCall",
          toolCall: {
            id: "call_1",
            name: "bash",
            arguments: { command: "pwd" },
            thoughtSignature: "tool-sig",
          },
        },
      ]),
    ],
  } as ChatParams);
  assertEquals(contents.length, 1);
  assertEquals(contents[0].parts.length, 2);
  const thinkingPart = contents[0].parts[0];
  assertEquals(thinkingPart.text, "thinking");
  assertEquals(thinkingPart.thought, true);
  assertEquals(thinkingPart.thoughtSignature, "think-sig");
  const part = contents[0].parts[1];
  assertEquals(part.functionCall?.name, "bash");
  assertEquals(part.thoughtSignature, "tool-sig");
});

// ─── streaming ───────────────────────────────────────────────────────────────

test("GoogleStreamMultipleFunctionCallsPreservesIDs", async () => {
  const sse = 'data: {"candidates":[{"content":{"parts":[' +
    '{"functionCall":{"id":"call-1","name":"lookup","args":{"key":"a"}}},' +
    '{"functionCall":{"id":"call-2","name":"lookup","args":{"key":"b"}}}]},' +
    '"finishReason":"STOP"}]}\n';
  for (
    const tc of [
      {
        name: "gemini",
        p: createGeminiProvider(
          "fake-key",
          "https://generativelanguage.googleapis.com/v1beta/models",
          [m("mock")],
        ),
      },
      {
        name: "vertex",
        p: createVertexProvider(
          "fake-key",
          "https://aiplatform.googleapis.com/v1/publishers/google/models",
          [m("mock")],
        ),
      },
    ]
  ) {
    const p = createMockGoogleProvider(tc.p, sse);
    const calls: ToolCallBlock[] = [];
    for (
      const event of await chatAndCollect(p, {
        ...abortParams(),
        modelId: "mock",
        messages: [createUserMessage("hi")],
      })
    ) {
      if (event.type === streamToolCall && event.toolCall !== undefined) {
        calls.push(event.toolCall);
      }
    }
    assertEquals(calls.length, 2, tc.name);
    assertEquals(calls[0].id, "call-1", tc.name);
    assertEquals(calls[1].id, "call-2", tc.name);
    assertEquals(calls[0].arguments, { key: "a" }, tc.name);
    assertEquals(calls[1].arguments, { key: "b" }, tc.name);
  }
});

test("GoogleStreamTextThinkToolCallAndUsage", async () => {
  const sse =
    'data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true,"thoughtSignature":"sig-1"},{"text":"Hello "}]}}]}\n' +
    'data: {"candidates":[{"content":{"parts":[{"thoughtSignature":"tool-sig","functionCall":{"name":"read","args":{"path":"main.go"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":2,"cachedContentTokenCount":7,"totalTokenCount":17}}\n';
  const p = createMockGoogleProvider(
    createGeminiProvider(
      "fake-key",
      "https://generativelanguage.googleapis.com/v1beta/models",
      [m("gemini-test")],
    ),
    sse,
  );
  let text = "";
  let think = "";
  let thinkSignature = "";
  let tool: ToolCallBlock | undefined;
  let usage: Usage | undefined;
  let done = false;
  for (
    const ev of await chatAndCollect(p, {
      ...abortParams(),
      modelId: "gemini-test",
      messages: [createUserMessage("hi")],
    })
  ) {
    switch (ev.type) {
      case streamTextDelta:
        text += ev.textDelta ?? "";
        break;
      case streamThinkDelta:
        think += ev.thinkDelta ?? "";
        break;
      case streamThinkSignature:
        thinkSignature = ev.thinkSignature ?? "";
        break;
      case streamToolCall:
        tool = ev.toolCall;
        break;
      case streamUsage:
        usage = ev.usage;
        break;
      case streamDone:
        done = true;
        assertEquals(ev.stopReason, "stop");
        break;
    }
  }
  assertEquals(text, "Hello ");
  assertEquals(think, "thinking");
  assertEquals(thinkSignature, "sig-1");
  assert(tool !== undefined && tool!.name === "read");
  assertEquals(tool!.arguments, { path: "main.go" });
  assertEquals(tool!.thoughtSignature, "tool-sig");
  assert(usage !== undefined);
  assertEquals(usage!.input, 10);
  assertEquals(usage!.output, 5);
  assertEquals(usage!.reasoning, 2);
  assertEquals(usage!.cacheRead, 7);
  assertEquals(usage!.totalTokens, 17);
  assert(done);
});

// ─── requests ────────────────────────────────────────────────────────────────

test("GoogleCustomHeaders", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockGoogleProvider(
    createGeminiProvider(
      "fake-key",
      "https://generativelanguage.googleapis.com/v1beta/models",
      [m("gemini-test")],
    ),
    okSSE,
    bodies,
    (req) => {
      assertEquals(req.headers.get("X-Custom-Header"), "custom-value");
      assertEquals(req.headers.get("x-goog-api-key"), "override-key");
    },
  );
  p.setHeaders({
    "X-Custom-Header": "custom-value",
    "x-goog-api-key": "override-key",
  });
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "gemini-test",
    messages: [createUserMessage("hi")],
  });
});

test("GoogleGeminiRequest", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockGoogleProvider(
    createGeminiProvider(
      "fake-key",
      "https://generativelanguage.googleapis.com/v1beta/models",
      [m("gemini-test", {
        reasoning: true,
        compat: { disableSamplingParams: false },
      })],
    ),
    okSSE,
    bodies,
    (req) => {
      assertEquals(
        req.url.pathname,
        "/v1beta/models/gemini-test:streamGenerateContent",
      );
      assertEquals(req.url.searchParams.get("alt"), "sse");
      assertEquals(req.headers.get("x-goog-api-key"), "fake-key");
    },
  );
  const req = await captureBody(p, {
    ...abortParams(),
    modelId: "gemini-test",
    systemPrompt: "system",
    messages: [createUserMessage("hi")],
    tools: [{
      name: "read",
      description: "Read file",
      parameters: { type: "object" },
    }],
    thinkingLevel: thinkingHigh,
    maxTokens: 123,
    temperature: 0.2,
  }, bodies);

  const si = req.systemInstruction as Record<string, unknown>;
  const siParts = si.parts as Array<Record<string, unknown>>;
  assertEquals(siParts[0].text, "system");
  const contents = req.contents as Array<Record<string, unknown>>;
  assertEquals(contents.length, 1);
  assertEquals(contents[0].role, "user");
  assertEquals(
    (contents[0].parts as Array<Record<string, unknown>>)[0].text,
    "hi",
  );
  const gc = req.generationConfig as Record<string, unknown>;
  assertEquals(gc.maxOutputTokens, 123);
  assertEquals(gc.temperature, 0.2);
  assertEquals(
    (gc.thinkingConfig as Record<string, unknown>).thinkingBudget,
    8192,
  );
  assertEquals(
    (gc.thinkingConfig as Record<string, unknown>).includeThoughts,
    true,
  );
  const tools = req.tools as Array<Record<string, unknown>>;
  assertEquals(tools.length, 1);
  assertEquals(
    (tools[0].functionDeclarations as Array<Record<string, unknown>>)[0].name,
    "read",
  );
});

test("GoogleGeminiOmitsMaxOutputTokensByDefault", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockGoogleProvider(
    createGeminiProvider(
      "fake-key",
      "https://generativelanguage.googleapis.com/v1beta/models",
      [m("gemini-test", { maxTokens: 65536 })],
    ),
    okSSE,
    bodies,
  );
  const req = await captureBody(p, {
    ...abortParams(),
    modelId: "gemini-test",
    messages: [createUserMessage("hi")],
  }, bodies);
  const gc = req.generationConfig as Record<string, unknown>;
  assert(gc !== undefined && typeof gc === "object");
  assert(!("maxOutputTokens" in gc));
});

test("GoogleImageMediaResolution", async () => {
  const tests = [
    { detail: "detail", want: "MEDIA_RESOLUTION_HIGH" },
    { detail: "raw", want: "MEDIA_RESOLUTION_HIGH" },
    { detail: "fast", want: "MEDIA_RESOLUTION_LOW" },
    { detail: "auto", want: "" },
  ];
  for (const tt of tests) {
    const bodies: CapturedRequest[] = [];
    const p = createMockGoogleProvider(
      createGeminiProvider(
        "fake-key",
        "https://generativelanguage.googleapis.com/v1beta/models",
        [m("gemini-test")],
      ),
      okSSE,
      bodies,
    );
    const contents: ContentBlock[] = [{
      type: "image",
      image: { data: "aW1hZ2U=", mimeType: "image/png", detail: tt.detail },
    }];
    const req = await captureBody(p, {
      ...abortParams(),
      modelId: "gemini-test",
      messages: [{
        role: "user",
        contents,
        timestamp: new Date(),
      }],
    }, bodies);
    const gc = req.generationConfig as Record<string, unknown>;
    assert(gc !== undefined);
    const got = (gc.mediaResolution as string | undefined) ?? "";
    assertEquals(got, tt.want, tt.detail);
  }
});

test("GoogleRequestCachedContent", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createGeminiProvider(
    "fake-key",
    "https://generativelanguage.googleapis.com/v1beta/models",
    [m("gemini-test")],
  );
  p.setCachedContent("cachedContents/test-cache");
  createMockGoogleProvider(p, "data: {}\n", bodies);
  const req = await captureBody(p, {
    ...abortParams(),
    modelId: "gemini-test",
    messages: [createUserMessage("hi")],
  }, bodies);
  assertEquals(req.cachedContent, "cachedContents/test-cache");
});

test("GoogleVertexAPIKeyHeaderAndEndpoint", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockGoogleProvider(
    createVertexProvider(
      "fake-key",
      "https://aiplatform.googleapis.com/v1/projects/test/locations/global/publishers/google/models",
      [m("gemini-test")],
    ),
    "data: {}\n",
    bodies,
    (req) => {
      assertEquals(
        req.url.pathname,
        "/v1/publishers/google/models/gemini-test:streamGenerateContent",
      );
      assertEquals(req.headers.get("x-goog-api-key"), "fake-key");
      assertEquals(req.headers.get("Authorization"), null);
    },
  );
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "gemini-test",
    messages: [createUserMessage("hi")],
  });
});

test("GoogleVertexOAuthAuthorizationHeader", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockGoogleProvider(
    createVertexProvider(
      "ya29.fake-token",
      "https://aiplatform.googleapis.com/v1/projects/test/locations/global/publishers/google/models",
      [m("gemini-test")],
    ),
    "data: {}\n",
    bodies,
    (req) => {
      assertEquals(
        req.url.pathname,
        "/v1/projects/test/locations/global/publishers/google/models/gemini-test:streamGenerateContent",
      );
      assertEquals(
        req.headers.get("Authorization"),
        "Bearer ya29.fake-token",
      );
    },
  );
  await chatAndCollect(p, {
    ...abortParams(),
    modelId: "gemini-test",
    messages: [createUserMessage("hi")],
  });
  assert(bodies.length === 1);
});

test("GoogleDisableSamplingParamsCompat", async () => {
  const bodies: CapturedRequest[] = [];
  const p = createMockGoogleProvider(
    createGeminiProvider(
      "fake-key",
      "https://generativelanguage.googleapis.com/v1beta/models",
      [m("gemini-test", { compat: { disableSamplingParams: true } })],
    ),
    okSSE,
    bodies,
  );
  const req = await captureBody(p, {
    ...abortParams(),
    modelId: "gemini-test",
    messages: [createUserMessage("hi")],
    temperature: 0.2,
    topP: 0.9,
  }, bodies);
  const gc = req.generationConfig as Record<string, unknown>;
  assert(gc !== undefined);
  assertEquals(gc.temperature, undefined);
  assertEquals(gc.topP, undefined);
});

// ─── helpers / register ──────────────────────────────────────────────────────

test("VertexAPIKeyBaseURL", () => {
  assertEquals(
    vertexAPIKeyBaseURL("https://aiplatform.googleapis.com/v1/projects/x"),
    "https://aiplatform.googleapis.com/v1/publishers/google/models",
  );
  assertEquals(
    vertexAPIKeyBaseURL("https://x/publishers/google"),
    "https://x/publishers/google/models",
  );
  assertEquals(
    vertexAPIKeyBaseURL("https://x/publishers/google/models"),
    "https://x/publishers/google/models",
  );
});

// Keep the vertex kind symbol referenced for parity with the Go provider.
void apiKindVertex;
