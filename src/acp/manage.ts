// Ported from internal/acp/manage.go / manage_env.go / manage_experts.go /
// manage_application.go (the Phase 3 `mothx/manage/*` management plane).
//
// This slice ports the secret-safe management surface that does not depend on
// the unported `internal/serve` runtime: the shared manage helpers, the
// `mothx/manage/env/*` projection of internal/config/env.go, the
// `mothx/manage/experts/*` projection of internal/expert.Manager, and the
// `mothx/manage/application/*` projection of the Runtime-owned settings subset.
//
// This slice also ports the settings/providers, skills, mcp, stats, memory, and
// deliveries families of manage.go.
//
// Migration bridge (owner #35, removed when manage_serve.go / manage_cron and
// manage_skillhub*.go / manage_knowledge_bases.go land): the router routes the
// ported families and returns `manage_method_unavailable` for the
// recognized-but-not-yet-ported families. Unknown methods still return the
// canonical manage_method_not_found error.
//
// Deviations from Go: `json.RawMessage` params/values map to already-decoded
// JSON values, so the whitelist/validators inspect typed values rather than raw
// bytes; `config.Settings` methods become the exported `src/config` functions;
// and Go's `*mcp.RPCError` returns become thrown `RPCError`s that the handlers
// project onto the wire response.

import { RPCError } from "../mcp/rpc.ts";
import { acpStructuredRPCError } from "./projection.ts";
import type { ACPRPCRequest } from "./wire.ts";
import type { RequestMeta } from "./metadata.ts";
import type { AcpServer } from "./server.ts";
import * as path from "@std/path";
import {
  applyEnvPatch,
  configDir,
  defaultProviderConfig,
  envList,
  getGlobalSkillsDir,
  getProviderConfig,
  getSessionDir,
  globalMCPPath,
  globalSettingsPath,
  isACPArtifactEnabled,
  isArtifactEnabled,
  isImageGenerationEnabled,
  isWebSearchEnabled,
  loadEnv,
  loadMCPConfig,
  loadSettings,
  type MCPConfig,
  type MCPServer,
  mcpServerEnabled,
  normalizeMCPConfig,
  projectMCPPath,
  resolveImageGenerationToken,
  resolveKey,
  resolveProviderConfig,
  saveGlobalSettingsPatch,
  saveMCPConfig,
  skillsDisabled,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
  validateEnvName,
} from "../config/mod.ts";
import type {
  ModelConfig,
  ProviderConfig,
  Settings,
} from "../config/settings.ts";
import {
  create as createFactoryProvider,
  resolvedModels,
  sortProviderIDs,
} from "../provider/factory/mod.ts";
import { discoverModels } from "../provider/discover.ts";
import {
  streamDone as streamDoneType,
  streamError as streamErrorType,
  thinkingHigh,
  type ThinkingLevel,
  thinkingLow,
  thinkingMax,
  thinkingMedium,
  thinkingMinimal,
  thinkingOff,
  thinkingXHigh,
} from "../provider/types.ts";
import {
  loadConfig as loadServeConfig,
  memoryEnabled as serveMemoryEnabled,
} from "../serve/config.ts";
import {
  ErrDeliveryOperationAbsent,
  getDeliveryOperation,
  listAllDetailed,
  listDeliveryFailures,
  reopenFailedDeliveryOperation,
} from "../session/mod.ts";
import {
  Manager as SkillsManager,
  newManagerWithProjectDirs,
  projectSkillDirs,
} from "../skills/mod.ts";
import {
  DB as StatsDB,
  type Query as StatsQuery,
  type Summary as StatsSummary,
} from "../stats/stats.ts";
import { parseQueryParams as parseStatsQueryParams } from "../stats/server.ts";
import { Store as MemoryStore } from "../memory/store.ts";
import { deliveryFailureRetryable } from "../agentruntime/delivery_coordinator.ts";
import {
  type ManagedBundle,
  Manager as ExpertManager,
  type Scope,
  ScopeGlobal,
  ScopeProject,
  type Summary as ExpertSummary,
} from "../expert/mod.ts";
import {
  ModeAgent,
  ModeOS,
  ModePlan,
  ModeYolo,
} from "../agentruntime/source.ts";
import {
  handleManageSkillHubActivate,
  handleManageSkillHubCategories,
  handleManageSkillHubDetail,
  handleManageSkillHubGet,
  handleManageSkillHubInstall,
  handleManageSkillHubInstalled,
  handleManageSkillHubMarkets,
  handleManageSkillHubOfficial,
  handleManageSkillHubPatch,
  handleManageSkillHubSearch,
  handleManageSkillHubTargets,
  handleManageSkillHubUninstall,
} from "./manage_skillhub.ts";

// ─── shared manage helpers (manage.go) ────────────────────────────────────────

/** Loads the effective settings exactly like every other runtime entry point. */
export function manageSettings(): Settings {
  try {
    return loadSettings();
  } catch (err) {
    throw new Error(`load settings: ${errorMessage(err)}`);
  }
}

/**
 * Returns the negotiated workspace cwd, falling back to the process cwd for
 * direct/unit fixtures without workspace metadata.
 */
export function manageWorkDir(s: AcpServer): string {
  if (s.workspaceCwd !== "") return s.workspaceCwd;
  return s.cwd;
}

/**
 * Reports whether a resolved key value is an actual secret. Unresolved
 * `${ENV}` placeholders and `!shell` references are config syntax, not key
 * material, and project as "no key configured".
 */
export function manageSecretUsable(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return !trimmed.startsWith("${") && !trimmed.startsWith("!");
}

/** Masks a resolved key as prefix + `***` + suffix. */
export function manageMaskSecret(value: string): string {
  if (value.length <= 6) return "***";
  return value.slice(0, 3) + "***" + value.slice(value.length - 3);
}

/** Scrubs every configured provider key from an outgoing human-readable message. */
export function manageRedactSecrets(
  message: string,
  settings: Settings | null,
): string {
  if (settings === null || message === "") return message;
  let out = message;
  const providers = settings.providers ?? {};
  for (const name of Object.keys(providers)) {
    const resolved = resolveKey(settings, name);
    if (!manageSecretUsable(resolved) || resolved.length < 4) continue;
    out = out.split(resolved).join("***");
  }
  const imageToken = resolveImageGenerationToken(settings);
  if (manageSecretUsable(imageToken) && imageToken.length >= 4) {
    out = out.split(imageToken).join("***");
  }
  for (const market of settings.skillHub?.markets ?? []) {
    const token = market.apiToken ?? "";
    if (!manageSecretUsable(token) || token.length < 4) continue;
    out = out.split(token).join("***");
  }
  return out;
}

/**
 * Reads the current global settings.json as raw top-level keys so nested
 * patches preserve sibling and unknown fields exactly. The write itself always
 * stays in `config.saveGlobalSettingsPatch`.
 */
export function manageRawGlobalSettings(): Record<string, unknown> {
  const settingsPath = globalSettingsPath();
  let data: string;
  try {
    data = Deno.readTextFileSync(settingsPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw new Error(`read global settings: ${errorMessage(err)}`);
  }
  if (data.trim() === "") return {};
  const parsed = JSON.parse(data) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parse global settings: not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merges one top-level object key of the raw settings map in place, keeping
 * every sibling field intact.
 */
export function manageMergeRawObject(
  raw: Record<string, unknown>,
  key: string,
  mutate: (target: Record<string, unknown>) => void,
): void {
  let object: Record<string, unknown> = {};
  const existing = raw[key];
  if (
    existing !== undefined && existing !== null
  ) {
    if (typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error(`parse settings key ${key}: value must be an object`);
    }
    object = { ...(existing as Record<string, unknown>) };
  }
  mutate(object);
  raw[key] = object;
}

/** Decodes a whitelist field that may be absent. */
export function manageDecodeOptionalString(
  raw: unknown,
): { value: string; present: boolean } {
  if (raw === undefined) return { value: "", present: false };
  if (typeof raw !== "string") throw new Error("value must be a string");
  return { value: raw, present: true };
}

/** Decodes a whitelist boolean field that may be absent. */
export function manageDecodeOptionalBool(
  raw: unknown,
): { value: boolean; present: boolean } {
  if (raw === undefined) return { value: false, present: false };
  if (typeof raw !== "boolean") throw new Error("value must be a boolean");
  return { value: raw, present: true };
}

/**
 * Decodes a params object and rejects every key outside the whitelist with a
 * structured error carrying the stable machine code.
 */
export function manageDecodeWhitelist(
  params: unknown,
  allowed: Record<string, boolean>,
  code: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (params !== undefined && params !== null) {
    if (typeof params !== "object" || Array.isArray(params)) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "params must be a JSON object",
      );
    }
    for (
      const [key, value] of Object.entries(params as Record<string, unknown>)
    ) {
      fields[key] = value;
    }
  }
  const rejected = Object.keys(fields).filter((field) => !allowed[field])
    .sort();
  if (rejected.length > 0) {
    const allowedList = Object.keys(allowed).sort();
    throw acpStructuredRPCError(
      -32602,
      code,
      `field ${JSON.stringify(rejected[0])} is not allowed`,
      { field: rejected[0], rejected, allowed: allowedList },
    );
  }
  return fields;
}

/** The mode vocabulary this ACP process exposes through session/set_mode. */
export const manageAllowedModes: Record<string, boolean> = {
  [ModeAgent]: true,
  [ModePlan]: true,
  [ModeYolo]: true,
  [ModeOS]: true,
};

// ─── mothx/manage router ──────────────────────────────────────────────────────

/**
 * Routes the `mothx/manage/*` extension family. Family members that are not yet
 * ported receive a structured manage_method_unavailable error; unknown methods
 * keep the canonical manage_method_not_found error.
 */
