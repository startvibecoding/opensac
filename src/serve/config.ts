// Ported from internal/serve/config.go, config_schema.go, and
// config_mapping.go (the global/project `serve.json` schema, legacy overlay,
// normalization, and save path).
//
// The serve HTTP runtime (backlog #36) lands later; this module owns the
// configuration surface that doctor and the ACP management plane already
// depend on. Deviations: `encoding/json` maps to `JSON` (unknown fields are
// ignored, matching Go); the typed primary decode followed by the legacy
// top-level `rawConfig` overlay is reproduced as `decodeConfigBytesInto`; and
// the Go custom `MarshalJSON` maps to `serializeConfig`, which writes the same
// canonical wire shape (camelCase, omitempty on empty scalars).

import { configDir, projectPath } from "../config/mod.ts";
import path from "node:path";

/** Returns the global `serve.json` path. */
export function configPath(): string {
  return path.join(configDir(), "serve.json");
}

/** Returns the project-level `serve.json` path. */
export function projectConfigPath(): string {
  return projectPath("serve.json");
}

// ─── schema ─────────────────────────────────────────────────────────────────

export interface AuthConfig {
  enabled: boolean;
  tokens: string[];
}

export interface SandboxConfig {
  enabled: boolean;
  level: string;
}

export interface APISessionConfig {
  idleTimeoutSeconds: number;
  maxSessions: number;
}

export interface CORSConfig {
  enabled: boolean;
  allowOrigins: string[];
}

export interface ToolVisibilityConfig {
  mode: string;
  detail: string;
}

export interface APIConfig {
  listen: string;
  auth: AuthConfig;
  defaultMode: string;
  defaultThinkingLevel: string;
  enableSubAgents: boolean;
  enableDelegate: boolean;
  enableWorkflows: boolean;
  enableWebSearch: boolean;
  enableBrowser: boolean;
  enableArtifact: boolean;
  enableA2AMaster: boolean;
  sandbox: SandboxConfig;
  /** `undefined` means no check; an empty array denies every work dir. */
  allowedWorkDirs?: string[];
  session: APISessionConfig;
  defaultWorkDir: string;
  /** Legacy alias for defaultWorkDir, not persisted. */
  workingDir: string;
  cors: CORSConfig;
  provider: string;
  model: string;
  toolVisibility: ToolVisibilityConfig;
  systemPromptMode: string;
  requestTimeoutSeconds: number;
  backgroundRunMaxSeconds: number;
  maxConcurrentRequests: number;
  logLevel: string;
}

export interface FeatureConfig {
  webUI: boolean;
  openAIAPI: boolean;
  wechat: boolean;
  feishu: boolean;
  multiAgent: boolean;
  cron: boolean;
  memory: boolean;
}

export interface WechatConfig {
  enabled: boolean;
  credPath: string;
  workDir: string;
  autoTyping: boolean;
}

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  workDir: string;
}

export interface ChannelConfig {
  artifact: boolean;
  wechat: WechatConfig;
  feishu: FeishuConfig;
}

export interface WebUIConfig {
  enabled: boolean;
  dir: string;
}

export interface CronServeConfig {
  enabled: boolean;
  interval: number;
}

export interface ServeMemoryConfig {
  enabled: boolean;
  path: string;
}

export interface SecurityConfig {
  smartApprovals: boolean;
  allowedWorkDirs: string[];
}

export interface HooksConfig {
  preToolCall: string;
  postToolCall: string;
}

export interface AgentServeConfig {
  maxTurns: number;
  budgetPressure: boolean;
  contextPressure: boolean;
  budgetPressureThreshold: number;
  contextPressureThreshold: number;
  runStaleTimeoutSeconds: number;
  runMaxDurationSeconds: number;
  backgroundRunMaxSeconds: number;
}

export interface ServeConfig {
  api: APIConfig;
  features: FeatureConfig;
  channels: ChannelConfig;
  webUI: WebUIConfig;
  lobsterMode: boolean;
  cron: CronServeConfig;
  memory: ServeMemoryConfig;
  security: SecurityConfig;
  hooks: HooksConfig;
  agent: AgentServeConfig;
}

// 16h iteration-budget wall clock (agent.DefaultIterationBudgetWallClock).
const defaultBackgroundRunMaxSeconds = 16 * 60 * 60;
const defaultRunStaleTimeoutSeconds = 600;

