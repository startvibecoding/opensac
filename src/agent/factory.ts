//
// AgentFactory creates Agent instances with consistent configuration, giving
// each agent its own Registry (workDir, sandbox, JobManager). It also bridges
// the public `sdk/agent.Builder` API to the internal Agent implementation via
// `setBuilderFunc`. Go's `init()` builder registration maps to a module-level
// call at the bottom of this file, mirroring `bootstrap`'s blank import.
//
// Deviations: `os.Getwd` maps to `Deno.cwd`; Go's `*bool` optional fields map
// to plain optional booleans; `context.CancelFunc`/`chan` are dropped (Deno is
// single-threaded); `provider.ThinkingLevel(...)` maps to the `thinkingMedium`
// constant.

import type { Agent as PublicAgent, AgentID } from "../../sdk/agent/types.ts";
import {
  type Builder,
  type BuilderConfig,
  setBuilderFunc,
} from "../../sdk/agent/builder.ts";
import {
  defaultToolExecutionMaxConcurrency,
  getSessionDir,
  isPlanToolEnabled,
  type Settings,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
} from "../config/settings.ts";
import { type AllowConfig, loadAllow } from "../config/allow.ts";
import { envList, loadEnv } from "../config/env.ts";
import type { CompactionSettings } from "../context/compaction.ts";
import type { Model } from "../provider/types.ts";
import { type ThinkingLevel, thinkingMedium } from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import { newManager, newSubAgentManager } from "../session/manager.ts";
import { Level, Manager as SandboxManager } from "../sandbox/sandbox.ts";
import { newManagerWithOptions } from "../sandbox/sandbox.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import { sessionDir as platformSessionDir } from "../platform/platform.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import {
  newRegistry,
  newRegistryWithConfig,
  type Registry,
} from "../tools/tool.ts";
import {
  type AgentLoopConfig,
  type Config,
  newAgentWithLoopConfig,
} from "./agent.ts";
import {
  type BeforeToolCallContext,
  type BeforeToolExecuteContext,
  type ToolCallBlockResult,
} from "./agent.ts";
import { compactionSettingsFromConfig } from "./compaction.ts";
import { composeFollowUps } from "./followup.ts";
import type { AgentManager } from "./manager.ts";
import { resolveMaxTokens, resolveMaxTokensValue } from "./max_tokens.ts";
import { newExternalToolAdapter } from "./external_tool_adapter.ts";
import { buildSubAgentContext } from "./system_prompt.ts";
import { AgentAdapter, newAgentAdapter, ProviderAdapter } from "./bridge.ts";
import { registerSubAgentTools } from "./subagent.ts";
import { subAgentToolNames } from "./subagent_support.ts";

/**
 * AgentFactoryOptions configures AgentFactory behavior.
 */
export interface AgentFactoryOptions {
  multiAgentEnabled: boolean;
  delegateEnabled: boolean;
  workflowsEnabled: boolean;
  providerName?: string;
  allow?: AllowConfig;
  beforeToolCall?: (
    ctx: BeforeToolCallContext,
  ) => ToolCallBlockResult | undefined;
  beforeToolExecute?: (
    ctx: BeforeToolExecuteContext,
  ) => ToolCallBlockResult | undefined;
  forcedMode?: string;
  resolveMode?: (
    manager: SessionManager | undefined,
    requestedMode: string,
  ) => string;
  beforeToolCallForSession?: (
    manager: SessionManager | undefined,
  ) =>
    | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
    | undefined;
  /**
   * ExpertIdentity/ExpertRoster are injected into main agents only
   * (`parentId === ""`); sub-agents never receive the lead persona overlay.
   */
  expertIdentity?: string;
  expertRoster?: string;
}