export function handleManageRequest(s: AcpServer, req: ACPRPCRequest): void {
  switch (req.method) {
    case "mothx/manage/env/get":
      handleManageEnvGet(s, req);
      return;
    case "mothx/manage/env/patch":
      handleManageEnvPatch(s, req);
      return;
    case "mothx/manage/experts/list":
      handleManageExpertsList(s, req);
      return;
    case "mothx/manage/experts/get":
      handleManageExpertsGet(s, req);
      return;
    case "mothx/manage/experts/create":
      handleManageExpertsCreate(s, req);
      return;
    case "mothx/manage/experts/update":
      handleManageExpertsUpdate(s, req);
      return;
    case "mothx/manage/experts/delete":
      handleManageExpertsDelete(s, req);
      return;
    case "mothx/manage/application/get":
      handleManageApplicationGet(s, req);
      return;
    case "mothx/manage/application/patch":
      handleManageApplicationPatch(s, req);
      return;
    case "mothx/manage/settings/get":
      handleManageSettingsGet(s, req);
      return;
    case "mothx/manage/settings/patch":
      handleManageSettingsPatch(s, req);
      return;
    case "mothx/manage/providers/list":
      handleManageProvidersList(s, req);
      return;
    case "mothx/manage/providers/save":
      handleManageProvidersSave(s, req);
      return;
    case "mothx/manage/providers/delete":
      handleManageProvidersDelete(s, req);
      return;
    case "mothx/manage/providers/discover":
      void handleManageProvidersDiscover(s, req);
      return;
    case "mothx/manage/providers/test":
      void handleManageProvidersTest(s, req);
      return;
    case "mothx/manage/skills/list":
      handleManageSkillsList(s, req);
      return;
    case "mothx/manage/skills/set":
      handleManageSkillsSet(s, req);
      return;
    case "mothx/manage/mcp/list":
      handleManageMCPList(s, req);
      return;
    case "mothx/manage/mcp/set":
      handleManageMCPSet(s, req);
      return;
    case "mothx/manage/stats/summary":
      handleManageStatsSummary(s, req);
      return;
    case "mothx/manage/stats/timeseries":
      handleManageStatsTimeseries(s, req);
      return;
    case "mothx/manage/memory/get":
      handleManageMemoryGet(s, req);
      return;
    case "mothx/manage/memory/put":
      handleManageMemoryPut(s, req);
      return;
    case "mothx/manage/deliveries/list":
      handleManageDeliveriesList(s, req);
      return;
    case "mothx/manage/deliveries/retry":
      handleManageDeliveriesRetry(s, req);
      return;
    case "mothx/manage/skillhub/get":
      handleManageSkillHubGet(s, req);
      return;
    case "mothx/manage/skillhub/patch":
      handleManageSkillHubPatch(s, req);
      return;
    case "mothx/manage/skillhub/markets":
      handleManageSkillHubMarkets(s, req);
      return;
    case "mothx/manage/skillhub/categories":
      void handleManageSkillHubCategories(s, req);
      return;
    case "mothx/manage/skillhub/official":
      void handleManageSkillHubOfficial(s, req);
      return;
    case "mothx/manage/skillhub/search":
      void handleManageSkillHubSearch(s, req);
      return;
    case "mothx/manage/skillhub/detail":
      void handleManageSkillHubDetail(s, req);
      return;
    case "mothx/manage/skillhub/targets":
      handleManageSkillHubTargets(s, req);
      return;
    case "mothx/manage/skillhub/installed":
      handleManageSkillHubInstalled(s, req);
      return;
    case "mothx/manage/skillhub/install":
      void handleManageSkillHubInstall(s, req);
      return;
    case "mothx/manage/skillhub/activate":
      void handleManageSkillHubActivate(s, req);
      return;
    case "mothx/manage/skillhub/uninstall":
      handleManageSkillHubUninstall(s, req);
      return;
    default:
      if (isUnportedManageMethod(req.method)) {
        s.writeResponse(
          req.idRaw,
          null,
          acpStructuredRPCError(
            -32601,
            "manage_method_unavailable",
            `management method ${
              JSON.stringify(req.method)
            } is not available yet`,
            { method: req.method },
          ),
        );
        return;
      }
      s.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32601,
          "manage_method_not_found",
          `unknown management method ${JSON.stringify(req.method)}`,
          null,
        ),
      );
  }
}

/** Recognized `mothx/manage/*` methods owned by later, unported slices. */
function isUnportedManageMethod(method: string): boolean {
  switch (method) {
    case "mothx/manage/serve/get":
    case "mothx/manage/serve/patch":
    case "mothx/manage/channels/get":
    case "mothx/manage/channels/patch":
    case "mothx/manage/cron/list":
    case "mothx/manage/cron/create":
    case "mothx/manage/cron/update":
    case "mothx/manage/cron/remove":
    case "mothx/manage/cron/run":
    case "mothx/manage/knowledge-bases/list":
    case "mothx/manage/knowledge-bases/get":
    case "mothx/manage/knowledge-bases/create":
    case "mothx/manage/knowledge-bases/update":
    case "mothx/manage/knowledge-bases/delete":
    case "mothx/manage/knowledge-bases/scan":
    case "mothx/manage/knowledge-bases/status":
    case "mothx/manage/knowledge-bases/query":
    case "mothx/manage/knowledge-bases/mcp/apply":
      return true;
    default:
      return false;
  }
}

// ─── mothx/manage/env/* (manage_env.go) ───────────────────────────────────────

interface ManageEnvVariableView {
  name: string;
  valueConfigured: boolean;
}

interface ManageEnvView {
  variables: ManageEnvVariableView[];
}

function manageEnvViewFromConfig(
  cfg: { vars: Record<string, string> },
): ManageEnvView {
  const vars = envList(cfg);
  const names = Object.keys(vars).sort();
  return {
    variables: names.map((name) => ({ name, valueConfigured: true })),
  };
}

const manageEnvPatchFields: Record<string, boolean> = {
  set: true,
  unset: true,
};
const manageEnvSetEntryFields: Record<string, boolean> = {
  name: true,
  value: true,
};

function handleManageEnvGet(s: AcpServer, req: ACPRPCRequest): void {
  const cfg = loadEnv();
  s.writeResponse(req.idRaw, manageEnvViewFromConfig(cfg), null);
}

function handleManageEnvPatch(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const fields = manageDecodeWhitelist(
      req.params,
      manageEnvPatchFields,
      "env_field_not_allowed",
    );
    if (Object.keys(fields).length === 0) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "set or unset must contain at least one variable",
        null,
      );
    }
    const set = manageEnvDecodeSet(fields["set"]);
    const unset = manageEnvDecodeUnset(fields["unset"]);
    if (Object.keys(set).length === 0 && unset.length === 0) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "set or unset must contain at least one variable",
        null,
      );
    }
    for (const name of Object.keys(set)) {
      if (unset.includes(name)) {
        throw acpStructuredRPCError(
          -32602,
          "env_name_conflict",
          `name ${JSON.stringify(name)} cannot appear in both set and unset`,
          { name },
        );
      }
    }
    const cfg = loadEnv();
    try {
      applyEnvPatch(cfg, set, unset);
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "env_save_failed",
        errorMessage(err),
        null,
      );
    }
    s.writeResponse(req.idRaw, manageEnvViewFromConfig(cfg), null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

function manageEnvDecodeSet(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (raw === null) {
    throw manageEnvFieldInvalid(
      "set must be an array of {name, value} objects",
      "set",
      -1,
    );
  }
  if (!Array.isArray(raw)) {
    throw manageEnvFieldInvalid(
      "set must be an array of {name, value} objects",
      "set",
      -1,
    );
  }
  const set: Record<string, string> = {};
  raw.forEach((entry, index) => {
    let fields: Record<string, unknown>;
    try {
      fields = manageDecodeWhitelist(
        entry,
        manageEnvSetEntryFields,
        "env_field_not_allowed",
      );
    } catch {
      throw manageEnvFieldInvalid(
        "each set entry may contain only name and value",
        "set",
        index,
      );
    }
    if (
      Object.keys(fields).length !== 2 || fields["name"] === undefined ||
      fields["value"] === undefined
    ) {
      throw manageEnvFieldInvalid(
        "each set entry requires name and value strings",
        "set",
        index,
      );
    }
    const { name, value } = manageEnvDecodeEntry(
      fields["name"],
      fields["value"],
      index,
    );
    if (Object.prototype.hasOwnProperty.call(set, name)) {
      throw acpStructuredRPCError(
        -32602,
        "env_name_duplicate",
        `set[${index}]: duplicate name ${JSON.stringify(name)}`,
        { field: "set", index },
      );
    }
    set[name] = value;
  });
  return set;
}

function manageEnvDecodeEntry(
  rawName: unknown,
  rawValue: unknown,
  index: number,
): { name: string; value: string } {
  if (rawName === null || rawValue === null) {
    throw manageEnvFieldInvalid(
      "each set entry requires name and value strings",
      "set",
      index,
    );
  }
  if (typeof rawName !== "string" || typeof rawValue !== "string") {
    throw manageEnvFieldInvalid(
      "each set entry requires name and value strings",
      "set",
      index,
    );
  }
  const name = rawName.trim();
  try {
    validateEnvName(name);
  } catch (err) {
    throw acpStructuredRPCError(
      -32602,
      "env_name_invalid",
      `set[${index}]: ${errorMessage(err)}`,
      { field: "set", index },
    );
  }
  return { name, value: rawValue };
}

function manageEnvDecodeUnset(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (raw === null) {
    throw manageEnvFieldInvalid(
      "unset must be an array of variable names",
      "unset",
      -1,
    );
  }
  if (!Array.isArray(raw)) {
    throw manageEnvFieldInvalid(
      "unset must be an array of variable names",
      "unset",
      -1,
    );
  }
  const unset: string[] = [];
  const seen = new Set<string>();
  raw.forEach((rawName, index) => {
    if (rawName === null || typeof rawName !== "string") {
      throw manageEnvFieldInvalid(
        "unset must contain only names",
        "unset",
        index,
      );
    }
    const name = rawName.trim();
    try {
      validateEnvName(name);
    } catch (err) {
      throw acpStructuredRPCError(
        -32602,
        "env_name_invalid",
        `unset[${index}]: ${errorMessage(err)}`,
        { field: "unset", index },
      );
    }
    if (seen.has(name)) {
      throw acpStructuredRPCError(
        -32602,
        "env_name_duplicate",
        `unset[${index}]: duplicate name ${JSON.stringify(name)}`,
        { field: "unset", index },
      );
    }
    seen.add(name);
    unset.push(name);
  });
  return unset;
}

function manageEnvFieldInvalid(
  message: string,
  field: string,
  index: number,
): RPCError {
  const data: Record<string, unknown> = { field };
  if (index >= 0) data["index"] = index;
  return acpStructuredRPCError(-32602, "env_field_invalid", message, data);
}

// ─── mothx/manage/experts/* (manage_experts.go) ───────────────────────────────

interface ManageExpertsRequest {
  cwd: string;
  scope: Scope | "";
  name: string;
  bundle?: ManagedBundle;
  meta?: RequestMeta;
}

function decodeManageExpertsRequest(
  params: unknown,
): ManageExpertsRequest | null {
  if (params === undefined || params === null) {
    return { cwd: "", scope: "", name: "" };
  }
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: ManageExpertsRequest = {
    cwd: typeof record["cwd"] === "string" ? record["cwd"] : "",
    scope: typeof record["scope"] === "string" ? record["scope"] : "",
    name: typeof record["name"] === "string" ? record["name"] : "",
  };
  if (record["bundle"] !== undefined) {
    request.bundle = record["bundle"] as ManagedBundle;
  }
  if (record["_meta"] !== undefined && record["_meta"] !== null) {
    request.meta = record["_meta"] as RequestMeta;
  }
  return request;
}

function manageExpertManager(
  s: AcpServer,
  input: ManageExpertsRequest,
): { manager: ExpertManager; scope: Scope; cwd: string } {
  let scope = input.scope;
  if (scope === "") scope = ScopeGlobal;
  if (scope !== ScopeGlobal && scope !== ScopeProject) {
    throw new Error(`expert scope ${JSON.stringify(scope)} is not supported`);
  }
  if (scope === ScopeGlobal) {
    return { manager: new ExpertManager(""), scope, cwd: "" };
  }
  let cwd = "";
  try {
    cwd = s.resolveWorkspace(input.meta, input.cwd).cwd;
  } catch (err) {
    throw new Error(errorMessage(err));
  }
  if (cwd.trim() === "") {
    throw new Error("project scope requires a workspace cwd");
  }
  return { manager: new ExpertManager(cwd), scope, cwd };
}

function manageExpertRPCError(err: unknown): RPCError {
  const message = errorMessage(err);
  let code = "expert_operation_failed";
  let status = -32000;
  const lowered = message.toLowerCase();
  if (
    lowered.includes("scope") || lowered.includes("invalid") ||
    lowered.includes("requires") || lowered.includes("not found") ||
    lowered.includes("already exists")
  ) {
    code = "expert_invalid_request";
    status = -32602;
  }
  return acpStructuredRPCError(status, code, message, null);
}

function handleManageExpertsList(s: AcpServer, req: ACPRPCRequest): void {
  const input = decodeManageExpertsRequest(req.params);
  if (input === null) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(-32602, "invalid_params", "invalid params", null),
    );
    return;
  }
  try {
    const { manager, scope, cwd } = manageExpertManager(s, input);
    const items = manager.listScope(scope);
    s.writeResponse(req.idRaw, {
      scope,
      cwd,
      experts: items,
      effectiveExperts: manager.list(),
    }, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageExpertRPCError(err));
  }
}