function defaultAPIConfig(): APIConfig {
  return {
    listen: "127.0.0.1:7872",
    auth: { enabled: false, tokens: [] },
    defaultMode: "yolo",
    defaultThinkingLevel: "medium",
    enableSubAgents: false,
    enableDelegate: false,
    enableWorkflows: false,
    enableWebSearch: false,
    enableBrowser: false,
    enableArtifact: false,
    enableA2AMaster: false,
    sandbox: { enabled: false, level: "" },
    session: { idleTimeoutSeconds: 1800, maxSessions: 0 },
    defaultWorkDir: "",
    workingDir: "",
    cors: { enabled: false, allowOrigins: ["*"] },
    provider: "",
    model: "",
    toolVisibility: { mode: "content", detail: "collapsed" },
    systemPromptMode: "append",
    requestTimeoutSeconds: 1800,
    backgroundRunMaxSeconds: 0,
    maxConcurrentRequests: 0,
    logLevel: "info",
  };
}

function defaultAgentConfig(): AgentServeConfig {
  return {
    maxTurns: 90,
    budgetPressure: true,
    contextPressure: true,
    budgetPressureThreshold: 0.2,
    contextPressureThreshold: 0.55,
    runStaleTimeoutSeconds: defaultRunStaleTimeoutSeconds,
    runMaxDurationSeconds: defaultBackgroundRunMaxSeconds,
    backgroundRunMaxSeconds: defaultBackgroundRunMaxSeconds,
  };
}

export function defaultServeConfig(): ServeConfig {
  const api = defaultAPIConfig();
  const agent = defaultAgentConfig();
  api.backgroundRunMaxSeconds = agent.backgroundRunMaxSeconds;
  return {
    api,
    features: {
      webUI: true,
      openAIAPI: true,
      wechat: false,
      feishu: false,
      multiAgent: api.enableSubAgents,
      cron: true,
      memory: true,
    },
    channels: {
      artifact: false,
      wechat: { enabled: false, credPath: "", workDir: "", autoTyping: true },
      feishu: { enabled: false, appId: "", appSecret: "", workDir: "" },
    },
    webUI: { enabled: true, dir: "ui/dist" },
    lobsterMode: false,
    cron: { enabled: true, interval: 0 },
    memory: { enabled: true, path: "" },
    security: { smartApprovals: true, allowedWorkDirs: [] },
    hooks: { preToolCall: "", postToolCall: "" },
    agent,
  };
}

// ─── normalization ──────────────────────────────────────────────────────────

export function normalizeServeConfig(cfg: ServeConfig): void {
  if (cfg.api.listen === "") cfg.api.listen = "127.0.0.1:7872";
  if (cfg.api.defaultMode === "") cfg.api.defaultMode = "yolo";
  if (cfg.api.toolVisibility.mode === "") {
    cfg.api.toolVisibility.mode = "content";
  }
  if (cfg.api.toolVisibility.detail === "") {
    cfg.api.toolVisibility.detail = "collapsed";
  }
  if (cfg.api.systemPromptMode === "") cfg.api.systemPromptMode = "append";
  if (cfg.api.defaultThinkingLevel === "") {
    cfg.api.defaultThinkingLevel = "medium";
  }
  if (cfg.api.requestTimeoutSeconds <= 0) {
    cfg.api.requestTimeoutSeconds = 1800;
  }
  if (cfg.webUI.dir === "") cfg.webUI.dir = "ui/dist";
  if (cfg.agent.maxTurns === 0) {
    cfg.agent = defaultAgentConfig();
  }
  if (cfg.api.backgroundRunMaxSeconds <= 0) {
    cfg.api.backgroundRunMaxSeconds = cfg.agent.backgroundRunMaxSeconds;
  }
  if (cfg.lobsterMode) {
    cfg.api.defaultMode = "yolo";
    cfg.api.sandbox.enabled = false;
    cfg.api.enableSubAgents = true;
  }
  cfg.features.webUI = cfg.webUI.enabled;
  cfg.features.wechat = cfg.channels.wechat.enabled;
  cfg.features.feishu = cfg.channels.feishu.enabled;
  cfg.features.multiAgent = cfg.api.enableSubAgents;
  cfg.features.cron = cfg.cron.enabled;
  cfg.features.memory = cfg.memory.enabled;
}

// ─── decode with legacy overlay ─────────────────────────────────────────────