/** Specifies per-agent overrides. */
export interface AgentOptions {
  id?: AgentID;
  parentId?: AgentID;
  memberId?: string;
  expertId?: string;
  memberDisplayName?: string;
  memberEmoji?: string;
  memberRole?: string;
  mode?: string;
  model?: Model;
  workDir?: string;
  /** Optional tool filter. */
  tools?: string[];
  /** Removes tools from the resolved child registry after standard filtering. */
  excludeTools?: string[];
  systemPromptExtra?: string;
  maxIterations?: number;
  toolExecutionMode?: string;
  maxToolConcurrency?: number;
  session?: SessionManager;
  /** Persists this agent outside the user-continuable session tables. */
  isSubAgent?: boolean;
  /** Per-agent approval override. */
  approvalHandler?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  /** Opts an IsSubAgent role back into the session member mailbox. */
  ownsSessionMailbox?: boolean;
  /** Marks an agent that is not the session's conversational lead. */
  auxiliaryRole?: boolean;
  multiAgent?: boolean;
  delegateMode?: boolean;
  workflows?: boolean;
}

/** Creates Agent instances with consistent configuration. */
export class AgentFactory {
  provider?: Provider;
  providerName = "";
  model?: Model;
  settings?: Settings;
  allow?: AllowConfig;
  sandboxMgr?: SandboxManager;
  extraContext = "";
  ruleContent = "";
  skillsMgr?: SkillsManager;
  compactionSettings: CompactionSettings = {
    enabled: false,
    reserveTokens: 0,
    keepRecentTokens: 0,
  };
  approvalHandler?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  multiAgentEnabled = false;
  delegateEnabled = false;
  workflowsEnabled = false;
  toolExecutionMode = "";
  maxToolConcurrency = 0;
  beforeToolCall?: (
    ctx: BeforeToolCallContext,
  ) => ToolCallBlockResult | undefined;
  beforeToolExecute?: (
    ctx: BeforeToolExecuteContext,
  ) => ToolCallBlockResult | undefined;
  forcedMode = "";
  resolveMode?: (
    manager: SessionManager | undefined,
    requestedMode: string,
  ) => string;
  beforeToolCallForSession?: (
    manager: SessionManager | undefined,
  ) =>
    | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
    | undefined;
  expertIdentity = "";
  expertRoster = "";
  /**
   * Installed by AgentManager during shared Runtime assembly. Used only for
   * manager-created top-level agents, never for child agents.
   */
  manager?: AgentManager;
  memberMailbox?: import("./mailbox.ts").MemberMailbox;
  /** Whether this manager's lead may hold its run open for running members. */
  memberWaitEnabled = false;

  /** Creates a new Agent with a per-agent Registry. */
  create(opts: AgentOptions): AgentAdapter {
    return createAgent(this, opts);
  }

  /** Returns a clone carrying a parent agent's runtime config. */
  withParentRuntimeConfig(cfg: AgentLoopConfig): AgentFactory {
    return withParentRuntimeConfig(this, cfg)!;
  }

  /** Returns a clone carrying a new runtime config. */
  withRuntimeConfig(
    p: Provider | undefined,
    providerName: string,
    model: Model | undefined,
    settings: Settings | undefined,
    allow: AllowConfig | undefined,
  ): AgentFactory {
    return withRuntimeConfig(this, p, providerName, model, settings, allow)!;
  }

  /** Returns the resolved mode for a requested mode. */
  resolveAgentMode(
    manager: SessionManager | undefined,
    requestedMode: string,
  ): string {
    return resolveAgentMode(this, manager, requestedMode);
  }

  /** Creates an agent from public Builder options. */
  createFromPublicOptions(b: Builder | undefined): PublicAgent | undefined {
    return createFromPublicOptions(this, b);
  }
}

