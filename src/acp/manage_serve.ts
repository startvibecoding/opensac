// Ported from internal/acp/manage_serve.go (the serve + channels families of
// the `opensac/manage/*` Phase 3 management plane).
//
// Serve config management is a thin, secret-safe projection of internal/serve.
// It only reads and writes the global serve.json (not any project/workdir
// layer), reuses the shared load/save path, and never returns auth tokens,
// channel credentials, CORS origins, allowed work dirs, hook commands, or
// provider secrets.
//
// Deviations from Go: `json.RawMessage` params are already-decoded JSON, so
// sections operate on decoded objects; Go's `*mcp.RPCError` returns become
// thrown `RPCError`s; and sorted patch-section application uses
// `Object.keys().sort()` like Go's `sortedKeys`.

import { acpStructuredRPCError } from "./projection.ts";
import type { ACPRPCRequest } from "./wire.ts";
import { RPCError } from "../mcp/rpc.ts";
import type { AcpServer } from "./server.ts";
import {
  configPath,
  loadConfigFrom,
  saveServeConfig,
  type ServeConfig,
} from "../serve/config.ts";
import { manageAllowedThinkingLevels } from "./manage.ts";

// ─── whitelists ─────────────────────────────────────────────────────────────

const manageServePatchTopLevel: Record<string, boolean> = {
  api: true,
  features: true,
  webUI: true,
  cron: true,
  memory: true,
  security: true,
  agent: true,
  lobsterMode: true,
};

const manageServePatchAPIFields: Record<string, boolean> = {
  listen: true,
  defaultMode: true,
  defaultThinkingLevel: true,
  enableSubAgents: true,
  enableDelegate: true,
  enableWorkflows: true,
  enableWebSearch: true,
  enableBrowser: true,
  enableArtifact: true,
  enableA2AMaster: true,
  toolVisibility: true,
  systemPromptMode: true,
  requestTimeoutSeconds: true,
  backgroundRunMaxSeconds: true,
  maxConcurrentRequests: true,
  logLevel: true,
  session: true,
};

const manageServePatchAPISessionFields: Record<string, boolean> = {
  idleTimeoutSeconds: true,
  maxSessions: true,
};

const manageServePatchFeaturesFields: Record<string, boolean> = {
  webUI: true,
  openAIAPI: true,
  multiAgent: true,
  cron: true,
  memory: true,
};

const manageServePatchWebUIFields: Record<string, boolean> = {
  enabled: true,
  dir: true,
};

const manageServePatchCronFields: Record<string, boolean> = {
  enabled: true,
  interval: true,
};

const manageServePatchMemoryFields: Record<string, boolean> = {
  enabled: true,
  path: true,
};

const manageServePatchSecurityFields: Record<string, boolean> = {
  smartApprovals: true,
};

const manageServePatchAgentFields: Record<string, boolean> = {
  maxTurns: true,
  budgetPressure: true,
  contextPressure: true,
  budgetPressureThreshold: true,
  contextPressureThreshold: true,
  runStaleTimeoutSeconds: true,
  runMaxDurationSeconds: true,
  backgroundRunMaxSecs: true,
};

const manageServePatchToolVisibilityFields: Record<string, boolean> = {
  mode: true,
  detail: true,
};

const manageServeAllowedLogLevels: Record<string, boolean> = {
  debug: true,
  info: true,
  warn: true,
  error: true,
};

const manageServeAllowedToolVisibilityModes: Record<string, boolean> = {
  content: true,
  sse_event: true,
  none: true,
};

const manageServeAllowedToolVisibilityDetails: Record<string, boolean> = {
  collapsed: true,
  expanded: true,
};

const manageServeAllowedSystemPromptModes: Record<string, boolean> = {
  append: true,
  ignore: true,
};

// Modes come from manageAllowedModes in manage.ts; mirror the validation
// message exactly.
const manageServeAllowedModes = ["agent", "plan", "yolo", "os"];

// ─── views ──────────────────────────────────────────────────────────────────

