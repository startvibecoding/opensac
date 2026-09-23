import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type ChatParams as PublicChatParams,
  type StreamEvent as PublicStreamEvent,
  streamHostedItem as publicStreamHostedItem,
  streamToolCall as publicStreamToolCall,
  streamUsage as publicStreamUsage,
} from "../../sdk/agent/mod.ts";
import {
  type ChatParams as InternalChatParams,
  type Model as InternalModel,
  type Provider as InternalProvider,
  type StreamEvent as InternalStreamEvent,
  streamHostedItem as internalStreamHostedItem,
  streamToolCall as internalStreamToolCall,
  streamUsage as internalStreamUsage,
} from "../provider/mod.ts";
import { ProviderAdapter, streamEventTypeToPublic } from "./provider_bridge.ts";

class ModelCaptureInternalProvider implements InternalProvider {
  modelId = "";

  chat(_params: InternalChatParams): AsyncIterable<InternalStreamEvent> {
    this.modelId = _params.modelId;
    return (async function* () {})();
  }

  name(): string {
    return "capture";
  }

  api(): string {
    return "openai-chat";
  }

  models(): InternalModel[] {
    return [{
      id: "fallback",
      name: "fallback",
      provider: "capture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
    }];
  }

  getModel(id: string): InternalModel | undefined {
    return this.models().find((m) => m.id === id);
  }
}

function publicParams(modelId: string): PublicChatParams {
  return {
    messages: [],
    systemPrompt: "",
    thinkingLevel: "medium",
    maxTokens: 0,
    modelId,
  };
}

Deno.test("ProviderBridgePreservesModelID", async () => {
  const internal = new ModelCaptureInternalProvider();
  const adapter = new ProviderAdapter(internal);
  for await (const _ev of adapter.chat(publicParams("Kimi-K2.5"))) {
    // drain
  }
  assertEquals(internal.modelId, "Kimi-K2.5");
});

class RetryMetadataInternalProvider extends ModelCaptureInternalProvider {
  override chat(
    _params: InternalChatParams,
  ): AsyncIterable<InternalStreamEvent> {
    this.modelId = _params.modelId;
    return (async function* () {
      yield {
        type: 9, // streamRetry
        retryAttempt: 2,
        retryMaxAttempts: 4,
        retryAfterMs: 1250,
      } satisfies InternalStreamEvent;
    })();
  }
}

Deno.test("ProviderBridgePreservesRetryMetadata", async () => {
  const internal = new RetryMetadataInternalProvider();
  const adapter = new ProviderAdapter(internal);
  let retry: PublicStreamEvent | undefined;
  for await (const event of adapter.chat(publicParams("Kimi-K2.5"))) {
    if (event.type === 8 /* public streamRetry */) {
      retry = event;
    }
  }
  assertNotEquals(retry, undefined);
  assertEquals(retry!.retryAttempt, 2);
  assertEquals(retry!.retryMaxAttempts, 4);
  assertEquals(retry!.retryAfterMs, 1250);
});

Deno.test("ProviderBridgeMapsToolCallEvent", () => {
  assertEquals(
    streamEventTypeToPublic(internalStreamToolCall),
    publicStreamToolCall,
  );
  assertEquals(
    streamEventTypeToPublic(internalStreamUsage),
    publicStreamUsage,
  );
  assertEquals(
    streamEventTypeToPublic(internalStreamHostedItem),
    publicStreamHostedItem,
  );
});
