// Ported from internal/config/settings.go

import * as path from "@std/path";
import {
  configDir as platformConfigDirImpl,
  defaultEnvVars,
  defaultShell,
  deniedPaths as platformDeniedPaths,
  expandHome,
  isWindows,
  sandboxPaths,
  sessionDir as platformSessionDir,
  skillsDir as platformSkillsDir,
} from "../platform/platform.ts";
import type { Options as SandboxOptions } from "../sandbox/sandbox.ts";
import { Level } from "../sandbox/sandbox.ts";
import { defaultProviderConfigs } from "./provider_defaults.ts";
import { ProjectDirName, projectPath, projectPathFor } from "./paths.ts";

/** Controls whether config loading prints diagnostic messages to stderr. */
export let Verbose = false;

export function setVerbose(v: boolean): void {
  Verbose = v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types (field names follow the settings.json schema)
// ─────────────────────────────────────────────────────────────────────────────

export interface CostConfig {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCompat {
  thinkingFormat?: string;
  requiresReasoningContentOnAssistant?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  forceAdaptiveThinking?: boolean;
  parseReasoningInContent?: boolean;
  supportsDeveloperRole?: boolean;
  supportsStore?: boolean;
  supportsResponses?: boolean;
  supportsPreviousResponseId?: boolean;
  supportsConversation?: boolean;
  supportsBackground?: boolean;
  supportsStructuredOutput?: boolean;
  supportsServiceTier?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsToolChoice?: boolean;
  supportsHostedTools?: Record<string, boolean>;
  supportedInclude?: string[];
  supportsReasoningEffort?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: string;
  disableSamplingParams?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsReasoningSummary?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsEagerToolInputStreaming?: boolean;
}

export interface ModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  temperature?: number;
  top_p?: number;
  cost?: CostConfig;
  input?: string[];
  compat?: ModelCompat;
  /** Records which JSON keys were explicitly present (never serialized). */
  fieldSet?: Record<string, boolean>;
}

export interface ResponsesStructuredOutputConfig {
  name?: string;
  description?: string;
  strict?: boolean;
  schema?: unknown;
}

export interface ResponsesToolControlConfig {
  choice?: string;
  parallel?: boolean;
  maxCalls?: number;
}

export interface ResponsesHostedToolsConfig {
  webSearch?: Record<string, unknown>;
  fileSearch?: Record<string, unknown>;
  codeInterpreter?: Record<string, unknown>;
  computerUse?: Record<string, unknown>;
  imageGeneration?: Record<string, unknown>;
  remoteMCP?: Array<Record<string, unknown>>;
}

export interface ResponsesConfig {
  reasoningSummary?: string;
  reasoningContext?: string;
  reasoningMode?: string;
  promptCacheEnabled?: boolean;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  promptCacheMode?: string;
  promptCacheTTL?: string;
  safetyIdentifier?: string;
  metadata?: Record<string, string>;
  stateMode?: string;
  store?: boolean;
  conversation?: string;
  truncation?: string;
  background?: boolean;
  include?: string[];
  serviceTier?: string;
  structuredOutput?: ResponsesStructuredOutputConfig;
  toolControl?: ResponsesToolControlConfig;
  hostedTools?: ResponsesHostedToolsConfig;
}

export interface ProviderConfig {
  vendor?: string;
  apiKey?: string;
  baseUrl?: string;
  httpProxy?: string;
  forceHTTP11?: boolean;
  headers?: Record<string, string>;
  api?: string;
  thinkingFormat?: string;
  cacheControl?: boolean;
  maxImagesPerRequest?: number;
  responses?: ResponsesConfig;
  models: ModelConfig[];
  /** Records which JSON keys were explicitly present (never serialized). */
  fieldSet?: Record<string, boolean>;
}

export interface ToolExecutionSettings {
  mode?: string;
  maxConcurrency?: number;
}

export interface WebSearchSettings {
  enabled?: boolean;
  provider?: string;
  providerType?: string;
  model?: string;
}

export interface ImageGenerationSettings {
  enabled?: boolean;
  provider?: string;
  apiType?: string;
  baseUrl?: string;
  token?: string;
  model?: string;
}

export interface SkillHubMarketSettings {
  id: string;
  name?: string;
  siteURL?: string;
  apiURL?: string;
  enabled: boolean;
  apiToken?: string;
}

export interface SkillHubSettings {
  defaultMarket?: string;
  defaultInstallScope?: string;
  officialHandles?: string[];
  markets?: SkillHubMarketSettings[];
}

export interface StatusLineSettings {
  enabled?: boolean;
  type?: string;
  command?: string;
  padding?: number;
  refreshInterval?: number;
  timeoutMs?: number;
  fallback?: string;
}

export interface ContextFilesSettings {
  enabled: boolean;
  extraFiles?: string[];
}

export interface SkillsSettings {
  disabled?: string[];
}

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  tokenizer?: string;
  tokenizerModel?: string;
  template?: string;
}

export interface SandboxSettings {
  enabled: boolean;
  level: string;
  bwrapPath?: string;
  allowNetwork: boolean;
  allowedRead?: string[];
  allowedWrite?: string[];
  deniedPaths?: string[];
  passEnv?: string[];
  tmpSize?: string;
  protectGit?: boolean;
}

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export interface ApprovalSettings {
  bashWhitelist?: string[];
  bashBlacklist?: string[];
  confirmBeforeWrite?: boolean;
}

export interface MaintenanceSettings {
  reclaimAttachmentStorage?: boolean;
  storageReconcileSchedule?: string;
}

export interface Settings {
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  defaultMode?: string;
  authored?: boolean;
  tuilang?: string;
  toolExecution?: ToolExecutionSettings;
  statusLine?: StatusLineSettings;
  enablePlanTool?: boolean;
  enableArtifact?: boolean;
  enableACPArtifact?: boolean;
  webSearch?: WebSearchSettings;
  imageGeneration?: ImageGenerationSettings;
  maxContextTokens?: number;
  contextFiles?: ContextFilesSettings;
  skillsDir?: string;
  skills?: SkillsSettings;
  skillHub?: SkillHubSettings;
  compaction?: CompactionSettings;
  sandbox?: SandboxSettings;
  sessionDir?: string;
  shellPath?: string;
  shellCommandPrefix?: string;
  theme?: string;
  retry?: RetrySettings;
  approval?: ApprovalSettings;
  maintenance?: MaintenanceSettings;
  updateCheck?: boolean;
}

/** Default number of local tool calls that may run concurrently per turn. */
export const DefaultToolExecutionMaxConcurrency = 10;

/** Default official SkillHub handle. */
export const DefaultSkillHubOfficialHandle = "user_0064faa7";