interface ManageServeConfigView {
  api: Record<string, unknown>;
  features: Record<string, unknown>;
  webUI: Record<string, unknown>;
  cron: Record<string, unknown>;
  memory: Record<string, unknown>;
  security: Record<string, unknown>;
  agent: Record<string, unknown>;
  lobsterMode: boolean;
}

export function manageServeConfigView(
  cfg: ServeConfig,
): ManageServeConfigView {
  return {
    api: {
      listen: cfg.api.listen,
      defaultMode: cfg.api.defaultMode,
      defaultThinkingLevel: cfg.api.defaultThinkingLevel,
      enableSubAgents: cfg.api.enableSubAgents,
      enableDelegate: cfg.api.enableDelegate,
      enableWorkflows: cfg.api.enableWorkflows,
      enableWebSearch: cfg.api.enableWebSearch,
      enableBrowser: cfg.api.enableBrowser,
      enableArtifact: cfg.api.enableArtifact,
      enableA2AMaster: cfg.api.enableA2AMaster,
      toolVisibility: {
        mode: cfg.api.toolVisibility.mode,
        detail: cfg.api.toolVisibility.detail,
      },
      systemPromptMode: cfg.api.systemPromptMode,
      requestTimeoutSeconds: cfg.api.requestTimeoutSeconds,
      backgroundRunMaxSeconds: cfg.api.backgroundRunMaxSeconds,
      maxConcurrentRequests: cfg.api.maxConcurrentRequests,
      logLevel: cfg.api.logLevel,
      session: {
        idleTimeoutSeconds: cfg.api.session.idleTimeoutSeconds,
        maxSessions: cfg.api.session.maxSessions,
      },
    },
    features: {
      webUI: cfg.features.webUI,
      openAIAPI: cfg.features.openAIAPI,
      multiAgent: cfg.features.multiAgent,
      cron: cfg.features.cron,
      memory: cfg.features.memory,
    },
    webUI: { enabled: cfg.webUI.enabled, dir: cfg.webUI.dir },
    cron: { enabled: cfg.cron.enabled, interval: cfg.cron.interval },
    memory: { enabled: cfg.memory.enabled, path: cfg.memory.path },
    security: { smartApprovals: cfg.security.smartApprovals },
    agent: {
      maxTurns: cfg.agent.maxTurns,
      budgetPressure: cfg.agent.budgetPressure,
      contextPressure: cfg.agent.contextPressure,
      budgetPressureThreshold: cfg.agent.budgetPressureThreshold,
      contextPressureThreshold: cfg.agent.contextPressureThreshold,
      runStaleTimeoutSeconds: cfg.agent.runStaleTimeoutSeconds,
      runMaxDurationSeconds: cfg.agent.runMaxDurationSeconds,
      backgroundRunMaxSecs: cfg.agent.backgroundRunMaxSeconds,
    },
    lobsterMode: cfg.lobsterMode,
  };
}

function manageServeLoadGlobalConfig(): ServeConfig {
  return loadConfigFrom(configPath());
}

function manageServeSaveGlobalConfig(cfg: ServeConfig): void {
  saveServeConfig(configPath(), cfg);
}

// ─── section decode / typed-value helpers ───────────────────────────────────

function sortedKeys(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).sort();
}

/**
 * Applies the Serve management whitelist to one nested section. Rejects null
 * and empty objects explicitly at this public boundary (Go's json.Unmarshal
 * accepts null into a map, which would turn a malformed patch into a silent
 * no-op).
 */
function manageServeDecodeSection(
  raw: unknown,
  section: string,
  allowed: Record<string, boolean>,
): Record<string, unknown> {
  if (
    raw === null || raw === undefined || typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw manageServeFieldInvalid(section, "a non-empty object is required");
  }
  const source = raw as Record<string, unknown>;
  const rejected = Object.keys(source).filter((key) => !allowed[key]).sort();
  if (rejected.length > 0) {
    throw acpStructuredRPCError(
      -32602,
      "serve_field_not_allowed",
      `field ${JSON.stringify(rejected[0])} is not allowed`,
      { field: rejected[0], rejected, allowed: Object.keys(allowed).sort() },
    );
  }
  if (Object.keys(source).length === 0) {
    throw manageServeFieldInvalid(section, "a non-empty object is required");
  }
  return source;
}