/** Creates a factory with shared configuration. */
export function newAgentFactory(
  provider: Provider | undefined,
  model: Model | undefined,
  settings: Settings | undefined,
  sandboxMgr: SandboxManager | undefined,
  extraContext: string,
  ruleContent: string,
  skillsMgr: SkillsManager | undefined,
  compactionSettings: CompactionSettings,
  approvalHandler:
    | ((
      toolCallId: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => boolean)
    | undefined,
): AgentFactory {
  return newAgentFactoryWithOptions(
    provider,
    model,
    settings,
    sandboxMgr,
    extraContext,
    ruleContent,
    skillsMgr,
    compactionSettings,
    approvalHandler,
    {
      multiAgentEnabled: true,
      delegateEnabled: false,
      workflowsEnabled: false,
    },
  );
}

/** Creates a factory with explicit behavior flags. */
export function newAgentFactoryWithOptions(
  provider: Provider | undefined,
  model: Model | undefined,
  settings: Settings | undefined,
  sandboxMgr: SandboxManager | undefined,
  extraContext: string,
  ruleContent: string,
  skillsMgr: SkillsManager | undefined,
  compactionSettings: CompactionSettings,
  approvalHandler:
    | ((
      toolCallId: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => boolean)
    | undefined,
  opts: AgentFactoryOptions,
): AgentFactory {
  const allow = opts.allow ?? loadAllow();
  const f = new AgentFactory();
  f.provider = provider;
  f.providerName = opts.providerName ?? "";
  f.model = model;
  f.settings = settings;
  f.allow = allow;
  f.sandboxMgr = sandboxMgr;
  f.extraContext = extraContext;
  f.ruleContent = ruleContent;
  f.skillsMgr = skillsMgr;
  f.compactionSettings = compactionSettings;
  f.approvalHandler = approvalHandler;
  f.multiAgentEnabled = opts.multiAgentEnabled;
  f.delegateEnabled = opts.delegateEnabled;
  f.workflowsEnabled = opts.workflowsEnabled;
  f.beforeToolCall = opts.beforeToolCall;
  f.beforeToolExecute = opts.beforeToolExecute;
  f.forcedMode = opts.forcedMode ?? "";
  f.resolveMode = opts.resolveMode;
  f.beforeToolCallForSession = opts.beforeToolCallForSession;
  f.expertIdentity = opts.expertIdentity ?? "";
  f.expertRoster = opts.expertRoster ?? "";
  return f;
}

/** Creates a new Agent with per-agent Registry. */
export function createAgent(
  f: AgentFactory,
  opts: AgentOptions,
): AgentAdapter {
  let workDir = opts.workDir ?? "";
  if (workDir === "") {
    try {
      workDir = Deno.cwd();
    } catch {
      workDir = "";
    }
  }

  // Determine session before mode and sandbox so Runtime policy can use
  // persisted identity for manager-created background agents.
  let sess = opts.session;
  if (sess === undefined) {
    sess = defaultSession(
      f,
      workDir,
      opts.isSubAgent === true || (opts.parentId ?? "") !== "",
    );
  }

  let mode = opts.mode ?? "";
  if (mode === "") mode = "yolo";
  try {
    mode = resolveAgentMode(f, sess, mode);
  } catch {
    // Keep the requested mode when the resolver rejects it (mirrors Go
    // ignoring the error and keeping the prior mode).
  }

  let model = opts.model;
  if (model === undefined) {
    model = f.model;
    if (sess !== undefined) {
      const entry = sess.getLatestModelChange();
      if (
        entry !== null && entry.modelId !== "" && f.provider !== undefined
      ) {
        const persisted = f.provider.getModel(entry.modelId);
        if (persisted !== undefined) model = persisted;
      }
    }
  }

  let maxIterations = opts.maxIterations ?? 0;
  if (maxIterations === 0) maxIterations = 200;

  let toolExecMode = opts.toolExecutionMode ?? "";
  if (toolExecMode === "") {
    toolExecMode = "parallel";
    if (f.toolExecutionMode !== "") {
      toolExecMode = f.toolExecutionMode;
    } else if (f.settings !== undefined) {
      toolExecMode = toolExecutionEffectiveMode(
        f.settings.toolExecution ?? {},
      );
    }
  }
  let maxToolConcurrency = opts.maxToolConcurrency ?? 0;
  if (maxToolConcurrency <= 0) maxToolConcurrency = f.maxToolConcurrency;
  if (maxToolConcurrency <= 0) {
    if (f.settings !== undefined) {
      maxToolConcurrency = toolExecutionEffectiveMaxConcurrency(
        f.settings.toolExecution ?? {},
      );
    } else {
      maxToolConcurrency = defaultToolExecutionMaxConcurrency;
    }
  }

  // Create per-agent Registry with isolated workDir/sandbox/JobManager.
  const sb = sandboxForMode(f, mode);
  const registry = newRegistryWithConfig({
    workDir,
    sandbox: sb,
    toolFilter: opts.tools,
    skillsMgr: f.skillsMgr,
    enablePlanTool: f.settings === undefined || isPlanToolEnabled(f.settings),
    envVars: envList(loadEnv()),
  });

  // Decision 5: Sub-agents cannot spawn sub-agents.
  if ((opts.parentId ?? "") !== "") {
    for (const name of subAgentToolNames()) registry.remove(name);
    registry.remove("delegate_subagent");
  }
  for (const name of opts.excludeTools ?? []) registry.remove(name);

  // Build extra context: factory-level + per-agent.
  let extraContext = f.extraContext;
  if ((opts.parentId ?? "") !== "") {
    extraContext += "\n" + buildSubAgentContext();
  }
  if ((opts.systemPromptExtra ?? "") !== "") {
    extraContext += "\n" + opts.systemPromptExtra;
  }

  let multiAgent = f.multiAgentEnabled && (opts.parentId ?? "") === "";
  if (opts.multiAgent !== undefined) multiAgent = opts.multiAgent;
  let delegateMode = f.delegateEnabled && (opts.parentId ?? "") === "";
  if (opts.delegateMode !== undefined) delegateMode = opts.delegateMode;
  let workflows = f.workflowsEnabled && (opts.parentId ?? "") === "";
  if (opts.workflows !== undefined) workflows = opts.workflows;
  if ((opts.parentId ?? "") !== "") {
    delegateMode = false;
    workflows = false;
  }
  // Manager-created top-level agents normally have an isolated Registry. If the
  // shared Runtime resolved team capability for this run, reattach the canonical
  // manager-owned sub-agent tools here.
  if (
    (opts.parentId ?? "") === "" && multiAgent && f.manager !== undefined
  ) {
    registerSubAgentTools(registry, f.manager);
  }

  let thinkingLevel: ThinkingLevel = thinkingMedium;
  if (f.settings !== undefined) {
    thinkingLevel = f.settings.defaultThinkingLevel ?? thinkingMedium;
  }
  if (sess !== undefined) {
    const entry = sess.getLatestThinkingLevelChange();
    if (entry !== null && entry.thinkingLevel !== "") {
      thinkingLevel = entry.thinkingLevel;
    }
  }
  let expertIdentity = "";
  let expertRoster = "";
  if ((opts.parentId ?? "") === "") {
    expertIdentity = f.expertIdentity;
    expertRoster = f.expertRoster;
  }
  const cfg: Config = {
    id: opts.id,
    parentId: opts.parentId,
    provider: f.provider,
    vendor: f.providerName,
    model,
    mode,
    thinkingLevel,
    maxTokens: resolveMaxTokens(model),
    sandboxMgr: sb,
    settings: f.settings,
    allow: f.allow,
    session: sess,
    extraContext,
    ruleContent: f.ruleContent,
    compactionSettings: f.compactionSettings,
    approvalHandler: opts.approvalHandler ?? f.approvalHandler,
    multiAgent,
    delegateMode,
    workflows,
    expertIdentity,
    expertRoster,
  };

  let beforeToolCall = f.beforeToolCall;
  if (f.beforeToolCallForSession !== undefined) {
    beforeToolCall = composeBeforeToolCall(
      f.beforeToolCallForSession(sess),
      beforeToolCall,
    );
  }
  const loopCfg: AgentLoopConfig = {
    ...cfg,
    forcedMode: f.forcedMode,
    toolExecutionMode: toolExecMode,
    maxToolConcurrency,
    maxIterations,
    beforeToolCall,
    beforeToolExecute: f.beforeToolExecute,
  };
  // The session mailbox belongs to the conversational lead.
  if (
    (opts.parentId ?? "") === "" && opts.auxiliaryRole !== true &&
    f.memberMailbox !== undefined &&
    (opts.isSubAgent !== true || opts.ownsSessionMailbox === true)
  ) {
    const mailbox = f.memberMailbox;
    loopCfg.getSteeringMessages = () => mailbox.drainSteering() ?? [];
    if (f.memberWaitEnabled) {
      const followUps = composeFollowUps(mailbox, undefined);
      if (followUps !== undefined) {
        loopCfg.getFollowUpMessages = (ctx) => followUps(ctx.signal);
      }
    }
  }

  const a = newAgentWithLoopConfig(loopCfg, registry);
  return newAgentAdapter(a);
}

/** Returns a clone of the factory carrying a parent agent's runtime config. */
export function withParentRuntimeConfig(
  f: AgentFactory | undefined,
  cfg: AgentLoopConfig,
): AgentFactory | undefined {
  if (f === undefined) return undefined;
  const clone = cloneFactory(f);
  clone.provider = cfg.provider;
  clone.providerName = cfg.vendor ?? "";
  clone.model = cfg.model;
  clone.settings = cfg.settings;
  clone.allow = cfg.allow;
  clone.extraContext = cfg.extraContext ?? "";
  clone.ruleContent = cfg.ruleContent ?? "";
  clone.compactionSettings = cfg.compactionSettings ??
    { enabled: false, reserveTokens: 0, keepRecentTokens: 0 };
  clone.approvalHandler = cfg.approvalHandler;
  clone.beforeToolCall = cfg.beforeToolCall;
  clone.beforeToolExecute = cfg.beforeToolExecute;
  clone.forcedMode = cfg.forcedMode ?? "";
  clone.toolExecutionMode = cfg.toolExecutionMode ?? "";
  clone.maxToolConcurrency = cfg.maxToolConcurrency ?? 0;
  return clone;
}

/** Returns the resolved mode for a requested mode. Throws on resolver error. */
export function resolveAgentMode(
  f: AgentFactory | undefined,
  manager: SessionManager | undefined,
  requestedMode: string,
): string {
  if (f === undefined) return requestedMode;
  if (f.forcedMode !== "") return f.forcedMode;
  if (f.resolveMode !== undefined) {
    return f.resolveMode(manager, requestedMode);
  }
  return requestedMode;
}

/** Returns a clone of the factory carrying a new runtime config. */
export function withRuntimeConfig(
  f: AgentFactory | undefined,
  p: Provider | undefined,
  providerName: string,
  model: Model | undefined,
  settings: Settings | undefined,
  allow: AllowConfig | undefined,
): AgentFactory | undefined {
  if (f === undefined) return undefined;
  const clone = cloneFactory(f);
  if (p !== undefined) clone.provider = p;
  clone.providerName = providerName;
  if (model !== undefined) clone.model = model;
  if (settings !== undefined) {
    clone.settings = settings;
    clone.compactionSettings = compactionSettingsFromConfig(
      settings.compaction ?? {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 0,
      },
    );
  }
  if (allow !== undefined) clone.allow = allow;
  return clone;
}

function cloneFactory(f: AgentFactory): AgentFactory {
  const clone = new AgentFactory();
  Object.assign(clone, f);
  return clone;
}

/** Composes two BeforeToolCall hooks, short-circuiting on the first block. */
export function composeBeforeToolCall(
  first:
    | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
    | undefined,
  second:
    | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
    | undefined,
):
  | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
  | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return (ctx) => {
    const result = first(ctx);
    if (result !== undefined && result.block) return result;
    return second(ctx);
  };
}

/** Returns the appropriate sandbox for the given mode. */
function sandboxForMode(f: AgentFactory, mode: string) {
  if (f.sandboxMgr === undefined) return newNoneSandbox();
  switch (mode) {
    case "plan":
    case "agent":
      return f.sandboxMgr.getActive();
    case "yolo":
    case "os":
      return newNoneSandbox();
    default:
      return f.sandboxMgr.getActive();
  }
}

/** Creates a default session manager for the given work directory. */
function defaultSession(
  f: AgentFactory,
  workDir: string,
  subAgent: boolean,
): SessionManager {
  let sessionDir = "";
  if (f.settings !== undefined) sessionDir = getSessionDir(f.settings);
  if (sessionDir === "") sessionDir = platformSessionDir();
  if (subAgent) return newSubAgentManager(workDir, sessionDir);
  return newManager(workDir, sessionDir);
}

/** Creates an agent from public Builder options (Go `CreateFromPublicOptions`). */
export function createFromPublicOptions(
  _f: AgentFactory,
  b: Builder | undefined,
): PublicAgent | undefined {
  if (b === undefined) return undefined;
  try {
    return buildFromPublicBuilder(b);
  } catch {
    return undefined;
  }
}

/** Converts a public Builder into an internal Agent (public bridge). */
export function buildFromPublicBuilder(b: Builder): AgentAdapter {
  const cfg: BuilderConfig = b.config();

  if (cfg.provider === undefined) {
    throw new Error("agent: provider is required");
  }
  const internalProvider = new ProviderAdapter(cfg.provider);

  let model = internalProvider.getModel(cfg.modelID);
  if (model === undefined) {
    model = {
      id: cfg.modelID,
      name: cfg.modelID,
      provider: "",
      reasoning: false,
      input: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
    };
  }

  const compactionSettings: CompactionSettings = {
    enabled: cfg.compactionEnabled,
    reserveTokens: cfg.compactionReserve,
    keepRecentTokens: 0,
  };
  if (compactionSettings.reserveTokens === 0) {
    compactionSettings.reserveTokens = 16384;
  }

  let sandboxMgr: SandboxManager | undefined;
  if (cfg.sandboxEnabled) {
    sandboxMgr = newManagerWithOptions(cfg.workDir, { protectGit: true });
    sandboxMgr.setLevel(Level.Standard);
  }

  const sess = newManager(cfg.workDir, cfg.sessionDir);

  let sb;
  if (sandboxMgr !== undefined) {
    sb = sandboxMgr.getActive();
  } else {
    sb = newNoneSandbox();
  }
  let registry: Registry;
  if (cfg.disableBuiltinTools) {
    registry = newRegistry(cfg.workDir, sb);
  } else {
    registry = newRegistryWithConfig({
      workDir: cfg.workDir,
      sandbox: sb,
      toolFilter: cfg.tools,
    });
  }
  for (const et of cfg.externalTools) {
    if (et === undefined || et === null) continue;
    registry.register(newExternalToolAdapter(et));
  }

  const agentCfg: Config = {
    provider: internalProvider,
    model,
    mode: cfg.mode,
    thinkingLevel: cfg.thinkingLevel,
    maxTokens: resolveMaxTokensValue(cfg.maxTokens, model),
    maxTokensUserSet: cfg.maxTokens > 0,
    sandboxMgr: sandboxMgr !== undefined ? sandboxMgr.getActive() : undefined,
    session: sess,
    extraContext: cfg.systemPromptExtra,
    compactionSettings,
    approvalHandler: cfg.approvalHandler,
    multiAgent: cfg.multiAgent,
    delegateMode: cfg.delegateMode,
  };

  const loopCfg: AgentLoopConfig = {
    ...agentCfg,
    toolExecutionMode: cfg.toolExecutionMode,
    maxToolConcurrency: cfg.maxToolConcurrency,
    maxIterations: cfg.maxIterations,
  };

  const a = newAgentWithLoopConfig(loopCfg, registry);
  return newAgentAdapter(a);
}

// --- Register the internal builder with the public agent package ---

setBuilderFunc((b) => buildFromPublicBuilder(b));