/** Returns a pointer-equivalent for a bool value. */
export function BoolPtr(v: boolean): boolean {
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clone helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a deep copy of a string map, or undefined if src is undefined. */
export function cloneStringMap(
  src: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return src === undefined ? undefined : { ...src };
}

/** Returns a copy of a string slice, or undefined if src is undefined. */
export function cloneStringSlice(
  src: string[] | undefined,
): string[] | undefined {
  return src === undefined ? undefined : [...src];
}

/** Returns a copy of a bool pointer, or undefined if src is undefined. */
export function cloneBoolPtr(src: boolean | undefined): boolean | undefined {
  return src === undefined ? undefined : src;
}

/** Returns a copy of a float pointer, or undefined if src is undefined. */
export function cloneFloat64Ptr(
  src: number | undefined,
): number | undefined {
  return src === undefined ? undefined : src;
}

/**
 * Returns undefined if src is zero; otherwise returns a copy of src. This stops
 * zero-valued temperature/top_p from being serialized to API requests.
 */
export function normalizeSamplingPtr(
  src: number | undefined,
): number | undefined {
  if (src === undefined || src === 0) return undefined;
  return src;
}

function cloneFieldSet(
  src: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  return src === undefined ? undefined : { ...src };
}

function cloneModelCompat(
  src: ModelCompat | undefined,
): ModelCompat | undefined {
  if (src === undefined) return undefined;
  return {
    ...src,
    supportsHostedTools: cloneBoolMap(src.supportsHostedTools),
    supportedInclude: cloneStringSlice(src.supportedInclude),
  };
}

function cloneBoolMap(
  src: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  return src === undefined ? undefined : { ...src };
}

function cloneResponsesConfig(src: ResponsesConfig): ResponsesConfig {
  return {
    ...src,
    metadata: cloneStringMap(src.metadata),
    include: cloneStringSlice(src.include),
    structuredOutput: src.structuredOutput
      ? { ...src.structuredOutput }
      : undefined,
    toolControl: src.toolControl ? { ...src.toolControl } : undefined,
    hostedTools: src.hostedTools
      ? {
        ...src.hostedTools,
        webSearch: cloneAnyMap(src.hostedTools.webSearch),
        fileSearch: cloneAnyMap(src.hostedTools.fileSearch),
        codeInterpreter: cloneAnyMap(src.hostedTools.codeInterpreter),
        computerUse: cloneAnyMap(src.hostedTools.computerUse),
        imageGeneration: cloneAnyMap(src.hostedTools.imageGeneration),
        remoteMCP: cloneAnyMapSlice(src.hostedTools.remoteMCP),
      }
      : undefined,
  };
}

function cloneAnyMap(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (src === undefined) return undefined;
  return JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
}

function cloneAnyMapSlice(
  src: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (src === undefined) return undefined;
  return src.map((m) => cloneAnyMap(m) ?? {});
}

function cloneModelConfig(src: ModelConfig): ModelConfig {
  return {
    ...src,
    temperature: cloneFloat64Ptr(src.temperature),
    top_p: cloneFloat64Ptr(src.top_p),
    cost: src.cost ? { ...src.cost } : undefined,
    input: cloneStringSlice(src.input),
    compat: cloneModelCompat(src.compat),
    fieldSet: cloneFieldSet(src.fieldSet),
  };
}

function cloneModelConfigs(
  src: ModelConfig[] | undefined,
): ModelConfig[] | undefined {
  return src === undefined ? undefined : src.map(cloneModelConfig);
}

function cloneProviderConfig(
  src: ProviderConfig | undefined,
): ProviderConfig | undefined {
  if (src === undefined) return undefined;
  return {
    ...src,
    headers: cloneStringMap(src.headers),
    responses: src.responses ? cloneResponsesConfig(src.responses) : undefined,
    models: cloneModelConfigs(src.models) ?? [],
    fieldSet: cloneFieldSet(src.fieldSet),
  };
}

function cloneProviderConfigs(
  src: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = {};
  for (const [name, pc] of Object.entries(src)) {
    out[name] = cloneProviderConfig(pc)!;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the full runtime defaults, including built-in provider presets. */
export function defaultSettings(): Settings {
  return {
    providers: cloneProviderConfigs(defaultProviderConfigs),
    defaultProvider: "deepseek-openai",
    defaultModel: "deepseek-v4-flash",
    defaultThinkingLevel: "medium",
    defaultMode: "yolo",
    authored: false,
    tuilang: "auto",
    toolExecution: {
      mode: "parallel",
      maxConcurrency: DefaultToolExecutionMaxConcurrency,
    },
    statusLine: {
      enabled: false,
      type: "command",
      padding: 0,
      timeoutMs: 800,
      fallback: "builtin",
    },
    enablePlanTool: true,
    enableArtifact: false,
    enableACPArtifact: false,
    webSearch: {
      enabled: false,
      provider: "openai",
      providerType: "openai-responses",
    },
    imageGeneration: {
      enabled: false,
      provider: "openai",
      apiType: "openai-images",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-image-1",
    },
    contextFiles: { enabled: true },
    skillsDir: platformSkillsDir(),
    skillHub: {
      defaultMarket: "skillhub.cn",
      defaultInstallScope: "project",
      officialHandles: [DefaultSkillHubOfficialHandle],
    },
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    },
    sandbox: {
      enabled: false,
      level: "none",
      allowNetwork: false,
      allowedRead: sandboxPaths(),
      deniedPaths: platformDeniedPaths(),
      passEnv: defaultEnvVars(),
      tmpSize: "100m",
      protectGit: true,
    },
    sessionDir: platformSessionDir(),
    theme: "dark",
    retry: { enabled: true, maxRetries: 5, baseDelayMs: 3000 },
    approval: {
      bashWhitelist: [
        "go ",
        "make ",
        "git ",
        "npm ",
        "yarn ",
        "node ",
        "python ",
        "pip ",
      ],
      confirmBeforeWrite: true,
    },
  };
}

/** Returns the defaults used for a newly created settings.json (no providers). */
function defaultSettingsFile(): Settings {
  const s = defaultSettings();
  s.providers = undefined;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization
// ─────────────────────────────────────────────────────────────────────────────

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (v === "" || v === 0 || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function put(o: Record<string, unknown>, k: string, v: unknown): void {
  if (v !== undefined) o[k] = v;
}

function putNonEmpty(
  o: Record<string, unknown>,
  k: string,
  v: unknown,
): void {
  if (!isEmptyValue(v)) o[k] = v;
}

function jsonCost(c: CostConfig): Record<string, unknown> {
  const o: Record<string, unknown> = { input: c.input, output: c.output };
  putNonEmpty(o, "cacheRead", c.cacheRead);
  putNonEmpty(o, "cacheWrite", c.cacheWrite);
  return o;
}

function jsonCompat(m: ModelCompat): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "thinkingFormat", m.thinkingFormat);
  putNonEmpty(
    o,
    "requiresReasoningContentOnAssistant",
    m.requiresReasoningContentOnAssistant,
  );
  putNonEmpty(
    o,
    "requiresReasoningContentOnAssistantMessages",
    m.requiresReasoningContentOnAssistantMessages,
  );
  putNonEmpty(o, "forceAdaptiveThinking", m.forceAdaptiveThinking);
  putNonEmpty(o, "parseReasoningInContent", m.parseReasoningInContent);
  put(o, "supportsDeveloperRole", m.supportsDeveloperRole);
  put(o, "supportsStore", m.supportsStore);
  put(o, "supportsResponses", m.supportsResponses);
  put(o, "supportsPreviousResponseId", m.supportsPreviousResponseId);
  put(o, "supportsConversation", m.supportsConversation);
  put(o, "supportsBackground", m.supportsBackground);
  put(o, "supportsStructuredOutput", m.supportsStructuredOutput);
  put(o, "supportsServiceTier", m.supportsServiceTier);
  put(o, "supportsParallelToolCalls", m.supportsParallelToolCalls);
  put(o, "supportsToolChoice", m.supportsToolChoice);
  putNonEmpty(o, "supportsHostedTools", m.supportsHostedTools);
  putNonEmpty(o, "supportedInclude", m.supportedInclude);
  put(o, "supportsReasoningEffort", m.supportsReasoningEffort);
  put(o, "supportsStrictMode", m.supportsStrictMode);
  putNonEmpty(o, "maxTokensField", m.maxTokensField);
  put(o, "disableSamplingParams", m.disableSamplingParams);
  put(o, "supportsCacheControlOnTools", m.supportsCacheControlOnTools);
  put(o, "supportsLongCacheRetention", m.supportsLongCacheRetention);
  put(o, "supportsPromptCacheKey", m.supportsPromptCacheKey);
  put(o, "supportsReasoningSummary", m.supportsReasoningSummary);
  putNonEmpty(o, "sendSessionAffinityHeaders", m.sendSessionAffinityHeaders);
  put(o, "supportsEagerToolInputStreaming", m.supportsEagerToolInputStreaming);
  return o;
}

function jsonModel(c: ModelConfig): Record<string, unknown> {
  const o: Record<string, unknown> = { id: c.id, name: c.name };
  putNonEmpty(o, "reasoning", c.reasoning);
  putNonEmpty(o, "contextWindow", c.contextWindow);
  if (
    c.maxTokens !== undefined &&
    (c.maxTokens > 0 || configFieldWasSet(c.fieldSet, "maxTokens"))
  ) {
    o.maxTokens = c.maxTokens;
  }
  put(o, "temperature", c.temperature);
  put(o, "top_p", c.top_p);
  if (c.cost !== undefined) o.cost = jsonCost(c.cost);
  putNonEmpty(o, "input", c.input);
  if (c.compat !== undefined) o.compat = jsonCompat(c.compat);
  return o;
}

function jsonResponses(r: ResponsesConfig): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "reasoningSummary", r.reasoningSummary);
  putNonEmpty(o, "reasoningContext", r.reasoningContext);
  putNonEmpty(o, "reasoningMode", r.reasoningMode);
  put(o, "promptCacheEnabled", r.promptCacheEnabled);
  putNonEmpty(o, "promptCacheKey", r.promptCacheKey);
  putNonEmpty(o, "promptCacheRetention", r.promptCacheRetention);
  putNonEmpty(o, "promptCacheMode", r.promptCacheMode);
  putNonEmpty(o, "promptCacheTTL", r.promptCacheTTL);
  putNonEmpty(o, "safetyIdentifier", r.safetyIdentifier);
  putNonEmpty(o, "metadata", r.metadata);
  putNonEmpty(o, "stateMode", r.stateMode);
  put(o, "store", r.store);
  putNonEmpty(o, "conversation", r.conversation);
  putNonEmpty(o, "truncation", r.truncation);
  put(o, "background", r.background);
  putNonEmpty(o, "include", r.include);
  putNonEmpty(o, "serviceTier", r.serviceTier);
  if (r.structuredOutput !== undefined) {
    const so = r.structuredOutput;
    const jo: Record<string, unknown> = {};
    putNonEmpty(jo, "name", so.name);
    putNonEmpty(jo, "description", so.description);
    put(jo, "strict", so.strict);
    putNonEmpty(jo, "schema", so.schema);
    if (!isEmptyValue(jo)) o.structuredOutput = jo;
  }
  if (r.toolControl !== undefined) {
    const tc = r.toolControl;
    const jo: Record<string, unknown> = {};
    putNonEmpty(jo, "choice", tc.choice);
    put(jo, "parallel", tc.parallel);
    putNonEmpty(jo, "maxCalls", tc.maxCalls);
    if (!isEmptyValue(jo)) o.toolControl = jo;
  }
  if (r.hostedTools !== undefined) {
    const ht = r.hostedTools;
    const jo: Record<string, unknown> = {};
    putNonEmpty(jo, "webSearch", ht.webSearch);
    putNonEmpty(jo, "fileSearch", ht.fileSearch);
    putNonEmpty(jo, "codeInterpreter", ht.codeInterpreter);
    putNonEmpty(jo, "computerUse", ht.computerUse);
    putNonEmpty(jo, "imageGeneration", ht.imageGeneration);
    putNonEmpty(jo, "remoteMCP", ht.remoteMCP);
    if (!isEmptyValue(jo)) o.hostedTools = jo;
  }
  return o;
}

