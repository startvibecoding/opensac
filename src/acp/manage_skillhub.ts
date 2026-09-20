// Ported from internal/acp/manage_skillhub.go and
// internal/acp/manage_skillhub_catalog.go (the SkillHub half of the
// `mothx/manage/*` Phase 3 management plane).
//
// `manage_skillhub.go` projects the token-free SkillHub settings view and
// applies the strict write-only market patch. `manage_skillhub_catalog.go` is
// an ACP projection of the shared `skillhub.Service`: Desktop never discovers a
// market, writes a skill, or constructs a client itself; it can only render
// these capability-gated RPC responses and submit explicit installation
// choices scoped to an open ACP session's Runtime-owned working directory.
//
// Deviations from Go: `json.RawMessage` params/values are already-decoded JSON,
// so the market merge operates on decoded objects and re-serializes through the
// shared `saveGlobalSettingsPatch` raw-object boundary; `context.Background()`
// maps to an `undefined` `AbortSignal`, so the Remote-call handlers are async;
// and Go's `*mcp.RPCError` returns become thrown `RPCError`s that the handlers
// project onto the wire response.

import { RPCError } from "../mcp/rpc.ts";
import { acpStructuredRPCError } from "./projection.ts";
import type { ACPRPCRequest } from "./wire.ts";
import type { AcpServer, ACPSessionRuntime } from "./server.ts";
import * as path from "@std/path";
import {
  defaultSettings,
  DefaultSkillHubOfficialHandle,
  getGlobalSkillsDir,
  saveGlobalSettingsPatch,
  type Settings,
  type SkillHubSettings,
} from "../config/mod.ts";
import {
  clientsForSettings,
  type InstallRequest,
  type Market,
  MarketClawHub,
  MarketSkillHub,
  newLocalIndex,
  Service as SkillHubService,
} from "../skillhub/mod.ts";
import { projectSkillDirs } from "../skills/mod.ts";
import {
  manageDecodeWhitelist,
  manageMergeRawObject,
  manageRawGlobalSettings,
  manageRedactSecrets,
  manageSecretUsable,
  manageSettings,
} from "./manage.ts";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── SkillHub settings view/patch (manage_skillhub.go) ───────────────────────

/** The safe, token-free projection of one SkillHub market entry. */
export interface ManageSkillHubMarketView {
  id: string;
  name?: string;
  siteURL?: string;
  apiURL?: string;
  enabled: boolean;
  apiTokenConfigured: boolean;
}

/**
 * Resolves the canonical default market once: the persisted setting wins, and
 * the product default (skillhub.cn) fills an empty value.
 */
export function manageSkillHubDefaultMarket(
  settings: Settings | null | undefined,
): string {
  const fallback = defaultSettings().skillHub?.defaultMarket ?? "";
  if (settings === null || settings === undefined) return fallback;
  const configured = (settings.skillHub?.defaultMarket ?? "").trim();
  if (configured === "") return fallback;
  return configured;
}

/**
 * Assembles the token-free SkillHub view model. The `apiToken` field is never
 * echoed; clients learn only whether a usable token is currently configured.
 */
export function manageSkillHubView(
  settings: Settings,
): Record<string, unknown> {
  const skillHub: SkillHubSettings = settings.skillHub ?? {};
  const markets: ManageSkillHubMarketView[] = [];
  for (const market of skillHub.markets ?? []) {
    markets.push({
      id: market.id ?? "",
      name: market.name,
      siteURL: market.siteURL,
      apiURL: market.apiURL,
      enabled: market.enabled ?? false,
      apiTokenConfigured: manageSecretUsable(market.apiToken ?? ""),
    });
  }
  const officialHandles = skillHub.officialHandles ?? [];
  let defaultInstallScope = (skillHub.defaultInstallScope ?? "").trim();
  if (defaultInstallScope === "") {
    defaultInstallScope = defaultSettings().skillHub?.defaultInstallScope ?? "";
  }
  return {
    defaultMarket: manageSkillHubDefaultMarket(settings),
    defaultInstallScope,
    officialHandles,
    markets,
  };
}

