// (non-session
// cases) and the Responses API cases in provider_test.go.

import { runtime } from "../../platform/runtime.ts";
import { assert, assertEquals } from "../../compat/assert.ts";
import { createProvider } from "../registry.ts";
import {
  type ChatParams,
  createToolResultMessage,
  createUserMessage,
  type Model,
  streamError,
  type StreamEvent,
  streamHostedItem,
  streamTextDelta,
  streamThinkDelta,
  streamToolCall,
  streamUsage,
  thinkingHigh,
  thinkingLow,
  thinkingOff,
  thinkingXHigh,
} from "../types.ts";
import { createOpenAIProvider, type Provider } from "./provider.ts";
// Side-effect import: registers the OpenAI provider factories.
import "./register.ts";
import {
  buildResponsesRequest,
  convertResponsesInput,
  type ResponsesInputItem,
  type ResponsesRequest,
  responsesRequestDiagnostics,
} from "./responses.ts";
import { validateResponsesCapabilities } from "./responses_config.ts";
import {
  chatAndCollect,
  createMockOpenAIProvider,
  decodeBody,
} from "./test_helpers.ts";
import { test } from "#testing";

function model(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...extra,
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

function readResponsesFixture(name: string): string {
  return runtime.readTextFileSync(
    new URL(`./testdata/responses/${name}`, import.meta.url),
  );
}

test("ResponsesChatFallsBackToSynchronousWhenBackgroundCoordinatorIsUnavailable", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test")],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ background: true });
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("stay available")],
    }),
  );
  assertEquals(requests.length, 1);
  const body = decodeBody(requests[0]);
  assertEquals(body["background"], undefined);
  assertEquals(body["stream"], true);
});

test("ResponsesRequestDiagnosticsDescribeLocalFieldOmissions", () => {
  const opts = { suppressConversation: true };
  const diagnostics = responsesRequestDiagnostics(
    params({ temperature: 0.4, topP: 0.4, responseOptions: opts }),
    { model: "", input: [], stream: true, reasoning: {} } as ResponsesRequest,
  );
  assertEquals(diagnostics.length, 2);
  assertEquals(diagnostics[0]["field"], "temperature/top_p");
  assertEquals(diagnostics[0]["reason"], "reasoning_incompatible");
  assertEquals(diagnostics[1]["field"], "conversation");
  assertEquals(diagnostics[1]["reason"], "remote_state_replay_fallback");
});

test("ResponsesStreamEmitsHostedItemLifecycleEvents", async () => {
  const { provider: p } = createMockOpenAIProvider(
    [model("responses-hosted")],
    readResponsesFixture("hosted_lifecycle.sse"),
  );
  p.setUseResponsesAPI(true);
  const events = await chatAndCollect(
    p,
    params({
      modelId: "responses-hosted",
      messages: [createUserMessage("search")],
    }),
  );
  const lifecycle = events
    .filter((e) => e.type === streamHostedItem && e.hostedItem !== undefined)
    .map((e) => e.hostedItem!);
  assertEquals(lifecycle.length, 2);
  assertEquals(lifecycle[0].status, "in_progress");
  assertEquals(lifecycle[1].status, "completed");
  assertEquals(lifecycle[1].outputIndex, 2);
});

test("OpenAIResponsesAPIRequest", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test", { reasoning: true })],
    "data: [DONE]\n",
    (req) => {
      assert(req.url.endsWith("/v1/responses"));
    },
  );
  p.setUseResponsesAPI(true);
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      systemPrompt: "You are a helper.",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingXHigh,
    }),
  );
  const raw = decodeBody(requests[0]);
  assertEquals(raw["model"], "responses-test");
  assertEquals(raw["instructions"], "You are a helper.");
  assertEquals(raw["stream"], true);
  assert(!("max_output_tokens" in raw));
  assert(Array.isArray(raw["input"]));
  const reasoning = raw["reasoning"] as Record<string, unknown>;
  assertEquals(reasoning["effort"], "high");
  assertEquals(reasoning["summary"], "auto");
  assert((raw["prompt_cache_key"] as string) !== "");
});

test("OpenAIResponsesAPIConfigOverrides", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test", { reasoning: true })],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({
    reasoningSummary: "concise",
    promptCacheKey: "custom-cache-key",
    promptCacheRetention: "24h",
  });
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("hi")],
      maxTokens: 1234,
      thinkingLevel: "minimal",
    }),
  );
  const raw = decodeBody(requests[0]);
  const reasoning = raw["reasoning"] as Record<string, unknown>;
  assertEquals(reasoning["effort"], "minimal");
  assertEquals(reasoning["summary"], "concise");
  assertEquals(raw["prompt_cache_key"], "custom-cache-key");
  assertEquals(raw["prompt_cache_retention"], "24h");
  assertEquals(raw["max_output_tokens"], 1234);
});

