// Public surface of src/provider (ported from internal/provider).

export {
  type AttachmentContent,
  type AttachmentMetadataResolver,
  type AttachmentResolver,
  validateAttachmentReferenceForResolver,
} from "./attachments.ts";
export { BaseProvider } from "./base.ts";
export { isContentRejectionError } from "./content_rejection.ts";
export { errMessage, isContextOverflowError } from "./context_overflow.ts";
export {
  debugCompleteResponse,
  debugJSON,
  debugLogf,
  debugLogOnlyEnv,
  type DebugResponse,
  goSprintf,
} from "./debug.ts";
export {
  applyDiscoveryAuthHeaders,
  defaultDiscoverTimeoutMs,
  type DiscoveredModel,
  discoverMaxResponseBytes,
  discoverModels,
  type DiscoverModelsOptions,
  fetchDiscoveredModels,
  modelsEndpoint,
  parseDiscoveredModels,
  resolveSecretRef,
} from "./discover.ts";
export {
  hostedToolImageGeneration,
  hostedToolOpenAIResponsesWebSearch,
  hostedToolType,
  hostedToolWebSearch,
  hostedToolWebSearchAnthropicMessages,
  hostedWebSearchToolType,
} from "./hosted_tools.ts";
export {
  applyHeaders,
  type HttpClient,
  type HTTPClientOptions,
  newHttpClient,
  newHttpClientWithOptions,
  newStreamHttpClient,
  newStreamHttpClientWithOptions,
  streamConnectTimeoutMs,
  streamResponseHeaderTimeoutMs,
} from "./http_client.ts";
export {
  isStreamTimeoutError,
  newIdleTimeoutStream,
  streamIdleTimeoutMs,
  StreamTimeoutError,
} from "./idle_timeout.ts";
export {
  mapNormalizedPointToOriginal,
  mapNormalizedRectToOriginal,
  mapPointToOriginal,
  mapRectToOriginal,
} from "./image_coordinates.ts";
export { MockProvider, newMockProvider } from "./mock.ts";
export { type Provider } from "./provider.ts";
export {
  createProvider,
  globalProviderRegistry,
  listProviders,
  type ProviderFactory,
  ProviderRegistry,
  register,
  resolveProvider,
  setGlobalProviderRegistry,
  vendorFromBaseURL,
} from "./registry.ts";
export {
  formatRetryMessage,
  httpStatusOriginTimeout,
  isRetryable,
  type RetryConfig,
  retryDelay,
  retryErrorDetail,
  sanitizeRetryDetail,
  truncateErr,
} from "./retry.ts";
export { nextToolCallFallbackId } from "./toolcall_id.ts";
export {
  type AdapterConfig,
  getVendorAdapter,
  listVendorAdapters,
  normalizeVendorName,
  registerVendorAdapter,
  resolveAdapterConfig,
  SimpleVendorAdapter,
  type VendorAdapter,
} from "./vendor.ts";
export { registerBuiltinVendors } from "./vendors.ts";
export * from "./types.ts";