/** Projects the current SkillHub settings without ever exposing an apiToken. */
export function handleManageSkillHubGet(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  let settings: Settings;
  try {
    settings = manageSettings();
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, manageSkillHubView(settings), null);
}

const manageSkillHubPatchTopFields: Record<string, boolean> = {
  defaultMarket: true,
  defaultInstallScope: true,
  officialHandles: true,
  markets: true,
};

const manageSkillHubMarketFields: Record<string, boolean> = {
  id: true,
  name: true,
  siteURL: true,
  apiURL: true,
  enabled: true,
  apiToken: true,
  clearApiToken: true,
};

const manageSkillHubAllowedScopes: Record<string, boolean> = {
  project: true,
  global: true,
};

/**
 * Applies a whitelist patch to the global skillHub object. Market tokens are
 * write-only: an omitted apiToken keeps the existing secret,
 * clearApiToken=true removes it, and a submitted apiToken overwrites it.
 * Unknown sibling fields on the skillHub object and on each market object are
 * preserved.
 */
export function handleManageSkillHubPatch(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  const invalidParams = (): RPCError =>
    acpStructuredRPCError(
      -32602,
      "invalid_params",
      "patch object with at least one supported skillHub field is required",
      null,
    );
  try {
    const params = req.params;
    if (
      params === undefined || params === null || typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw invalidParams();
    }
    const patchRaw = (params as Record<string, unknown>)["patch"];
    if (patchRaw === undefined || patchRaw === null) throw invalidParams();
    const fields = manageDecodeWhitelist(
      patchRaw,
      manageSkillHubPatchTopFields,
      "skillhub_field_not_allowed",
    );
    if (Object.keys(fields).length === 0) throw invalidParams();

    let settings: Settings;
    try {
      settings = manageSettings();
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }
    let raw: Record<string, unknown>;
    try {
      raw = manageRawGlobalSettings();
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }

    // Pre-validate every supplied field before touching the raw settings object.
    try {
      manageValidateSkillHubPatch(fields);
    } catch (err) {
      if (err instanceof RPCError) throw err;
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }

    try {
      manageMergeRawObject(raw, "skillHub", (skillHub) => {
        for (const [field, value] of Object.entries(fields)) {
          switch (field) {
            case "defaultMarket":
              skillHub["defaultMarket"] = manageDecodeOptionalStringValue(
                value,
              );
              break;
            case "defaultInstallScope":
              skillHub["defaultInstallScope"] = manageDecodeOptionalStringValue(
                value,
              );
              break;
            case "officialHandles":
              skillHub["officialHandles"] = value;
              break;
            case "markets": {
              const drafts = manageDecodeSkillHubMarkets(value);
              const existing = manageSkillHubExistingMarkets(skillHub);
              skillHub["markets"] = manageMergeSkillHubMarkets(
                existing,
                drafts,
              );
              break;
            }
          }
        }
      });
    } catch (err) {
      if (err instanceof RPCError) throw err;
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }

    try {
      saveGlobalSettingsPatch({ skillHub: raw["skillHub"] });
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_save_failed",
        manageRedactSecrets(errorMessage(err), settings),
        null,
      );
    }
    let updated: Settings;
    try {
      updated = manageSettings();
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }
    s.writeResponse(req.idRaw, manageSkillHubView(updated), null);
  } catch (err) {
    if (err instanceof RPCError) {
      s.writeResponse(req.idRaw, null, err);
      return;
    }
    throw err;
  }
}

function manageDecodeOptionalStringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("value must be a string");
  return value.trim();
}

/**
 * Validates the supplied top-level fields and the market array without altering
 * settings. Throws a structured `RPCError` on validation failure.
 */