test("OpenAIResponsesAPIConfigAndResponseOptions", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test")],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({
    stateMode: "conversation",
    store: true,
    conversation: "conv_123",
    truncation: "auto",
    include: ["reasoning.encrypted_content"],
    serviceTier: "flex",
  });
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("hi")],
      responseOptions: {
        parallelTools: false,
        maxToolCalls: 2,
        toolChoice: { type: "function", name: "bash" },
        structuredOutput: {
          format: "json_schema",
          name: "result",
          strict: true,
          schema: { type: "object" },
        },
      },
    }),
  );
  const raw = decodeBody(requests[0]);
  assertEquals(raw["store"], true);
  assertEquals(raw["conversation"], "conv_123");
  assertEquals(raw["truncation"], "auto");
  assertEquals(raw["service_tier"], "flex");
  assertEquals(raw["parallel_tool_calls"], false);
  assertEquals(raw["max_tool_calls"], 2);
  assertEquals(raw["include"], ["reasoning.encrypted_content"]);
  const choice = raw["tool_choice"] as Record<string, unknown>;
  assertEquals(choice["type"], "function");
  assertEquals(choice["name"], "bash");
  const text = raw["text"] as Record<string, unknown>;
  const format = text["format"] as Record<string, unknown>;
  assertEquals(format["type"], "json_schema");
  assertEquals(format["name"], "result");
  assertEquals(format["strict"], true);
});

test("OpenAIResponsesAPIConfigFieldsAreEncoded", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test")],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({
    structuredOutput: {
      name: "result",
      strict: false,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
      },
    },
    toolControl: { choice: "required", parallel: false, maxCalls: 3 },
    hostedTools: { fileSearch: { max_num_results: 5 } },
  });
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("find a file")],
    }),
  );
  const raw = decodeBody(requests[0]);
  assertEquals(raw["tool_choice"], "required");
  assertEquals(raw["parallel_tool_calls"], false);
  assertEquals(raw["max_tool_calls"], 3);
  const tools = raw["tools"] as Array<Record<string, unknown>>;
  assertEquals(tools.length, 1);
  assertEquals(tools[0]["type"], "file_search");
  assertEquals(tools[0]["max_num_results"], 5);
  const text = raw["text"] as Record<string, unknown>;
  const format = text["format"] as Record<string, unknown>;
  assertEquals(format["type"], "json_schema");
  assertEquals(format["name"], "result");
  assertEquals(format["strict"], false);
});

test("OpenAIResponsesAPIPreviousResponseIDIsEncoded", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test")],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ stateMode: "previous_response_id" });
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("continue")],
      responseOptions: { previousResponseId: "resp_previous" },
    }),
  );
  const raw = decodeBody(requests[0]);
  assertEquals(raw["previous_response_id"], "resp_previous");
  assert(!("conversation" in raw));
});

test("OpenAIResponsesAPIConversationCanBeSuppressedForReplay", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({
    stateMode: "conversation",
    conversation: "conv_1",
    store: true,
  });
  const req = buildResponsesRequest(
    p,
    params({
      messages: [createUserMessage("replay")],
      responseOptions: { suppressConversation: true },
    }),
    "responses-test",
    p.getModel("responses-test"),
    false,
    false,
  );
  assertEquals(req.conversation ?? "", "");
});

test("OpenAIResponsesAPINativeReplayItemsArePreserved", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test")],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("must not be rebuilt")],
      responseOptions: {
        replayItems: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first" }],
          },
          { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "read",
            arguments: `{"path":"a"}`,
          },
        ],
      },
    }),
  );
  const body = requests[0].body;
  assert(body.includes(`"encrypted_content":"ciphertext"`));
  assert(body.includes(`"call_id":"call_1"`));
});

test("OpenAIResponsesAPICustomToolRequestAndContinuation", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  const req = buildResponsesRequest(
    p,
    params({
      tools: [
        {
          name: "shell_script",
          description: "Execute a constrained script.",
          kind: "custom",
          format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
        },
      ],
      messages: [
        {
          role: "assistant",
          contents: [
            {
              type: "toolCall",
              toolCall: {
                id: "call_custom",
                name: "shell_script",
                kind: "custom",
                input: "echo hello",
              },
            },
          ],
          timestamp: new Date(),
        },
        (() => {
          const result = createToolResultMessage(
            "call_custom",
            "shell_script",
            "hello",
            false,
            null,
          );
          result.toolKind = "custom";
          return result;
        })(),
      ],
    }),
    "responses-test",
    p.getModel("responses-test"),
    false,
    false,
  );
  assertEquals(req.tools?.length, 1);
  assertEquals(req.tools![0].type, "custom");
  assertEquals(req.tools![0].name, "shell_script");
  assertEquals(
    JSON.stringify(req.tools![0].format),
    `{"type":"grammar","syntax":"regex","definition":"[a-z]+"}`,
  );
  const input = req.input as ResponsesInputItem[];
  assertEquals(input.length, 3);
  assertEquals(input[1].type, "custom_tool_call");
  assertEquals(input[1].input, "echo hello");
  assertEquals(input[2].type, "custom_tool_call_output");
  assertEquals(input[2].output, "hello");
});