function jsonProvider(c: ProviderConfig): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "vendor", c.vendor);
  putNonEmpty(o, "apiKey", c.apiKey);
  putNonEmpty(o, "baseUrl", c.baseUrl);
  putNonEmpty(o, "httpProxy", c.httpProxy);
  putNonEmpty(o, "forceHTTP11", c.forceHTTP11);
  putNonEmpty(o, "headers", c.headers);
  putNonEmpty(o, "api", c.api);
  putNonEmpty(o, "thinkingFormat", c.thinkingFormat);
  put(o, "cacheControl", c.cacheControl);
  putNonEmpty(o, "maxImagesPerRequest", c.maxImagesPerRequest);
  if (c.responses !== undefined && responsesConfigHasValues(c.responses)) {
    o.responses = jsonResponses(c.responses);
  }
  o.models = (c.models ?? []).map(jsonModel);
  return o;
}

function jsonToolExecution(t: ToolExecutionSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "mode", t.mode);
  putNonEmpty(o, "maxConcurrency", t.maxConcurrency);
  return o;
}

function jsonWebSearch(w: WebSearchSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  put(o, "enabled", w.enabled);
  putNonEmpty(o, "provider", w.provider);
  putNonEmpty(o, "providerType", w.providerType);
  putNonEmpty(o, "model", w.model);
  return o;
}

function jsonImageGeneration(
  g: ImageGenerationSettings,
): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  put(o, "enabled", g.enabled);
  putNonEmpty(o, "provider", g.provider);
  putNonEmpty(o, "apiType", g.apiType);
  putNonEmpty(o, "baseUrl", g.baseUrl);
  putNonEmpty(o, "token", g.token);
  putNonEmpty(o, "model", g.model);
  return o;
}

function jsonSkillHub(h: SkillHubSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "defaultMarket", h.defaultMarket);
  putNonEmpty(o, "defaultInstallScope", h.defaultInstallScope);
  putNonEmpty(o, "officialHandles", h.officialHandles);
  putNonEmpty(o, "markets", h.markets);
  return o;
}

function jsonStatusLine(s: StatusLineSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "enabled", s.enabled);
  putNonEmpty(o, "type", s.type);
  putNonEmpty(o, "command", s.command);
  putNonEmpty(o, "padding", s.padding);
  putNonEmpty(o, "refreshInterval", s.refreshInterval);
  putNonEmpty(o, "timeoutMs", s.timeoutMs);
  putNonEmpty(o, "fallback", s.fallback);
  return o;
}

function jsonContextFiles(c: ContextFilesSettings): Record<string, unknown> {
  const o: Record<string, unknown> = { enabled: c.enabled };
  putNonEmpty(o, "extraFiles", c.extraFiles);
  return o;
}

function jsonCompaction(c: CompactionSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {
    enabled: c.enabled,
    reserveTokens: c.reserveTokens,
    keepRecentTokens: c.keepRecentTokens,
  };
  putNonEmpty(o, "tokenizer", c.tokenizer);
  putNonEmpty(o, "tokenizerModel", c.tokenizerModel);
  putNonEmpty(o, "template", c.template);
  return o;
}

function jsonSandbox(s: SandboxSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {
    enabled: s.enabled,
    level: s.level,
    allowNetwork: s.allowNetwork,
  };
  putNonEmpty(o, "bwrapPath", s.bwrapPath);
  putNonEmpty(o, "allowedRead", s.allowedRead);
  putNonEmpty(o, "allowedWrite", s.allowedWrite);
  putNonEmpty(o, "deniedPaths", s.deniedPaths);
  putNonEmpty(o, "passEnv", s.passEnv);
  putNonEmpty(o, "tmpSize", s.tmpSize);
  putNonEmpty(o, "protectGit", s.protectGit);
  return o;
}

function jsonRetry(r: RetrySettings): Record<string, unknown> {
  return {
    enabled: r.enabled,
    maxRetries: r.maxRetries,
    baseDelayMs: r.baseDelayMs,
  };
}