export function manageValidateSkillHubPatch(
  fields: Record<string, unknown>,
): void {
  for (const [field, value] of Object.entries(fields)) {
    switch (field) {
      case "defaultMarket": {
        if (
          typeof value !== "string" || value.trim() === ""
        ) {
          throw acpStructuredRPCError(
            -32602,
            "skillhub_field_invalid",
            "a non-empty string value is required",
            { field },
          );
        }
        break;
      }
      case "defaultInstallScope": {
        if (
          typeof value !== "string" ||
          !manageSkillHubAllowedScopes[value.trim()]
        ) {
          throw acpStructuredRPCError(
            -32602,
            "skillhub_field_invalid",
            "install scope must be one of project, global",
            { field },
          );
        }
        break;
      }
      case "officialHandles": {
        if (!Array.isArray(value)) {
          throw acpStructuredRPCError(
            -32602,
            "skillhub_field_invalid",
            "an array of strings is required",
            { field },
          );
        }
        for (const handle of value) {
          if (typeof handle !== "string" || handle.trim() === "") {
            throw acpStructuredRPCError(
              -32602,
              "skillhub_field_invalid",
              "array entries must be non-empty strings",
              { field },
            );
          }
        }
        break;
      }
      case "markets": {
        const drafts = manageDecodeSkillHubMarkets(value);
        const seen = new Set<string>();
        for (const draft of drafts) {
          if (seen.has(draft.id)) {
            throw acpStructuredRPCError(
              -32602,
              "skillhub_field_invalid",
              `duplicate market id ${JSON.stringify(draft.id)}`,
              { field: "markets", id: draft.id },
            );
          }
          seen.add(draft.id);
        }
        break;
      }
    }
  }
}

/** One validated market entry from a patch request. */
export interface ManageSkillHubMarketDraft {
  id: string;
  name: string;
  siteURL: string;
  apiURL: string;
  enabled: boolean;
  apiToken: string | null;
  clearApiToken: boolean;
}

/**
 * Parses the markets array and validates every supplied field before returning
 * the normalized market drafts. Throws a structured `RPCError`.
 */
export function manageDecodeSkillHubMarkets(
  raw: unknown,
): ManageSkillHubMarketDraft[] {
  if (raw === null || !Array.isArray(raw)) {
    throw acpStructuredRPCError(
      -32602,
      "skillhub_field_invalid",
      "markets must be an array of objects",
      { field: "markets" },
    );
  }
  const drafts: ManageSkillHubMarketDraft[] = [];
  raw.forEach((item, i) => {
    let fields: Record<string, unknown>;
    try {
      fields = manageDecodeWhitelist(
        item,
        manageSkillHubMarketFields,
        "skillhub_market_field_not_allowed",
      );
    } catch (err) {
      // Keep the original whitelist error details while attaching the
      // market-array location.
      const errData = err instanceof RPCError && err.data !== null &&
          typeof err.data === "object"
        ? (err.data as Record<string, unknown>)
        : {};
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(errData)) {
        if (key !== "code") data[key] = value;
      }
      data["field"] = `markets[${i}]`;
      throw acpStructuredRPCError(
        -32602,
        "skillhub_market_field_not_allowed",
        errorMessage(err),
        data,
      );
    }
    if (typeof fields["id"] !== "string") {
      throw acpStructuredRPCError(
        -32602,
        "skillhub_field_invalid",
        "market id must be a non-empty string",
        { field: `markets[${i}].id` },
      );
    }
    const id = (fields["id"] as string).trim();
    if (id === "") {
      throw acpStructuredRPCError(
        -32602,
        "skillhub_field_invalid",
        "market id is required",
        { field: `markets[${i}].id` },
      );
    }
    const draft: ManageSkillHubMarketDraft = {
      id,
      name: "",
      siteURL: "",
      apiURL: "",
      enabled: false,
      apiToken: null,
      clearApiToken: false,
    };
    for (
      const [field, key] of [
        ["name", "name"],
        ["siteURL", "siteURL"],
        ["apiURL", "apiURL"],
      ] as const
    ) {
      if (fields[field] !== undefined) {
        if (typeof fields[field] !== "string") {
          throw manageSkillHubMarketFieldError(
            i,
            key,
            `market ${key.toLowerCase()} must be a string`,
          );
        }
        draft[key] = fields[field] as string;
      }
    }
    if (fields["enabled"] !== undefined) {
      if (typeof fields["enabled"] !== "boolean") {
        throw manageSkillHubMarketFieldError(
          i,
          "enabled",
          "enabled must be a boolean",
        );
      }
      draft.enabled = fields["enabled"] as boolean;
    }
    if (fields["apiToken"] !== undefined) {
      if (typeof fields["apiToken"] !== "string") {
        throw manageSkillHubMarketFieldError(
          i,
          "apiToken",
          "API token must be a string",
        );
      }
      draft.apiToken = fields["apiToken"] as string;
    }
    if (fields["clearApiToken"] !== undefined) {
      if (typeof fields["clearApiToken"] !== "boolean") {
        throw manageSkillHubMarketFieldError(
          i,
          "clearApiToken",
          "clearApiToken must be a boolean",
        );
      }
      draft.clearApiToken = fields["clearApiToken"] as boolean;
    }
    if (draft.clearApiToken && draft.apiToken !== null) {
      throw manageSkillHubMarketFieldError(
        i,
        "apiToken",
        "apiToken and clearApiToken cannot be set together",
      );
    }
    drafts.push(draft);
  });
  return drafts;
}