test("OpenAIResponsesAPICustomToolContentListOutput", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  const result = createToolResultMessage("call-custom", "render", "", false, [
    { type: "text", text: "preview" },
    {
      type: "image",
      image: { mimeType: "image/png", data: "aW1n", detail: "low" },
    },
    {
      type: "file",
      file: { id: "file_123", filename: "report.csv" },
    },
  ]);
  result.toolKind = "custom";
  const items = convertResponsesInput(p, params({ messages: [result] }));
  assertEquals(items.length, 1);
  assertEquals(items[0].type, "custom_tool_call_output");
  const content = items[0].output as Array<Record<string, unknown>>;
  assertEquals(content.length, 3);
  assertEquals(content[0].type, "input_text");
  assertEquals(content[0].text, "preview");
  assertEquals(content[1].type, "input_image");
  assertEquals(content[1].image_url, "data:image/png;base64,aW1n");
  assertEquals(content[1].detail, "low");
  assertEquals(content[2].type, "input_file");
  assertEquals(content[2].file_id, "file_123");
  assertEquals(content[2].filename, "report.csv");
});

test("OpenAIResponsesAPIRejectsInvalidCustomToolFormat", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  let error: Error | undefined;
  try {
    validateResponsesCapabilities(
      p,
      p.getModel("responses-test"),
      params({
        tools: [
          {
            name: "shell_script",
            description: "",
            kind: "custom",
            format: { type: "grammar", syntax: "invalid", definition: "x" },
          },
        ],
      }),
    );
  } catch (err) {
    error = err as Error;
  }
  assert(error !== undefined);
  assert(error!.message.includes("grammar syntax"));
});

test("OpenAIResponsesAPIRejectsInvalidNativeReplayItem", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  let error: Error | undefined;
  try {
    buildResponsesRequest(
      p,
      params({
        responseOptions: { replayItems: [undefined] },
      }),
      "responses-test",
      p.getModel("responses-test"),
      true,
      false,
    );
  } catch (err) {
    error = err as Error;
  }
  assert(error !== undefined);
  assert(error!.message.includes("replay item"));
});

test("OpenAIResponsesAPIRejectsInvalidConfig", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  let error: Error | undefined;
  try {
    p.setResponsesConfig({ stateMode: "conversation", conversation: "" });
  } catch (err) {
    error = err as Error;
  }
  assert(error !== undefined);
  assert(error!.message.includes("conversation"));
});

test("OpenAIResponsesAPIValidatesStrictStructuredOutputSchema", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  let invalidError: Error | undefined;
  try {
    p.setResponsesConfig({
      structuredOutput: {
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: [],
        },
      },
    });
  } catch (err) {
    invalidError = err as Error;
  }
  assert(invalidError !== undefined);
  assert(invalidError!.message.includes("additionalProperties=false"));

  p.setResponsesConfig({
    structuredOutput: {
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
        required: ["answer", "items"],
      },
    },
  });
});

test("OpenAIResponsesStateFallbackError", () => {
  const p = createOpenAIProvider("fake-key", "https://api.test/v1", [
    model("responses-test"),
  ]);
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ stateMode: "previous_response_id" });
  const cases: Array<[string, boolean]> = [
    ["API error 404: response not found", true],
    ["previous_response_id expired", true],
    ["API error 403: forbidden", true],
    ["API error 429: rate limit", false],
    ["API error 500: unavailable", false],
  ];
  for (const [message, want] of cases) {
    assertEquals(p.responseStateFallbackError(new Error(message)), want);
  }
});