function jsonApproval(a: ApprovalSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  putNonEmpty(o, "bashWhitelist", a.bashWhitelist);
  putNonEmpty(o, "bashBlacklist", a.bashBlacklist);
  put(o, "confirmBeforeWrite", a.confirmBeforeWrite);
  return o;
}

function jsonMaintenance(m: MaintenanceSettings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  put(o, "reclaimAttachmentStorage", m.reclaimAttachmentStorage);
  putNonEmpty(o, "storageReconcileSchedule", m.storageReconcileSchedule);
  return o;
}

function jsonSettings(s: Settings): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (s.providers && Object.keys(s.providers).length > 0) {
    const providers: Record<string, unknown> = {};
    for (const [id, pc] of Object.entries(s.providers)) {
      providers[id] = jsonProvider(pc);
    }
    o.providers = providers;
  }
  putNonEmpty(o, "defaultProvider", s.defaultProvider);
  putNonEmpty(o, "defaultModel", s.defaultModel);
  putNonEmpty(o, "defaultThinkingLevel", s.defaultThinkingLevel);
  putNonEmpty(o, "defaultMode", s.defaultMode);
  putNonEmpty(o, "authored", s.authored);
  putNonEmpty(o, "tuilang", s.tuilang);
  if (
    s.toolExecution !== undefined &&
    (s.toolExecution.mode || s.toolExecution.maxConcurrency)
  ) {
    o.toolExecution = jsonToolExecution(s.toolExecution);
  }
  if (s.statusLine !== undefined) {
    const j = jsonStatusLine(s.statusLine);
    if (!isEmptyValue(j)) o.statusLine = j;
  }
  put(o, "enablePlanTool", s.enablePlanTool);
  put(o, "enableArtifact", s.enableArtifact);
  put(o, "enableACPArtifact", s.enableACPArtifact);
  o.webSearch = jsonWebSearch(s.webSearch ?? {});
  o.imageGeneration = jsonImageGeneration(s.imageGeneration ?? {});
  putNonEmpty(o, "maxContextTokens", s.maxContextTokens);
  o.contextFiles = jsonContextFiles(s.contextFiles ?? { enabled: false });
  putNonEmpty(o, "skillsDir", s.skillsDir);
  if (s.skills !== undefined) {
    const j: Record<string, unknown> = {};
    putNonEmpty(j, "disabled", s.skills.disabled);
    o.skills = j;
  }
  if (s.skillHub !== undefined) {
    const j = jsonSkillHub(s.skillHub);
    if (!isEmptyValue(j)) o.skillHub = j;
  }
  o.compaction = jsonCompaction(
    s.compaction ?? { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  );
  o.sandbox = jsonSandbox(
    s.sandbox ?? { enabled: false, level: "", allowNetwork: false },
  );
  putNonEmpty(o, "sessionDir", s.sessionDir);
  putNonEmpty(o, "shellPath", s.shellPath);
  putNonEmpty(o, "shellCommandPrefix", s.shellCommandPrefix);
  putNonEmpty(o, "theme", s.theme);
  o.retry = jsonRetry(
    s.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  );
  o.approval = jsonApproval(s.approval ?? {});
  if (s.maintenance !== undefined) {
    const j = jsonMaintenance(s.maintenance);
    if (!isEmptyValue(j)) o.maintenance = j;
  }
  put(o, "updateCheck", s.updateCheck);
  return o;
}