function manageSkillHubMarketFieldError(
  index: number,
  field: string,
  message: string,
): RPCError {
  return acpStructuredRPCError(-32602, "skillhub_field_invalid", message, {
    field: `markets[${index}].${field}`,
  });
}

/**
 * Reads the current markets array from raw settings and indexes them by id,
 * preserving all fields including secrets.
 */
export function manageSkillHubExistingMarkets(
  skillHub: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const marketsRaw = skillHub["markets"];
  if (marketsRaw === undefined || !Array.isArray(marketsRaw)) return result;
  for (const item of marketsRaw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const idRaw = entry["id"];
    if (typeof idRaw !== "string") continue;
    const id = idRaw.trim();
    if (id === "") continue;
    result.set(id, { ...entry });
  }
  return result;
}

/**
 * Builds the final markets array in patch order. Existing markets supply their
 * apiToken when the patch omits one, and clearApiToken=true removes it.
 * Duplicate ids in the patch are rejected.
 */
export function manageMergeSkillHubMarkets(
  existing: Map<string, Record<string, unknown>>,
  drafts: ManageSkillHubMarketDraft[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.id)) {
      throw new Error(`duplicate market id ${JSON.stringify(draft.id)}`);
    }
    seen.add(draft.id);
    const entry: Record<string, unknown> = {
      ...(existing.get(draft.id) ?? {}),
    };
    entry["id"] = draft.id;
    entry["name"] = draft.name;
    entry["siteURL"] = draft.siteURL;
    entry["apiURL"] = draft.apiURL;
    entry["enabled"] = draft.enabled;
    if (draft.clearApiToken) {
      delete entry["apiToken"];
    } else if (draft.apiToken !== null) {
      entry["apiToken"] = draft.apiToken;
    }
    merged.push(entry);
  }
  return merged;
}

// ─── SkillHub catalog (manage_skillhub_catalog.go) ───────────────────────────

/** The common request envelope for every `mothx/manage/skillhub/*` call. */
export interface ManageSkillHubCatalogRequest {
  sessionId: string;
  market: string;
  id: string;
  version: string;
  scope: string;
  targetDir: string;
  query: string;
  category: string;
  sort: string;
  order: string;
  page: number;
  limit: number;
  cursor: string;
  overwrite: boolean;
  activate: boolean;
}

interface ManageSkillHubTarget {
  path: string;
  scope: string;
  label: string;
}

function decodeManageSkillHubCatalogRequest(
  params: unknown,
): ManageSkillHubCatalogRequest {
  const input: ManageSkillHubCatalogRequest = {
    sessionId: "",
    market: "",
    id: "",
    version: "",
    scope: "",
    targetDir: "",
    query: "",
    category: "",
    sort: "",
    order: "",
    page: 0,
    limit: 0,
    cursor: "",
    overwrite: false,
    activate: false,
  };
  if (params === undefined || params === null) return input;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error("invalid params");
  }
  const record = params as Record<string, unknown>;
  for (
    const key of [
      "sessionId",
      "market",
      "id",
      "version",
      "scope",
      "targetDir",
      "query",
      "category",
      "sort",
      "order",
      "cursor",
    ] as const
  ) {
    if (typeof record[key] === "string") input[key] = record[key] as string;
  }
  if (typeof record["page"] === "number") input.page = record["page"] as number;
  if (typeof record["limit"] === "number") {
    input.limit = record["limit"] as number;
  }
  if (typeof record["overwrite"] === "boolean") {
    input.overwrite = record["overwrite"] as boolean;
  }
  if (typeof record["activate"] === "boolean") {
    input.activate = record["activate"] as boolean;
  }
  return input;
}