function manageServeRequireString(
  raw: unknown,
  field: string,
): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw manageServeFieldInvalid(field, "a non-empty string is required");
  }
  return raw.trim();
}

function manageServeRequireBool(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw manageServeFieldInvalid(field, "a boolean value is required");
  }
  return raw;
}

function manageServeRequireInt(
  raw: unknown,
  field: string,
  min: number,
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) {
    throw manageServeFieldInvalid(
      field,
      `an integer >= ${min} is required`,
    );
  }
  return raw;
}

function manageServeRequireFloat(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max
  ) {
    throw manageServeFieldInvalid(
      field,
      `a number between ${min} and ${max} is required`,
    );
  }
  return raw;
}

function manageServeFieldInvalid(field: string, message: string): RPCError {
  return acpStructuredRPCError(
    -32602,
    "serve_field_invalid",
    `field ${field}: ${message}`,
    { field },
  );
}

// ─── serve/get + serve/patch ────────────────────────────────────────────────

export function handleManageServeConfigGet(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  let cfg: ServeConfig;
  try {
    cfg = manageServeLoadGlobalConfig();
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "serve_config_unavailable",
        (err as Error).message,
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, manageServeConfigView(cfg), null);
}

interface ManageServePatchRequest {
  patch?: Record<string, unknown>;
}

export function handleManageServeConfigPatch(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  const input = req.params as ManageServePatchRequest | null;
  if (
    input === null || typeof input !== "object" ||
    input.patch === null || typeof input.patch !== "object" ||
    Array.isArray(input.patch) ||
    Object.keys(input.patch).length === 0
  ) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one allowed section is required",
        null,
      ),
    );
    return;
  }
  const envelope = input.patch;
  for (const key of Object.keys(envelope)) {
    if (!manageServePatchTopLevel[key]) {
      const allowed = Object.keys(manageServePatchTopLevel).sort();
      s.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "serve_field_not_allowed",
          `serve config section ${JSON.stringify(key)} is not writable`,
          { field: key, allowed },
        ),
      );
      return;
    }
  }

  let cfg: ServeConfig;
  try {
    cfg = manageServeLoadGlobalConfig();
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "serve_config_unavailable",
        (err as Error).message,
        null,
      ),
    );
    return;
  }

  try {
    for (const key of sortedKeys(envelope)) {
      const raw = envelope[key];
      switch (key) {
        case "api":
          manageServePatchAPI(cfg, raw);
          break;
        case "features":
          manageServePatchFeatures(cfg, raw);
          break;
        case "webUI":
          manageServePatchWebUI(cfg, raw);
          break;
        case "cron":
          manageServePatchCron(cfg, raw);
          break;
        case "memory":
          manageServePatchMemory(cfg, raw);
          break;
        case "security":
          manageServePatchSecurity(cfg, raw);
          break;
        case "agent":
          manageServePatchAgent(cfg, raw);
          break;
        case "lobsterMode":
          manageServePatchLobsterMode(cfg, raw);
          break;
      }
    }
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return;
  }

  try {
    manageServeSaveGlobalConfig(cfg);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "serve_config_save_failed",
        (err as Error).message,
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, manageServeConfigView(cfg), null);
}