function handleManageExpertsGet(s: AcpServer, req: ACPRPCRequest): void {
  const input = decodeManageExpertsRequest(req.params);
  if (input === null || input.name.trim() === "") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(-32602, "invalid_params", "name is required", null),
    );
    return;
  }
  try {
    const { manager, scope, cwd } = manageExpertManager(s, input);
    const bundle = manager.get(scope, input.name.trim());
    s.writeResponse(req.idRaw, { scope, cwd, bundle }, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageExpertRPCError(err));
  }
}

function handleManageExpertsCreate(s: AcpServer, req: ACPRPCRequest): void {
  const input = decodeManageExpertsRequest(req.params);
  if (input === null || input.bundle === undefined) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "bundle is required",
        null,
      ),
    );
    return;
  }
  try {
    const { manager, scope, cwd } = manageExpertManager(s, input);
    const bundle = manager.create(
      scope,
      normalizeExpertDraft(input.bundle, scope),
    );
    s.writeResponse(req.idRaw, { scope, cwd, bundle }, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageExpertRPCError(err));
  }
}

function handleManageExpertsUpdate(s: AcpServer, req: ACPRPCRequest): void {
  const input = decodeManageExpertsRequest(req.params);
  if (input === null || input.bundle === undefined) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "bundle is required",
        null,
      ),
    );
    return;
  }
  try {
    const { manager, scope, cwd } = manageExpertManager(s, input);
    const bundle = manager.update(
      scope,
      normalizeExpertDraft(input.bundle, scope),
    );
    s.writeResponse(req.idRaw, { scope, cwd, bundle }, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageExpertRPCError(err));
  }
}

function handleManageExpertsDelete(s: AcpServer, req: ACPRPCRequest): void {
  const input = decodeManageExpertsRequest(req.params);
  if (input === null || input.name.trim() === "") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(-32602, "invalid_params", "name is required", null),
    );
    return;
  }
  try {
    const { manager, scope, cwd } = manageExpertManager(s, input);
    const name = input.name.trim();
    manager.delete(scope, name);
    s.writeResponse(req.idRaw, { deleted: true, scope, cwd, name }, null);
  } catch (err) {
    s.writeResponse(req.idRaw, null, manageExpertRPCError(err));
  }
}

/** Fills the draft's scope so the shared Manager validation sees a value. */
function normalizeExpertDraft(
  draft: ManagedBundle,
  scope: Scope,
): ManagedBundle {
  return {
    scope: draft.scope === undefined || draft.scope === null
      ? scope
      : draft.scope,
    manifest: draft.manifest,
    agents: draft.agents ?? {},
  };
}

/** Re-exported for tests that need the expert summary shape. */
export type { ExpertSummary };

// ─── mothx/manage/application/* (manage_application.go) ───────────────────────

const manageApplicationSections: Record<string, Record<string, boolean>> = {
  defaults: {
    defaultMode: true,
    enablePlanTool: true,
    enableArtifact: true,
    enableACPArtifact: true,
    authored: true,
    updateCheck: true,
  },
  contextFiles: { enabled: true, extraFiles: true },
  compaction: {
    enabled: true,
    reserveTokens: true,
    keepRecentTokens: true,
    tokenizer: true,
    tokenizerModel: true,
    template: true,
  },
  toolExecution: { mode: true, maxConcurrency: true },
  webSearch: {
    enabled: true,
    provider: true,
    providerType: true,
    model: true,
  },
  imageGeneration: {
    enabled: true,
    provider: true,
    apiType: true,
    baseUrl: true,
    model: true,
    token: true,
  },
  retry: { enabled: true, maxRetries: true, baseDelayMs: true },
  statusLine: {
    enabled: true,
    type: true,
    command: true,
    padding: true,
    refreshInterval: true,
    timeoutMs: true,
    fallback: true,
  },
  sandbox: {
    enabled: true,
    level: true,
    bwrapPath: true,
    allowNetwork: true,
    allowedRead: true,
    allowedWrite: true,
    deniedPaths: true,
    tmpSize: true,
    protectGit: true,
  },
  approval: {
    bashWhitelist: true,
    bashBlacklist: true,
    confirmBeforeWrite: true,
  },
};

const manageApplicationConfigKey: Record<string, string> = {
  contextFiles: "contextFiles",
  compaction: "compaction",
  toolExecution: "toolExecution",
  webSearch: "webSearch",
  imageGeneration: "imageGeneration",
  retry: "retry",
  statusLine: "statusLine",
  sandbox: "sandbox",
  approval: "approval",
};

const manageApplicationSectionNames: Record<string, boolean> = {
  defaults: true,
  contextFiles: true,
  compaction: true,
  toolExecution: true,
  webSearch: true,
  imageGeneration: true,
  retry: true,
  statusLine: true,
  sandbox: true,
  approval: true,
};

function manageOptionalBool(value: boolean | undefined | null): boolean {
  return value !== undefined && value !== null && value;
}

/** The Runtime-owned, secret-safe application settings view. */
export function manageApplicationView(
  settings: Settings,
): Record<string, unknown> {
  let defaultMode = (settings.defaultMode ?? "").trim();
  if (defaultMode === "") defaultMode = ModeYolo;
  const sandbox = settings.sandbox;
  const compaction = settings.compaction;
  const statusLine = settings.statusLine;
  const retry = settings.retry;
  const approval = settings.approval;
  const webSearch = settings.webSearch;
  const imageGeneration = settings.imageGeneration;
  const contextFiles = settings.contextFiles;
  return {
    defaults: {
      defaultMode,
      enablePlanTool: manageOptionalBool(settings.enablePlanTool),
      enableArtifact: isArtifactEnabled(settings),
      enableACPArtifact: isACPArtifactEnabled(settings),
      authored: settings.authored ?? false,
      updateCheck: settings.updateCheck === undefined || settings.updateCheck,
    },
    contextFiles: {
      enabled: contextFiles?.enabled ?? false,
      extraFiles: [...(contextFiles?.extraFiles ?? [])],
    },
    compaction: {
      enabled: compaction?.enabled ?? false,
      reserveTokens: compaction?.reserveTokens ?? 0,
      keepRecentTokens: compaction?.keepRecentTokens ?? 0,
      tokenizer: compaction?.tokenizer ?? "",
      tokenizerModel: compaction?.tokenizerModel ?? "",
      template: compaction?.template ?? "",
    },
    toolExecution: {
      mode: toolExecutionEffectiveMode(settings.toolExecution ?? {}),
      maxConcurrency: toolExecutionEffectiveMaxConcurrency(
        settings.toolExecution ?? {},
      ),
    },
    webSearch: {
      enabled: isWebSearchEnabled(settings),
      provider: webSearch?.provider ?? "",
      providerType: webSearch?.providerType ?? "",
      model: webSearch?.model ?? "",
    },
    imageGeneration: {
      enabled: isImageGenerationEnabled(settings),
      provider: imageGeneration?.provider ?? "",
      apiType: imageGeneration?.apiType ?? "",
      baseUrl: imageGeneration?.baseUrl ?? "",
      model: imageGeneration?.model ?? "",
      tokenConfigured: manageSecretUsable(
        resolveImageGenerationToken(settings),
      ),
    },
    retry: {
      enabled: retry?.enabled ?? false,
      maxRetries: retry?.maxRetries ?? 0,
      baseDelayMs: retry?.baseDelayMs ?? 0,
    },
    statusLine: {
      enabled: statusLine?.enabled ?? false,
      type: statusLine?.type ?? "",
      command: statusLine?.command ?? "",
      padding: statusLine?.padding ?? 0,
      refreshInterval: statusLine?.refreshInterval ?? 0,
      timeoutMs: statusLine?.timeoutMs ?? 0,
      fallback: statusLine?.fallback ?? "",
    },
    sandbox: {
      enabled: sandbox?.enabled ?? false,
      level: sandbox?.level ?? "",
      bwrapPath: sandbox?.bwrapPath ?? "",
      allowNetwork: sandbox?.allowNetwork ?? false,
      allowedRead: [...(sandbox?.allowedRead ?? [])],
      allowedWrite: [...(sandbox?.allowedWrite ?? [])],
      deniedPaths: [...(sandbox?.deniedPaths ?? [])],
      tmpSize: sandbox?.tmpSize ?? "",
      protectGit: sandbox?.protectGit ?? false,
    },
    approval: {
      bashWhitelist: [...(approval?.bashWhitelist ?? [])],
      bashBlacklist: [...(approval?.bashBlacklist ?? [])],
      confirmBeforeWrite: manageOptionalBool(approval?.confirmBeforeWrite),
    },
  };
}

function handleManageApplicationGet(s: AcpServer, req: ACPRPCRequest): void {
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
  s.writeResponse(req.idRaw, manageApplicationView(settings), null);
}

function manageApplicationDecodeSection(
  section: string,
  raw: unknown,
): Record<string, unknown> {
  const allowed = manageApplicationSections[section];
  if (allowed === undefined) {
    throw acpStructuredRPCError(
      -32602,
      "application_section_not_allowed",
      `application section ${JSON.stringify(section)} is not supported`,
      { section },
    );
  }
  const fields = manageDecodeWhitelist(
    raw,
    allowed,
    "application_field_not_allowed",
  );
  for (const [field, value] of Object.entries(fields)) {
    const message = manageApplicationValidateField(section, field, value);
    if (message !== undefined) {
      throw acpStructuredRPCError(
        -32602,
        "application_field_invalid",
        `field ${section}.${field}: ${message}`,
        { section, field },
      );
    }
  }
  return fields;
}

function manageApplicationValidateField(
  section: string,
  field: string,
  raw: unknown,
): string | undefined {
  const boolField = (): string | undefined =>
    typeof raw === "boolean" ? undefined : "a boolean value is required";
  const stringField = (): string | undefined =>
    typeof raw === "string" ? undefined : "a string value is required";
  const intField = (min: number): string | undefined =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= min
      ? undefined
      : `an integer >= ${min} is required`;
  const stringListField = (): string | undefined => {
    if (!Array.isArray(raw)) return "an array of strings is required";
    for (const value of raw) {
      if (typeof value !== "string" || value.trim() === "") {
        return "array entries must be non-empty strings";
      }
    }
    return undefined;
  };

  switch (section) {
    case "defaults": {
      if (field === "defaultMode") {
        if (typeof raw !== "string" || !manageAllowedModes[raw.trim()]) {
          return "must be one of agent, plan, yolo, os";
        }
        return undefined;
      }
      return boolField();
    }
    case "contextFiles":
      return field === "extraFiles" ? stringListField() : boolField();
    case "compaction":
      if (field === "enabled") return boolField();
      if (field === "reserveTokens" || field === "keepRecentTokens") {
        return intField(0);
      }
      return stringField();
    case "toolExecution":
      if (field === "maxConcurrency") return intField(1);
      return raw === "parallel" || raw === "sequential"
        ? undefined
        : "must be parallel or sequential";
    case "webSearch":
    case "imageGeneration":
      return field === "enabled" ? boolField() : stringField();
    case "retry":
      return field === "enabled" ? boolField() : intField(0);
    case "statusLine":
      if (field === "enabled") return boolField();
      if (
        field === "padding" || field === "refreshInterval" ||
        field === "timeoutMs"
      ) {
        return intField(0);
      }
      return stringField();
    case "sandbox":
      if (
        field === "enabled" || field === "allowNetwork" ||
        field === "protectGit"
      ) {
        return boolField();
      }
      if (
        field === "allowedRead" || field === "allowedWrite" ||
        field === "deniedPaths"
      ) {
        return stringListField();
      }
      return stringField();
    case "approval":
      return field === "confirmBeforeWrite" ? boolField() : stringListField();
    default:
      return "unsupported application section";
  }
}