function boolField(
  raw: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = raw[key];
  return typeof value === "boolean" ? value : undefined;
}
function stringField(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}
function intField(
  raw: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = raw[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return undefined;
}
function floatField(
  raw: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = raw[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
function objectField(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Decodes bytes over the defaults (typed decode + legacy top-level overlay). */
export function decodeConfigBytesInto(cfg: ServeConfig, data: string): void {
  const parsed = JSON.parse(data) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("serve config must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;

  // Typed primary decode (json.Unmarshal into *Config).
  if (objectField(root, "api")) decodeAPI(cfg, objectField(root, "api")!);
  if (objectField(root, "features")) {
    decodeFeatures(cfg, objectField(root, "features")!);
  }
  if (objectField(root, "channels")) {
    decodeChannels(cfg, objectField(root, "channels")!);
  }
  if (objectField(root, "webUI")) decodeWebUI(cfg, objectField(root, "webUI")!);
  if (objectField(root, "cron")) decodeCron(cfg, objectField(root, "cron")!);
  if (objectField(root, "memory")) {
    decodeMemory(cfg, objectField(root, "memory")!);
  }
  if (objectField(root, "security")) {
    decodeSecurity(cfg, objectField(root, "security")!);
  }
  if (objectField(root, "hooks")) decodeHooks(cfg, objectField(root, "hooks")!);
  if (objectField(root, "agent")) decodeAgent(cfg, objectField(root, "agent")!);
  if (typeof root["lobsterMode"] === "boolean") {
    cfg.lobsterMode = root["lobsterMode"];
  }

  // Legacy top-level overlay (rawConfig).
  if (stringField(root, "listen")) {
    cfg.api.listen = stringField(root, "listen")!;
  }
  if (stringField(root, "provider")) {
    cfg.api.provider = stringField(root, "provider")!;
  }
  if (stringField(root, "model")) cfg.api.model = stringField(root, "model")!;
  if (stringField(root, "mode")) {
    cfg.api.defaultMode = stringField(root, "mode")!;
  }
  const defaultWorkDir = stringField(root, "defaultWorkDir");
  const legacyWorkDir = stringField(root, "workDir");
  if (defaultWorkDir !== undefined) {
    cfg.api.defaultWorkDir = defaultWorkDir;
    cfg.api.workingDir = "";
  } else if (legacyWorkDir !== undefined) {
    cfg.api.defaultWorkDir = legacyWorkDir;
    cfg.api.workingDir = "";
  }
  const auth = objectField(root, "auth");
  if (auth) {
    const enabled = boolField(auth, "enabled");
    if (enabled !== undefined) cfg.api.auth.enabled = enabled;
    if (Array.isArray(auth["tokens"])) {
      cfg.api.auth.tokens = (auth["tokens"] as unknown[]).filter(
        (v): v is string => typeof v === "string",
      );
    }
  }
  const sandbox = objectField(root, "sandbox");
  if (sandbox) {
    const enabled = boolField(sandbox, "enabled");
    if (enabled !== undefined) cfg.api.sandbox.enabled = enabled;
    const level = stringField(sandbox, "level");
    if (level) cfg.api.sandbox.level = level;
  }
  if (Array.isArray(root["allowedWorkDirs"])) {
    cfg.api.allowedWorkDirs = (root["allowedWorkDirs"] as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
  }
  const session = objectField(root, "session");
  if (session) {
    const idle = intField(session, "idleTimeoutSeconds");
    if (idle !== undefined) cfg.api.session.idleTimeoutSeconds = idle;
    const max = intField(session, "maxSessions");
    if (max !== undefined) cfg.api.session.maxSessions = max;
  }
  const tv = objectField(root, "toolVisibility");
  if (tv) {
    const mode = stringField(tv, "mode");
    if (mode) cfg.api.toolVisibility.mode = mode;
    const detail = stringField(tv, "detail");
    if (detail) cfg.api.toolVisibility.detail = detail;
  }
  if (stringField(root, "thinking")) {
    cfg.api.defaultThinkingLevel = stringField(root, "thinking")!;
  }
  if (stringField(root, "systemPromptMode")) {
    cfg.api.systemPromptMode = stringField(root, "systemPromptMode")!;
  }
  const requestTimeout = intField(root, "requestTimeoutSeconds");
  if (requestTimeout !== undefined) {
    cfg.api.requestTimeoutSeconds = requestTimeout;
  }
  const maxConcurrent = intField(root, "maxConcurrentRequests");
  if (maxConcurrent !== undefined) {
    cfg.api.maxConcurrentRequests = maxConcurrent;
  }
  const webSearch = boolField(root, "webSearch");
  if (webSearch !== undefined) cfg.api.enableWebSearch = webSearch;
  else {applyAPIFlag(root, "api", "enableWebSearch", (v) =>
      cfg.api.enableWebSearch = v);}
  const browser = boolField(root, "browser");
  if (browser !== undefined) cfg.api.enableBrowser = browser;
  else {applyAPIFlag(root, "api", "enableBrowser", (v) =>
      cfg.api.enableBrowser = v);}
  const artifact = boolField(root, "artifact");
  if (artifact !== undefined) cfg.api.enableArtifact = artifact;
  else {applyAPIFlag(root, "api", "enableArtifact", (v) =>
      cfg.api.enableArtifact = v);}
  const a2a = boolField(root, "a2aMaster");
  if (a2a !== undefined) cfg.api.enableA2AMaster = a2a;
  else {applyAPIFlag(root, "api", "enableA2AMaster", (v) =>
      cfg.api.enableA2AMaster = v);}

  applyRawAgent(cfg, objectField(root, "agent"));
  const webUI = objectField(root, "webUI");
  if (webUI) {
    const enabled = boolField(webUI, "enabled");
    if (enabled !== undefined) cfg.webUI.enabled = enabled;
    const dir = stringField(webUI, "dir");
    if (dir) cfg.webUI.dir = dir;
  }
  const cron = objectField(root, "cron");
  if (cron) {
    const enabled = boolField(cron, "enabled");
    if (enabled !== undefined) cfg.cron.enabled = enabled;
    const interval = intField(cron, "interval");
    if (interval !== undefined) cfg.cron.interval = interval;
  }
  const memory = objectField(root, "memory");
  if (memory) {
    const enabled = boolField(memory, "enabled");
    if (enabled !== undefined) cfg.memory.enabled = enabled;
    const p = stringField(memory, "path");
    if (p) cfg.memory.path = p;
  }
  const security = objectField(root, "security");
  if (security) {
    const smart = boolField(security, "smartApprovals");
    if (smart !== undefined) cfg.security.smartApprovals = smart;
    if (Array.isArray(security["allowedWorkDirs"])) {
      cfg.security.allowedWorkDirs = (security["allowedWorkDirs"] as unknown[])
        .filter((v): v is string => typeof v === "string");
    }
  }
  const hooks = objectField(root, "hooks");
  if (hooks) {
    const pre = stringField(hooks, "preToolCall");
    if (pre) cfg.hooks.preToolCall = pre;
    const post = stringField(hooks, "postToolCall");
    if (post) cfg.hooks.postToolCall = post;
  }
  applyRawChannels(cfg, objectField(root, "channels"));

  const features = objectField(root, "features");
  if (features) {
    const fWebUI = boolField(features, "webUI");
    if (fWebUI !== undefined) {
      cfg.features.webUI = fWebUI;
      cfg.webUI.enabled = fWebUI;
    }
    const openAIAPI = boolField(features, "openAIAPI");
    if (openAIAPI !== undefined) cfg.features.openAIAPI = openAIAPI;
    const multi = boolField(features, "multiAgent");
    if (multi !== undefined) {
      cfg.features.multiAgent = multi;
      cfg.api.enableSubAgents = multi;
    }
    const fWechat = boolField(features, "wechat");
    if (fWechat !== undefined) {
      cfg.features.wechat = fWechat;
      cfg.channels.wechat.enabled = fWechat;
    }
    const fFeishu = boolField(features, "feishu");
    if (fFeishu !== undefined) {
      cfg.features.feishu = fFeishu;
      cfg.channels.feishu.enabled = fFeishu;
    }
    const fCron = boolField(features, "cron");
    if (fCron !== undefined) {
      cfg.features.cron = fCron;
      cfg.cron.enabled = fCron;
    }
    const fMemory = boolField(features, "memory");
    if (fMemory !== undefined) {
      cfg.features.memory = fMemory;
      cfg.memory.enabled = fMemory;
    }
  }
  if (root["lobsterMode"] === true) cfg.lobsterMode = true;
}

function applyAPIFlag(
  root: Record<string, unknown>,
  section: string,
  field: string,
  set: (v: boolean) => void,
): void {
  const api = objectField(root, section);
  if (!api) return;
  const value = boolField(api, field);
  if (value !== undefined) set(value);
}

function applyRawAgent(
  cfg: ServeConfig,
  raw: Record<string, unknown> | undefined,
): void {
  if (!raw) return;
  const maxTurns = intField(raw, "maxTurns");
  if (maxTurns !== undefined) cfg.agent.maxTurns = maxTurns;
  const budget = boolField(raw, "budgetPressure");
  if (budget !== undefined) cfg.agent.budgetPressure = budget;
  const context = boolField(raw, "contextPressure");
  if (context !== undefined) cfg.agent.contextPressure = context;
  const budgetT = floatField(raw, "budgetPressureThreshold");
  if (budgetT !== undefined) cfg.agent.budgetPressureThreshold = budgetT;
  const contextT = floatField(raw, "contextPressureThreshold");
  if (contextT !== undefined) cfg.agent.contextPressureThreshold = contextT;
  const stale = intField(raw, "runStaleTimeoutSeconds");
  if (stale !== undefined) cfg.agent.runStaleTimeoutSeconds = stale;
  const max = intField(raw, "runMaxDurationSeconds");
  if (max !== undefined) cfg.agent.runMaxDurationSeconds = max;
  const bg = intField(raw, "backgroundRunMaxSeconds");
  if (bg !== undefined) cfg.agent.backgroundRunMaxSeconds = bg;
}

function applyRawChannels(
  cfg: ServeConfig,
  raw: Record<string, unknown> | undefined,
): void {
  if (!raw) return;
  const artifact = boolField(raw, "artifact");
  if (artifact !== undefined) cfg.channels.artifact = artifact;
  const wechat = objectField(raw, "wechat");
  if (wechat) {
    const enabled = boolField(wechat, "enabled");
    if (enabled !== undefined) cfg.channels.wechat.enabled = enabled;
    const auto = boolField(wechat, "autoTyping");
    if (auto !== undefined) cfg.channels.wechat.autoTyping = auto;
    const cred = stringField(wechat, "credPath");
    if (cred) cfg.channels.wechat.credPath = cred;
    const workDir = stringField(wechat, "workDir");
    if (workDir) cfg.channels.wechat.workDir = workDir;
  }
  const feishu = objectField(raw, "feishu");
  if (feishu) {
    const enabled = boolField(feishu, "enabled");
    if (enabled !== undefined) cfg.channels.feishu.enabled = enabled;
    const appId = stringField(feishu, "appId");
    if (appId) cfg.channels.feishu.appId = appId;
    const appSecret = stringField(feishu, "appSecret");
    if (appSecret) cfg.channels.feishu.appSecret = appSecret;
    const workDir = stringField(feishu, "workDir");
    if (workDir) cfg.channels.feishu.workDir = workDir;
  }
}

// ─── typed section decoders (primary json.Unmarshal shape) ──────────────────
// Go's typed unmarshal also accepts the channels' snake_case wire tags
// (`cred_path`, `work_dir`, `auto_typing`, `app_id`, `app_secret`,
// `smart_approvals`, `max_turns`, ...); decode both spellings.

function decodeAPI(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const api = cfg.api;
  const listen = stringField(raw, "listen");
  if (listen) api.listen = listen;
  if (stringField(raw, "provider")) {
    api.provider = stringField(raw, "provider")!;
  }
  if (stringField(raw, "model")) api.model = stringField(raw, "model")!;
  if (stringField(raw, "defaultMode")) {
    api.defaultMode = stringField(raw, "defaultMode")!;
  }
  if (stringField(raw, "defaultThinkingLevel")) {
    api.defaultThinkingLevel = stringField(raw, "defaultThinkingLevel")!;
  }
  if (stringField(raw, "systemPromptMode")) {
    api.systemPromptMode = stringField(raw, "systemPromptMode")!;
  }
  // Go's typed decode accepts defaultWorkDir/workingDir inside the api object
  // (openaiapi.Config json tags); the legacy top-level overlay clears
  // workingDir when the canonical field is present.
  if (stringField(raw, "defaultWorkDir")) {
    api.defaultWorkDir = stringField(raw, "defaultWorkDir")!;
  }
  if (stringField(raw, "workingDir")) {
    api.workingDir = stringField(raw, "workingDir")!;
  }
  if (stringField(raw, "logLevel")) {
    api.logLevel = stringField(raw, "logLevel")!;
  }
  for (
    const [field, set] of [
      ["enableSubAgents", (v: boolean) => api.enableSubAgents = v],
      ["enableDelegate", (v: boolean) => api.enableDelegate = v],
      ["enableWorkflows", (v: boolean) => api.enableWorkflows = v],
      ["enableWebSearch", (v: boolean) => api.enableWebSearch = v],
      ["enableBrowser", (v: boolean) => api.enableBrowser = v],
      ["enableArtifact", (v: boolean) => api.enableArtifact = v],
      ["enableA2AMaster", (v: boolean) => api.enableA2AMaster = v],
    ] as [string, (v: boolean) => void][]
  ) {
    const v = boolField(raw, field);
    if (v !== undefined) set(v);
  }
  const tv = objectField(raw, "toolVisibility");
  if (tv) {
    if (stringField(tv, "mode")) {
      api.toolVisibility.mode = stringField(tv, "mode")!;
    }
    if (stringField(tv, "detail")) {
      api.toolVisibility.detail = stringField(tv, "detail")!;
    }
  }
  const session = objectField(raw, "session");
  if (session) {
    const idle = intField(session, "idleTimeoutSeconds");
    if (idle !== undefined) api.session.idleTimeoutSeconds = idle;
    const max = intField(session, "maxSessions");
    if (max !== undefined) api.session.maxSessions = max;
  }
  const sandbox = objectField(raw, "sandbox");
  if (sandbox) {
    const enabled = boolField(sandbox, "enabled");
    if (enabled !== undefined) api.sandbox.enabled = enabled;
    if (stringField(sandbox, "level")) {
      api.sandbox.level = stringField(sandbox, "level")!;
    }
  }
  const auth = objectField(raw, "auth");
  if (auth) {
    const enabled = boolField(auth, "enabled");
    if (enabled !== undefined) api.auth.enabled = enabled;
    if (Array.isArray(auth["tokens"])) {
      api.auth.tokens = (auth["tokens"] as unknown[]).filter(
        (v): v is string => typeof v === "string",
      );
    }
  }
  const requestTimeout = intField(raw, "requestTimeoutSeconds");
  if (requestTimeout !== undefined) api.requestTimeoutSeconds = requestTimeout;
  const bg = intField(raw, "backgroundRunMaxSeconds");
  if (bg !== undefined) api.backgroundRunMaxSeconds = bg;
  const maxConcurrent = intField(raw, "maxConcurrentRequests");
  if (maxConcurrent !== undefined) api.maxConcurrentRequests = maxConcurrent;
}

function decodeFeatures(cfg: ServeConfig, raw: Record<string, unknown>): void {
  for (
    const [field, set] of [
      ["webUI", (v: boolean) => cfg.features.webUI = v],
      ["openAIAPI", (v: boolean) => cfg.features.openAIAPI = v],
      ["wechat", (v: boolean) => cfg.features.wechat = v],
      ["feishu", (v: boolean) => cfg.features.feishu = v],
      ["multiAgent", (v: boolean) => cfg.features.multiAgent = v],
      ["cron", (v: boolean) => cfg.features.cron = v],
      ["memory", (v: boolean) => cfg.features.memory = v],
    ] as [string, (v: boolean) => void][]
  ) {
    const v = boolField(raw, field);
    if (v !== undefined) set(v);
  }
}

function decodeChannels(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const artifact = boolField(raw, "artifact");
  if (artifact !== undefined) cfg.channels.artifact = artifact;
  const wechat = objectField(raw, "wechat");
  if (wechat) {
    const w = cfg.channels.wechat;
    const enabled = boolField(wechat, "enabled");
    if (enabled !== undefined) w.enabled = enabled;
    const auto = boolField(wechat, "autoTyping") ??
      boolField(wechat, "auto_typing");
    if (auto !== undefined) w.autoTyping = auto;
    const cred = stringField(wechat, "credPath") ??
      stringField(wechat, "cred_path");
    if (cred) w.credPath = cred;
    const workDir = stringField(wechat, "workDir") ??
      stringField(wechat, "work_dir");
    if (workDir) w.workDir = workDir;
  }
  const feishu = objectField(raw, "feishu");
  if (feishu) {
    const f = cfg.channels.feishu;
    const enabled = boolField(feishu, "enabled");
    if (enabled !== undefined) f.enabled = enabled;
    const appId = stringField(feishu, "appId") ??
      stringField(feishu, "app_id");
    if (appId) f.appId = appId;
    const appSecret = stringField(feishu, "appSecret") ??
      stringField(feishu, "app_secret");
    if (appSecret) f.appSecret = appSecret;
    const workDir = stringField(feishu, "workDir") ??
      stringField(feishu, "work_dir");
    if (workDir) f.workDir = workDir;
  }
}

function decodeWebUI(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const enabled = boolField(raw, "enabled");
  if (enabled !== undefined) cfg.webUI.enabled = enabled;
  if (stringField(raw, "dir")) cfg.webUI.dir = stringField(raw, "dir")!;
}

function decodeCron(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const enabled = boolField(raw, "enabled");
  if (enabled !== undefined) cfg.cron.enabled = enabled;
  const interval = intField(raw, "interval");
  if (interval !== undefined) cfg.cron.interval = interval;
}

function decodeMemory(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const enabled = boolField(raw, "enabled");
  if (enabled !== undefined) cfg.memory.enabled = enabled;
  if (stringField(raw, "path")) cfg.memory.path = stringField(raw, "path")!;
}

function decodeSecurity(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const smart = boolField(raw, "smartApprovals") ??
    boolField(raw, "smart_approvals");
  if (smart !== undefined) cfg.security.smartApprovals = smart;
  if (Array.isArray(raw["allowedWorkDirs"])) {
    cfg.security.allowedWorkDirs = (raw["allowedWorkDirs"] as unknown[])
      .filter((v): v is string => typeof v === "string");
  } else if (Array.isArray(raw["allowed_work_dirs"])) {
    cfg.security.allowedWorkDirs = (raw["allowed_work_dirs"] as unknown[])
      .filter((v): v is string => typeof v === "string");
  }
}

function decodeHooks(cfg: ServeConfig, raw: Record<string, unknown>): void {
  if (stringField(raw, "preToolCall")) {
    cfg.hooks.preToolCall = stringField(raw, "preToolCall")!;
  }
  if (stringField(raw, "postToolCall")) {
    cfg.hooks.postToolCall = stringField(raw, "postToolCall")!;
  }
}

function decodeAgent(cfg: ServeConfig, raw: Record<string, unknown>): void {
  const a = cfg.agent;
  const maxTurns = intField(raw, "maxTurns") ?? intField(raw, "max_turns");
  if (maxTurns !== undefined) a.maxTurns = maxTurns;
  const budget = boolField(raw, "budgetPressure") ??
    boolField(raw, "budget_pressure");
  if (budget !== undefined) a.budgetPressure = budget;
  const context = boolField(raw, "contextPressure") ??
    boolField(raw, "context_pressure");
  if (context !== undefined) a.contextPressure = context;
  const budgetT = floatField(raw, "budgetPressureThreshold") ??
    floatField(raw, "budget_pressure_threshold");
  if (budgetT !== undefined) a.budgetPressureThreshold = budgetT;
  const contextT = floatField(raw, "contextPressureThreshold") ??
    floatField(raw, "context_pressure_threshold");
  if (contextT !== undefined) a.contextPressureThreshold = contextT;
  const stale = intField(raw, "runStaleTimeoutSeconds") ??
    intField(raw, "run_stale_timeout_secs");
  if (stale !== undefined) a.runStaleTimeoutSeconds = stale;
  const max = intField(raw, "runMaxDurationSeconds") ??
    intField(raw, "run_max_duration_secs");
  if (max !== undefined) a.runMaxDurationSeconds = max;
  const bg = intField(raw, "backgroundRunMaxSeconds") ??
    intField(raw, "background_run_max_secs");
  if (bg !== undefined) a.backgroundRunMaxSeconds = bg;
}

// ─── load / save ────────────────────────────────────────────────────────────

export function loadConfigFrom(p: string): ServeConfig {
  const cfg = defaultServeConfig();
  let data: string;
  try {
    data = Deno.readTextFileSync(p);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      normalizeServeConfig(cfg);
      return cfg;
    }
    throw new Error(`read serve config ${p}: ${(err as Error).message}`);
  }
  try {
    decodeConfigBytesInto(cfg, data);
  } catch (err) {
    throw new Error(`parse serve config ${p}: ${(err as Error).message}`);
  }
  normalizeServeConfig(cfg);
  return cfg;
}

export function loadServeConfig(): ServeConfig {
  const cfg = loadConfigFrom(configPath());
  try {
    const data = Deno.readTextFileSync(projectConfigPath());
    decodeConfigBytesInto(cfg, data);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new Error(
        `read project serve config ${projectConfigPath()}: ${
          (err as Error).message
        }`,
      );
    }
  }
  normalizeServeConfig(cfg);
  return cfg;
}

/** Serializes in the canonical rawConfig wire shape (Go MarshalJSON). */
export function serializeConfig(c: ServeConfig): unknown {
  normalizeServeConfig(c);
  const defaultWorkDir = c.api.defaultWorkDir !== ""
    ? c.api.defaultWorkDir
    : c.api.workingDir;
  return {
    listen: c.api.listen,
    provider: c.api.provider,
    model: c.api.model,
    mode: c.api.defaultMode,
    defaultWorkDir,
    auth: { enabled: c.api.auth.enabled, tokens: [...c.api.auth.tokens] },
    features: {
      webUI: c.features.webUI,
      openAIAPI: c.features.openAIAPI,
      wechat: c.features.wechat,
      feishu: c.features.feishu,
      multiAgent: c.features.multiAgent,
      cron: c.features.cron,
      memory: c.features.memory,
    },
    sandbox: {
      enabled: c.api.sandbox.enabled,
      ...(c.api.sandbox.level ? { level: c.api.sandbox.level } : {}),
    },
    ...(c.api.allowedWorkDirs !== undefined
      ? { allowedWorkDirs: [...c.api.allowedWorkDirs] }
      : {}),
    session: {
      idleTimeoutSeconds: c.api.session.idleTimeoutSeconds,
      maxSessions: c.api.session.maxSessions,
    },
    toolVisibility: {
      mode: c.api.toolVisibility.mode,
      detail: c.api.toolVisibility.detail,
    },
    thinking: c.api.defaultThinkingLevel,
    systemPromptMode: c.api.systemPromptMode,
    requestTimeoutSeconds: c.api.requestTimeoutSeconds,
    maxConcurrentRequests: c.api.maxConcurrentRequests,
    webSearch: c.api.enableWebSearch,
    browser: c.api.enableBrowser,
    artifact: c.api.enableArtifact,
    a2aMaster: c.api.enableA2AMaster,
    agent: {
      maxTurns: c.agent.maxTurns,
      budgetPressure: c.agent.budgetPressure,
      contextPressure: c.agent.contextPressure,
      budgetPressureThreshold: c.agent.budgetPressureThreshold,
      contextPressureThreshold: c.agent.contextPressureThreshold,
      runStaleTimeoutSeconds: c.agent.runStaleTimeoutSeconds,
      runMaxDurationSeconds: c.agent.runMaxDurationSeconds,
      backgroundRunMaxSeconds: c.agent.backgroundRunMaxSeconds,
    },
    webUI: { enabled: c.webUI.enabled, dir: c.webUI.dir },
    ...(c.lobsterMode ? { lobsterMode: true } : {}),
    cron: { enabled: c.cron.enabled, interval: c.cron.interval },
    memory: { enabled: c.memory.enabled, path: c.memory.path },
    security: {
      smartApprovals: c.security.smartApprovals,
      allowedWorkDirs: [...c.security.allowedWorkDirs],
    },
    hooks: {
      preToolCall: c.hooks.preToolCall,
      postToolCall: c.hooks.postToolCall,
    },
    channels: {
      artifact: c.channels.artifact,
      wechat: {
        enabled: c.channels.wechat.enabled,
        credPath: c.channels.wechat.credPath,
        workDir: c.channels.wechat.workDir,
        autoTyping: c.channels.wechat.autoTyping,
      },
      feishu: {
        enabled: c.channels.feishu.enabled,
        appId: c.channels.feishu.appId,
        appSecret: c.channels.feishu.appSecret,
        workDir: c.channels.feishu.workDir,
      },
    },
  };
}

export function saveServeConfig(p: string, cfg: ServeConfig): void {
  normalizeServeConfig(cfg);
  Deno.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  Deno.writeTextFileSync(
    p,
    JSON.stringify(serializeConfig(cfg), null, 2),
    { mode: 0o600 },
  );
}

// ─── legacy memory-focused surface (used by earlier slices) ─────────────────

/** @deprecated Use {@link defaultServeConfig}. */
export function defaultConfig(): ServeConfig {
  return defaultServeConfig();
}

/**
 * Loads the effective serve config. The global `serve.json` seeds the
 * defaults, then the project `serve.json` overlays present fields, matching
 * the Go `LoadConfig` order.
 */
export function loadConfig(): ServeConfig {
  return loadServeConfig();
}

/**
 * Reports whether serve memory is enabled. Matches `cfg.Features.Memory`
 * after normalization.
 */
export function memoryEnabled(): boolean {
  return loadConfig().memory.enabled;
}

// --- placeholder auth token (ports config.go's template-token helpers) --------

/** The API token written by `opensac serve init-config` (Go PlaceholderAuthToken). */
export const PLACEHOLDER_AUTH_TOKEN =
  "sk-change-me-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/** Go's PlaceholderAuthTokenWarning startup banner. */
export const PLACEHOLDER_AUTH_TOKEN_WARNING =
  `WARNING: serve.json ships the placeholder API token (${PLACEHOLDER_AUTH_TOKEN}),\n` +
  "         which is public. Replace api.auth.tokens before enabling auth or exposing this server.";

/** Reports whether token is the generated template value. */
export function isPlaceholderAuthToken(token: string): boolean {
  return token.trim() === PLACEHOLDER_AUTH_TOKEN;
}

/**
 * Reports whether the resolved config enables auth and still ships the
 * generated template token, which means the API is reachable with a publicly
 * known key.
 */
export function usesPlaceholderAuthToken(cfg: ServeConfig | null): boolean {
  if (cfg === null || !cfg.api.auth.enabled) return false;
  return cfg.api.auth.tokens.some((token) => isPlaceholderAuthToken(token));
}
