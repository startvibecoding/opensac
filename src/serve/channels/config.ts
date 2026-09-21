// Ported from internal/serve/channels/config.go — messaging channel runtime
// configuration types, defaults, and resolution helpers.
//
// Deviations: Go time.Duration fields map to millisecond numbers and the
// `Get*Timeout` accessors are suffixed `MS` (matching the ported
// `resolveSubAgentWaitTimeoutMS` convention); the default wall-clock caps are
// read from the shared iteration budget policy instead of a Go constant.

import { DefaultIterationBudgetWallClock } from "../../agent/iteration_budget.ts";
import { configDir } from "../../config/mod.ts";
import { join } from "@std/path";

/** Config holds messaging channel runtime configuration. */
export interface Config {
  defaultProvider?: string;
  defaultModel?: string;
  multiAgent: boolean;
  webSearch: boolean;
  browser: boolean;
  artifact: boolean;
  a2aMaster: boolean;
  sandbox: boolean;
  wechat: WechatConfig;
  feishu: FeishuConfig;
  webhooks: WebhookConfig;
  cron: CronConfig;
  memory: MemoryConfig;
  security: SecurityConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  workDir: string;
}

/** WechatConfig defines WeChat iLink platform settings. */
export interface WechatConfig {
  enabled: boolean;
  credPath: string;
  workDir: string;
  autoTyping: boolean;
}

/** FeishuConfig defines Feishu (Lark) platform settings. */
export interface FeishuConfig {
  enabled: boolean;
  appID: string;
  appSecret: string;
  workDir: string;
}

/** WebhookConfig defines inbound webhook settings. */
export interface WebhookConfig {
  enabled: boolean;
  secret: string;
  routes: WebhookRoute[];
}

/** WebhookRoute maps an inbound webhook path to an agent skill + delivery. */
export interface WebhookRoute {
  path: string;
  events: string[];
  skill: string;
  /** "wechat", "feishu", or "" (no delivery). */
  delivery: string;
  deliveryTarget?: string;
}

/** CronConfig defines cron scheduler settings. */
export interface CronConfig {
  enabled: boolean;
  /** Seconds between checks (default 30). */
  interval?: number;
}

/** MemoryConfig defines persistent memory settings. */
export interface MemoryConfig {
  enabled: boolean;
  /** Empty = auto-discover .mothx/memory.md → <GLOBAL_DIR>/memory.md. */
  path: string;
}

/** SecurityConfig defines security settings. */
export interface SecurityConfig {
  smartApprovals: boolean;
  allowedWorkDirs: string[];
}

/** HooksConfig defines shell hook scripts. */
export interface HooksConfig {
  preToolCall: string;
  postToolCall: string;
}

/** AgentConfig defines agent behavior settings. */
export interface AgentConfig {
  maxTurns: number;
  budgetPressure: boolean;
  contextPressure: boolean;
  /** Remaining ratio (0-1), default 0.20. */
  budgetPressureThreshold?: number;
  /** Usage ratio (0-1), default 0.55. */
  contextPressureThreshold?: number;
  /** Watchdog: abort a run with no agent events for this long (default 600). */
  runStaleTimeoutSecs?: number;
  /** Watchdog: abort a run exceeding this total duration (default 57600). */
  runMaxDurationSecs?: number;
  /** Hard cap for durable background polling (default 57600). */
  backgroundRunMaxSecs?: number;
}

export const defaultRunStaleTimeoutSecs = 600;
// The run watchdog and the durable background-polling cap share the agent
// loop's wall-clock budget so a run the policy allows is never cut short by a
// shorter watchdog or polling limit.
export const defaultRunMaxDuration = DefaultIterationBudgetWallClock;
export const defaultBackgroundRunMax = DefaultIterationBudgetWallClock;

const SECS = 1000;

/** Returns the watchdog inactivity timeout (ms) for channel runs. */
export function getRunStaleTimeoutMS(cfg: AgentConfig): number {
  if (!cfg.runStaleTimeoutSecs || cfg.runStaleTimeoutSecs <= 0) {
    return defaultRunStaleTimeoutSecs * SECS;
  }
  return cfg.runStaleTimeoutSecs * SECS;
}

/** Returns the watchdog total-duration cap (ms) for channel runs. */
export function getRunMaxDurationMS(cfg: AgentConfig): number {
  if (!cfg.runMaxDurationSecs || cfg.runMaxDurationSecs <= 0) {
    return defaultRunMaxDuration;
  }
  return cfg.runMaxDurationSecs * SECS;
}

/** Returns the hard cap (ms) for durable background polling. */
export function getBackgroundRunMaxDurationMS(cfg: AgentConfig): number {
  if (!cfg.backgroundRunMaxSecs || cfg.backgroundRunMaxSecs <= 0) {
    return defaultBackgroundRunMax;
  }
  return cfg.backgroundRunMaxSecs * SECS;
}