function handleManageApplicationPatch(s: AcpServer, req: ACPRPCRequest): void {
  try {
    if (
      req.params === undefined || req.params === null ||
      typeof req.params !== "object" || Array.isArray(req.params)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one supported application section is required",
        null,
      );
    }
    const patch = (req.params as Record<string, unknown>)["patch"];
    if (
      patch === undefined || patch === null || typeof patch !== "object" ||
      Array.isArray(patch)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one supported application section is required",
        null,
      );
    }
    const sections = manageDecodeWhitelist(
      patch,
      manageApplicationSectionNames,
      "application_section_not_allowed",
    );
    if (Object.keys(sections).length === 0) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one supported application section is required",
        null,
      );
    }
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
    const names = Object.keys(sections).sort();
    const updates: Record<string, unknown> = {};
    for (const section of names) {
      const fields = manageApplicationDecodeSection(section, sections[section]);
      if (section === "defaults") {
        for (const [field, value] of Object.entries(fields)) {
          updates[field] = value;
        }
        continue;
      }
      const configKey = manageApplicationConfigKey[section];
      try {
        manageMergeRawObject(raw, configKey, (target) => {
          for (const [field, value] of Object.entries(fields)) {
            target[field] = value;
          }
        });
      } catch (err) {
        throw acpStructuredRPCError(
          -32000,
          "settings_unavailable",
          errorMessage(err),
          null,
        );
      }
      updates[configKey] = raw[configKey];
    }
    try {
      saveGlobalSettingsPatch(updates);
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
    s.applyACPArtifactSetting(isACPArtifactEnabled(updated));
    s.writeResponse(req.idRaw, manageApplicationView(updated), null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

// ─── §6.1 settings (manage.go) ────────────────────────────────────────────────

/**
 * The strict whitelist of `settings/patch`. Every entry maps onto the existing
 * internal/config schema; fields owned by other configuration surfaces
 * (serve.json features such as memoryEnabled) are deliberately rejected with
 * settings_field_not_allowed.
 */
export const manageSettingsPatchFields: Record<string, boolean> = {
  defaultProvider: true,
  defaultModel: true,
  defaultMode: true,
  thinkingLevel: true,
  providerKey: true,
  providerBaseUrl: true,
  sandboxEnabled: true,
  webSearchEnabled: true,
};

/** The thinking vocabulary this ACP process exposes. */
export const manageAllowedThinkingLevels: Record<string, boolean> = {
  [thinkingOff]: true,
  [thinkingMinimal]: true,
  [thinkingLow]: true,
  [thinkingMedium]: true,
  [thinkingHigh]: true,
  [thinkingXHigh]: true,
  [thinkingMax]: true,
};

/** Projects one provider's masked key, or null when none is configured. */
export function manageMaskedKey(
  settings: Settings,
  providerName: string,
): string | null {
  const resolved = resolveKey(settings, providerName);
  if (!manageSecretUsable(resolved)) return null;
  return manageMaskSecret(resolved);
}

/** Deep-clones a nested value without alarming the linter about `any`. */
function manageClonePlain<T>(value: T): T {
  return structuredClone(value);
}

/** Projects one model config with Go's `omitempty` semantics. */
function manageProjectModelConfig(m: ModelConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { id: m.id, name: m.name };
  if (m.reasoning) out.reasoning = true;
  if (m.contextWindow) out.contextWindow = m.contextWindow;
  if (m.maxTokens) out.maxTokens = m.maxTokens;
  if (m.temperature !== undefined && m.temperature !== null) {
    out.temperature = m.temperature;
  }
  if (m.top_p !== undefined && m.top_p !== null) out.top_p = m.top_p;
  if (m.cost !== undefined && m.cost !== null) {
    out.cost = manageClonePlain(m.cost);
  }
  if (m.input !== undefined && m.input.length > 0) out.input = [...m.input];
  if (m.compat !== undefined && m.compat !== null) {
    out.compat = manageClonePlain(m.compat);
  }
  return out;
}

/**
 * The editable, non-secret part of one provider configuration. Keys are
 * projected only as a mask; headers and response metadata are omitted until
 * they receive a dedicated redacted management contract.
 */
export function manageProjectProviderConfig(
  pc: ProviderConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (pc.vendor) out.vendor = pc.vendor;
  if (pc.baseUrl) out.baseUrl = pc.baseUrl;
  if (pc.httpProxy) out.httpProxy = pc.httpProxy;
  if (pc.forceHTTP11) out.forceHTTP11 = true;
  if (pc.api) out.api = pc.api;
  if (pc.thinkingFormat) out.thinkingFormat = pc.thinkingFormat;
  if (pc.cacheControl !== undefined && pc.cacheControl !== null) {
    out.cacheControl = pc.cacheControl;
  }
  if (pc.maxImagesPerRequest) out.maxImagesPerRequest = pc.maxImagesPerRequest;
  // Go sets Responses to the zero struct, which marshals as `{}`.
  out.responses = pc.responses !== undefined &&
      Object.keys(pc.responses).length > 0
    ? manageClonePlain(pc.responses)
    : {};
  out.models = (pc.models ?? []).map(manageProjectModelConfig);
  return out;
}

interface ManageProviderView {
  name: string;
  maskedKey: string | null;
  baseUrl?: string;
  modelCount: number;
  apiKeyConfigured: boolean;
  isDefault?: boolean;
}

/** Projects the configured provider list with masked keys. */
export function manageProviderViews(settings: Settings): ManageProviderView[] {
  const ids = Object.keys(settings.providers ?? {});
  sortProviderIDs(ids);
  return ids.map((id) => {
    const baseUrl = resolveProviderConfig(id, settings).baseUrl ?? "";
    const masked = manageMaskedKey(settings, id);
    const view: ManageProviderView = {
      name: id,
      maskedKey: masked,
      modelCount: resolvedModels(settings, id).length,
      apiKeyConfigured: masked !== null,
    };
    if (baseUrl !== "") view.baseUrl = baseUrl;
    if (id === settings.defaultProvider) view.isDefault = true;
    return view;
  });
}

interface ManageProviderConfigView {
  id: string;
  provider: Record<string, unknown>;
  maskedKey: string | null;
  apiKeyConfigured: boolean;
  isDefault?: boolean;
  globalOverride?: boolean;
}

/**
 * Projects the factory-effective config of every provider without ever
 * serializing a credential. The raw global key map is used only to mark
 * whether a reset/delete operation is meaningful.
 */
export function manageProviderConfigs(
  settings: Settings,
): ManageProviderConfigView[] {
  const raw = manageRawGlobalSettings();
  let globalProviders: Record<string, unknown> = {};
  const providersRaw = raw["providers"];
  if (providersRaw !== undefined && providersRaw !== null) {
    if (typeof providersRaw !== "object" || Array.isArray(providersRaw)) {
      throw new Error("parse settings providers: value must be an object");
    }
    globalProviders = providersRaw as Record<string, unknown>;
  }
  const ids = Object.keys(settings.providers ?? {});
  sortProviderIDs(ids);
  const views: ManageProviderConfigView[] = [];
  for (const id of ids) {
    const resolved = resolveProviderConfig(id, settings);
    if (resolved === null || resolved === undefined) continue;
    const masked = manageMaskedKey(settings, id);
    const view: ManageProviderConfigView = {
      id,
      provider: manageProjectProviderConfig(resolved),
      maskedKey: masked,
      apiKeyConfigured: masked !== null,
    };
    if (id === settings.defaultProvider) view.isDefault = true;
    if (Object.prototype.hasOwnProperty.call(globalProviders, id)) {
      view.globalOverride = true;
    }
    views.push(view);
  }
  return views;
}

/** Assembles the settings view model shared by settings/get and settings/patch. */
export function manageSettingsView(
  settings: Settings,
): Record<string, unknown> {
  let defaultMode = (settings.defaultMode ?? "").trim();
  if (defaultMode === "") defaultMode = ModeYolo;
  const disabled = skillsDisabled(settings) ?? [];
  return {
    defaultProvider: settings.defaultProvider ?? "",
    defaultModel: settings.defaultModel ?? "",
    defaultMode,
    thinkingLevel: settings.defaultThinkingLevel ?? "",
    providers: manageProviderViews(settings),
    sandboxEnabled: settings.sandbox?.enabled ?? false,
    sandboxLevel: settings.sandbox?.level ?? "",
    webSearchEnabled: isWebSearchEnabled(settings),
    skillsDisabled: [...disabled],
    memoryEnabled: serveMemoryEnabled(),
  };
}

function handleManageSettingsGet(s: AcpServer, req: ACPRPCRequest): void {
  let view: Record<string, unknown>;
  try {
    view = manageSettingsView(manageSettings());
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
  s.writeResponse(req.idRaw, view, null);
}

/**
 * Applies a strict-whitelist patch to the global settings file through
 * `config.saveGlobalSettingsPatch`. Nested objects are merged at the object
 * level so sibling and unknown fields survive untouched.
 */
function handleManageSettingsPatch(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const params = req.params;
    if (
      params === undefined || params === null || typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one allowed field is required",
        null,
      );
    }
    const patch = (params as Record<string, unknown>)["patch"];
    if (
      patch === undefined || patch === null || typeof patch !== "object" ||
      Array.isArray(patch)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one allowed field is required",
        null,
      );
    }
    const envelopeRecord = patch as Record<string, unknown>;
    if (Object.keys(envelopeRecord).length === 0) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one allowed field is required",
        null,
      );
    }

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

    const fields = Object.keys(envelopeRecord).sort();
    const allowedList = Object.keys(manageSettingsPatchFields).sort();
    for (const field of fields) {
      if (!manageSettingsPatchFields[field]) {
        throw acpStructuredRPCError(
          -32602,
          "settings_field_not_allowed",
          `settings field ${
            JSON.stringify(field)
          } is not writable through mothx/manage/settings/patch`,
          { field, allowed: allowedList },
        );
      }
    }

    const invalid = (field: string, message: string): RPCError =>
      acpStructuredRPCError(
        -32602,
        "settings_field_invalid",
        `field ${field}: ${message}`,
        { field },
      );

    const raw = manageRawGlobalSettings();
    const updates: Record<string, unknown> = {};
    let providersTouched = false;

    for (const field of fields) {
      const value = envelopeRecord[field];
      switch (field) {
        case "defaultProvider": {
          const text = decodeOptionalStringOrInvalid(field, value, invalid);
          const trimmed = text.trim();
          if (trimmed === "") {
            throw invalid(field, "a non-empty provider name is required");
          }
          if (
            getProviderConfig(settings, trimmed) === undefined &&
            defaultProviderConfig(trimmed) === undefined
          ) {
            throw invalid(field, `unknown provider ${JSON.stringify(trimmed)}`);
          }
          updates["defaultProvider"] = trimmed;
          break;
        }
        case "defaultModel": {
          const text = decodeOptionalStringOrInvalid(field, value, invalid);
          if (text.trim() === "") {
            throw invalid(field, "a non-empty model id is required");
          }
          updates["defaultModel"] = text.trim();
          break;
        }
        case "defaultMode": {
          const text = decodeOptionalStringOrInvalid(field, value, invalid);
          if (!manageAllowedModes[text.trim()]) {
            throw invalid(field, "mode must be one of agent, plan, yolo, os");
          }
          updates["defaultMode"] = text.trim();
          break;
        }
        case "thinkingLevel": {
          const text = decodeOptionalStringOrInvalid(field, value, invalid);
          if (!manageAllowedThinkingLevels[text.trim()]) {
            throw invalid(
              field,
              "thinkingLevel must be one of off, minimal, low, medium, high, xhigh, max",
            );
          }
          updates["defaultThinkingLevel"] = text.trim();
          break;
        }
        case "providerKey":
        case "providerBaseUrl": {
          const entry = manageDecodeProviderCredential(value);
          if (entry === null || entry.name.trim() === "") {
            throw invalid(
              field,
              "an object with a non-empty provider name is required",
            );
          }
          const name = entry.name.trim();
          if (
            getProviderConfig(settings, name) === undefined &&
            defaultProviderConfig(name) === undefined
          ) {
            throw invalid(field, `unknown provider ${JSON.stringify(name)}`);
          }
          const target = field === "providerBaseUrl" ? "baseUrl" : "apiKey";
          const replacement = field === "providerBaseUrl"
            ? entry.url
            : entry.key;
          if (replacement === undefined) {
            throw invalid(
              field,
              `${field} requires a ${target} value (use an empty string to clear)`,
            );
          }
          try {
            manageMergeRawObject(raw, "providers", (providers) => {
              const existing = providers[name];
              let entryRaw: Record<string, unknown> = {};
              if (existing !== undefined && existing !== null) {
                if (typeof existing !== "object" || Array.isArray(existing)) {
                  throw new Error(
                    `parse provider ${name}: value must be an object`,
                  );
                }
                entryRaw = { ...(existing as Record<string, unknown>) };
              }
              entryRaw[target] = field === "providerBaseUrl"
                ? replacement.trim()
                : replacement;
              providers[name] = entryRaw;
            });
          } catch (err) {
            throw acpStructuredRPCError(
              -32000,
              "settings_unavailable",
              errorMessage(err),
              null,
            );
          }
          providersTouched = true;
          break;
        }
        case "sandboxEnabled":
        case "webSearchEnabled": {
          const enabled = decodeOptionalBoolOrInvalid(field, value, invalid);
          const key = field === "webSearchEnabled" ? "webSearch" : "sandbox";
          try {
            manageMergeRawObject(raw, key, (object) => {
              object["enabled"] = enabled;
            });
          } catch (err) {
            throw acpStructuredRPCError(
              -32000,
              "settings_unavailable",
              errorMessage(err),
              null,
            );
          }
          updates[key] = raw[key];
          break;
        }
        default:
          break;
      }
    }
    if (providersTouched) updates["providers"] = raw["providers"];
    try {
      saveGlobalSettingsPatch(updates);
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_save_failed",
        manageRedactSecrets(errorMessage(err), settings),
        null,
      );
    }

    let view: Record<string, unknown>;
    try {
      view = manageSettingsView(manageSettings());
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }
    s.writeResponse(req.idRaw, view, null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

function decodeOptionalStringOrInvalid(
  field: string,
  value: unknown,
  invalid: (field: string, message: string) => RPCError,
): string {
  if (typeof value !== "string") {
    throw invalid(field, "a string value is required");
  }
  return value;
}

function decodeOptionalBoolOrInvalid(
  field: string,
  value: unknown,
  invalid: (field: string, message: string) => RPCError,
): boolean {
  if (typeof value !== "boolean") {
    throw invalid(field, "a boolean value is required");
  }
  return value;
}

interface ManageProviderCredential {
  name: string;
  key?: string;
  url?: string;
}

function manageDecodeProviderCredential(
  value: unknown,
): ManageProviderCredential | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["name"] !== "string") return null;
  const out: ManageProviderCredential = { name: record["name"] };
  if (Object.prototype.hasOwnProperty.call(record, "key")) {
    if (typeof record["key"] !== "string") return null;
    out.key = record["key"];
  }
  if (Object.prototype.hasOwnProperty.call(record, "url")) {
    if (typeof record["url"] !== "string") return null;
    out.url = record["url"];
  }
  return out;
}