function manageServePatchAPI(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "api",
    manageServePatchAPIFields,
  );
  for (const field of sortedKeys(fields)) {
    const value = fields[field];
    switch (field) {
      case "listen":
        cfg.api.listen = manageServeRequireString(value, field);
        break;
      case "defaultMode": {
        const str = manageServeRequireString(value, field);
        if (!manageServeAllowedModes.includes(str)) {
          throw manageServeFieldInvalid(
            field,
            "mode must be one of agent, plan, yolo, os",
          );
        }
        cfg.api.defaultMode = str;
        break;
      }
      case "defaultThinkingLevel": {
        const str = manageServeRequireString(value, field);
        if (!manageAllowedThinkingLevels[str]) {
          throw manageServeFieldInvalid(
            field,
            "thinking level must be one of off, minimal, low, medium, high, xhigh, max",
          );
        }
        cfg.api.defaultThinkingLevel = str;
        break;
      }
      case "enableSubAgents": {
        const b = manageServeRequireBool(value, field);
        cfg.api.enableSubAgents = b;
        cfg.features.multiAgent = b;
        break;
      }
      case "enableDelegate":
        cfg.api.enableDelegate = manageServeRequireBool(value, field);
        break;
      case "enableWorkflows":
        cfg.api.enableWorkflows = manageServeRequireBool(value, field);
        break;
      case "enableWebSearch":
        cfg.api.enableWebSearch = manageServeRequireBool(value, field);
        break;
      case "enableBrowser":
        cfg.api.enableBrowser = manageServeRequireBool(value, field);
        break;
      case "enableArtifact":
        cfg.api.enableArtifact = manageServeRequireBool(value, field);
        break;
      case "enableA2AMaster":
        cfg.api.enableA2AMaster = manageServeRequireBool(value, field);
        break;
      case "toolVisibility": {
        const tvFields = manageServeDecodeSection(
          value,
          "api.toolVisibility",
          manageServePatchToolVisibilityFields,
        );
        for (const tvField of sortedKeys(tvFields)) {
          switch (tvField) {
            case "mode": {
              const str = manageServeRequireString(
                tvFields[tvField],
                "toolVisibility.mode",
              );
              if (!manageServeAllowedToolVisibilityModes[str]) {
                throw manageServeFieldInvalid(
                  "toolVisibility.mode",
                  "mode must be one of content, sse_event, none",
                );
              }
              cfg.api.toolVisibility.mode = str;
              break;
            }
            case "detail": {
              const str = manageServeRequireString(
                tvFields[tvField],
                "toolVisibility.detail",
              );
              if (!manageServeAllowedToolVisibilityDetails[str]) {
                throw manageServeFieldInvalid(
                  "toolVisibility.detail",
                  "detail must be one of collapsed, expanded",
                );
              }
              cfg.api.toolVisibility.detail = str;
              break;
            }
          }
        }
        break;
      }
      case "systemPromptMode": {
        const str = manageServeRequireString(value, field);
        if (!manageServeAllowedSystemPromptModes[str]) {
          throw manageServeFieldInvalid(
            field,
            "systemPromptMode must be one of append, ignore",
          );
        }
        cfg.api.systemPromptMode = str;
        break;
      }
      case "requestTimeoutSeconds":
        cfg.api.requestTimeoutSeconds = manageServeRequireInt(
          value,
          field,
          1,
        );
        break;
      case "backgroundRunMaxSeconds": {
        const i = manageServeRequireInt(value, field, 1);
        cfg.api.backgroundRunMaxSeconds = i;
        cfg.agent.backgroundRunMaxSeconds = i;
        break;
      }
      case "maxConcurrentRequests":
        cfg.api.maxConcurrentRequests = manageServeRequireInt(
          value,
          field,
          0,
        );
        break;
      case "logLevel": {
        const str = manageServeRequireString(value, field);
        if (!manageServeAllowedLogLevels[str]) {
          throw manageServeFieldInvalid(
            field,
            "logLevel must be one of debug, info, warn, error",
          );
        }
        cfg.api.logLevel = str;
        break;
      }
      case "session":
        manageServePatchAPISession(cfg, value);
        break;
    }
  }
}

function manageServePatchAPISession(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "api.session",
    manageServePatchAPISessionFields,
  );
  for (const field of sortedKeys(fields)) {
    switch (field) {
      case "idleTimeoutSeconds":
        cfg.api.session.idleTimeoutSeconds = manageServeRequireInt(
          fields[field],
          `api.session.${field}`,
          1,
        );
        break;
      case "maxSessions":
        cfg.api.session.maxSessions = manageServeRequireInt(
          fields[field],
          `api.session.${field}`,
          0,
        );
        break;
    }
  }
}

