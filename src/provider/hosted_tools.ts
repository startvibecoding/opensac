// Ported from internal/provider/hosted_tools.go

/**
 * The OpenSAC-configured search capability. It is controlled by the local
 * web-search settings/session switch.
 */
export const hostedToolWebSearch = "web_search";
/**
 * An internal name for the native OpenAI Responses capability. Its wire type is
 * still "web_search".
 */
export const hostedToolOpenAIResponsesWebSearch = "openai_responses_web_search";
export const hostedToolWebSearchAnthropicMessages = "web_search_20250305";
export const hostedToolImageGeneration = "image_generation";

/**
 * Maps a provider-neutral hosted tool name to its provider-specific wire type.
 * The mapping depends on the API family, not the vendor name.
 */
export function hostedToolType(providerType: string, name: string): string {
  switch (name) {
    case hostedToolWebSearch:
      switch (providerType) {
        case "responses":
        case "openai-responses":
          return hostedToolWebSearch;
        case "messages":
        case "anthropic-messages":
          return hostedToolWebSearchAnthropicMessages;
      }
      break;
    case hostedToolOpenAIResponsesWebSearch:
      switch (providerType) {
        case "responses":
        case "openai-responses":
          return hostedToolWebSearch;
      }
      break;
    case hostedToolImageGeneration:
      switch (providerType) {
        case "responses":
        case "openai-responses":
          return hostedToolImageGeneration;
      }
      break;
  }
  return "";
}

/**
 * Retained for callers that only need the historical web_search mapping.
 */
export function hostedWebSearchToolType(
  providerType: string,
  name: string,
): string {
  return hostedToolType(providerType, name);
}