// ─── §6.1 providers (manage.go) ───────────────────────────────────────────────

const manageProviderWritableFields: Record<string, boolean> = {
  vendor: true,
  baseUrl: true,
  httpProxy: true,
  forceHTTP11: true,
  headers: true,
  api: true,
  thinkingFormat: true,
  cacheControl: true,
  maxImagesPerRequest: true,
  responses: true,
  models: true,
};

interface ManageProviderDraft {
  draft: ProviderConfig;
  fields: Record<string, unknown>;
}

/**
 * Validates the schema supplied by a management client. It uses the canonical
 * settings shape while preserving unknown fields already present in
 * settings.json on save.
 */
function manageDecodeProviderDraft(raw: unknown): ManageProviderDraft {
  const fields = manageDecodeWhitelist(
    raw,
    manageProviderWritableFields,
    "provider_field_not_allowed",
  );
  const stringField = (name: string): void => {
    if (fields[name] !== undefined && typeof fields[name] !== "string") {
      throw acpStructuredRPCError(
        -32602,
        "provider_field_invalid",
        `field ${name} must be a string`,
        { field: name },
      );
    }
  };
  const boolField = (name: string): void => {
    if (fields[name] !== undefined && typeof fields[name] !== "boolean") {
      throw acpStructuredRPCError(
        -32602,
        "provider_field_invalid",
        `field ${name} must be a boolean`,
        { field: name },
      );
    }
  };
  const objectField = (name: string): void => {
    const value = fields[name];
    if (
      value !== undefined &&
      (value === null || typeof value !== "object" || Array.isArray(value))
    ) {
      throw acpStructuredRPCError(
        -32602,
        "provider_field_invalid",
        `field ${name} must be an object`,
        { field: name },
      );
    }
  };
  for (
    const name of [
      "vendor",
      "baseUrl",
      "httpProxy",
      "api",
      "thinkingFormat",
    ]
  ) {
    stringField(name);
  }
  for (const name of ["forceHTTP11", "cacheControl"]) boolField(name);
  if (
    fields["maxImagesPerRequest"] !== undefined &&
    typeof fields["maxImagesPerRequest"] !== "number"
  ) {
    throw acpStructuredRPCError(
      -32602,
      "provider_field_invalid",
      "field maxImagesPerRequest must be a number",
      { field: "maxImagesPerRequest" },
    );
  }
  objectField("headers");
  objectField("responses");

  const seenModels = new Set<string>();
  const models = fields["models"];
  if (models !== undefined) {
    if (!Array.isArray(models)) {
      throw acpStructuredRPCError(
        -32602,
        "provider_field_invalid",
        "field models must be an array",
        { field: "models" },
      );
    }
    for (const model of models) {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        throw acpStructuredRPCError(
          -32602,
          "provider_field_invalid",
          "each model must be an object",
          { field: "models" },
        );
      }
      const id = (model as Record<string, unknown>)["id"];
      if (typeof id !== "string" || id.trim() === "") {
        throw acpStructuredRPCError(
          -32602,
          "provider_field_invalid",
          "model id is required",
          { field: "models" },
        );
      }
      const trimmed = id.trim();
      if (seenModels.has(trimmed)) {
        throw acpStructuredRPCError(
          -32602,
          "provider_field_invalid",
          `duplicate model id ${JSON.stringify(trimmed)}`,
          { field: "models" },
        );
      }
      seenModels.add(trimmed);
    }
  }
  return { draft: fields as unknown as ProviderConfig, fields };
}

/** Projects the factory-resolvable provider list plus the shared model catalog. */
export function manageProvidersCatalog(
  settings: Settings,
): Record<string, unknown> {
  const views = manageProviderViews(settings);
  const configs = manageProviderConfigs(settings);
  const models: Record<string, unknown>[] = [];
  for (const view of views) {
    for (const model of resolvedModels(settings, view.name)) {
      if (model === null || model === undefined) continue;
      models.push({
        id: model.id,
        name: model.name,
        provider: view.name,
        input: [...(model.input ?? [])],
        reasoning: model.reasoning,
      });
    }
  }
  return {
    providers: views,
    providerConfigs: configs,
    models,
    defaultProvider: settings.defaultProvider ?? "",
    defaultModel: settings.defaultModel ?? "",
  };
}