/**
 * Parses the common request envelope and resolves its session to the
 * Runtime-owned working directory. A catalogue request must name an open ACP
 * session so a Desktop UI can never choose an arbitrary path for discovery or
 * installation. Throws an `Error` the handlers project as a structured error.
 */
function manageSkillHubCatalog(
  s: AcpServer,
  req: ACPRPCRequest,
): {
  input: ManageSkillHubCatalogRequest;
  rt: ACPSessionRuntime;
  service: SkillHubService;
} {
  const input = decodeManageSkillHubCatalogRequest(req.params);
  input.sessionId = input.sessionId.trim();
  if (input.sessionId === "") throw new Error("sessionId is required");
  const rt = s.sessionRuntime(input.sessionId);
  if (rt === null || rt.runtime === null) {
    throw new Error("unknown or inactive session");
  }
  let settings: Settings;
  try {
    settings = manageSettings();
  } catch (err) {
    throw new Error(`load settings: ${errorMessage(err)}`);
  }
  let officialHandles = settings.skillHub?.officialHandles ?? [];
  if (officialHandles.length === 0) {
    officialHandles = [DefaultSkillHubOfficialHandle];
  }
  const service = SkillHubService.forWorkDir(
    getGlobalSkillsDir(settings),
    rt.runtime.workDir,
    officialHandles,
    ...clientsForSettings(settings.skillHub ?? {}),
  );
  return { input, rt, service };
}

function manageSkillHubMarket(
  value: string,
  fallback: string,
): Market {
  let resolved = value.trim();
  if (resolved === "") resolved = fallback;
  if (resolved !== MarketSkillHub && resolved !== MarketClawHub) {
    throw new Error(`unsupported skill market ${JSON.stringify(resolved)}`);
  }
  return resolved;
}

function manageSkillHubLimit(value: number): number {
  if (value <= 0) return 20;
  if (value > 100) return 100;
  return value;
}

function safeManageSettings(): Settings | null {
  try {
    return manageSettings();
  } catch {
    return null;
  }
}

function writeManageSkillHubCatalogError(
  s: AcpServer,
  req: ACPRPCRequest,
  err: unknown,
): void {
  let message = "SkillHub request failed";
  let code = "skillhub_unavailable";
  if (err !== null && err !== undefined) {
    message = errorMessage(err);
    if (
      message.includes("sessionId is required") ||
      message.includes("unknown or inactive session") ||
      message.includes("invalid params") ||
      message.includes("unsupported skill market") ||
      message.includes("must be") ||
      message.includes("required")
    ) {
      code = "skillhub_invalid_request";
    }
  }
  const settings = safeManageSettings();
  if (settings !== null) {
    message = manageRedactSecrets(message, settings);
  }
  s.writeResponse(
    req.idRaw,
    null,
    acpStructuredRPCError(-32602, code, message, null),
  );
}