function manageServePatchFeatures(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "features",
    manageServePatchFeaturesFields,
  );
  for (const field of sortedKeys(fields)) {
    const b = manageServeRequireBool(fields[field], `features.${field}`);
    switch (field) {
      case "webUI":
        cfg.features.webUI = b;
        cfg.webUI.enabled = b;
        break;
      case "openAIAPI":
        cfg.features.openAIAPI = b;
        break;
      case "multiAgent":
        cfg.features.multiAgent = b;
        cfg.api.enableSubAgents = b;
        break;
      case "cron":
        cfg.features.cron = b;
        cfg.cron.enabled = b;
        break;
      case "memory":
        cfg.features.memory = b;
        cfg.memory.enabled = b;
        break;
    }
  }
}

function manageServePatchWebUI(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "webUI",
    manageServePatchWebUIFields,
  );
  for (const field of sortedKeys(fields)) {
    switch (field) {
      case "enabled": {
        const b = manageServeRequireBool(fields[field], "webUI.enabled");
        cfg.webUI.enabled = b;
        cfg.features.webUI = b;
        break;
      }
      case "dir":
        cfg.webUI.dir = manageServeRequireString(fields[field], "webUI.dir");
        break;
    }
  }
}

function manageServePatchCron(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "cron",
    manageServePatchCronFields,
  );
  for (const field of sortedKeys(fields)) {
    switch (field) {
      case "enabled": {
        const b = manageServeRequireBool(fields[field], "cron.enabled");
        cfg.cron.enabled = b;
        cfg.features.cron = b;
        break;
      }
      case "interval":
        cfg.cron.interval = manageServeRequireInt(
          fields[field],
          "cron.interval",
          1,
        );
        break;
    }
  }
}

function manageServePatchMemory(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "memory",
    manageServePatchMemoryFields,
  );
  for (const field of sortedKeys(fields)) {
    switch (field) {
      case "enabled": {
        const b = manageServeRequireBool(fields[field], "memory.enabled");
        cfg.memory.enabled = b;
        cfg.features.memory = b;
        break;
      }
      case "path": {
        const value = fields[field];
        if (typeof value !== "string") {
          throw manageServeFieldInvalid(
            "memory.path",
            "value must be a string",
          );
        }
        cfg.memory.path = value;
        break;
      }
    }
  }
}

function manageServePatchSecurity(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "security",
    manageServePatchSecurityFields,
  );
  for (const field of sortedKeys(fields)) {
    if (field === "smartApprovals") {
      cfg.security.smartApprovals = manageServeRequireBool(
        fields[field],
        "security.smartApprovals",
      );
    }
  }
}

function manageServePatchAgent(cfg: ServeConfig, raw: unknown): void {
  const fields = manageServeDecodeSection(
    raw,
    "agent",
    manageServePatchAgentFields,
  );
  for (const field of sortedKeys(fields)) {
    const value = fields[field];
    switch (field) {
      case "maxTurns":
        cfg.agent.maxTurns = manageServeRequireInt(value, field, 1);
        break;
      case "budgetPressure":
        cfg.agent.budgetPressure = manageServeRequireBool(value, field);
        break;
      case "contextPressure":
        cfg.agent.contextPressure = manageServeRequireBool(value, field);
        break;
      case "budgetPressureThreshold":
        cfg.agent.budgetPressureThreshold = manageServeRequireFloat(
          value,
          field,
          0,
          1,
        );
        break;
      case "contextPressureThreshold":
        cfg.agent.contextPressureThreshold = manageServeRequireFloat(
          value,
          field,
          0,
          1,
        );
        break;
      case "runStaleTimeoutSeconds":
        cfg.agent.runStaleTimeoutSeconds = manageServeRequireInt(
          value,
          field,
          1,
        );
        break;
      case "runMaxDurationSeconds":
        cfg.agent.runMaxDurationSeconds = manageServeRequireInt(
          value,
          field,
          1,
        );
        break;
      case "backgroundRunMaxSecs":
        cfg.agent.backgroundRunMaxSeconds = manageServeRequireInt(
          value,
          field,
          1,
        );
        break;
    }
  }
}

