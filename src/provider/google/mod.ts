// Public surface of src/provider/google (ported from internal/provider/google).
// Importing this module runs the provider registration, mirroring the Go
// package init().

export {
  type APIKind,
  apiKindGemini,
  apiKindVertex,
  convertUsage,
  defaultModels,
  googleMediaResolution,
  googleRole,
  googleThinkingBudget,
  googleWireCallID,
  isGoogleOAuthToken,
  newGeminiProvider,
  newGeminiProviderWithModels,
  newGeminiProviderWithModelsAndOptions,
  newGeminiProviderWithModelsAndProxy,
  newProviderWithHTTPClient,
  newVertexProvider,
  newVertexProviderWithModels,
  newVertexProviderWithModelsAndOptions,
  newVertexProviderWithModelsAndProxy,
  Provider,
  vertexAPIKeyBaseURL,
} from "./provider.ts";
export { convertModels, resolveAPIKey, toCompat } from "./register.ts";

// Side-effect import: registers "google-gemini" and "google-vertex".
import "./register.ts";
