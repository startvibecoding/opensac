// Ported from internal/serve/openaiapi/handler_models.go. The Go methods bind
// to *Server; the Deno projection takes the Server as its first argument.
import type { Server } from "./server.ts";
import type { Model } from "../../provider/types.ts";
import {
  resolvedModels,
  sortProviderIDs,
} from "../../provider/factory/factory.ts";
import type {
  ModelCatalogResponse,
  ModelItem,
  ModelListResponse,
} from "./types.ts";
import { writeError, writeJSON } from "./auth.ts";

export function handleModels(server: Server, req: Request): Response {
  if (req.method !== "GET") {
    return writeError(405, "method not allowed", "invalid_request_error");
  }
  const models = server.provider?.models() ?? [];
  const items: ModelItem[] = [];
  for (const m of models) {
    if (m === undefined || m === null) continue;
    items.push(modelItem(m, m.provider, Math.floor(Date.now() / 1000)));
  }
  const resp: ModelListResponse = {
    object: "list",
    data: items,
  };
  return writeJSON(200, resp);
}

/**
 * handleModelCatalog serves the WebUI model picker. Every listed model is
 * resolved through the provider factory's resolvedModels — the same shared
 * logic that builds the TUI provider's model list — so both front ends offer
 * one canonical catalog instead of the WebUI merging raw settings JSON.
 */
export function handleModelCatalog(server: Server, req: Request): Response {
  if (req.method !== "GET") {
    return writeError(405, "method not allowed", "invalid_request_error");
  }
  const settings = server.settings;
  const currentProvider = server.providerName;
  const currentModel = server.model?.id ?? "";

  const providerIDs: string[] = [];
  const seen = new Set<string>();
  const addProvider = (id: string) => {
    if (id === "") return;
    if (seen.has(id)) return;
    seen.add(id);
    providerIDs.push(id);
  };
  if (settings?.providers) {
    for (const id of Object.keys(settings.providers)) {
      addProvider(id);
    }
  }
  // The active provider is always selectable, even when it comes from a
  // built-in preset or serve flag instead of the settings providers map.
  addProvider(currentProvider);
  sortProviderIDs(providerIDs);

  const created = Math.floor(Date.now() / 1000);
  const items: ModelItem[] = [];
  for (const providerID of providerIDs) {
    for (const m of resolvedModels(settings ?? undefined, providerID)) {
      if (m === undefined || m === null) continue;
      items.push(modelItem(m, providerID, created));
    }
  }

  const resp: ModelCatalogResponse = {
    object: "list",
    defaultProvider: currentProvider,
    defaultModel: currentModel,
    providers: providerIDs,
    data: items,
  };
  return writeJSON(200, resp);
}

function modelItem(m: Model, providerID: string, created: number): ModelItem {
  return {
    id: m.id,
    name: m.name,
    object: "model",
    created,
    owned_by: "vibecoding",
    provider: providerID,
    input: m.input ? [...m.input] : undefined,
  };
}