/** Serializes settings to JSON matching the Go MarshalJSON contract. */
export function marshalSettings(s: Settings): string {
  return JSON.stringify(jsonSettings(s), null, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_SCALAR_KEYS = new Set([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "defaultMode",
  "authored",
  "tuilang",
  "enablePlanTool",
  "enableArtifact",
  "enableACPArtifact",
  "maxContextTokens",
  "skillsDir",
  "sessionDir",
  "shellPath",
  "shellCommandPrefix",
  "theme",
  "updateCheck",
]);

const SETTINGS_OBJECT_KEYS: Record<string, Set<string>> = {
  toolExecution: new Set(["mode", "maxConcurrency"]),
  statusLine: new Set([
    "enabled",
    "type",
    "command",
    "padding",
    "refreshInterval",
    "timeoutMs",
    "fallback",
  ]),
  webSearch: new Set(["enabled", "provider", "providerType", "model"]),
  imageGeneration: new Set([
    "enabled",
    "provider",
    "apiType",
    "baseUrl",
    "token",
    "model",
  ]),
  contextFiles: new Set(["enabled", "extraFiles"]),
  skills: new Set(["disabled"]),
  skillHub: new Set([
    "defaultMarket",
    "defaultInstallScope",
    "officialHandles",
    "markets",
  ]),
  compaction: new Set([
    "enabled",
    "reserveTokens",
    "keepRecentTokens",
    "tokenizer",
    "tokenizerModel",
    "template",
  ]),
  sandbox: new Set([
    "enabled",
    "level",
    "bwrapPath",
    "allowNetwork",
    "allowedRead",
    "allowedWrite",
    "deniedPaths",
    "passEnv",
    "tmpSize",
    "protectGit",
  ]),
  retry: new Set(["enabled", "maxRetries", "baseDelayMs"]),
  approval: new Set(["bashWhitelist", "bashBlacklist", "confirmBeforeWrite"]),
  maintenance: new Set([
    "reclaimAttachmentStorage",
    "storageReconcileSchedule",
  ]),
};

const PROVIDER_KEYS = new Set([
  "vendor",
  "apiKey",
  "baseUrl",
  "httpProxy",
  "forceHTTP11",
  "headers",
  "api",
  "thinkingFormat",
  "cacheControl",
  "maxImagesPerRequest",
  "responses",
  "models",
]);

function parseModelConfig(raw: Record<string, unknown>): ModelConfig {
  const fieldSet: Record<string, boolean> = {};
  for (const k of Object.keys(raw)) fieldSet[k] = true;
  const mc: ModelConfig = {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
  };
  if (typeof raw.reasoning === "boolean") mc.reasoning = raw.reasoning;
  if (typeof raw.contextWindow === "number") {
    mc.contextWindow = raw.contextWindow;
  }
  if (typeof raw.maxTokens === "number") mc.maxTokens = raw.maxTokens;
  if (typeof raw.temperature === "number") mc.temperature = raw.temperature;
  if (typeof raw.top_p === "number") mc.top_p = raw.top_p;
  if (raw.cost !== null && typeof raw.cost === "object") {
    mc.cost = raw.cost as CostConfig;
  }
  if (Array.isArray(raw.input)) mc.input = raw.input as string[];
  if (raw.compat !== null && typeof raw.compat === "object") {
    mc.compat = raw.compat as ModelCompat;
  }
  mc.fieldSet = fieldSet;
  return mc;
}

function parseProviderConfigInto(
  pc: ProviderConfig,
  raw: Record<string, unknown>,
): void {
  const fieldSet: Record<string, boolean> = {};
  for (const k of Object.keys(raw)) fieldSet[k] = true;

  for (const k of Object.keys(raw)) {
    if (!PROVIDER_KEYS.has(k) || k === "models") continue;
    const v = raw[k];
    if (v === null || v === undefined) continue;
    (pc as unknown as Record<string, unknown>)[k] = v;
  }
  if ("models" in raw && Array.isArray(raw.models)) {
    pc.models = (raw.models as Array<Record<string, unknown>>).map(
      parseModelConfig,
    );
  }
  pc.fieldSet = fieldSet;
}

function mergeObjectInto(
  target: Record<string, unknown> | undefined,
  raw: unknown,
  keys: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = target ? { ...target } : {};
  if (raw !== null && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!keys.has(k) || v === null || v === undefined) continue;
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parses `data` over `base` and returns a new Settings value. Mirrors the Go
 * custom UnmarshalJSON: providers merge per-entry, nested objects merge
 * field-by-field, and explicit JSON keys are recorded for merge semantics.
 */
export function parseSettings(
  base: Settings,
  data: string | Record<string, unknown>,
): Settings {
  const raw = typeof data === "string"
    ? JSON.parse(data) as Record<string, unknown>
    : data;

  const result: Settings = {
    ...base,
    providers: base.providers ? { ...base.providers } : undefined,
  };

  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (SETTINGS_SCALAR_KEYS.has(k)) {
      (result as Record<string, unknown>)[k] = v;
      continue;
    }
    const objectKeys = SETTINGS_OBJECT_KEYS[k];
    if (objectKeys) {
      (result as Record<string, unknown>)[k] = mergeObjectInto(
        (result as Record<string, unknown>)[k] as
          | Record<string, unknown>
          | undefined,
        v,
        objectKeys,
      );
    }
  }

  const providersRaw = raw["providers"];
  if (providersRaw !== null && typeof providersRaw === "object") {
    if (!result.providers) result.providers = {};
    for (
      const [id, pd] of Object.entries(
        providersRaw as Record<string, unknown>,
      )
    ) {
      let pc = result.providers[id];
      if (!pc) pc = { models: [] };
      parseProviderConfigInto(pc, (pd ?? {}) as Record<string, unknown>);
      result.providers[id] = pc;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the process-wide configuration directory. */
export function configDir(): string {
  return platformConfigDirImpl();
}

/** Returns the global settings.json path. */
export function globalSettingsPath(): string {
  return path.join(configDir(), "settings.json");
}

/** Returns the project-level settings.json path. */
export function projectSettingsPath(): string {
  return projectPath("settings.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

function readTextFileIfExists(p: string): string | undefined {
  try {
    return Deno.readTextFileSync(p);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

function applyEnvOverrides(s: Settings): void {
  const provider = Deno.env.get("VIBECODING_PROVIDER") ?? "";
  if (provider !== "") s.defaultProvider = provider;
  const model = Deno.env.get("VIBECODING_MODEL") ?? "";
  if (model !== "") s.defaultModel = model;
  const mode = Deno.env.get("VIBECODING_MODE") ?? "";
  if (mode !== "") s.defaultMode = mode;
  const thinking = Deno.env.get("VIBECODING_THINKING") ?? "";
  if (thinking !== "") s.defaultThinkingLevel = thinking;
}

/** Loads settings, creating the global file if needed. */
export function loadSettings(): Settings {
  return loadSettingsWithMeta().settings;
}

/**
 * Loads the same settings schema as loadSettings, but applies project settings
 * from `cwd` instead of the process working directory. It is intentionally
 * side-effect free.
 */
export function loadSettingsFor(cwd: string): Settings {
  if (cwd === "") cwd = ".";
  let s = defaultSettings();
  const globalPath = globalSettingsPath();
  const globalData = readTextFileIfExists(globalPath);
  if (globalData !== undefined) {
    try {
      s = parseSettings(s, globalData);
    } catch (err) {
      throw new Error(
        `parse global settings ${globalPath}: ${(err as Error).message}`,
      );
    }
  }

  const projectPathValue = projectPathFor(cwd, "settings.json");
  const projectData = readTextFileIfExists(projectPathValue);
  if (projectData !== undefined) {
    try {
      s = parseSettings(s, projectData);
    } catch (err) {
      throw new Error(
        `parse project settings ${projectPathValue}: ${(err as Error).message}`,
      );
    }
  }

  applyEnvOverrides(s);
  return s;
}

/** Describes side effects and paths from settings loading. */
export interface LoadMeta {
  createdGlobalConfig: boolean;
  globalSettingsPath: string;
}

/** Loads settings and reports whether the global settings file was created. */
export function loadSettingsWithMeta(): {
  settings: Settings;
  meta: LoadMeta;
} {
  let s = defaultSettings();
  const meta: LoadMeta = {
    createdGlobalConfig: false,
    globalSettingsPath: globalSettingsPath(),
  };

  try {
    meta.createdGlobalConfig = ensureConfigExists();
  } catch (err) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(`Warning: could not create config: ${err}\n`),
    );
  }

  const globalPath = globalSettingsPath();
  if (Verbose) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `[config] Loading global settings: ${globalPath}\n`,
      ),
    );
  }
  const globalData = readTextFileIfExists(globalPath);
  if (globalData !== undefined) {
    try {
      s = parseSettings(s, globalData);
    } catch (err) {
      backupCorruptSettings(globalPath);
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          `Warning: invalid global settings backed up; using defaults: ${err}\n`,
        ),
      );
    }
  }

  const projectPathValue = projectSettingsPath();
  const projectData = readTextFileIfExists(projectPathValue);
  if (projectData !== undefined) {
    try {
      s = parseSettings(s, projectData);
    } catch (err) {
      backupCorruptSettings(projectPathValue);
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          `Warning: invalid project settings backed up and ignored: ${err}\n`,
        ),
      );
    }
  } else if (Verbose) {
    if (readTextFileIfExists(projectPath("setting.json")) !== undefined) {
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          `[config] Found ${
            projectPath("setting.json")
          } (singular) — expected ${projectPathValue} (plural). Please rename the file.\n`,
        ),
      );
    }
  }

  applyEnvOverrides(s);
  return { settings: s, meta };
}