function manageServePatchLobsterMode(cfg: ServeConfig, raw: unknown): void {
  cfg.lobsterMode = manageServeRequireBool(raw, "lobsterMode");
}

// ─── channels/get + channels/patch ──────────────────────────────────────────

const manageChannelsPatchTopLevel: Record<string, boolean> = {
  artifact: true,
  wechat: true,
  feishu: true,
};

const manageChannelsWechatFields: Record<string, boolean> = {
  enabled: true,
  workDir: true,
  autoTyping: true,
  credPath: true,
  clearCredPath: true,
};

const manageChannelsFeishuFields: Record<string, boolean> = {
  enabled: true,
  workDir: true,
  appId: true,
  appSecret: true,
  clearAppId: true,
  clearAppSecret: true,
};

interface ManageChannelsView {
  artifact: boolean;
  wechat: {
    enabled: boolean;
    workDir: string;
    autoTyping: boolean;
    credentialConfigured: boolean;
  };
  feishu: {
    enabled: boolean;
    workDir: string;
    appIDConfigured: boolean;
    appSecretConfigured: boolean;
  };
}

function manageChannelsConfigView(cfg: ServeConfig): ManageChannelsView {
  return {
    artifact: cfg.channels.artifact,
    wechat: {
      enabled: cfg.channels.wechat.enabled,
      workDir: cfg.channels.wechat.workDir,
      autoTyping: cfg.channels.wechat.autoTyping,
      credentialConfigured: cfg.channels.wechat.credPath !== "",
    },
    feishu: {
      enabled: cfg.channels.feishu.enabled,
      workDir: cfg.channels.feishu.workDir,
      appIDConfigured: cfg.channels.feishu.appId !== "",
      appSecretConfigured: cfg.channels.feishu.appSecret !== "",
    },
  };
}

export function handleManageChannelsGet(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  let cfg: ServeConfig;
  try {
    cfg = manageServeLoadGlobalConfig();
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "serve_config_unavailable",
        (err as Error).message,
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, manageChannelsConfigView(cfg), null);
}

interface ManageChannelsPatchRequest {
  patch?: Record<string, unknown>;
}

export function handleManageChannelsPatch(
  s: AcpServer,
  req: ACPRPCRequest,
): void {
  const input = req.params as ManageChannelsPatchRequest | null;
  if (
    input === null || typeof input !== "object" ||
    input.patch === null || typeof input.patch !== "object" ||
    Array.isArray(input.patch) ||
    Object.keys(input.patch).length === 0
  ) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32602,
        "invalid_params",
        "patch object with at least one allowed section is required",
        null,
      ),
    );
    return;
  }
  const envelope = input.patch;
  let cfg: ServeConfig;
  try {
    cfg = manageServeLoadGlobalConfig();
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "serve_config_unavailable",
        (err as Error).message,
        null,
      ),
    );
    return;
  }

  try {
    for (const key of sortedKeys(envelope)) {
      if (!manageChannelsPatchTopLevel[key]) {
        const allowed = Object.keys(manageChannelsPatchTopLevel).sort();
        throw acpStructuredRPCError(
          -32602,
          "serve_field_not_allowed",
          `channel config section ${JSON.stringify(key)} is not writable`,
          { field: key, allowed },
        );
      }
      const raw = envelope[key];
      if (key === "artifact") {
        cfg.channels.artifact = manageServeRequireBool(raw, "artifact");
        continue;
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw manageServeFieldInvalid(key, "a non-empty object is required");
      }
      const fields = raw as Record<string, unknown>;
      if (Object.keys(fields).length === 0) {
        throw manageServeFieldInvalid(key, "a non-empty object is required");
      }
      if (key === "wechat") manageChannelsPatchWechat(cfg, fields);
      if (key === "feishu") manageChannelsPatchFeishu(cfg, fields);
    }
  } catch (err) {
    s.writeResponse(req.idRaw, null, err as RPCError);
    return;
  }

  try {
    manageServeSaveGlobalConfig(cfg);
  } catch (err) {
    s.writeResponse(
      req.idRaw,
      null,
      acpStructuredRPCError(
        -32000,
        "serve_config_save_failed",
        (err as Error).message,
        null,
      ),
    );
    return;
  }
  s.writeResponse(req.idRaw, manageChannelsConfigView(cfg), null);
}

