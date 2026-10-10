import { assertEquals } from "../compat/assert.ts";
import {
  hostedToolImageGeneration,
  hostedToolType,
  hostedToolWebSearchAnthropicMessages,
  hostedWebSearchToolType,
} from "./mod.ts";
import { test } from "#testing";

test("HostedToolTypeImageGeneration", () => {
  assertEquals(
    hostedToolType("openai-responses", hostedToolImageGeneration),
    hostedToolImageGeneration,
  );
  assertEquals(
    hostedToolType("anthropic-messages", hostedToolImageGeneration),
    "",
  );
});

test("HostedWebSearchToolType", () => {
  const tests: Array<[string, string, string, string]> = [
    ["responses web search", "responses", "web_search", "web_search"],
    [
      "openai responses web search",
      "openai-responses",
      "web_search",
      "web_search",
    ],
    [
      "messages web search",
      "messages",
      "web_search",
      hostedToolWebSearchAnthropicMessages,
    ],
    [
      "anthropic messages web search",
      "anthropic-messages",
      "web_search",
      hostedToolWebSearchAnthropicMessages,
    ],
    [
      "native OpenAI Responses web search",
      "openai-responses",
      "openai_responses_web_search",
      "web_search",
    ],
    [
      "native OpenAI web search is not an Anthropic tool",
      "anthropic-messages",
      "openai_responses_web_search",
      "",
    ],
    ["unknown tool", "responses", "other", ""],
    ["unknown provider type", "other", "web_search", ""],
  ];
  for (const [name, providerType, toolName, want] of tests) {
    assertEquals(hostedWebSearchToolType(providerType, toolName), want, name);
  }
});