/** Methods of the Go `Config`/`AgentConfig` value types. */
export interface ConfigMethods {
  /** Returns the watchdog inactivity timeout (ms) for channel runs. */
  getRunStaleTimeoutMS(): number;
  /** Returns the watchdog total-duration cap (ms) for channel runs. */
  getRunMaxDurationMS(): number;
  /** Returns the hard cap (ms) for durable background polling. */
  getBackgroundRunMaxDurationMS(): number;
  /** Returns the resolved work directory; falls back to the current one. */
  getWorkDir(): string;
  /** Platform work_dir → global work_dir → cwd. */
  getPlatformWorkDir(platform: string): string;
  /** Returns the wechat credentials path. */
  getWechatCredPath(): string;
  /** Resolves ${VAR} references in string fields (mutates). */
  resolveEnvVars(): void;
  /** Effective default provider: Config → Settings. */
  getDefaultProvider(settingsProvider: string): string;
  /** Effective default model: Config → Settings. */
  getDefaultModel(settingsModel: string): string;
}

function agentConfigOf(cfg: Config): AgentConfigMethods {
  return {
    getRunStaleTimeoutMS: () => getRunStaleTimeoutMS(cfg.agent),
    getRunMaxDurationMS: () => getRunMaxDurationMS(cfg.agent),
    getBackgroundRunMaxDurationMS: () =>
      getBackgroundRunMaxDurationMS(cfg.agent),
  };
}

type AgentConfigMethods = Pick<
  ConfigMethods,
  | "getRunStaleTimeoutMS"
  | "getRunMaxDurationMS"
  | "getBackgroundRunMaxDurationMS"
>;

/** Attaches the Go method set to a decoded `Config` object. */
export function withConfigMethods(cfg: Config): Config & ConfigMethods {
  return {
    ...cfg,
    ...agentConfigOf(cfg),
    getWorkDir: () => getWorkDir(cfg),
    getPlatformWorkDir: (platform: string) => getPlatformWorkDir(cfg, platform),
    getWechatCredPath: () => getWechatCredPath(cfg),
    resolveEnvVars: () => resolveEnvVars(cfg),
    getDefaultProvider: (settingsProvider: string) =>
      getDefaultProvider(cfg, settingsProvider),
    getDefaultModel: (settingsModel: string) =>
      getDefaultModel(cfg, settingsModel),
  };
}

function getWorkDir(cfg: Config): string {
  if (cfg.workDir && cfg.workDir !== ".") {
    return cfg.workDir;
  }
  try {
    return Deno.cwd();
  } catch {
    return ".";
  }
}

function getPlatformWorkDir(cfg: Config, platform: string): string {
  switch (platform) {
    case "wechat":
      if (cfg.wechat.workDir !== "") {
        return cfg.wechat.workDir;
      }
      break;
    case "feishu":
      if (cfg.feishu.workDir !== "") {
        return cfg.feishu.workDir;
      }
      break;
  }
  return getWorkDir(cfg);
}

function getWechatCredPath(cfg: Config): string {
  if (cfg.wechat.credPath !== "") {
    return cfg.wechat.credPath;
  }
  return join(configDir(), "wechat-credentials.json");
}

function resolveEnvVars(cfg: Config): void {
  cfg.feishu.appID = resolveEnv(cfg.feishu.appID);
  cfg.feishu.appSecret = resolveEnv(cfg.feishu.appSecret);
  cfg.webhooks.secret = resolveEnv(cfg.webhooks.secret);
}

/** Effective default provider: Config → Settings. */
export function getDefaultProvider(
  cfg: Config,
  settingsProvider: string,
): string {
  if (cfg.defaultProvider !== undefined && cfg.defaultProvider !== "") {
    return cfg.defaultProvider;
  }
  return settingsProvider;
}

/** Effective default model: Config → Settings. */
export function getDefaultModel(cfg: Config, settingsModel: string): string {
  if (cfg.defaultModel !== undefined && cfg.defaultModel !== "") {
    return cfg.defaultModel;
  }
  if (cfg.defaultProvider !== undefined && cfg.defaultProvider !== "") {
    return "";
  }
  return settingsModel;
}

/** resolveEnv resolves a single ${VAR} reference. */
export function resolveEnv(s: string): string {
  if (s.startsWith("${") && s.endsWith("}")) {
    const envName = s.slice(2, -1);
    const v = Deno.env.get(envName);
    if (v) {
      return v;
    }
  }
  return s;
}

/** DefaultConfig returns the default configuration. */
export function defaultConfig(): Config & ConfigMethods {
  return withConfigMethods({
    multiAgent: false,
    webSearch: false,
    browser: false,
    artifact: false,
    a2aMaster: false,
    sandbox: false,
    wechat: {
      enabled: false,
      credPath: "",
      workDir: "",
      autoTyping: true,
    },
    feishu: {
      enabled: false,
      appID: "",
      appSecret: "",
      workDir: "",
    },
    webhooks: {
      enabled: false,
      secret: "",
      routes: [],
    },
    cron: {
      enabled: true,
    },
    memory: {
      enabled: true,
      path: "",
    },
    security: {
      smartApprovals: true,
      allowedWorkDirs: [],
    },
    hooks: {
      preToolCall: "",
      postToolCall: "",
    },
    agent: {
      maxTurns: 90,
      budgetPressure: true,
      contextPressure: true,
      budgetPressureThreshold: 0.20,
      contextPressureThreshold: 0.55,
      runStaleTimeoutSecs: defaultRunStaleTimeoutSecs,
      runMaxDurationSecs: Math.floor(defaultRunMaxDuration / SECS),
      backgroundRunMaxSecs: Math.floor(defaultBackgroundRunMax / SECS),
    },
    workDir: ".",
  });
}