function manageChannelsPatchWechat(
  cfg: ServeConfig,
  fields: Record<string, unknown>,
): void {
  if (
    Object.hasOwn(fields, "credPath") && Object.hasOwn(fields, "clearCredPath")
  ) {
    throw manageServeFieldInvalid(
      "wechat.credPath",
      "credPath and clearCredPath cannot both be set",
    );
  }
  for (const field of sortedKeys(fields)) {
    if (!manageChannelsWechatFields[field]) {
      throw manageServeFieldInvalid(`wechat.${field}`, "field is not allowed");
    }
    const raw = fields[field];
    switch (field) {
      case "enabled": {
        const b = manageServeRequireBool(raw, "wechat.enabled");
        cfg.channels.wechat.enabled = b;
        cfg.features.wechat = b;
        break;
      }
      case "workDir":
        cfg.channels.wechat.workDir = manageServeRequireString(
          raw,
          "wechat.workDir",
        );
        break;
      case "autoTyping":
        cfg.channels.wechat.autoTyping = manageServeRequireBool(
          raw,
          "wechat.autoTyping",
        );
        break;
      case "credPath":
        cfg.channels.wechat.credPath = manageServeRequireString(
          raw,
          "wechat.credPath",
        );
        break;
      case "clearCredPath":
        if (manageServeRequireBool(raw, "wechat.clearCredPath")) {
          cfg.channels.wechat.credPath = "";
        }
        break;
    }
  }
}

function manageChannelsPatchFeishu(
  cfg: ServeConfig,
  fields: Record<string, unknown>,
): void {
  if (Object.hasOwn(fields, "appId") && Object.hasOwn(fields, "clearAppId")) {
    throw manageServeFieldInvalid(
      "feishu.appId",
      "appId and clearAppId cannot both be set",
    );
  }
  if (
    Object.hasOwn(fields, "appSecret") &&
    Object.hasOwn(fields, "clearAppSecret")
  ) {
    throw manageServeFieldInvalid(
      "feishu.appSecret",
      "appSecret and clearAppSecret cannot both be set",
    );
  }
  for (const field of sortedKeys(fields)) {
    if (!manageChannelsFeishuFields[field]) {
      throw manageServeFieldInvalid(`feishu.${field}`, "field is not allowed");
    }
    const raw = fields[field];
    switch (field) {
      case "enabled": {
        const b = manageServeRequireBool(raw, "feishu.enabled");
        cfg.channels.feishu.enabled = b;
        cfg.features.feishu = b;
        break;
      }
      case "workDir":
        cfg.channels.feishu.workDir = manageServeRequireString(
          raw,
          "feishu.workDir",
        );
        break;
      case "appId":
        cfg.channels.feishu.appId = manageServeRequireString(
          raw,
          "feishu.appId",
        );
        break;
      case "appSecret":
        cfg.channels.feishu.appSecret = manageServeRequireString(
          raw,
          "feishu.appSecret",
        );
        break;
      case "clearAppId":
        if (manageServeRequireBool(raw, "feishu.clearAppId")) {
          cfg.channels.feishu.appId = "";
        }
        break;
      case "clearAppSecret":
        if (manageServeRequireBool(raw, "feishu.clearAppSecret")) {
          cfg.channels.feishu.appSecret = "";
        }
        break;
    }
  }
}
