// Public surface of src/provider/factory (ported from internal/provider/factory).
// Importing this module also triggers protocol provider registration because the
// anthropic/google/openai modules register on import.

export {
  configureHeaders,
  configureRetry,
  convertCompat,
  convertModelConfigs,
  create,
  type CreateResult,
  type Options,
  parseQualifiedModel,
  providerSortPriority,
  qualifiedModel,
  resolvedModels,
  resolveModel,
  sortProviderIDs,
} from "./factory.ts";

import "../anthropic/mod.ts";
import "../google/mod.ts";
import "../openai/mod.ts";