function backupCorruptSettings(p: string): string {
  const absolutePath = path.resolve(p);
  const stamp = formatStamp(new Date());
  let backupPath = `${absolutePath}.bak_${stamp}`;
  for (let i = 1;; i++) {
    if (!existsSync(backupPath)) break;
    backupPath = `${absolutePath}.bak_${stamp}_${i}`;
  }
  Deno.renameSync(absolutePath, backupPath);
  Deno.stderr.writeSync(
    new TextEncoder().encode(
      `Warning: corrupt settings backed up to ${backupPath}\n`,
    ),
  );
  return backupPath;
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${
    pad(d.getHours())
  }${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function existsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureConfigExists(): boolean {
  const dir = configDir();
  const settingsPath = globalSettingsPath();
  if (existsSync(settingsPath)) return false;

  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = marshalSettings(defaultSettingsFile());
  Deno.writeTextFileSync(settingsPath, data, { mode: 0o600 });
  Deno.stderr.writeSync(
    new TextEncoder().encode(`Created default config: ${settingsPath}\n`),
  );
  return true;
}

/**
 * Loads only the global settings file over defaults. It does not apply project
 * settings or environment overrides.
 */
export function loadGlobalSettingsOrDefault(): Settings {
  let s = defaultSettings();
  const globalPath = globalSettingsPath();
  const data = readTextFileIfExists(globalPath);
  if (data !== undefined) {
    try {
      s = parseSettings(s, data);
    } catch (err) {
      throw new Error(`parse global settings: ${(err as Error).message}`);
    }
  }
  return s;
}

/**
 * Loads only fields explicitly present in the global settings file. Missing
 * files yield an empty Settings.
 */
export function loadGlobalSettingsSparse(): Settings {
  const s: Settings = {};
  const globalPath = globalSettingsPath();
  const data = readTextFileIfExists(globalPath);
  if (data !== undefined) {
    try {
      const parsed = parseSettings(s, data);
      Object.assign(s, parsed);
    } catch (err) {
      throw new Error(`parse global settings: ${(err as Error).message}`);
    }
  }
  if (!s.providers) s.providers = {};
  return s;
}

/** Loads only fields explicitly present in the project settings file. */
export function loadProjectSettingsSparse(): Settings {
  const s: Settings = {};
  const projectPathValue = projectSettingsPath();
  const data = readTextFileIfExists(projectPathValue);
  if (data !== undefined) {
    try {
      const parsed = parseSettings(s, data);
      Object.assign(s, parsed);
      s.providers = parsed.providers ?? {};
    } catch (err) {
      throw new Error(`parse project settings: ${(err as Error).message}`);
    }
  }
  if (!s.providers) s.providers = {};
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saving
// ─────────────────────────────────────────────────────────────────────────────

/** Writes settings.json atomically with private permissions. */
export function saveGlobalSettings(s: Settings): void {
  if (!s) throw new Error("settings is nil");
  const data = marshalSettings(s);
  writeGlobalSettingsData(data);
}

/**
 * Updates only the given top-level keys in the global settings file, preserving
 * existing keys without expanding defaults.
 */
export function saveGlobalSettingsPatch(
  updates: Record<string, unknown>,
): void {
  if (Object.keys(updates).length === 0) return;
  const settingsPath = globalSettingsPath();
  let existing: Record<string, unknown> = {};
  const data = readTextFileIfExists(settingsPath);
  if (data !== undefined) {
    try {
      existing = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`parse global settings: ${(err as Error).message}`);
    }
  }
  delete existing["maxOutputTokens"];
  for (const [key, value] of Object.entries(updates)) {
    if (key === "") continue;
    if (value === null || value === undefined) {
      delete existing[key];
      continue;
    }
    existing[key] = value;
  }
  writeGlobalSettingsData(JSON.stringify(existing, null, 2));
}

function writeGlobalSettingsData(data: string): void {
  const dir = configDir();
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settingsPath = globalSettingsPath();
  const tmpName = Deno.makeTempFileSync({
    dir,
    prefix: "settings-",
    suffix: ".tmp",
  });
  try {
    Deno.writeTextFileSync(tmpName, data);
    Deno.chmodSync(tmpName, 0o600);
    Deno.renameSync(tmpName, settingsPath);
  } catch (err) {
    try {
      Deno.removeSync(tmpName);
    } catch {
      // already gone
    }
    throw err;
  }
}

/** Updates only the given top-level keys in the project settings file. */
export function saveProjectSettingsPatch(
  updates: Record<string, unknown>,
): void {
  if (Object.keys(updates).length === 0) return;
  const settingsPath = projectSettingsPath();
  const projectDir = path.dirname(settingsPath);
  Deno.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  const data = readTextFileIfExists(settingsPath);
  if (data !== undefined) {
    try {
      existing = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`parse project settings: ${(err as Error).message}`);
    }
  }
  delete existing["maxOutputTokens"];
  for (const [key, value] of Object.entries(updates)) {
    if (key === "") continue;
    if (value === null || value === undefined) {
      delete existing[key];
      continue;
    }
    existing[key] = value;
  }
  writeProjectSettingsData(
    projectDir,
    settingsPath,
    JSON.stringify(existing, null, 2),
  );
}

/** Writes .opensac/settings.json atomically with private permissions. */
export function saveProjectSettings(s: Settings): void {
  if (!s) throw new Error("settings is nil");
  const settingsPath = projectSettingsPath();
  const projectDir = path.dirname(settingsPath);
  Deno.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeProjectSettingsData(projectDir, settingsPath, marshalSettings(s));
}

function writeProjectSettingsData(
  dir: string,
  settingsPath: string,
  data: string,
): void {
  const tmpName = Deno.makeTempFileSync({
    dir,
    prefix: "settings-",
    suffix: ".tmp",
  });
  try {
    Deno.writeTextFileSync(tmpName, data);
    Deno.chmodSync(tmpName, 0o600);
    Deno.renameSync(tmpName, settingsPath);
  } catch (err) {
    try {
      Deno.removeSync(tmpName);
    } catch {
      // already gone
    }
    throw err;
  }
}

/** Reports whether `p` looks like a project directory. */
export function isProjectDir(p: string): boolean {
  p = p.trim();
  if (p === "") return false;
  try {
    if (!Deno.statSync(p).isDirectory) return false;
  } catch {
    return false;
  }
  for (
    const marker of [
      ".git",
      ProjectDirName,
      "go.mod",
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
    ]
  ) {
    if (existsSync(path.join(p, marker))) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves the API key for a provider. */
export function resolveKey(s: Settings, providerName: string): string {
  const pc = s.providers?.[providerName];
  if (pc?.apiKey) return resolveKeyValue(pc.apiKey);

  const preset = defaultProviderConfig(providerName);
  if (preset?.apiKey) {
    const v = resolveKeyValue(preset.apiKey);
    if (v !== "" && !v.startsWith("${") && !v.startsWith("!")) return v;
  }

  const envVar = providerToEnvVar(providerName);
  const v = Deno.env.get(envVar) ?? "";
  if (v !== "") return v;
  return "";
}

/** Resolves configured per-provider HTTP header values. */
export function resolveProviderHeaders(
  s: Settings | undefined,
  providerName: string,
): Record<string, string> | undefined {
  if (!s) return undefined;
  const pc = resolveProviderConfig(providerName, s);
  if (!pc || !pc.headers || Object.keys(pc.headers).length === 0) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(pc.headers)) {
    const name = rawName.trim();
    if (name === "") continue;
    headers[name] = resolveKeyValue(value);
  }
  return headers;
}

/** Converts a provider name to a conventional env var name. */
export function providerToEnvVar(name: string): string {
  return name.replaceAll("-", "_").toUpperCase() + "_API_KEY";
}

/** Resolves `${VAR}` and `!shell` references in a config value. */
export function resolveKeyValue(key: string): string {
  if (key.startsWith("!")) {
    if (Deno.env.get("VIBECODING_ALLOW_SHELL_CONFIG") !== "1") return key;
    return resolveShellCommand(key.slice(1));
  }
  let envName = key;
  if (key.startsWith("${") && key.endsWith("}")) envName = key.slice(2, -1);
  if (!envName.includes(" ")) {
    const v = Deno.env.get(envName) ?? "";
    if (v !== "") return v;
  }
  return key;
}

function resolveShellCommand(cmd: string): string {
  if (cmd === "") return "";
  try {
    const [program, args] = isWindows()
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]]
      : ["sh", ["-c", cmd]];
    const result = new Deno.Command(program, {
      args,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!result.success) return "";
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return "";
  }
}

/** Returns the provider config from the settings map. */
export function getProviderConfig(
  s: Settings,
  name: string,
): ProviderConfig | undefined {
  return s.providers?.[name];
}

/** Returns a model config from a provider in the settings map. */
export function getModelConfig(
  s: Settings,
  providerName: string,
  modelID: string,
): ModelConfig | undefined {
  const pc = getProviderConfig(s, providerName);
  if (!pc) return undefined;
  return pc.models.find((m) => m.id === modelID);
}

/** Returns the effective shell path. */
export function getShell(s: Settings): string {
  if (s.shellPath) return s.shellPath;
  return defaultShell();
}

/** Returns the effective session directory. */
export function getSessionDir(s: Settings): string {
  if (s.sessionDir) return expandHome(s.sessionDir);
  return platformSessionDir();
}

/** Returns the effective global skills directory. */
export function getGlobalSkillsDir(s: Settings): string {
  if (s.skillsDir) return expandHome(s.skillsDir);
  return platformSkillsDir();
}

/** Returns whether the plan tool is enabled (default true). */
export function isPlanToolEnabled(s: Settings): boolean {
  if (s.enablePlanTool === undefined) return true;
  return s.enablePlanTool;
}

/** Reports whether terminal sessions may publish generated artifacts. */
export function isArtifactEnabled(s: Settings): boolean {
  return s.enableArtifact === true;
}

/** Reports whether ACP/Desktop sessions may publish generated artifacts. */
export function isACPArtifactEnabled(s: Settings): boolean {
  return s.enableACPArtifact === true;
}

/** Reports whether startup update checks are enabled (default true). */
export function isUpdateCheckEnabled(s: Settings | undefined): boolean {
  if (!s || s.updateCheck === undefined) return true;
  return s.updateCheck;
}

/** Reports whether attachment-storage reclamation is enabled (default true). */
export function isAttachmentStorageReclaimEnabled(
  s: Settings | undefined,
): boolean {
  if (
    !s || !s.maintenance || s.maintenance.reclaimAttachmentStorage === undefined
  ) {
    return true;
  }
  return s.maintenance.reclaimAttachmentStorage;
}

/** Returns the configured reclamation schedule, or "" for the Runtime default. */
export function attachmentStorageReclaimSchedule(
  s: Settings | undefined,
): string {
  if (!s || !s.maintenance) return "";
  return (s.maintenance.storageReconcileSchedule ?? "").trim();
}

/** Reports whether web search is enabled (default false). */
export function isWebSearchEnabled(s: Settings | undefined): boolean {
  return s?.webSearch?.enabled === true;
}

/** Reports whether standalone image generation is enabled (default false). */
export function isImageGenerationEnabled(s: Settings | undefined): boolean {
  return s?.imageGeneration?.enabled === true;
}

/**
 * Returns the standalone image-generation config, filling omitted
 * endpoint/API/token fields from the selected provider.
 */
export function effectiveImageGeneration(s: Settings): ImageGenerationSettings {
  const cfg: ImageGenerationSettings = { ...(s.imageGeneration ?? {}) };
  if (!cfg.provider) cfg.provider = "openai";
  const pc = resolveProviderConfig(cfg.provider, s);
  if (pc) {
    if (!cfg.baseUrl) cfg.baseUrl = pc.baseUrl;
    if (!cfg.apiType) cfg.apiType = pc.api;
    if (!cfg.token) cfg.token = pc.apiKey;
  }
  if (!cfg.apiType) cfg.apiType = "openai-images";
  if (!cfg.baseUrl) cfg.baseUrl = "https://api.openai.com/v1";
  if (!cfg.model) cfg.model = "gpt-image-1";
  cfg.token = resolveKeyValue(cfg.token ?? "");
  return cfg;
}

/** Resolves environment/shell references in the image-generation token. */
export function resolveImageGenerationToken(s: Settings): string {
  return effectiveImageGeneration(s).token ?? "";
}

export function mergeWebSearchSettings(
  base: WebSearchSettings,
  override: WebSearchSettings,
): WebSearchSettings {
  if (override.enabled !== undefined) base.enabled = override.enabled;
  if (override.provider) {
    base.provider = override.provider;
    if (!override.providerType) base.providerType = "";
  }
  if (override.providerType) base.providerType = override.providerType;
  if (override.model) base.model = override.model;
  return normalizeWebSearchSettings(base);
}

export function normalizeWebSearchSettings(
  cfg: WebSearchSettings,
): WebSearchSettings {
  if (cfg.enabled === undefined) cfg.enabled = false;
  if (!cfg.provider) cfg.provider = "openai";
  if (!cfg.providerType) {
    cfg.providerType = cfg.provider === "anthropic"
      ? "anthropic-messages"
      : "openai-responses";
  }
  return cfg;
}

/** Returns a deep copy of all built-in provider presets. */
export function defaultProviderConfigsAll(): Record<string, ProviderConfig> {
  return cloneProviderConfigs(defaultProviderConfigs);
}

/** Returns a deep copy of one built-in provider preset, or undefined. */
export function defaultProviderConfig(
  providerID: string,
): ProviderConfig | undefined {
  const src = defaultProviderConfigs[providerID];
  if (!src) return undefined;
  return cloneProviderConfig(src);
}

/** Returns a deep copy of a built-in model config, or undefined. */
export function defaultModelConfig(
  providerID: string,
  modelID: string,
): ModelConfig | undefined {
  const pc = defaultProviderConfigs[providerID];
  if (!pc) return undefined;
  const model = pc.models.find((m) => m.id === modelID);
  return model ? cloneModelConfig(model) : undefined;
}

/**
 * Merges built-in provider defaults with runtime overrides. Priority: runtime
 * settings > built-in defaults > safe generic defaults.
 */
export function resolveProviderConfig(
  providerID: string,
  runtime: Settings | undefined,
): ProviderConfig {
  let base = defaultProviderConfig(providerID);
  if (!base) base = { api: "openai-chat", models: [] };
  if (runtime) {
    const existing = runtime.providers?.[providerID];
    if (existing) base = mergeProviderConfig(base, existing);
  }
  return base;
}

/** Merges built-in model defaults with runtime overrides. */
export function resolveModelConfig(
  providerID: string,
  modelID: string,
  runtime: Settings | undefined,
): ModelConfig | undefined {
  const base = defaultModelConfig(providerID, modelID);
  if (runtime?.providers) {
    const existing = getModelConfig(runtime, providerID, modelID);
    if (existing) {
      if (!base) return cloneModelConfig(existing);
      return mergeModelConfig(base, existing);
    }
  }
  return base;
}

function configFieldWasSet(
  fields: Record<string, boolean> | undefined,
  name: string,
): boolean {
  return fields !== undefined && fields[name] === true;
}

function markConfigField(
  fields: Record<string, boolean> | undefined,
  name: string,
): Record<string, boolean> {
  const out = fields ? { ...fields } : {};
  out[name] = true;
  return out;
}

/** Reports whether maxTokens was explicitly set on this model. */
export function modelMaxTokensWasSet(mc: ModelConfig): boolean {
  return configFieldWasSet(mc.fieldSet, "maxTokens");
}

/** Records an explicit output-token setting. */
export function setModelMaxTokens(mc: ModelConfig, value: number): void {
  mc.maxTokens = value;
  mc.fieldSet = markConfigField(mc.fieldSet, "maxTokens");
}

/**
 * Overlays non-zero fields from `overlay` onto `base`. undefined optional
 * fields in overlay are treated as unset and do not overwrite base.
 */
export function mergeProviderConfig(
  base: ProviderConfig | undefined,
  overlay: ProviderConfig,
): ProviderConfig {
  if (!base) return cloneProviderConfig(overlay)!;
  const result = cloneProviderConfig(base)!;
  const fs = overlay.fieldSet;
  if (
    configFieldWasSet(fs, "apiKey") || (fs === undefined && !!overlay.apiKey)
  ) {
    result.apiKey = overlay.apiKey;
  }
  if (
    configFieldWasSet(fs, "baseUrl") || (fs === undefined && !!overlay.baseUrl)
  ) {
    result.baseUrl = overlay.baseUrl;
  }
  if (configFieldWasSet(fs, "api") || (fs === undefined && !!overlay.api)) {
    result.api = overlay.api;
  }
  if (
    configFieldWasSet(fs, "vendor") || (fs === undefined && !!overlay.vendor)
  ) {
    result.vendor = overlay.vendor;
  }
  if (
    configFieldWasSet(fs, "httpProxy") ||
    (fs === undefined && !!overlay.httpProxy)
  ) {
    result.httpProxy = overlay.httpProxy;
  }
  if (
    configFieldWasSet(fs, "forceHTTP11") ||
    (fs === undefined && !!overlay.forceHTTP11)
  ) {
    result.forceHTTP11 = overlay.forceHTTP11;
  }
  if (
    configFieldWasSet(fs, "thinkingFormat") ||
    (fs === undefined && !!overlay.thinkingFormat)
  ) {
    result.thinkingFormat = overlay.thinkingFormat;
  }
  if (
    configFieldWasSet(fs, "cacheControl") ||
    (fs === undefined && overlay.cacheControl !== undefined)
  ) {
    result.cacheControl = cloneBoolPtr(overlay.cacheControl);
  }
  if (
    configFieldWasSet(fs, "maxImagesPerRequest") ||
    (fs === undefined && (overlay.maxImagesPerRequest ?? 0) !== 0)
  ) {
    result.maxImagesPerRequest = overlay.maxImagesPerRequest;
  }
  if (
    configFieldWasSet(fs, "headers") ||
    (fs === undefined && Object.keys(overlay.headers ?? {}).length > 0)
  ) {
    result.headers = cloneStringMap(overlay.headers);
  }
  if (
    configFieldWasSet(fs, "responses") ||
    (overlay.responses !== undefined &&
      responsesConfigHasValues(overlay.responses))
  ) {
    result.responses = overlay.responses
      ? cloneResponsesConfig(overlay.responses)
      : undefined;
  }
  if (
    configFieldWasSet(fs, "models") ||
    (fs === undefined && (overlay.models?.length ?? 0) > 0)
  ) {
    result.models = mergeModelConfigs(
      result.models ?? [],
      overlay.models ?? [],
    );
  }
  return result;
}

function responsesConfigHasValues(c: ResponsesConfig): boolean {
  const so = c.structuredOutput ?? {};
  const tc = c.toolControl ?? {};
  const ht = c.hostedTools ?? {};
  return c.reasoningSummary !== undefined ||
    c.reasoningContext !== undefined ||
    c.reasoningMode !== undefined ||
    c.promptCacheEnabled !== undefined ||
    c.promptCacheKey !== undefined ||
    c.promptCacheRetention !== undefined ||
    c.promptCacheMode !== undefined ||
    c.promptCacheTTL !== undefined ||
    c.safetyIdentifier !== undefined ||
    Object.keys(c.metadata ?? {}).length > 0 ||
    c.stateMode !== undefined ||
    c.store !== undefined ||
    c.conversation !== undefined ||
    c.truncation !== undefined ||
    c.background !== undefined ||
    (c.include?.length ?? 0) > 0 ||
    c.serviceTier !== undefined ||
    so.name !== undefined ||
    so.description !== undefined ||
    so.strict !== undefined ||
    so.schema !== undefined ||
    tc.choice !== undefined ||
    tc.parallel !== undefined ||
    tc.maxCalls !== undefined ||
    Object.keys(ht.webSearch ?? {}).length > 0 ||
    Object.keys(ht.fileSearch ?? {}).length > 0 ||
    Object.keys(ht.codeInterpreter ?? {}).length > 0 ||
    Object.keys(ht.computerUse ?? {}).length > 0 ||
    Object.keys(ht.imageGeneration ?? {}).length > 0 ||
    (ht.remoteMCP?.length ?? 0) > 0;
}

/**
 * Combines built-in and runtime model lists by model ID. Runtime entries take
 * precedence for matching IDs; built-in-only entries remain available.
 */
export function mergeModelConfigs(
  builtin: ModelConfig[],
  runtime: ModelConfig[],
): ModelConfig[] {
  const result: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const model of runtime) {
    if (model.id === "") continue;
    result.push(cloneModelConfig(model));
    seen.add(model.id);
  }
  for (const model of builtin) {
    if (model.id === "") continue;
    if (seen.has(model.id)) continue;
    result.push(cloneModelConfig(model));
    seen.add(model.id);
  }
  return result;
}