function handleManageProvidersList(s: AcpServer, req: ACPRPCRequest): void {
  let catalog: Record<string, unknown>;
  try {
    catalog = manageProvidersCatalog(manageSettings());
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
  s.writeResponse(req.idRaw, catalog, null);
}

/**
 * Creates or updates one global provider overlay through
 * `SaveGlobalSettingsPatch` so unrelated global settings remain sparse and
 * unknown provider fields survive an edit.
 */
function handleManageProvidersSave(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const params = req.params;
    if (
      params === undefined || params === null || typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "id and provider are required",
        null,
      );
    }
    const record = params as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    const previousID = typeof record["previousId"] === "string"
      ? record["previousId"].trim()
      : "";
    const providerRaw = record["provider"];
    if (
      id === "" || providerRaw === undefined || providerRaw === null ||
      typeof providerRaw !== "object" || Array.isArray(providerRaw) ||
      Object.keys(providerRaw as Record<string, unknown>).length === 0
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "id and provider are required",
        null,
      );
    }
    if (id.includes("/")) {
      throw acpStructuredRPCError(
        -32602,
        "provider_field_invalid",
        "provider id must not contain '/'",
        { field: "id" },
      );
    }
    const { fields } = manageDecodeProviderDraft(providerRaw);

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
    const raw = manageRawGlobalSettings();
    const sourceID = previousID === "" ? id : previousID;
    if (
      sourceID !== id &&
      getProviderConfig(settings, sourceID) === undefined &&
      defaultProviderConfig(sourceID) === undefined
    ) {
      throw acpStructuredRPCError(
        -32602,
        "provider_not_found",
        `provider ${JSON.stringify(sourceID)} is not configured`,
        null,
      );
    }
    let apiKey: string | undefined;
    if (Object.prototype.hasOwnProperty.call(record, "apiKey")) {
      if (typeof record["apiKey"] !== "string") {
        throw acpStructuredRPCError(
          -32602,
          "invalid_params",
          "apiKey must be a string",
          null,
        );
      }
      apiKey = record["apiKey"];
    }
    try {
      manageMergeRawObject(raw, "providers", (providers) => {
        if (sourceID !== id) {
          if (!Object.prototype.hasOwnProperty.call(providers, sourceID)) {
            throw new Error("only a global provider override can be renamed");
          }
          if (Object.prototype.hasOwnProperty.call(providers, id)) {
            throw new Error(
              `provider ${
                JSON.stringify(id)
              } already exists in global settings`,
            );
          }
        }
        const existing = providers[sourceID];
        let entry: Record<string, unknown> = {};
        if (existing !== undefined && existing !== null) {
          if (typeof existing !== "object" || Array.isArray(existing)) {
            throw new Error(
              `parse provider ${sourceID}: value must be an object`,
            );
          }
          entry = { ...(existing as Record<string, unknown>) };
        }
        for (const key of Object.keys(fields)) delete entry[key];
        for (const [key, value] of Object.entries(fields)) {
          entry[key] = value;
        }
        if (apiKey !== undefined) entry["apiKey"] = apiKey;
        providers[id] = entry;
        if (sourceID !== id) delete providers[sourceID];
      });
    } catch (err) {
      throw acpStructuredRPCError(
        -32602,
        "provider_save_failed",
        errorMessage(err),
        null,
      );
    }
    const updates: Record<string, unknown> = {
      providers: raw["providers"],
    };
    if (sourceID !== id && settings.defaultProvider === sourceID) {
      updates["defaultProvider"] = id;
    }
    try {
      saveGlobalSettingsPatch(updates);
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_save_failed",
        manageRedactSecrets(errorMessage(err), settings),
        null,
      );
    }
    let catalog: Record<string, unknown>;
    try {
      catalog = manageProvidersCatalog(manageSettings());
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }
    s.writeResponse(req.idRaw, catalog, null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

/** Removes a global provider overlay, resetting presets or deleting customs. */
function handleManageProvidersDelete(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const params = req.params;
    const id = params !== null && params !== undefined &&
        typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)["id"]
      : undefined;
    const name = typeof id === "string" ? id.trim() : "";
    if (name === "") {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "provider id is required",
        null,
      );
    }
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
    if (settings.defaultProvider === name) {
      throw acpStructuredRPCError(
        -32602,
        "provider_default_in_use",
        "choose another default provider before deleting this one",
        null,
      );
    }
    const raw = manageRawGlobalSettings();
    let found = false;
    try {
      manageMergeRawObject(raw, "providers", (providers) => {
        if (!Object.prototype.hasOwnProperty.call(providers, name)) return;
        delete providers[name];
        found = true;
      });
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }
    if (!found) {
      throw acpStructuredRPCError(
        -32602,
        "provider_not_custom",
        `provider ${JSON.stringify(name)} has no global override to delete`,
        null,
      );
    }
    try {
      saveGlobalSettingsPatch({ providers: raw["providers"] });
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_save_failed",
        manageRedactSecrets(errorMessage(err), settings),
        null,
      );
    }
    let catalog: Record<string, unknown>;
    try {
      catalog = manageProvidersCatalog(manageSettings());
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "settings_unavailable",
        errorMessage(err),
        null,
      );
    }
    s.writeResponse(req.idRaw, catalog, null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

/** Projects one discovered model with Go's `omitempty` semantics. */
function manageProjectDiscoveredModel(
  model: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: model["id"] };
  if (model["name"]) out.name = model["name"];
  if (model["contextWindow"]) out.contextWindow = model["contextWindow"];
  if (model["maxTokens"]) out.maxTokens = model["maxTokens"];
  const input = model["input"];
  if (Array.isArray(input) && input.length > 0) out.input = input;
  if (model["reasoning"]) out.reasoning = true;
  return out;
}

/** Provider-owned model discovery; results are drafts until saved. */
async function handleManageProvidersDiscover(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const params = req.params;
    const record = params !== null && params !== undefined &&
        typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
    const api = typeof record["api"] === "string" ? record["api"].trim() : "";
    const baseUrl = typeof record["baseUrl"] === "string"
      ? record["baseUrl"].trim()
      : "";
    if (api === "" || baseUrl === "") {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "api and baseUrl are required",
        null,
      );
    }
    const apiKey = typeof record["apiKey"] === "string" ? record["apiKey"] : "";
    const httpProxy = typeof record["httpProxy"] === "string"
      ? record["httpProxy"]
      : "";
    const forceHTTP11 = record["forceHTTP11"] === true;
    const headers =
      record["headers"] !== undefined && record["headers"] !== null &&
        typeof record["headers"] === "object" &&
        !Array.isArray(record["headers"])
        ? record["headers"] as Record<string, string>
        : undefined;
    let models: Record<string, unknown>[];
    try {
      const discovered = await discoverModels(AbortSignal.timeout(30_000), {
        api,
        baseUrl,
        apiKey,
        httpProxy,
        forceHTTP11,
        headers,
      });
      models = discovered.map((m) =>
        manageProjectDiscoveredModel(m as unknown as Record<string, unknown>)
      );
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "provider_discovery_failed",
        errorMessage(err),
        null,
      );
    }
    s.writeResponse(req.idRaw, { models }, null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

/** One minimal (1-token, bounded) provider ping through the shared factory. */
async function handleManageProvidersTest(
  s: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  try {
    const params = req.params;
    const record = params !== null && params !== undefined &&
        typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
    const providerName = typeof record["provider"] === "string"
      ? record["provider"].trim()
      : "";
    if (providerName === "") {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "provider is required",
        null,
      );
    }
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
    const providerID = providerName;
    if (
      getProviderConfig(settings, providerID) === undefined &&
      defaultProviderConfig(providerID) === undefined
    ) {
      throw acpStructuredRPCError(
        -32000,
        "provider_not_found",
        `provider ${JSON.stringify(providerID)} is not configured`,
        null,
      );
    }
    let modelID = typeof record["model"] === "string"
      ? record["model"].trim()
      : "";
    if (modelID === "" && providerID === settings.defaultProvider) {
      modelID = settings.defaultModel ?? "";
    }
    let p;
    let selectedModel;
    try {
      const created = createFactoryProvider(settings, providerID, modelID);
      p = created.provider;
      selectedModel = created.model;
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "provider_test_failed",
        manageRedactSecrets(`create provider: ${errorMessage(err)}`, settings),
        null,
      );
    }
    const targetModel = selectedModel?.id ?? modelID;
    const started = Date.now();
    try {
      for await (
        const event of p.chat({
          modelId: targetModel,
          thinkingLevel: thinkingOff as ThinkingLevel,
          maxTokens: 1,
          systemPrompt: "",
          messages: [{
            role: "user",
            content: "ping",
            timestamp: new Date(),
          }],
          abort: AbortSignal.timeout(5_000),
        })
      ) {
        if (event.type === streamErrorType) {
          const message = event.error !== undefined && event.error !== null
            ? String(event.error)
            : "model request failed";
          s.writeResponse(req.idRaw, {
            ok: false,
            provider: providerID,
            model: targetModel,
            error: manageRedactSecrets(message, settings),
          }, null);
          return;
        }
        if (event.type === streamDoneType) {
          s.writeResponse(req.idRaw, {
            ok: true,
            provider: providerID,
            model: targetModel,
            latencyMs: Date.now() - started,
          }, null);
          return;
        }
      }
    } catch (err) {
      s.writeResponse(req.idRaw, {
        ok: false,
        provider: providerID,
        model: targetModel,
        error: manageRedactSecrets(errorMessage(err), settings),
      }, null);
      return;
    }
    s.writeResponse(req.idRaw, {
      ok: false,
      provider: providerID,
      model: targetModel,
      error: "model request ended without a completion",
    }, null);
  } catch (err) {
    writeManageError(s, req, err);
  }
}

// ─── §6.1 skills (manage.go) ───────────────────────────────────────────────────

interface ManageSkillsRequest {
  cwd: string;
  name: string;
  enabled?: boolean;
}

function manageDecodeSkillsRequest(
  params: unknown,
): ManageSkillsRequest | null {
  const request: ManageSkillsRequest = { cwd: "", name: "" };
  if (params === undefined || params === null) return request;
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  if (typeof record["cwd"] === "string") request.cwd = record["cwd"];
  if (typeof record["name"] === "string") request.name = record["name"];
  if (record["enabled"] !== undefined && record["enabled"] !== null) {
    if (typeof record["enabled"] !== "boolean") return null;
    request.enabled = record["enabled"];
  }
  return request;
}

/**
 * Builds the skills discovery manager for one cwd through the same constructor
 * and directory precedence the agent runtime uses.
 */
function manageSkillsManager(
  s: AcpServer,
  cwdInput: string,
): { manager: SkillsManager; cwd: string } {
  let cwd = cwdInput.trim();
  if (cwd === "") cwd = manageWorkDir(s);
  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }
  const settings = manageSettings();
  const manager = newManagerWithProjectDirs(
    getGlobalSkillsDir(settings),
    projectSkillDirs(cwd),
  );
  manager.load();
  return { manager, cwd };
}

function handleManageSkillsList(s: AcpServer, req: ACPRPCRequest): void {
  const input = manageDecodeSkillsRequest(req.params);
  if (input === null) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(-32602, "invalid_params", "invalid params", null),
    );
    return;
  }
  let manager: SkillsManager;
  let cwd: string;
  try {
    ({ manager, cwd } = manageSkillsManager(s, input.cwd));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "skills_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  const items = manager.listAll().map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: !manager.isSkillDisabled(skill.name),
  }));
  s.writeResponse(req.idRaw, { cwd, skills: items }, null);
}

/**
 * Toggles one skill through the global settings.skills.disabled list — the
 * single enable/disable source every skills.Manager load consults — and
 * live-applies the new list to this process's runtime skills manager.
 */
function handleManageSkillsSet(s: AcpServer, req: ACPRPCRequest): void {
  const input = manageDecodeSkillsRequest(req.params);
  if (
    input === null || input.name.trim() === "" || input.enabled === undefined
  ) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "name and enabled are required",
        null,
      ),
    );
    return;
  }
  const name = input.name.trim();
  const enabled = input.enabled;
  let manager: SkillsManager;
  try {
    ({ manager } = manageSkillsManager(s, input.cwd));
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "skills_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  if (!manager.listAll().some((skill) => skill.name === name)) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "skill_not_found",
        `skill ${JSON.stringify(name)} is not available`,
        null,
      ),
    );
    return;
  }
  let raw: Record<string, unknown>;
  try {
    raw = manageRawGlobalSettings();
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
  let currentDisabled: string[] = [];
  const existing = raw["skills"];
  if (existing !== undefined && existing !== null) {
    const invalid = () => {
      s.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "settings_unavailable",
          "parse skills settings",
          null,
        ),
      );
    };
    if (typeof existing !== "object" || Array.isArray(existing)) {
      invalid();
      return;
    }
    const disabled = (existing as Record<string, unknown>)["disabled"];
    if (disabled !== undefined && disabled !== null) {
      if (
        !Array.isArray(disabled) ||
        disabled.some((value) => typeof value !== "string")
      ) {
        invalid();
        return;
      }
      currentDisabled = disabled as string[];
    }
  }
  const next: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) return;
    seen.add(trimmed);
    next.push(trimmed);
  };
  for (const value of currentDisabled) {
    if (enabled && value === name) continue;
    add(value);
  }
  if (!enabled) add(name);
  next.sort();
  const updates: Record<string, unknown> = {};
  if (next.length === 0) {
    // Keep sparse settings sparse: drop the section entirely.
    updates["skills"] = null;
  } else {
    updates["skills"] = { disabled: next };
  }
  try {
    saveGlobalSettingsPatch(updates);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "settings_save_failed",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  // Live-apply to this process's runtime manager so the toggle takes effect
  // without a restart; other processes pick it up on their next skills load.
  if (s.skillsMgr !== null) s.skillsMgr.setDisabledSkills(next);
  s.writeResponse(
    req.idRaw,
    { name, enabled, skillsDisabled: next },
    null,
  );
}