test("OpenAIResponsesAPIStreamToolCall", async () => {
  const lines = [
    `{"type":"response.output_text.delta","delta":"Working"}`,
    `{"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"command\\":"}`,
    `{"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"\\"echo hi\\"}"}`,
    `{"type":"response.output_item.done","item":{"id":"call_1","type":"function_call","call_id":"call_1","name":"bash"}}`,
    `{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":5,"total_tokens":105,"input_tokens_details":{"cached_tokens":75},"output_tokens_details":{"reasoning_tokens":3}}}}`,
  ];
  let sse = "";
  for (const line of lines) sse += `data: ${line}\n`;
  sse += "data: [DONE]\n";

  const { provider: p } = createMockOpenAIProvider(
    [model("mock", { reasoning: true })],
    sse,
  );
  p.setUseResponsesAPI(true);
  const events = await chatAndCollect(
    p,
    params({
      messages: [createUserMessage("hi")],
    }),
  );
  let gotText = "";
  let gotTool: StreamEvent["toolCall"];
  let gotUsage: StreamEvent["usage"];
  let gotDone = false;
  for (const e of events) {
    if (e.type === streamTextDelta) gotText += e.textDelta;
    else if (e.type === streamToolCall) gotTool = e.toolCall;
    else if (e.type === streamUsage) gotUsage = e.usage;
    else if (e.type === 6) gotDone = true;
  }
  assertEquals(gotText, "Working");
  assert(gotTool !== undefined);
  assertEquals(gotTool!.id, "call_1");
  assertEquals(gotTool!.name, "bash");
  assertEquals(JSON.stringify(gotTool!.arguments), `{"command":"echo hi"}`);
  assertEquals(gotUsage?.cacheRead, 75);
  assertEquals(gotUsage?.reasoning, 3);
  assert(gotDone);
});

test("OpenAIResponsesAPISupportsDoneOnlyTextEvent", async () => {
  const sse =
    'data: {"type":"response.output_text.done","text":"done-only"}\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n' +
    "data: [DONE]\n";
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  p.setUseResponsesAPI(true);
  let text = "";
  for (const event of await chatAndCollect(
    p,
    params({ messages: [createUserMessage("hello")] }),
  )) {
    if (event.type === streamTextDelta) text += event.textDelta;
  }
  assertEquals(text, "done-only");
});

test("OpenAIResponsesAPISupportsDoneOnlyRefusalEvent", async () => {
  const sse =
    'data: {"type":"response.refusal.done","refusal":"cannot comply"}\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n';
  const { provider: p } = createMockOpenAIProvider([model("mock")], sse);
  p.setUseResponsesAPI(true);
  let text = "";
  for (const event of await chatAndCollect(
    p,
    params({ messages: [createUserMessage("hello")] }),
  )) {
    if (event.type === streamTextDelta) text += event.textDelta;
  }
  assertEquals(text, "cannot comply");
});

test("OpenAIResponsesAPISupportsDoneOnlyReasoningEvent", async () => {
  const sse =
    'data: {"type":"response.reasoning_summary_text.done","text":"think-only"}\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n';
  const { provider: p } = createMockOpenAIProvider(
    [model("mock", { reasoning: true })],
    sse,
  );
  p.setUseResponsesAPI(true);
  let reasoning = "";
  for (const event of await chatAndCollect(
    p,
    params({
      messages: [createUserMessage("hello")],
      thinkingLevel: thinkingLow,
    }),
  )) {
    if (event.type === streamThinkDelta) reasoning += event.thinkDelta;
  }
  assertEquals(reasoning, "think-only");
});

test("OpenAIResponsesAPICompatDisablesOptionalParams", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [
      model("responses-test", {
        reasoning: true,
        compat: {
          supportsPromptCacheKey: false,
          supportsReasoningSummary: false,
        },
      }),
    ],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
    }),
  );
  const raw = decodeBody(requests[0]);
  assert(!("prompt_cache_key" in raw));
  const reasoning = raw["reasoning"] as Record<string, unknown>;
  assert(!("summary" in reasoning));
});

test("OpenAIResponsesAPILongCacheRetentionCompat", async () => {
  const { provider: p } = createMockOpenAIProvider(
    [
      model("responses-test", {
        compat: { supportsLongCacheRetention: false },
      }),
    ],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ promptCacheRetention: "24h" });
  const events = await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("hi")],
    }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].type, streamError);
  assert((events[0].error?.message ?? "").includes("prompt_cache_retention"));
});

test("OpenAIResponsesAPIPromptCacheCanBeDisabled", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test", { reasoning: true })],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  p.setResponsesConfig({ promptCacheEnabled: false });
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingHigh,
    }),
  );
  const raw = decodeBody(requests[0]);
  assert(!("prompt_cache_key" in raw));
});

test("OpenAIResponsesAPINoReasoningWhenOff", async () => {
  const { provider: p, requests } = createMockOpenAIProvider(
    [model("responses-test", { reasoning: true })],
    "data: [DONE]\n",
  );
  p.setUseResponsesAPI(true);
  await chatAndCollect(
    p,
    params({
      modelId: "responses-test",
      messages: [createUserMessage("hi")],
      thinkingLevel: thinkingOff,
    }),
  );
  const raw = decodeBody(requests[0]);
  assert(!("reasoning" in raw));
});

test("OpenAIResponsesFactoryEnablesResponsesMode", () => {
  const p = createProvider("openai-responses", {
    api: "openai-responses",
    apiKey: "k",
    models: [],
  }) as Provider;
  assertEquals(p.useResponsesAPI, true);
});