/** Overlays non-zero fields from `overlay` onto `base`. */
export function mergeModelConfig(
  base: ModelConfig,
  overlay: ModelConfig,
): ModelConfig {
  const result = cloneModelConfig(base);
  const fs = overlay.fieldSet;
  if (configFieldWasSet(fs, "id") || (fs === undefined && !!overlay.id)) {
    result.id = overlay.id;
  }
  if (configFieldWasSet(fs, "name") || (fs === undefined && !!overlay.name)) {
    result.name = overlay.name;
  }
  if (
    configFieldWasSet(fs, "contextWindow") ||
    (fs === undefined && (overlay.contextWindow ?? 0) > 0)
  ) {
    result.contextWindow = overlay.contextWindow;
  }
  if (
    configFieldWasSet(fs, "maxTokens") ||
    (fs === undefined && (overlay.maxTokens ?? 0) > 0)
  ) {
    result.maxTokens = overlay.maxTokens;
    result.fieldSet = markConfigField(result.fieldSet, "maxTokens");
  }
  if (
    configFieldWasSet(fs, "reasoning") ||
    (fs === undefined && !!overlay.reasoning)
  ) {
    result.reasoning = overlay.reasoning;
  }
  if (
    configFieldWasSet(fs, "input") ||
    (fs === undefined && (overlay.input?.length ?? 0) > 0)
  ) {
    result.input = cloneStringSlice(overlay.input);
  }
  if (
    configFieldWasSet(fs, "temperature") ||
    (fs === undefined && overlay.temperature !== undefined)
  ) {
    result.temperature = cloneFloat64Ptr(overlay.temperature);
  }
  if (
    configFieldWasSet(fs, "top_p") ||
    (fs === undefined && overlay.top_p !== undefined)
  ) {
    result.top_p = cloneFloat64Ptr(overlay.top_p);
  }
  if (
    configFieldWasSet(fs, "cost") ||
    (fs === undefined && overlay.cost !== undefined)
  ) {
    result.cost = overlay.cost === undefined ? undefined : { ...overlay.cost };
  }
  if (
    configFieldWasSet(fs, "compat") ||
    (fs === undefined && overlay.compat !== undefined)
  ) {
    result.compat = cloneModelCompat(overlay.compat);
  }
  return result;
}