// ─── §6.1 mcp (manage.go) ──────────────────────────────────────────────────────

/** Projects the complete local mcp.json schema. */
function manageMCPViews(cfg: MCPConfig): Record<string, unknown>[] {
  const views: Record<string, unknown>[] = [];
  for (const srv of cfg.mcpServers ?? []) {
    const view: Record<string, unknown> = {
      name: srv.name,
      type: srv.type ?? "",
      enabled: mcpServerEnabled(srv),
    };
    if ((srv.command ?? "") !== "") view["command"] = srv.command;
    if (srv.args && srv.args.length > 0) view["args"] = [...srv.args];
    if ((srv.url ?? "") !== "") view["url"] = srv.url;
    if ((srv.messageUrl ?? "") !== "") view["messageUrl"] = srv.messageUrl;
    if (srv.env && srv.env.length > 0) {
      view["env"] = srv.env.map((kv) => ({ name: kv.name, value: kv.value }));
    }
    if (srv.headers && srv.headers.length > 0) {
      view["headers"] = srv.headers.map((kv) => ({
        name: kv.name,
        value: kv.value,
      }));
    }
    views.push(view);
  }
  return views;
}

interface ManageMCPTarget {
  scope: string;
  sessionID: string;
  path: string;
}

function resolveManageMCPTarget(
  s: AcpServer,
  scopeInput: string,
  sessionIDInput: string,
): ManageMCPTarget {
  let scope = scopeInput.trim();
  if (scope === "") scope = "global";
  if (scope === "global") {
    return { scope, sessionID: "", path: globalMCPPath() };
  }
  if (scope === "project") {
    const sessionID = sessionIDInput.trim();
    if (sessionID === "") {
      throw new Error("project MCP management requires sessionId");
    }
    const rt = s.sessionRuntime(sessionID);
    const workDir = rt?.runtime?.workDir ?? "";
    if (rt === null || rt.runtime === null || workDir.trim() === "") {
      throw new Error(`session ${JSON.stringify(sessionID)} is not active`);
    }
    return {
      scope,
      sessionID,
      path: path.join(workDir, projectMCPPath()),
    };
  }
  throw new Error("MCP scope must be global or project");
}