export function handleManageSkillHubMarkets(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  try {
    const { service } = manageSkillHubCatalog(s, req);
    const result: Record<string, unknown> = {
      markets: service.markets(),
    };
    // Project the canonical default market so clients select SkillHub.cn (or
    // the configured default) instead of guessing from alphabetical order.
    const settings = safeManageSettings();
    if (settings !== null) {
      result["defaultMarket"] = manageSkillHubDefaultMarket(settings);
    }
    s.writeResponse(req.idRaw, result, null);
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export async function handleManageSkillHubCategories(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const { input, service } = manageSkillHubCatalog(s, req);
    const settings = safeManageSettings();
    let market: Market;
    try {
      market = manageSkillHubMarket(
        input.market,
        manageSkillHubDefaultMarket(settings),
      );
    } catch (err) {
      writeManageSkillHubCatalogError(s, req, err);
      return;
    }
    const categories = await service.categories(undefined, market);
    s.writeResponse(req.idRaw, { categories }, null);
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export async function handleManageSkillHubOfficial(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const { input, service } = manageSkillHubCatalog(s, req);
    const market = manageSkillHubMarket(input.market, MarketSkillHub);
    if (market !== MarketSkillHub) {
      writeManageSkillHubCatalogError(
        s,
        req,
        new Error("official recommendations are available on SkillHub.cn only"),
      );
      return;
    }
    const result = await service.official(undefined, {
      query: input.query,
      limit: manageSkillHubLimit(input.limit),
      page: input.page,
    });
    s.writeResponse(req.idRaw, result, null);
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export async function handleManageSkillHubSearch(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const { input, service } = manageSkillHubCatalog(s, req);
    const settings = safeManageSettings();
    const market = manageSkillHubMarket(
      input.market,
      manageSkillHubDefaultMarket(settings),
    );
    const result = await service.search(undefined, market, {
      query: input.query,
      limit: manageSkillHubLimit(input.limit),
      page: input.page,
      cursor: input.cursor,
      sort: input.sort,
      order: input.order,
      category: input.category,
    });
    s.writeResponse(req.idRaw, result, null);
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export async function handleManageSkillHubDetail(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const { input, service } = manageSkillHubCatalog(s, req);
    if (input.id.trim() === "") throw new Error("skill id is required");
    const settings = safeManageSettings();
    const market = manageSkillHubMarket(
      input.market,
      manageSkillHubDefaultMarket(settings),
    );
    const detail = await service.detail(undefined, market, input.id.trim());
    s.writeResponse(req.idRaw, detail, null);
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export function handleManageSkillHubTargets(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  try {
    const { input, rt } = manageSkillHubCatalog(s, req);
    let settings: Settings;
    try {
      settings = manageSettings();
    } catch (err) {
      writeManageSkillHubCatalogError(s, req, err);
      return;
    }
    const labels = [
      "MothX project skills",
      "Project skills",
      "Agents skills",
      "Generic project skills",
    ];
    const dirs = projectSkillDirs(rt.runtime!.workDir);
    const targets: ManageSkillHubTarget[] = [];
    dirs.forEach((dir, i) => {
      targets.push({
        path: dir,
        scope: "project",
        label: labels[i] ?? "Project skills",
      });
    });
    const globalDir = getGlobalSkillsDir(settings);
    if (globalDir !== "") {
      targets.push({
        path: globalDir,
        scope: "global",
        label: "Global skills",
      });
    }
    s.writeResponse(
      req.idRaw,
      { sessionId: input.sessionId, workDir: rt.runtime!.workDir, targets },
      null,
    );
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export function handleManageSkillHubInstalled(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  try {
    const { input, rt } = manageSkillHubCatalog(s, req);
    const settings = manageSettings();
    const index = newLocalIndex(
      getGlobalSkillsDir(settings),
      projectSkillDirs(rt.runtime!.workDir),
    );
    s.writeResponse(
      req.idRaw,
      {
        sessionId: input.sessionId,
        workDir: rt.runtime!.workDir,
        installed: index.list(),
        session: manageSkillHubSessionState(rt),
      },
      null,
    );
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export async function handleManageSkillHubInstall(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const { input, rt, service } = manageSkillHubCatalog(s, req);
    if (input.id.trim() === "" || input.targetDir.trim() === "") {
      throw new Error("skill id and targetDir are required");
    }
    if (!path.isAbsolute(input.targetDir)) {
      throw new Error("targetDir must be an absolute path");
    }
    if (input.scope !== "project" && input.scope !== "global") {
      throw new Error("scope must be project or global");
    }
    const settings = safeManageSettings();
    const market = manageSkillHubMarket(
      input.market,
      manageSkillHubDefaultMarket(settings),
    );
    const request: InstallRequest = {
      market,
      id: input.id.trim(),
      version: input.version,
      scope: input.scope,
      targetDir: input.targetDir,
      overwrite: input.overwrite,
    };
    const result = await service.install(undefined, request);
    try {
      await refreshManageSkillHubSession(s, rt, result.name, input.activate);
    } catch (err) {
      throw new Error(
        `installed, but failed to refresh session: ${errorMessage(err)}`,
      );
    }
    s.writeResponse(
      req.idRaw,
      {
        install: result,
        activated: input.activate,
        session: manageSkillHubSessionState(rt),
      },
      null,
    );
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export async function handleManageSkillHubActivate(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const { input, rt } = manageSkillHubCatalog(s, req);
    if (input.id.trim() === "") throw new Error("skill name is required");
    await refreshManageSkillHubSession(s, rt, input.id.trim(), true);
    s.writeResponse(
      req.idRaw,
      { activated: true, session: manageSkillHubSessionState(rt) },
      null,
    );
  } catch (err) {
    writeManageSkillHubCatalogError(s, req, err);
  }
}

export function handleManageSkillHubUninstall(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  void (async () => {
    try {
      const { input, rt, service } = manageSkillHubCatalog(s, req);
      if (
        input.id.trim() === "" || input.market.trim() === ""
      ) {
        throw new Error("market and skill id are required");
      }
      const market = manageSkillHubMarket(input.market, "");
      let activeName = "";
      // Capture the local managed name before removal so reloading the Runtime
      // context cannot retain a reference to a removed skill.
      const settings = manageSettings();
      const index = newLocalIndex(
        getGlobalSkillsDir(settings),
        projectSkillDirs(rt.runtime!.workDir),
      );
      const installed = index.state(market, input.id.trim());
      if (installed !== undefined) activeName = installed.name ?? "";
      service.uninstall(market, input.id.trim(), input.scope);
      if (activeName !== "") rt.activeSkills.delete(activeName);
      await refreshManageSkillHubSession(s, rt, "", false);
      s.writeResponse(
        req.idRaw,
        { uninstalled: true, session: manageSkillHubSessionState(rt) },
        null,
      );
    } catch (err) {
      writeManageSkillHubCatalogError(s, req, err);
    }
  })();
}

/**
 * These active names are a Runtime resource choice, not Desktop state. ACP
 * materializes active skills on the loaded SessionRuntime; keeping the list
 * here lets an install/activate preserve earlier choices in the same open
 * session while `refreshResources` remains the sole context assembler.
 */
export async function refreshManageSkillHubSession(
  s: AcpServer,
  rt: ACPSessionRuntime,
  name: string,
  activate: boolean,
): Promise<void> {
  if (rt === null || rt.runtime === null) {
    throw new Error("unknown or inactive session");
  }
  if (s.settings === null) throw new Error("ACP settings are unavailable");
  await s.withSessionMutationLeaseAsync(rt.id, async () => {
    const previous = new Map<string, boolean>(rt.activeSkills);
    if (activate && name !== "") rt.activeSkills.set(name, true);
    const browserEnabled = rt.runtime!.capabilitySnapshot().browserEnabled;
    const activeSkills: Record<string, boolean> = {};
    for (const [skill, enabled] of rt.activeSkills) {
      activeSkills[skill] = enabled;
    }
    try {
      await rt.runtime!.refreshResources(s.settings as Settings, {
        workflows: s.workflows,
        browser: browserEnabled,
        activeSkills,
      });
    } catch (err) {
      rt.activeSkills = previous;
      throw err;
    }
    s.notifyAvailableCommandsFor(rt.id, rt.runtime!.skillsMgr ?? null);
  });
}

export function manageSkillHubSessionState(
  rt: ACPSessionRuntime,
): Record<string, unknown> {
  const active: string[] = [];
  for (const [name, enabled] of rt.activeSkills) {
    if (enabled) active.push(name);
  }
  active.sort();
  return {
    sessionId: rt.id,
    workDir: rt.runtime?.workDir ?? "",
    activeSkills: active,
  };
}