/** Returns the effective sandbox options described by settings. */
export function sandboxSettingsOptions(s: SandboxSettings): SandboxOptions {
  return {
    bwrapPath: s.bwrapPath,
    allowNetwork: s.allowNetwork,
    allowedRead: s.allowedRead,
    allowedWrite: s.allowedWrite,
    deniedPaths: s.deniedPaths,
    passEnv: s.passEnv,
    tmpSize: s.tmpSize,
    protectGit: s.protectGit,
  };
}

/**
 * Resolves the sandbox Level from settings once for every entry point.
 * Disabled settings mean direct execution (Level.None); "strict" requires
 * the strict backend; anything else is the best-effort standard level.
 */
export function sandboxLevelFromSettings(
  settings: Settings | undefined,
): Level {
  if (!settings?.sandbox?.enabled) return Level.None;
  return settings.sandbox.level === "strict" ? Level.Strict : Level.Standard;
}

/** Returns the configured disabled skill names, or undefined. */
export function skillsDisabled(s: Settings | undefined): string[] | undefined {
  const disabled = s?.skills?.disabled;
  if (!disabled || disabled.length === 0) return undefined;
  return [...disabled];
}

/** Normalizes the local tool execution mode. */
export function toolExecutionEffectiveMode(
  s: ToolExecutionSettings,
): string {
  return (s.mode ?? "").trim().toLowerCase() === "sequential"
    ? "sequential"
    : "parallel";
}

/** Returns the effective local tool concurrency. */
export function toolExecutionEffectiveMaxConcurrency(
  s: ToolExecutionSettings,
): number {
  if ((s.maxConcurrency ?? 0) <= 0) {
    return DefaultToolExecutionMaxConcurrency;
  }
  return s.maxConcurrency!;
}