function manageMCPConfigAtPath(p: string): MCPConfig {
  let cfg: MCPConfig;
  try {
    cfg = loadMCPConfig(p);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
  if (cfg === null || cfg === undefined) cfg = {};
  normalizeMCPConfig(cfg);
  return cfg;
}

function handleManageMCPList(s: AcpServer, req: ACPRPCRequest): void {
  let scope = "";
  let sessionID = "";
  const params = req.params;
  if (params !== undefined && params !== null) {
    if (typeof params !== "object" || Array.isArray(params)) {
      s.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "invalid_params",
          "invalid MCP scope parameters",
          null,
        ),
      );
      return;
    }
    const record = params as Record<string, unknown>;
    if (typeof record["scope"] === "string") scope = record["scope"];
    if (typeof record["sessionId"] === "string") {
      sessionID = record["sessionId"];
    }
  }
  let target: ManageMCPTarget;
  try {
    target = resolveManageMCPTarget(s, scope, sessionID);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "mcp_scope_invalid",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  let cfg: MCPConfig;
  try {
    cfg = manageMCPConfigAtPath(target.path);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "mcp_unavailable",
        `load MCP config: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  s.writeResponse(
    req.idRaw,
    {
      scope: target.scope,
      sessionId: target.sessionID,
      path: target.path,
      servers: manageMCPViews(cfg),
    },
    null,
  );
}

/** The mcp/set whitelist. */
const manageMCPServerFields: Record<string, boolean> = {
  name: true,
  type: true,
  command: true,
  args: true,
  url: true,
  messageUrl: true,
  enabled: true,
  headers: true,
  env: true,
};

const manageMCPServerTypes: Record<string, boolean> = {
  stdio: true,
  http: true,
  sse: true,
};

/**
 * Fully replaces the selected mcp.json server list from the complete
 * whitelisted input. Servers absent from the input are removed.
 */
function handleManageMCPSet(s: AcpServer, req: ACPRPCRequest): void {
  const invalidServer = (message: string): RPCError =>
    acpStructuredRPCError(-32602, "mcp_server_invalid", message, null);
  try {
    const params = req.params;
    if (
      params === undefined || params === null || typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "servers is required",
        null,
      );
    }
    const record = params as Record<string, unknown>;
    const serversRaw = record["servers"];
    if (!Array.isArray(serversRaw)) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "servers array is required",
        null,
      );
    }
    const scope = typeof record["scope"] === "string" ? record["scope"] : "";
    const sessionID = typeof record["sessionId"] === "string"
      ? record["sessionId"]
      : "";
    let target: ManageMCPTarget;
    try {
      target = resolveManageMCPTarget(s, scope, sessionID);
    } catch (err) {
      throw acpStructuredRPCError(
        -32602,
        "mcp_scope_invalid",
        errorMessage(err),
        null,
      );
    }
    let existing: MCPConfig;
    try {
      existing = manageMCPConfigAtPath(target.path);
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "mcp_unavailable",
        `load MCP config: ${errorMessage(err)}`,
        null,
      );
    }
    const byName = new Map<string, MCPServer>();
    for (const srv of existing.mcpServers ?? []) byName.set(srv.name, srv);
    const next: MCPServer[] = [];
    const seen = new Set<string>();
    for (const rawEntry of serversRaw) {
      if (
        rawEntry === null || typeof rawEntry !== "object" ||
        Array.isArray(rawEntry)
      ) {
        throw invalidServer("each server entry must be a JSON object");
      }
      const fields = rawEntry as Record<string, unknown>;
      let rejected = "";
      for (const field of Object.keys(fields)) {
        if (!manageMCPServerFields[field]) {
          if (rejected === "" || field < rejected) rejected = field;
        }
      }
      if (rejected !== "") {
        throw acpStructuredRPCError(
          -32602,
          "mcp_field_not_allowed",
          `MCP server field ${
            JSON.stringify(rejected)
          } is not writable through mothx/manage/mcp/set`,
          { field: rejected },
        );
      }
      if (typeof fields["name"] !== "string") {
        throw invalidServer("each server entry requires a non-empty name");
      }
      const name = (fields["name"] as string).trim();
      if (name === "") {
        throw invalidServer("each server entry requires a non-empty name");
      }
      if (seen.has(name)) {
        throw invalidServer(
          `duplicate MCP server name ${JSON.stringify(name)}`,
        );
      }
      seen.add(name);
      const base = byName.get(name) ?? { name };
      const entry: MCPServer = { ...base };
      entry.name = name;
      if (fields["type"] !== undefined) {
        if (typeof fields["type"] !== "string") {
          throw invalidServer(`server ${name}: type must be a string`);
        }
        const trimmed = (fields["type"] as string).trim();
        if (trimmed !== "" && !manageMCPServerTypes[trimmed]) {
          throw invalidServer(
            `server ${name}: type must be one of stdio, http, sse`,
          );
        }
        entry.type = trimmed;
      }
      for (const key of ["command", "url", "messageUrl"] as const) {
        const value = fields[key];
        if (value === undefined) continue;
        if (typeof value !== "string") {
          throw invalidServer(`server ${name}: ${key} must be a string`);
        }
        entry[key] = value.trim();
      }
      if (fields["args"] !== undefined) {
        const argsRaw = fields["args"];
        if (
          !Array.isArray(argsRaw) ||
          argsRaw.some((value) => typeof value !== "string")
        ) {
          throw invalidServer(
            `server ${name}: args must be an array of strings`,
          );
        }
        entry.args = argsRaw as string[];
      }
      for (const key of ["headers", "env"] as const) {
        const pairsRaw = fields[key];
        if (pairsRaw === undefined) continue;
        if (!Array.isArray(pairsRaw)) {
          throw invalidServer(
            `server ${name}: ${key} must be an array of name/value objects`,
          );
        }
        const pairs: { name: string; value: string }[] = [];
        for (const pair of pairsRaw) {
          if (
            pair === null || typeof pair !== "object" || Array.isArray(pair)
          ) {
            throw invalidServer(
              `server ${name}: ${key} must be an array of name/value objects`,
            );
          }
          const p = pair as Record<string, unknown>;
          if (typeof p["name"] !== "string" || typeof p["value"] !== "string") {
            throw invalidServer(
              `server ${name}: ${key} must be an array of name/value objects`,
            );
          }
          const pairName = (p["name"] as string).trim();
          if (pairName === "") {
            throw invalidServer(
              `server ${name}: ${key} entries require a non-empty name`,
            );
          }
          pairs.push({ name: pairName, value: p["value"] as string });
        }
        if (key === "headers") entry.headers = pairs;
        else entry.env = pairs;
      }
      if (fields["enabled"] !== undefined) {
        if (typeof fields["enabled"] !== "boolean") {
          throw invalidServer(`server ${name}: enabled must be a boolean`);
        }
        entry.enabled = fields["enabled"] as boolean;
      }
      next.push(entry);
    }
    const cfg: MCPConfig = { mcpServers: next };
    normalizeMCPConfig(cfg);
    for (const srv of cfg.mcpServers ?? []) {
      const type = srv.type ?? "stdio";
      if (type === "stdio") {
        if ((srv.command ?? "").trim() === "") {
          throw invalidServer(
            `server ${srv.name}: stdio transport requires a command`,
          );
        }
      } else if (type === "http" || type === "sse") {
        if ((srv.url ?? "").trim() === "") {
          throw invalidServer(
            `server ${srv.name}: ${type} transport requires a url`,
          );
        }
      }
    }
    try {
      saveMCPConfig(target.path, cfg);
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "mcp_unavailable",
        `save MCP config: ${errorMessage(err)}`,
        null,
      );
    }
    let saved: MCPConfig;
    try {
      saved = manageMCPConfigAtPath(target.path);
    } catch {
      saved = cfg;
    }
    s.writeResponse(
      req.idRaw,
      {
        scope: target.scope,
        sessionId: target.sessionID,
        path: target.path,
        servers: manageMCPViews(saved),
      },
      null,
    );
  } catch (err) {
    writeManageError(s, req, err);
  }
}

// ─── §6.1 stats (manage.go) ────────────────────────────────────────────────────

export interface ManageStatsRequest {
  from: string;
  to: string;
  group: string;
}

const manageStatsGroups: Record<string, boolean> = {
  day: true,
  "1h": true,
  week: true,
  month: true,
};
const manageStatsDefaultDays = 14;

function manageDecodeStatsRequest(params: unknown): ManageStatsRequest {
  const request: ManageStatsRequest = { from: "", to: "", group: "" };
  if (params === undefined || params === null) return request;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw acpStructuredRPCError(
      -32602,
      "invalid_params",
      "invalid params",
      null,
    );
  }
  const record = params as Record<string, unknown>;
  if (typeof record["from"] === "string") request.from = record["from"];
  if (typeof record["to"] === "string") request.to = record["to"];
  if (typeof record["group"] === "string") request.group = record["group"];
  return request;
}

/** Maps the request onto the shared stats.Query through the shared parser. */
export function manageStatsQuery(input: ManageStatsRequest): StatsQuery {
  const values = new URLSearchParams();
  const from = input.from.trim();
  const to = input.to.trim();
  if (from !== "") values.set("from", from);
  if (to !== "") values.set("to", to);
  let group = input.group.trim();
  if (group === "") group = "day";
  if (!manageStatsGroups[group]) {
    throw acpStructuredRPCError(
      -32602,
      "stats_group_invalid",
      `group ${JSON.stringify(group)} must be one of day, 1h, week, month`,
      null,
    );
  }
  values.set("groupBy", group);
  const query = parseStatsQueryParams(values);
  // ParseQueryParams only accepts YYYY-MM-DD; RFC3339 instants are an additive
  // convenience for protocol clients.
  if (from !== "" && query.from === undefined) {
    const parsed = manageParseRFC3339(from);
    if (parsed === null) {
      throw acpStructuredRPCError(
        -32602,
        "stats_time_invalid",
        "from must use YYYY-MM-DD or RFC3339",
        null,
      );
    }
    query.from = parsed;
  }
  if (to !== "" && query.to === undefined) {
    const parsed = manageParseRFC3339(to);
    if (parsed === null) {
      throw acpStructuredRPCError(
        -32602,
        "stats_time_invalid",
        "to must use YYYY-MM-DD or RFC3339",
        null,
      );
    }
    query.to = parsed;
  }
  return query;
}

function manageParseRFC3339(value: string): Date | null {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * Opens the shared sessions.db stats queries. The second result reports
 * whether the database exists; a missing database projects empty stats.
 */
function manageStatsDB(s: AcpServer): { db: StatsDB | null; exists: boolean } {
  if (s.settings === null) {
    throw new Error("ACP settings are unavailable");
  }
  const dbPath = path.join(getSessionDir(s.settings), "sessions.db");
  try {
    Deno.statSync(dbPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { db: null, exists: false };
    throw err;
  }
  return { db: StatsDB.open(dbPath), exists: true };
}

function handleManageStatsSummary(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const query = manageStatsQuery(manageDecodeStatsRequest(req.params));
    let sessionsCount = 0;
    if (s.settings !== null) {
      try {
        sessionsCount = listAllDetailed(getSessionDir(s.settings)).length;
      } catch {
        sessionsCount = 0;
      }
    }
    let summary: StatsSummary = {
      totalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const { db, exists } = manageStatsDB(s);
    if (exists && db !== null) {
      try {
        summary = db.summary(query);
      } finally {
        db.close();
      }
    }
    const result: Record<string, unknown> = {
      sessions: sessionsCount,
      runs: summary.totalRequests,
      tokens: {
        input: summary.inputTokens,
        output: summary.outputTokens,
        total: summary.totalTokens,
      },
      cost: 0.0,
    };
    if (query.from !== undefined) result["since"] = query.from.toISOString();
    if (query.to !== undefined) result["until"] = query.to.toISOString();
    s.writeResponse(req.idRaw, result, null);
  } catch (err) {
    if (err instanceof RPCError) {
      writeManageError(s, req, err);
      return;
    }
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "stats_unavailable",
        errorMessage(err),
        null,
      ),
    );
  }
}

function handleManageStatsTimeseries(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const query = manageStatsQuery(manageDecodeStatsRequest(req.params));
    if (query.from === undefined) {
      query.from = new Date(
        Date.now() - manageStatsDefaultDays * 24 * 60 * 60 * 1000,
      );
    }
    const points: Record<string, unknown>[] = [];
    const { db, exists } = manageStatsDB(s);
    if (exists && db !== null) {
      try {
        for (const aggregate of db.timeSeries(query)) {
          points.push({
            date: aggregate.label,
            runs: aggregate.requests,
            tokens: aggregate.totalTokens,
            cost: 0.0,
          });
        }
      } finally {
        db.close();
      }
    }
    const result: Record<string, unknown> = {
      group: query.groupBy ?? "day",
      points,
      from: query.from.toISOString(),
    };
    if (query.to !== undefined) result["to"] = query.to.toISOString();
    s.writeResponse(req.idRaw, result, null);
  } catch (err) {
    if (err instanceof RPCError) {
      writeManageError(s, req, err);
      return;
    }
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "stats_unavailable",
        errorMessage(err),
        null,
      ),
    );
  }
}

// ─── §6.1 memory (manage.go) ───────────────────────────────────────────────────

/** Caps one memory put payload (1MB). */
const manageMemoryMaxBytes = 1 << 20;

/**
 * Resolves memory.md through the same source as serve /api/memory: the serve
 * config's explicit memory path when configured, otherwise the global
 * ~/.mothx/memory.md.
 */
function manageMemoryStore(s: AcpServer): MemoryStore {
  let explicitPath = "";
  try {
    explicitPath = (loadServeConfig().memory.path ?? "").trim();
  } catch {
    explicitPath = "";
  }
  if (explicitPath === "") {
    explicitPath = path.join(configDir(), "memory.md");
  }
  return new MemoryStore(explicitPath, manageWorkDir(s));
}

function manageMemoryUpdatedAt(p: string): string {
  if (p.trim() === "") return "";
  try {
    return Deno.statSync(p).mtime?.toISOString() ?? "";
  } catch {
    return "";
  }
}

function manageContentByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

function handleManageMemoryGet(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const store = manageMemoryStore(s);
    const { content, path: memPath, source } = store.read();
    s.writeResponse(
      req.idRaw,
      {
        content,
        path: memPath,
        source,
        size: manageContentByteLength(content),
        updatedAt: manageMemoryUpdatedAt(memPath),
      },
      null,
    );
  } catch (err) {
    writeManageError(s, req, err);
  }
}

function handleManageMemoryPut(s: AcpServer, req: ACPRPCRequest): void {
  try {
    const params = req.params;
    if (
      params === undefined || params === null || typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "content is required",
        null,
      );
    }
    const content = (params as Record<string, unknown>)["content"];
    if (typeof content !== "string") {
      throw acpStructuredRPCError(
        -32602,
        "invalid_params",
        "content is required",
        null,
      );
    }
    const size = manageContentByteLength(content);
    if (size > manageMemoryMaxBytes) {
      throw acpStructuredRPCError(
        -32602,
        "memory_too_large",
        `memory content exceeds the ${manageMemoryMaxBytes} byte limit`,
        { size, maxBytes: manageMemoryMaxBytes },
      );
    }
    const store = manageMemoryStore(s);
    try {
      store.writeAll(content);
    } catch (err) {
      throw acpStructuredRPCError(
        -32000,
        "memory_unavailable",
        errorMessage(err),
        null,
      );
    }
    const read = store.read();
    s.writeResponse(
      req.idRaw,
      {
        size: manageContentByteLength(read.content),
        updatedAt: manageMemoryUpdatedAt(read.path),
        path: read.path,
        source: read.source,
      },
      null,
    );
  } catch (err) {
    writeManageError(s, req, err);
  }
}

// ─── §6.1 deliveries (manage.go) ──────────────────────────────────────────────

/**
 * Resolves the session database directory for the deliveries projection. The
 * negotiated server settings win; a direct fixture without settings falls back
 * to the global settings source.
 */
function manageDeliveriesSessionDir(s: AcpServer): string {
  const settings = s.settings;
  if (settings !== null && getSessionDir(settings).trim() !== "") {
    return getSessionDir(settings);
  }
  return getSessionDir(manageSettings());
}

function handleManageDeliveriesList(s: AcpServer, req: ACPRPCRequest): void {
  try {
    let sessionID = "";
    let limit = 0;
    const params = req.params;
    if (params !== undefined && params !== null) {
      if (typeof params !== "object" || Array.isArray(params)) {
        throw acpStructuredRPCError(
          -32602,
          "invalid_params",
          "params must be an object",
          null,
        );
      }
      const record = params as Record<string, unknown>;
      if (typeof record["sessionId"] === "string") {
        sessionID = record["sessionId"];
      }
      if (
        typeof record["limit"] === "number" && Number.isFinite(record["limit"])
      ) {
        limit = Math.trunc(record["limit"]);
      }
    }
    const sessionDir = manageDeliveriesSessionDir(s);
    const failures = listDeliveryFailures(sessionDir, sessionID, limit);
    const items = failures.map((failure) => ({
      operationId: failure.operationId,
      intentId: failure.intentId,
      sessionId: failure.sessionId,
      runId: failure.runId,
      platform: failure.platform,
      targetId: failure.targetId,
      operationKind: failure.operationKind,
      status: failure.status,
      failureCode: failure.failureCode,
      attemptCount: failure.attemptCount,
      updatedAt: failure.updatedAt.toISOString(),
      retryable: deliveryFailureRetryable(failure.failureCode),
    }));
    s.writeResponse(
      req.idRaw,
      { deliveries: items, count: items.length },
      null,
    );
  } catch (err) {
    if (err instanceof RPCError) {
      writeManageError(s, req, err);
      return;
    }
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "deliveries_unavailable",
        errorMessage(err),
        null,
      ),
    );
  }
}

function handleManageDeliveriesRetry(s: AcpServer, req: ACPRPCRequest): void {
  const params = req.params;
  const operationID = (params !== undefined && params !== null &&
      typeof params === "object" && !Array.isArray(params))
    ? ((params as Record<string, unknown>)["operationId"])
    : undefined;
  if (typeof operationID !== "string" || operationID.trim() === "") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "operationId is required",
        null,
      ),
    );
    return;
  }
  const id = operationID.trim();
  let sessionDir: string;
  try {
    sessionDir = manageDeliveriesSessionDir(s);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "manage_unavailable",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  let operation: { status: string; failureCode: string } | null;
  try {
    operation = getDeliveryOperation(sessionDir, id);
  } catch (err) {
    if (err === ErrDeliveryOperationAbsent) {
      s.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "delivery_not_found",
          `delivery operation ${id} does not exist`,
          null,
        ),
      );
      return;
    }
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "manage_unavailable",
        `delivery operation ${id} is not readable: ${errorMessage(err)}`,
        null,
      ),
    );
    return;
  }
  if (operation === null) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "delivery_not_found",
        `delivery operation ${id} does not exist`,
        null,
      ),
    );
    return;
  }
  if (operation.status !== "failed") {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "delivery_not_reopenable",
        `delivery operation ${id} is ${operation.status}, only a failed operation can be retried`,
        null,
      ),
    );
    return;
  }
  if (!deliveryFailureRetryable(operation.failureCode)) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "delivery_not_retryable",
        `delivery operation ${id} failed permanently (${operation.failureCode})`,
        null,
      ),
    );
    return;
  }
  let reopened: boolean;
  try {
    reopened = reopenFailedDeliveryOperation(sessionDir, id, new Date());
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "delivery_retry_failed",
        errorMessage(err),
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, { operationId: id, retried: reopened }, null);
}

// ─── reply helpers ────────────────────────────────────────────────────────────

/** Writes a thrown `RPCError` onto the wire; rethrows anything else. */
function writeManageError(
  s: AcpServer,
  req: ACPRPCRequest,
  err: unknown,
): void {
  if (err instanceof RPCError) {
    s.writeResponse(req.idRaw, null, err);
    return;
  }
  throw err;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
