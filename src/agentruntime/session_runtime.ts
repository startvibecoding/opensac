// `(*SessionRuntime)` methods of agent_build.go, artifact.go, expert.go, and
//
// SessionRuntime is the front-end-neutral state required to construct and run
// an agent session. Adapters may wrap it with protocol-specific locks, approval
// state, and event delivery, but must not rebuild these shared resources.
//
// TypeScript requires one class body per module (Go splits the methods across
// several files), so this module owns the whole class. The standalone helpers
// with no receiver live in expert.ts, registry.ts, and artifact.ts.
//
// Deviations: `sync.RWMutex` is dropped (Node is single-threaded); `time.Time`
// maps to `Date`; `context.Context` maps to an optional `AbortSignal`; the
// resource-assembly loaders are async because Node's filesystem APIs are async;
// and Go's `(value, error)` returns throw typed errors.

import {
  type AfterToolCallContext,
  type Agent,
  type AgentLoopConfig,
  type BeforeToolCallContext,
  type BeforeToolExecuteContext,
  compactionSettingsFromConfig,
  composeFollowUps,
  createAgentWithLoopConfig,
  createExtendBudgetTool,
  createMemberMailbox,
  emptyIterationBudgetPolicy,
  type IterationBudgetPolicy,
  iterationBudgetPolicyEnabled,
  type MemberMailbox,
  resolveMaxTokens,
  type ToolCallBlockResult,
  type ToolCallResult,
} from "../agent/mod.ts";
import {
  registerTool as registerBrowserTool,
  removeTool as removeBrowserTool,
  SKILL_NAME as BrowserSkillName,
} from "../browser/mod.ts";
import { type AllowConfig } from "../config/allow.ts";
import {
  configDir,
  getGlobalSkillsDir,
  isImageGenerationEnabled,
  isPlanToolEnabled,
  type Settings,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
} from "../config/settings.ts";
import {
  buildContextString,
  loadContextFiles,
  loadRuleFile,
} from "../contextfiles/contextfiles.ts";
import { Center } from "../expert/center.ts";
import { type Bundle, type Summary } from "../expert/expert.ts";
import { type Client, closeClients, connectServers } from "../mcp/mcp.ts";
import { loadConfiguredServers } from "../mcp/config.ts";
import { type Model, type ThinkingLevel } from "../provider/types.ts";
import {
  type Attachment,
  createUserMessage,
  type Message,
} from "../provider/types.ts";
import {
  type AttachmentMetadataResolver,
  type AttachmentResolver,
  validateAttachmentReferenceForResolver,
} from "../provider/attachments.ts";
import { type Provider } from "../provider/provider.ts";
import {
  parseQualifiedModel,
  qualifiedModel,
  resolveModel as resolveProviderModel,
} from "../provider/factory/factory.ts";
import { type RunContext } from "../agent/run_context.ts";
import { type AgentID } from "../../sdk/agent/types.ts";
import {
  createManager,
  Level,
  type Manager as SandboxManager,
  type Options as SandboxOptions,
} from "../sandbox/sandbox.ts";
import { type SandboxSettings } from "../config/settings.ts";
import { runUserEntryID } from "../session/run_user_message.ts";
import {
  loadSessionCapabilities,
  saveSessionCapabilities,
} from "../session/session_events.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import {
  createManager as createSkillsManager,
  type Manager as SkillsManager,
  projectSkillDirs,
} from "../skills/mod.ts";
import { ImageGenerationTool } from "../tools/image_generation.ts";
import { SkillRefTool } from "../tools/skill_ref.ts";
import { createRegistry, type Registry } from "../tools/tool.ts";
import {
  ensureProjectSkill,
  skillName as WorkflowSkillName,
} from "../workflow/skill.ts";
import { AttachmentService } from "./input.ts";
import {
  defaultInputPolicy,
  type InputIngress,
  InputMaterializer,
  type InputResource,
  type InputSubmission,
  type PreparedInput,
  preparedInput,
} from "./input_materializer.ts";
import { defaultAttachmentPolicy } from "./attachment.ts";
import {
  ATTACHMENT_AUDIO,
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
  type AttachmentKind,
  type SessionAttachment,
} from "./attachment.ts";
import { formatKnowledgeCapsules } from "./knowledge_context.ts";
import { ArtifactCollector, createPublishArtifactTool } from "./artifact.ts";
import type { DecisionService } from "./decision.ts";
import type { ExecutionRuntime } from "./execution.ts";
import {
  composeSteering,
  createExpertBinding,
  type ExpertBinding,
  expertConfigOption,
  ExpertSwitchRequiresForkError,
  expertSwitchRequiresForkMessage,
  inspectExpert as inspectExpertImpl,
  listExperts as listExpertsImpl,
  type PreparedExpertResources,
  projectExpertBuild,
  resolveBoundExpertBundle,
} from "./expert.ts";
import { normalizeAdditionalDirectories } from "./session_directories.ts";
import {
  CONFIG_OPTION_BROWSER,
  CONFIG_OPTION_EXPERT,
  CONFIG_OPTION_MODE,
  CONFIG_OPTION_MODEL,
  CONFIG_OPTION_PROVIDER,
  CONFIG_OPTION_SANDBOX,
  CONFIG_OPTION_THINKING_LEVEL,
  CONFIG_OPTION_WEB_SEARCH,
  type ProviderCatalog,
  type SessionConfigOption,
  sessionConfigOptionsWithProviders,
  validateThinkingLevel,
} from "./session_options.ts";
import {
  resolveManagerPolicy,
  resolveManagerSource,
} from "./session_source.ts";
import {
  ExecutionPolicy,
  MODE_YOLO,
  policyForSource,
  resolveIterationBudget,
  type RuntimeSource,
  SOURCE_UNKNOWN,
  type SourceResolution,
  sourceWaitsForMembers,
} from "./source.ts";
import { beforeToolCallForPolicy } from "./tool_policy.ts";
import { beforeToolExecuteForRuntime } from "./tool_fence.ts";
import { isMCPServerEnabled, type MCPPolicy } from "./registry.ts";
import { type SessionCapabilities } from "../session/session_events.ts";

/** The front-end-neutral state required to construct and run a session. */
export interface SessionRuntimeInit {
  id?: string;
  source?: RuntimeSource;
  entrySource?: RuntimeSource;
  policy?: ExecutionPolicy;
  workDir?: string;
  manager?: SessionManager;
  inputs?: InputMaterializer | null;
  attachments?: AttachmentService | null;
  registry?: Registry | null;
  sandboxMgr?: SandboxManager;
  skillsMgr?: SkillsManager;
  mcpClients?: Client[];
  providers?: ProviderCatalog;
  extraContext?: string;
  ruleContent?: string;
  additionalDirectories?: string[];
  artifactEnabled?: boolean;
  resourceSettings?: Settings | null;
  resourceWorkflows?: boolean;
  resourceBrowser?: boolean;
}

/**
 * The front-end-neutral state required to construct and run an agent session.
 * Adapters may wrap it with protocol-specific locks, approval state, and event
 * delivery, but must not rebuild these shared resources.
 */
export class SessionRuntime {
  id: string;
  source: RuntimeSource;
  entrySource: RuntimeSource;
  policy: ExecutionPolicy;
  workDir: string;
  manager: SessionManager | undefined;
  inputs: InputMaterializer | null;
  attachments: AttachmentService | null;
  registry: Registry | null;
  sandboxMgr: SandboxManager | undefined;
  skillsMgr: SkillsManager | undefined;
  mcpClients: Client[];
  extraContext: string;
  ruleContent: string;
  lastUsed: Date;
  execution: ExecutionRuntime | undefined;
  decisions: DecisionService | null;
  provider: Provider | null;
  providerName: string;
  providers: ProviderCatalog;
  model: Model | null;
  mode: string;
  thinkingLevel: ThinkingLevel;
  additionalDirectories: string[];
  sandboxEnabled: boolean;
  browserEnabled: boolean;
  webSearchEnabled: boolean;
  artifactEnabled: boolean;
  expert: ExpertBinding | null;
  mailbox: MemberMailbox | null;
  expertCenter: Center | null;
  resourceSettings: Settings | null;
  resourceWorkflows: boolean;
  resourceBrowser: boolean;
  closed: boolean;

  constructor(init: SessionRuntimeInit = {}) {
    this.id = init.id ?? "";
    this.source = init.source ?? SOURCE_UNKNOWN;
    this.entrySource = init.entrySource ?? SOURCE_UNKNOWN;
    this.policy = init.policy ?? policyForSource(SOURCE_UNKNOWN, "");
    this.workDir = init.workDir ?? "";
    this.manager = init.manager;
    this.inputs = init.inputs ?? null;
    this.attachments = init.attachments ?? null;
    this.registry = init.registry ?? null;
    this.sandboxMgr = init.sandboxMgr;
    this.skillsMgr = init.skillsMgr;
    this.mcpClients = init.mcpClients ?? [];
    this.extraContext = init.extraContext ?? "";
    this.ruleContent = init.ruleContent ?? "";
    this.lastUsed = new Date();
    this.execution = undefined;
    this.decisions = null;
    this.provider = null;
    this.providerName = "";
    this.providers = init.providers ?? {};
    this.model = null;
    this.mode = "";
    this.thinkingLevel = "";
    this.additionalDirectories = init.additionalDirectories ?? [];
    this.sandboxEnabled = false;
    this.browserEnabled = false;
    this.webSearchEnabled = false;
    this.artifactEnabled = init.artifactEnabled ?? false;
    this.expert = null;
    this.mailbox = null;
    this.expertCenter =
      init.workDir !== undefined && init.workDir !== ""
        ? new Center(init.workDir)
        : null;
    this.resourceSettings = init.resourceSettings ?? null;
    this.resourceWorkflows = init.resourceWorkflows ?? false;
    this.resourceBrowser = init.resourceBrowser ?? false;
    this.closed = false;
  }

  /** Attaches the session's canonical execution lifecycle. */
  setExecution(execution: ExecutionRuntime | undefined): void {
    this.execution = execution;
  }

  /** Attaches the session's shared decision lifecycle. */
  setDecisions(decisions: DecisionService | null): void {
    this.decisions = decisions;
  }

  /**
   * Cancels the active execution, waits for its terminal transition, and then
   * releases Runtime-owned MCP resources. A signal bounds the wait.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    const execution = this.execution;
    const decisions = this.decisions;
    let runID = "";
    let shutdownErr: unknown;
    if (execution !== undefined) {
      runID = execution.active().runId;
      try {
        await execution.shutdownContext(signal, "session runtime shutdown");
      } catch (err) {
        shutdownErr = err;
      }
    }
    if (decisions !== null) {
      if (runID !== "") {
        decisions.clearRunWithValue(runID, "cancelled");
      } else {
        for (const request of decisions.pending()) {
          decisions.clearRunWithValue(request.runId ?? "", "cancelled");
        }
      }
    }
    // Do not release MCP/resources while a loop is still active. Once the
    // execution is gone, release them even when durable terminal persistence
    // failed, so a shutdown error cannot leak MCP clients.
    if (shutdownErr === undefined) {
      this.close();
      return;
    }
    if (execution === undefined || !execution.active().active) {
      this.close();
    }
    throw shutdownErr;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * Releases resources owned by this runtime. Safe to call more than once and
   * prevents new resource mutations after the first close.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const clients = this.mcpClients;
    this.mcpClients = [];
    closeClients(clients);
  }

  /** Throws when this runtime has been closed. */
  ensureOpen(): void {
    if (this.closed) {
      throw new Error("agent runtime is closed");
    }
  }

  /**
   * Resolves the Runtime's effective execution policy. Go returns
   * `(ExecutionPolicy, error)`; this throws so the narrow AgentManagerRuntime
   * view can consume it synchronously.
   */
  resolvedExecutionPolicy(defaultMode: string): ExecutionPolicy {
    let source = this.source;
    const entrySource = this.entrySource;
    const policySource = this.policy.source;
    let policyDefault = this.policy.defaultMode;
    const manager = this.manager;
    if (source === SOURCE_UNKNOWN && policySource !== SOURCE_UNKNOWN) {
      source = policySource;
    }
    if (policyDefault === "") {
      policyDefault = defaultMode;
    }
    const resolved = resolveManagerPolicy(
      manager,
      { current: source, requested: entrySource },
      "",
      "",
      policyDefault,
    );
    return policyForSource(resolved.resolution.source, policyDefault);
  }

  /** Resolves one source/mode pair from Runtime-owned identity. */
  resolvePolicy(
    sessionMode: string,
    requestedMode: string,
    defaultMode: string,
  ): { resolution: SourceResolution; mode: string } {
    this.ensureOpen();
    let source = this.source;
    const entrySource = this.entrySource;
    const policySource = this.policy.source;
    let policyDefault = this.policy.defaultMode;
    const manager = this.manager;
    if (source === SOURCE_UNKNOWN && policySource !== SOURCE_UNKNOWN) {
      source = policySource;
    }
    if (policyDefault === "") {
      policyDefault = defaultMode;
    }
    return resolveManagerPolicy(
      manager,
      { current: source, requested: entrySource },
      sessionMode,
      requestedMode,
      policyDefault,
    );
  }

  /**
   * Attaches or replaces the persisted session identity owned by this Runtime.
   * Used by frontends that create sessions lazily.
   */
  async bindSession(
    manager: SessionManager,
    requested?: RuntimeSource,
  ): Promise<void> {
    this.ensureOpen();
    const header = manager.getHeader();
    if (header === null) {
      throw new Error("initialized session manager is required");
    }
    let entrySource = requested ?? SOURCE_UNKNOWN;
    if (entrySource === SOURCE_UNKNOWN) {
      entrySource = this.entrySource;
    }
    const resolved = resolveManagerSource(manager, { requested: entrySource });
    const inputs = createInputMaterializer(
      manager.getSessionDir(),
      header.cwd,
      defaultInputPolicy(),
    );
    const attachments = createAttachmentService(
      manager.getSessionDir(),
      defaultAttachmentPolicy(),
    );
    const prepared = await this.prepareBoundSessionResources(manager);
    if (this.closed) {
      throw new Error("agent runtime is closed");
    }
    this.id = header.id;
    this.source = resolved.source;
    this.entrySource = entrySource;
    this.policy.source = resolved.source;
    this.workDir = header.cwd;
    this.manager = manager;
    this.inputs = inputs;
    this.attachments = attachments;
    this.expertCenter = new Center(header.cwd);
    this.publishPreparedExpertResourcesLocked(prepared);
  }

  /**
   * Installs the initial per-session provider, model, mode, and thinking
   * bindings. It does not own provider construction.
   */
  configureSession(
    p: Provider,
    providerName: string,
    model: Model,
    mode: string,
    thinking: ThinkingLevel,
  ): void {
    this.ensureOpen();
    if (p === null || model === null) {
      throw new Error("session provider and model are required");
    }
    if (providerName === "") {
      providerName = p.name();
    }
    if (p.getModel(model.id) === undefined) {
      throw new Error(
        `model ${JSON.stringify(model.id)} is not available for provider ${JSON.stringify(
          providerName,
        )}`,
      );
    }
    if (mode.trim() === "") {
      mode = MODE_YOLO;
    }
    const { mode: effectiveMode } = this.resolvePolicy("", mode, MODE_YOLO);
    thinking = validateThinkingLevel(thinking);
    if (this.closed) {
      throw new Error("agent runtime is closed");
    }
    this.provider = p;
    this.providerName = providerName;
    let hasProvider = false;
    for (const name of Object.keys(this.providers)) {
      if (name.toLowerCase() === providerName.toLowerCase()) {
        hasProvider = true;
        break;
      }
    }
    if (!hasProvider) {
      const providers = cloneProviderCatalog(this.providers) ?? {};
      providers[providerName] = p;
      this.providers = providers;
    }
    this.model = model;
    this.mode = effectiveMode;
    this.thinkingLevel = thinking;
    this.lastUsed = new Date();
  }

  /** Returns the current session configuration atomically. */
  configSnapshot(): {
    provider: Provider | null;
    providerName: string;
    model: Model | null;
    mode: string;
    thinkingLevel: ThinkingLevel;
  } {
    return {
      provider: this.provider,
      providerName: this.providerName,
      model: this.model,
      mode: this.mode,
      thinkingLevel: this.thinkingLevel,
    };
  }

  /**
   * Returns a copy of the Runtime resource settings for a Runtime-owned derived
   * execution. The copy prevents a caller from mutating the active session's
   * shared configuration.
   */
  settingsSnapshot(): Settings | null {
    if (this.resourceSettings === null) return null;
    return { ...this.resourceSettings };
  }

  /**
   * Resolves an optional derived-role provider/model pair from the Runtime
   * provider catalog. Empty values retain this session's configured provider
   * and model.
   */
  resolveProviderModel(
    providerName: string,
    modelID: string,
  ): { provider: Provider; providerName: string; model: Model } {
    this.ensureOpen();
    const current = this.configSnapshot();
    providerName = providerName.trim();
    modelID = modelID.trim();
    if (providerName === "" && modelID === "") {
      if (current.provider === null || current.model === null) {
        throw new Error("session provider and model are required");
      }
      return {
        provider: current.provider,
        providerName: current.providerName,
        model: current.model,
      };
    }
    if (providerName === "" || modelID === "") {
      throw new Error("provider and model must be specified together");
    }
    const p = this.providerByName(providerName);
    const model = resolveProviderModel(p, providerName, modelID);
    return { provider: p, providerName, model };
  }

  /** Returns the mutable session capabilities used by the config-options contract. */
  capabilitySnapshot(): {
    sandboxEnabled: boolean;
    browserEnabled: boolean;
    webSearchEnabled: boolean;
  } {
    return {
      sandboxEnabled: this.sandboxEnabled,
      browserEnabled: this.browserEnabled,
      webSearchEnabled: this.webSearchEnabled,
    };
  }

  /** Reports whether this entry point permits agents to publish generated files. */
  artifactCapabilitySnapshot(): boolean {
    return this.artifactEnabled;
  }

  /** Updates the entry-point policy used by subsequent runs. */
  setArtifactEnabled(enabled: boolean): void {
    this.ensureOpen();
    this.artifactEnabled = enabled;
    this.lastUsed = new Date();
  }

  /**
   * Applies adapter-selected defaults and replays the persisted browser/
   * web-search capability state when a session has one.
   */
  configureCapabilities(
    sandboxEnabled: boolean,
    browserEnabled: boolean,
    webSearchEnabled: boolean,
  ): void {
    this.ensureOpen();
    const manager = this.manager;
    if (manager !== undefined) {
      const loaded = loadSessionCapabilities(manager.getSessionDir(), this.id);
      if (loaded !== null) {
        browserEnabled = loaded.browser;
        webSearchEnabled = loaded.webSearch;
      }
    }
    this.sandboxEnabled = sandboxEnabled;
    this.browserEnabled = browserEnabled;
    this.webSearchEnabled = webSearchEnabled;
    this.applySandboxLevel(sandboxEnabled);
    this.synchronizeCoreToolsLocked(browserEnabled);
    this.lastUsed = new Date();
  }

  /** Persists and applies one boolean session capability. */
  setCapabilityOption(id: string, enabled: boolean): void {
    this.ensureOpen();
    id = id.trim();
    const manager = this.manager;
    let sandboxEnabled = this.sandboxEnabled;
    let browserEnabled = this.browserEnabled;
    let webSearchEnabled = this.webSearchEnabled;
    switch (id) {
      case CONFIG_OPTION_SANDBOX:
        sandboxEnabled = enabled;
        break;
      case CONFIG_OPTION_BROWSER:
        browserEnabled = enabled;
        break;
      case CONFIG_OPTION_WEB_SEARCH:
        webSearchEnabled = enabled;
        break;
      default:
        throw new Error(
          `unknown capability config option ${JSON.stringify(id)}`,
        );
    }
    this.sandboxEnabled = sandboxEnabled;
    this.browserEnabled = browserEnabled;
    this.webSearchEnabled = webSearchEnabled;
    this.applySandboxLevel(sandboxEnabled);
    this.synchronizeCoreToolsLocked(browserEnabled);
    this.lastUsed = new Date();
    if (manager !== undefined) {
      const persisted =
        loadSessionCapabilities(manager.getSessionDir(), this.id) ??
        emptyCapabilities(this.id);
      persisted.sessionId = this.id;
      persisted.browser = browserEnabled;
      persisted.webSearch = webSearchEnabled;
      saveSessionCapabilities(manager.getSessionDir(), persisted);
    }
  }

  /** Returns a copy of the current session roots. */
  additionalDirectoriesSnapshot(): string[] {
    return [...this.additionalDirectories];
  }

  /** Persists and applies a complete replacement of the session roots. */
  setAdditionalDirectories(directories: string[]): void {
    this.ensureOpen();
    const normalized = normalizeAdditionalDirectories(directories);
    const manager = this.manager;
    const previous = [...this.additionalDirectories];
    if (
      manager !== undefined &&
      (normalized.length > 0 || previous.length > 0)
    ) {
      manager.reload();
      manager.appendAdditionalDirectories(normalized);
    }
    this.additionalDirectories = [...normalized];
    this.lastUsed = new Date();
  }

  /** Applies the latest persisted directory binding. */
  reloadAdditionalDirectories(manager: SessionManager | undefined): void {
    if (manager === undefined) return;
    const entry = manager.getLatestAdditionalDirectories();
    if (entry === null) return;
    const normalized = normalizeAdditionalDirectories(entry.directories);
    this.additionalDirectories = [...normalized];
  }

  /** Returns the standard mutable configuration catalog for this session. */
  configOptions(): SessionConfigOption[] {
    const p = this.provider;
    const providerName = this.providerName;
    const model = this.model;
    const mode = this.mode;
    const thinking = this.thinkingLevel;
    let providers = cloneProviderCatalog(this.providers);
    if (p === null) return [];
    if (providers === null || Object.keys(providers).length === 0) {
      providers = { [providerName]: p };
    }
    let options = sessionConfigOptionsWithProviders(
      providerName,
      providers,
      p.models(),
      model,
      mode,
      thinking,
    );
    options = options.concat(this.expertConfigOption());
    options = options.concat([
      {
        type: "boolean",
        id: CONFIG_OPTION_BROWSER,
        name: "Browser",
        category: "browser",
        currentValue: this.browserEnabled ? "true" : "false",
      },
      {
        type: "boolean",
        id: CONFIG_OPTION_WEB_SEARCH,
        name: "Web search",
        category: "web_search",
        currentValue: this.webSearchEnabled ? "true" : "false",
      },
    ]);
    return options;
  }

  /** Refreshes the manager's optimistic-lock cursor and in-memory bindings. */
  reloadPersistedConfig(manager: SessionManager | undefined): void {
    if (manager === undefined) return;
    this.reloadAdditionalDirectories(manager);
    let {
      provider: p,
      providerName,
      model,
      mode,
      thinkingLevel: thinking,
    } = this.configSnapshot();
    if (p === null) {
      throw new Error("session provider is unavailable");
    }
    const modelChange = manager.getLatestModelChange();
    if (modelChange !== null) {
      if (
        modelChange.provider !== "" &&
        modelChange.provider.toLowerCase() !== providerName.toLowerCase()
      ) {
        p = this.providerByName(modelChange.provider);
        providerName = modelChange.provider;
      }
      model = resolveProviderModel(p, providerName, modelChange.modelId);
    }
    const modeChange = manager.getLatestModeChange();
    if (modeChange !== null && modeChange.mode.trim() !== "") {
      mode = this.resolvePolicy("", modeChange.mode, MODE_YOLO).mode;
    }
    const thinkingChange = manager.getLatestThinkingLevelChange();
    if (thinkingChange !== null && thinkingChange.thinkingLevel.trim() !== "") {
      thinking = validateThinkingLevel(thinkingChange.thinkingLevel);
    }
    this.provider = p;
    this.providerName = providerName;
    this.model = model;
    this.mode = mode;
    this.thinkingLevel = thinking;
    this.lastUsed = new Date();
  }

  /** Validates, persists, and applies one mutable session option. */
  async setConfigOption(id: string, value: string): Promise<void> {
    this.ensureOpen();
    id = id.trim();
    value = value.trim();
    if (id === "" || (value === "" && id !== CONFIG_OPTION_EXPERT)) {
      throw new Error("config option id and value are required");
    }
    if (id === CONFIG_OPTION_EXPERT) {
      await this.setExpert(value);
      return;
    }
    let { provider: p, providerName } = this.configSnapshot();
    let currentModel = this.model;
    const currentMode = this.mode;
    if (p === null) {
      throw new Error("session provider is unavailable");
    }
    const manager = this.manager;
    if (manager !== undefined) {
      manager.reload();
      this.reloadPersistedConfig(manager);
      const snap = this.configSnapshot();
      p = snap.provider;
      providerName = snap.providerName;
      currentModel = snap.model;
      if (p === null) {
        throw new Error("session provider is unavailable");
      }
    }
    switch (id) {
      case CONFIG_OPTION_PROVIDER: {
        const target = this.providerByName(value);
        let targetName = value;
        let matched = false;
        const catalog = cloneProviderCatalog(this.providers) ?? {};
        for (const name of Object.keys(catalog)) {
          if (name.toLowerCase() === value.toLowerCase()) {
            targetName = name;
            matched = true;
            break;
          }
        }
        if (!matched && target.name() !== "") {
          targetName = target.name();
        }
        const currentModelID = currentModel === null ? "" : currentModel.id;
        let model = target.getModel(currentModelID);
        if (model === undefined) {
          const models = target.models();
          if (models.length > 0) model = models[0];
        }
        if (model === undefined) {
          throw new Error(
            `provider ${JSON.stringify(targetName)} has no usable model`,
          );
        }
        if (manager !== undefined) {
          manager.appendModelChange(targetName, model.id);
        }
        this.provider = target;
        this.providerName = targetName;
        this.model = model;
        this.lastUsed = new Date();
        return;
      }
      case CONFIG_OPTION_MODEL: {
        if (value.includes("/")) {
          const qualified = parseQualifiedModel(value);
          if (qualified === undefined) {
            throw new Error(`invalid qualified model ${JSON.stringify(value)}`);
          }
          if (
            qualified.providerName.toLowerCase() !== providerName.toLowerCase()
          ) {
            p = this.providerByName(qualified.providerName);
            providerName = qualified.providerName;
          }
        }
        const model = resolveProviderModel(p, providerName, value);
        if (manager !== undefined) {
          manager.appendModelChange(providerName, model.id);
        }
        this.provider = p;
        this.providerName = providerName;
        this.model = model;
        this.lastUsed = new Date();
        return;
      }
      case CONFIG_OPTION_MODE: {
        const mode = this.resolvePolicy(currentMode, value, MODE_YOLO).mode;
        if (manager !== undefined) {
          manager.appendModeChange(mode);
        }
        this.mode = mode;
        this.lastUsed = new Date();
        return;
      }
      case CONFIG_OPTION_THINKING_LEVEL: {
        if (currentModel === null || !currentModel.reasoning) {
          throw new Error(
            `config option ${JSON.stringify(
              CONFIG_OPTION_THINKING_LEVEL,
            )} is unavailable for model ${JSON.stringify(
              qualifiedModel(
                providerName,
                currentModel ?? ({ id: "" } as Model),
              ),
            )}`,
          );
        }
        const thinking = validateThinkingLevel(value);
        if (manager !== undefined) {
          manager.appendThinkingLevelChange(thinking);
        }
        this.thinkingLevel = thinking;
        this.lastUsed = new Date();
        return;
      }
      default:
        throw new Error(`unsupported config option ${JSON.stringify(id)}`);
    }
  }

  /** Resolves a provider from this session's catalog (case-insensitive). */
  providerByName(name: string): Provider {
    name = name.trim();
    if (name === "") {
      throw new Error("provider is required");
    }
    for (const [catalogName, p] of Object.entries(this.providers)) {
      if (catalogName.toLowerCase() === name.toLowerCase() && p !== null) {
        return p;
      }
    }
    if (
      this.providerName.toLowerCase() === name.toLowerCase() &&
      this.provider !== null
    ) {
      return this.provider;
    }
    throw new Error(`provider ${JSON.stringify(name)} is not available`);
  }

  /**
   * Clears persisted session identity while retaining reusable Runtime-owned
   * resources for a frontend that will lazily create another session.
   */
  async unbindSession(): Promise<void> {
    this.ensureOpen();
    this.id = "";
    this.source = this.entrySource;
    this.policy.source = this.source;
    this.manager = undefined;
    this.lastUsed = new Date();
    await this.rehydrateBoundResources();
  }

  // --- Expert orchestration -------------------------------------------------

  /** Returns the resolved binding and the session member mailbox. */
  expertState(): {
    binding: ExpertBinding | null;
    mailbox: MemberMailbox | null;
  } {
    return { binding: this.expert, mailbox: this.mailbox };
  }

  /** Projects the discoverable expert bundles for this work directory. */
  listExperts(): Summary[] {
    return listExpertsImpl(this.workDir);
  }

  /** Resolves one expert bundle for display or preflight validation. */
  inspectExpert(expertID: string): Bundle {
    return inspectExpertImpl(this.workDir, expertID);
  }

  /** Exposes the Runtime-discovered bundle catalog. */
  expertConfigOption(): SessionConfigOption {
    let current = "";
    if (this.manager !== undefined) {
      current = this.manager.getExpertId().trim();
    }
    return expertConfigOption(this.workDir, current);
  }

  /** Reports whether this session is bound to a team expert. */
  teamExpertActive(): boolean {
    return this.expert !== null && this.expert.team;
  }

  /** Resolves the persisted header binding into `this.expert`. */
  refreshExpertBinding(): void {
    let expertID = "";
    if (this.manager !== undefined) {
      expertID = this.manager.getExpertId();
    }
    if (expertID.trim() === "") {
      this.expert = null;
      return;
    }
    let center = this.expertCenter;
    if (center === null) {
      center = new Center(this.workDir);
    }
    const bundle = center.get(expertID);
    if (bundle.invalid) {
      throw new Error(
        `expert bundle ${JSON.stringify(
          expertID,
        )} is invalid: ${bundle.invalidReason}`,
      );
    }
    this.expert = createExpertBinding(bundle);
  }

  /**
   * Binds or unbinds the session expert (empty string unbinds) and persists the
   * header binding.
   */
  async setExpert(expertID: string): Promise<void> {
    this.ensureOpen();
    const manager = this.manager;
    if (manager === undefined) {
      throw new Error("expert binding requires a session manager");
    }
    const nextID = expertID.trim();
    const currentID = manager.getExpertId().trim();
    if (currentID !== "" && nextID !== "" && currentID !== nextID) {
      throw new ExpertSwitchRequiresForkError(
        `${expertSwitchRequiresForkMessage}: ${JSON.stringify(currentID)} -> ${JSON.stringify(
          nextID,
        )}`,
      );
    }
    const prepared = await this.prepareExpertResources(nextID);
    manager.setExpertBinding(nextID);
    await this.publishPreparedExpertResources(prepared);
  }

  /** Validates the requested bundle and eagerly builds its Runtime resources. */
  async prepareExpertResources(
    expertID: string,
  ): Promise<PreparedExpertResources> {
    let center = this.expertCenter;
    const workDir = this.workDir;
    if (center === null) {
      center = new Center(workDir);
    }
    let bundle: Bundle | null = null;
    if (expertID !== "") {
      bundle = center.get(expertID);
      if (bundle.invalid) {
        throw new Error(
          `expert bundle ${JSON.stringify(
            expertID,
          )} is invalid: ${bundle.invalidReason}`,
        );
      }
    }
    return await this.prepareResourcesForBundle(bundle, workDir);
  }

  /**
   * Validates every session-dependent resource before `bindSession` publishes a
   * new identity.
   */
  async prepareBoundSessionResources(
    manager: SessionManager,
  ): Promise<PreparedExpertResources> {
    const header = manager.getHeader();
    if (header === null) {
      throw new Error("initialized session manager is required");
    }
    const bundle = resolveBoundExpertBundle(header.cwd, manager);
    return await this.prepareResourcesForBundle(bundle, header.cwd);
  }

  /** Turns one resolved bundle into the Runtime-owned resources it affects. */
  async prepareResourcesForBundle(
    bundle: Bundle | null,
    workDir: string,
  ): Promise<PreparedExpertResources> {
    const settings = this.resourceSettings;
    const workflows = this.resourceWorkflows;
    const browserEnabled = this.resourceBrowser;
    const prepared: PreparedExpertResources = {
      binding: bundle !== null ? createExpertBinding(bundle) : null,
      skillsMgr: null,
      extraContext: "",
      ruleContent: "",
      hasResources: false,
    };
    if (settings === null) {
      return prepared;
    }
    const resources = await loadContextResourcesWithExpert(
      settings,
      workDir,
      workflows,
      browserEnabled,
      bundle,
    );
    prepared.skillsMgr = resources.skillsMgr;
    prepared.extraContext = resources.extraContext;
    prepared.ruleContent = resources.ruleContent;
    prepared.hasResources = true;
    return prepared;
  }

  /** Installs a successful preflight result (async wrapper). */
  publishPreparedExpertResources(prepared: PreparedExpertResources): void {
    this.ensureOpen();
    this.publishPreparedExpertResourcesLocked(prepared);
  }

  /** Installs a successful preflight result (in-memory only). */
  publishPreparedExpertResourcesLocked(
    prepared: PreparedExpertResources,
  ): void {
    this.expert = prepared.binding;
    if (prepared.hasResources) {
      if (this.registry !== null) {
        this.registry.register(new SkillRefTool(prepared.skillsMgr!));
      }
      this.synchronizeCoreToolsLocked(this.resourceBrowser);
      this.skillsMgr = prepared.skillsMgr ?? undefined;
      this.extraContext = prepared.extraContext;
      this.ruleContent = prepared.ruleContent;
    }
    this.lastUsed = new Date();
  }

  /** Injects adapter-owned tools into this Runtime. */
  applyRegistryHooks(hooks: RegistryHook[]): void {
    this.ensureOpen();
    if (this.closed) {
      throw new Error("agent runtime is closed");
    }
    for (const hook of hooks) {
      if (hook === null || hook === undefined) continue;
      hook(this);
    }
  }

  /**
   * Reloads context files and skills, synchronizes the shared skill_ref/browser
   * tools, and updates the Runtime fields atomically after validation succeeds.
   */
  async refreshResources(
    settings: Settings,
    opts: RefreshOptions,
  ): Promise<void> {
    if (settings === null) {
      throw new Error("agent runtime settings are required");
    }
    this.ensureOpen();
    const workDir = this.workDir;
    const manager = this.manager;
    const expertBundle = resolveBoundExpertBundle(workDir, manager);
    const resources = await loadContextResourcesWithExpert(
      settings,
      workDir,
      opts.workflows,
      opts.browser,
      expertBundle,
    );
    const skillsMgr = resources.skillsMgr;
    const extraContext = resources.extraContext;
    const activeContext = activeSkillsContext(skillsMgr, opts.activeSkills);
    const binding =
      expertBundle !== null ? createExpertBinding(expertBundle) : null;
    if (this.closed) {
      throw new Error("agent runtime is closed");
    }
    if (this.workDir !== workDir || this.manager !== manager) {
      throw new Error(
        "session identity changed while refreshing runtime resources",
      );
    }
    if (this.registry !== null) {
      this.registry.register(new SkillRefTool(skillsMgr));
    }
    this.synchronizeCoreToolsLocked(opts.browser);
    this.expert = binding;
    this.skillsMgr = skillsMgr;
    this.extraContext = extraContext + activeContext;
    this.ruleContent = resources.ruleContent;
    this.resourceSettings = settings;
    this.resourceWorkflows = opts.workflows;
    this.resourceBrowser = opts.browser;
    this.lastUsed = new Date();
  }

  /**
   * Refreshes the resolved expert binding after a runtime is attached to,
   * detached from, or explicitly rebound to a session.
   */
  async rehydrateBoundResources(): Promise<void> {
    const settings = this.resourceSettings;
    const workflows = this.resourceWorkflows;
    const browserEnabled = this.resourceBrowser;
    if (settings === null) {
      this.refreshExpertBinding();
      return;
    }
    await this.refreshResources(settings, {
      workflows,
      browser: browserEnabled,
      activeSkills: {},
    });
  }

  /** Applies mutable registry tools with no adapter dependency. */
  synchronizeCoreTools(browserEnabled: boolean): void {
    if (this.closed) return;
    this.synchronizeCoreToolsLocked(browserEnabled);
  }

  private synchronizeCoreToolsLocked(browserEnabled: boolean): void {
    if (this.registry === null) return;
    if (browserEnabled) {
      registerBrowserTool(this.registry);
    } else {
      removeBrowserTool(this.registry);
    }
  }

  private applySandboxLevel(enabled: boolean): void {
    if (this.registry === null) return;
    if (this.sandboxMgr === undefined) return;
    let active = this.sandboxMgr.getActive();
    if (!enabled) {
      try {
        active = this.sandboxMgr.getForLevel(Level.None);
      } catch {
        // keep current
      }
    } else if (active.level() === Level.None) {
      try {
        active = this.sandboxMgr.getForLevel(Level.Standard);
      } catch {
        // keep current
      }
    }
    this.registry.setSandbox(active);
  }

  // --- Runtime input path ---------------------------------------------------

  /**
   * Materializes every ephemeral resource and returns the canonical submission
   * shape consumed by Agent Core.
   */
  async acceptInput(
    _signal: AbortSignal | undefined,
    runID: string,
    text: string,
    ingresses: InputIngress[],
  ): Promise<InputSubmission> {
    this.ensureOpen();
    if (ingresses.length === 0) {
      return emptySubmission(text);
    }
    const inputs = this.inputs;
    const sessionID = this.id;
    if (inputs === null || sessionID === "") {
      throw new Error("input materializer is not bound to a session");
    }
    const submission = emptySubmission(text);
    for (let index = 0; index < ingresses.length; index++) {
      const ingress = { ...ingresses[index] };
      // `itemIndex` 0 is the "unset" sentinel for non-first items and is
      // rewritten to the declared order.
      if (ingress.itemIndex === 0 && index !== 0) {
        ingress.itemIndex = index;
      }
      let record: InputResource;
      try {
        record = await inputs.Prepare(sessionID, runID, ingress);
      } catch (err) {
        this.discardInput(submission);
        throw err;
      }
      submission.resources.push(preparedInput(record));
    }
    return submission;
  }

  /**
   * Stages one resource before a Run exists, as used by editors and clipboard
   * UIs. The resulting ID/path is the only state an adapter retains.
   */
  async prepareInput(
    _signal: AbortSignal | undefined,
    ingress: InputIngress,
  ): Promise<PreparedInput> {
    this.ensureOpen();
    const inputs = this.inputs;
    const sessionID = this.id;
    if (inputs === null || sessionID === "") {
      throw new Error("input materializer is not bound to a session");
    }
    const record = await inputs.Prepare(sessionID, "", ingress);
    return preparedInput(record);
  }

  /**
   * Validates staged Runtime resources and returns the canonical submission
   * without copying or reconstructing adapter content.
   */
  attachPreparedInput(
    _signal: AbortSignal | undefined,
    text: string,
    resources: PreparedInput[],
  ): InputSubmission {
    this.ensureOpen();
    const inputs = this.inputs;
    const sessionID = this.id;
    if (inputs === null || sessionID === "") {
      throw new Error("input materializer is not bound to a session");
    }
    const submission = emptySubmission(text);
    submission.resources = [...resources];
    for (const resource of submission.resources) {
      if (resource.resourceId === "") {
        throw new Error("prepared input resource ID is required");
      }
      const record = inputs.get(sessionID, resource.resourceId);
      if (record.status === "deleted" || record.status === "missing") {
        throw new Error(
          `prepared input ${record.id} is unavailable (status ${record.status})`,
        );
      }
    }
    return submission;
  }

  /**
   * Removes only unbound Runtime resources in a submission. Safe to retry.
   */
  discardInput(input: InputSubmission): void {
    const inputs = this.inputs;
    const sessionID = this.id;
    if (inputs === null || sessionID === "") return;
    for (const resource of input.resources) {
      try {
        inputs.Discard(sessionID, resource.resourceId);
      } catch {
        // deliberately ignored
      }
    }
  }

  /** Runs the Runtime-owned draft/missing reconciliation. */
  cleanupInputResources(
    _signal: AbortSignal | undefined,
    now: Date | undefined,
  ): number {
    const inputs = this.inputs;
    const sessionID = this.id;
    if (inputs === null || sessionID === "") {
      throw new Error("input materializer is not bound to a session");
    }
    return inputs.Cleanup(sessionID, now);
  }

  /**
   * Emits only text plus a deterministic project-path manifest. It never reads
   * input bytes or constructs provider image/file blocks.
   */
  buildUserMessage(
    _signal: AbortSignal | undefined,
    input: InputSubmission,
  ): Message {
    this.ensureOpen();
    const knowledge = formatKnowledgeCapsules(input.knowledgeCapsules);
    if (input.resources.length === 0) {
      let text = input.text.trim();
      if (knowledge !== "") {
        if (text !== "") text += "\n\n";
        text += knowledge;
      }
      return createUserMessage(text);
    }
    const inputs = this.inputs;
    const sessionID = this.id;
    if (inputs === null || sessionID === "") {
      throw new Error("input materializer is not bound to a session");
    }
    const records: InputResource[] = [];
    for (const prepared of input.resources) {
      records.push(inputs.get(sessionID, prepared.resourceId));
    }
    let text = input.text.trim();
    const manifest = inputs.buildManifest(records);
    text = text !== "" ? `${text}\n\n${manifest}` : manifest;
    if (knowledge !== "") {
      text += `\n\n${knowledge}`;
    }
    return createUserMessage(text);
  }

  /**
   * Materializes a provider-declared output attachment into the same private
   * session store used for inbound media. A URL or a filename alone is never an
   * artifact: the provider must expose an authorized resolver.
   */
  async acceptProviderAttachment(
    signal: AbortSignal | undefined,
    runID: string,
    p: Provider,
    attachment: Attachment,
  ): Promise<SessionAttachment> {
    this.ensureOpen();
    if (p === null || p === undefined) {
      throw new Error("provider attachment resolver is required");
    }
    const ref = attachment.providerRef ?? "";
    validateAttachmentReferenceForResolver(ref);
    const kind = attachment.kind as AttachmentKind;
    if (
      kind !== ATTACHMENT_IMAGE &&
      kind !== ATTACHMENT_FILE &&
      kind !== ATTACHMENT_AUDIO &&
      kind !== ATTACHMENT_VIDEO
    ) {
      throw new Error(
        `provider attachment kind ${JSON.stringify(
          attachment.kind,
        )} is not deliverable`,
      );
    }
    let content: { data: Uint8Array; mediaType: string; filename: string };
    const metadataResolver =
      p as unknown as Partial<AttachmentMetadataResolver>;
    const refResolver = p as unknown as Partial<AttachmentResolver>;
    if (typeof metadataResolver.resolveAttachmentWithMetadata === "function") {
      content = await metadataResolver.resolveAttachmentWithMetadata(
        signal,
        attachment,
      );
    } else if (typeof refResolver.resolveAttachment === "function") {
      content = await refResolver.resolveAttachment(signal, ref);
    } else {
      throw new Error(
        `provider ${JSON.stringify(p.name())} cannot resolve attachments`,
      );
    }
    if (content.data.length === 0) {
      throw new Error("provider attachment is empty");
    }
    const service = this.attachments;
    const sessionID = this.id;
    if (service === null || sessionID === "") {
      throw new Error("attachment runtime is not bound to a session");
    }
    let filename = content.filename;
    if (filename === "") filename = attachment.name ?? "";
    let mediaType = content.mediaType;
    if (mediaType === "") mediaType = attachment.mediaType ?? "";
    const bytes = content.data;
    const record = await service.acceptArtifact(
      sessionID,
      runID,
      {
        origin: `provider:${p.name()}`,
        reference: ref,
        kind,
        filename,
        mediaType,
        sizeHint: bytes.length,
        open: () => ({
          bytes,
          filename,
          mediaType,
          contentSize: bytes.length,
        }),
      },
      signal,
    );
    service.setStatus(sessionID, record.id, "generated");
    record.status = "generated";
    return record;
  }

  // --- Artifact collection --------------------------------------------------

  /**
   * Installs the Runtime-owned publication tool for one run. The caller must
   * close the collection after the Agent stream reaches a terminal state.
   */
  beginArtifactCollection(runID: string): ArtifactCollector | null {
    this.ensureOpen();
    if (runID.trim() === "") {
      throw new Error("artifact run ID is required");
    }
    if (!this.artifactEnabled) {
      return null;
    }
    const service = this.attachments;
    const registry = this.registry;
    if (
      service === null ||
      registry === null ||
      this.id === "" ||
      this.workDir === ""
    ) {
      throw new Error(
        "artifact runtime is not bound to a session and registry",
      );
    }
    const collector: ArtifactCollector = createArtifactCollector(this, runID);
    registry.register(createPublishArtifactTool(collector));
    return collector;
  }

  // --- MCP lifecycle --------------------------------------------------------

  /**
   * Connects policy servers to this Runtime's registry. Strict policy returns
   * errors; optional policy records them via `onError` and leaves the Runtime
   * usable without MCP clients.
   */
  async connectMCP(
    signal: AbortSignal | undefined,
    policy: MCPPolicy,
  ): Promise<void> {
    if (this.registry === null) {
      throw new Error("runtime registry is required");
    }
    const servers = policy.servers.filter((server) =>
      isMCPServerEnabled(server),
    );
    if (servers.length === 0) {
      return;
    }
    try {
      const clients = await connectServers(
        signal ?? new AbortController().signal,
        servers,
        this.registry,
        policy.callbacks ?? {},
      );
      this.mcpClients = clients;
    } catch (err) {
      if (policy.optional) {
        if (policy.onError !== undefined) policy.onError(err);
        return;
      }
      throw err;
    }
  }

  /**
   * Loads the standard global/project MCP configuration, appends explicitly
   * negotiated protocol servers, and applies the same strict/optional behavior.
   */
  async connectConfiguredMCP(
    signal: AbortSignal | undefined,
    policy: MCPPolicy,
  ): Promise<void> {
    let configured;
    try {
      configured = loadConfiguredServers(this.workDir);
    } catch (err) {
      if (policy.optional) {
        if (policy.onError !== undefined) policy.onError(err);
        return;
      }
      throw err;
    }
    policy.servers = [...configured, ...policy.servers];
    await this.connectMCP(signal, policy);
  }

  // --- Agent construction ---------------------------------------------------

  /** Builds the Agent using this runtime's shared resources. */
  buildAgent(opts: AgentBuildOptions): Agent {
    this.ensureOpen();
    const registry = this.registry;
    const manager = this.manager;
    const policyBudget = this.policy.iterationBudget;
    if (opts.provider === undefined) opts.provider = this.provider ?? undefined;
    if (opts.providerName === undefined || opts.providerName === "") {
      opts.providerName = this.providerName;
    }
    if (opts.model === undefined) opts.model = this.model ?? undefined;
    if (opts.mode === undefined || opts.mode === "") opts.mode = this.mode;
    if (opts.thinkingLevel === undefined || opts.thinkingLevel === "") {
      opts.thinkingLevel = this.thinkingLevel;
    }
    if (
      opts.iterationBudget === undefined ||
      isZeroIterationBudget(opts.iterationBudget)
    ) {
      opts.iterationBudget = policyBudget;
    }
    return this.doBuildAgent(registry, manager, opts, true);
  }

  /**
   * Constructs a non-persisted agent over an adapter-provided registry.
   * Intended for temporary side queries such as TUI /btw.
   */
  buildTransientAgent(registry: Registry, opts: AgentBuildOptions): Agent {
    this.ensureOpen();
    if (registry === null || registry === undefined) {
      throw new Error("transient agent registry is required");
    }
    return this.doBuildAgent(registry, undefined, opts, false);
  }

  private doBuildAgent(
    registry: Registry | null,
    manager: SessionManager | undefined,
    opts: AgentBuildOptions,
    enableIterationBudget: boolean,
  ): Agent {
    if (registry === null) {
      throw new Error("agent runtime registry is required");
    }
    if (opts.provider === undefined || opts.model === undefined) {
      throw new Error("agent provider and model are required");
    }
    if (
      opts.conversationTurn === true &&
      opts.runtimeOwnsTurnEnd === true &&
      (opts.runId ?? "") !== ""
    ) {
      opts.runtimeOwnsUserEntry = true;
      if ((opts.userEntryId ?? "") === "") {
        opts.userEntryId = runUserEntryID(opts.runId ?? "");
      }
    }
    const runtimeSource = this.source;
    let sandboxMgr = this.sandboxMgr;
    if (opts.sandboxMgr !== undefined) sandboxMgr = opts.sandboxMgr;
    if (opts.sandboxEnabled === false) sandboxMgr = undefined;
    let extraContext = this.extraContext;
    let ruleContent = this.ruleContent;
    const expertBinding = this.expert;
    const mailbox = this.mailbox;
    const projected = projectExpertBuild(expertBinding, {
      multiAgent: opts.multiAgent ?? false,
    });
    opts.multiAgent = opts.multiAgent ?? false;
    // `projectExpertBuild` mutates a bucket we copy back.
    const expertIdentity = projected.identity;
    const expertRoster = projected.roster;
    opts.multiAgent = projectedMultiAgent(expertBinding, opts.multiAgent);
    // Only the session's conversational lead owns the team mailbox.
    const teamBound = expertBinding !== null && expertBinding.team;
    let steeringMessages = opts.getSteeringMessages;
    let followUpMessages: AgentLoopConfig["getFollowUpMessages"];
    if (manager !== undefined && opts.auxiliaryRole !== true) {
      const composed = composeSteering(mailbox, opts.getSteeringMessages);
      steeringMessages = composed ?? undefined;
      if (teamBound || sourceWaitsForMembers(runtimeSource)) {
        const fu = composeFollowUps(mailbox, opts.getSteeringMessages);
        if (fu !== undefined) {
          followUpMessages = (ctx: RunContext) => fu(ctx.signal);
        }
      }
    }
    let settings = opts.settings;
    if (settings === undefined) settings = {};
    const settingsValue: Settings = { ...settings };
    if (manager !== undefined && manager.getSessionDir() !== "") {
      settingsValue.sessionDir = manager.getSessionDir();
    }
    settings = settingsValue;
    let mode = opts.mode ?? "";
    if (mode === "") mode = MODE_YOLO;
    if (opts.extraContext !== undefined && opts.extraContext !== "") {
      extraContext = opts.extraContext;
    }
    if (opts.ruleContent !== undefined && opts.ruleContent !== "") {
      ruleContent = opts.ruleContent;
    }
    const te = settings.toolExecution ?? {};
    let toolExecutionMode = opts.toolExecutionMode ?? "";
    let maxToolConcurrency = opts.maxToolConcurrency ?? 0;
    if (toolExecutionMode === "") {
      toolExecutionMode = toolExecutionEffectiveMode(te);
    }
    if (maxToolConcurrency <= 0) {
      maxToolConcurrency = toolExecutionEffectiveMaxConcurrency(te);
    }
    const policy = this.resolvedExecutionPolicy(MODE_YOLO);
    mode = policy.resolveMode("", mode);
    const beforeToolCall =
      beforeToolCallForPolicy(policy, opts.beforeToolCall) ?? undefined;
    let beforeToolExecute:
      | ((ctx: BeforeToolExecuteContext) => ToolCallBlockResult | undefined)
      | undefined = beforeToolExecuteForRuntime(this);
    if (opts.beforeToolExecute !== undefined) {
      beforeToolExecute = composeBeforeToolExecute(
        beforeToolExecute,
        opts.beforeToolExecute,
      );
    }
    let maxTokens = resolveMaxTokens(opts.model);
    if (opts.maxTokensSet === true) {
      maxTokens = opts.maxTokens ?? maxTokens;
    }
    let budgetPolicy = emptyIterationBudgetPolicy();
    if (
      enableIterationBudget &&
      opts.auxiliaryRole !== true &&
      (opts.parentId ?? "") === ""
    ) {
      budgetPolicy = resolveIterationBudget(
        opts.iterationBudget ?? emptyIterationBudgetPolicy(),
        opts.maxIterations ?? 0,
      );
      if (iterationBudgetPolicyEnabled(budgetPolicy)) {
        registry.register(createExtendBudgetTool());
      }
    }
    const cfg: AgentLoopConfig = {
      id: opts.id,
      parentId: opts.parentId,
      provider: opts.provider,
      vendor: opts.providerName,
      model: opts.model,
      mode,
      thinkingLevel: opts.thinkingLevel,
      maxTokens,
      maxTokensUserSet: opts.maxTokensSet,
      sandboxMgr: sandboxMgr === undefined ? undefined : sandboxMgr.getActive(),
      settings,
      allow: opts.allow,
      session: manager,
      extraContext,
      ruleContent,
      expertIdentity,
      expertRoster,
      compactionSettings: compactionSettingsFromConfig(
        settings.compaction ?? {
          enabled: false,
          reserveTokens: 0,
          keepRecentTokens: 0,
        },
      ),
      approvalHandler: opts.approvalHandler,
      approvalDecisionLookup: opts.approvalDecisionLookup,
      multiAgent: opts.multiAgent,
      delegateMode: opts.delegateMode,
      workflows: opts.workflows,
      conversationTurnId: opts.conversationTurnId,
      intentId: opts.intentId,
      runId: opts.runId,
      conversationTurn: opts.conversationTurn,
      runtimeOwnsTurnEnd: opts.runtimeOwnsTurnEnd,
      runtimeOwnsUserEntry: opts.runtimeOwnsUserEntry,
      userEntryId: opts.userEntryId,
      toolExecutionMode,
      maxToolConcurrency,
      maxIterations: opts.maxIterations,
      contextPressureThreshold: opts.contextPressure,
      budgetPressureThreshold: opts.budgetPressure,
      iterationBudget: budgetPolicy,
      beforeToolCall,
      beforeToolExecute,
      afterToolCall: opts.afterToolCall,
      getSteeringMessages: steeringMessages,
      getFollowUpMessages: followUpMessages,
      forcedMode: policy.forcedMode(),
    };
    const agent = createAgentWithLoopConfig(cfg, registry);
    // Opt-in history hydration: adapters that replay history themselves
    // (ACP and other callers of loadHistoryState after the build) must keep the
    // default off, or the replayed turns would be loaded twice.
    if (opts.hydrateHistory === true && manager !== undefined) {
      const replay = manager.getReplayState();
      if (replay.messages.length > 0) {
        agent.loadHistoryState(replay.messages, replay.entryIDs);
      }
    }
    return agent;
  }
}

/** Builds the Runtime ownership fence (`beforeToolExecute`) hook. */
export function composeBeforeToolExecute(
  first:
    | ((ctx: BeforeToolExecuteContext) => ToolCallBlockResult | undefined)
    | undefined,
  second:
    | ((ctx: BeforeToolExecuteContext) => ToolCallBlockResult | undefined)
    | undefined,
):
  | ((ctx: BeforeToolExecuteContext) => ToolCallBlockResult | undefined)
  | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return (ctx: BeforeToolExecuteContext): ToolCallBlockResult | undefined => {
    const result = first(ctx);
    if (result !== undefined && result.block) return result;
    return second(ctx);
  };
}

/** The per-run inputs supplied by an adapter after Runtime resolution. */
export interface AgentBuildOptions {
  id?: AgentID;
  parentId?: AgentID;
  provider?: Provider;
  providerName?: string;
  model?: Model;
  settings?: Settings;
  allow?: AllowConfig;
  mode?: string;
  toolExecutionMode?: string;
  maxToolConcurrency?: number;
  extraContext?: string;
  ruleContent?: string;
  thinkingLevel?: ThinkingLevel;
  sandboxMgr?: SandboxManager;
  sandboxEnabled?: boolean;
  maxTokens?: number;
  maxTokensSet?: boolean;
  multiAgent?: boolean;
  delegateMode?: boolean;
  workflows?: boolean;
  /**
   * Resolves a tool approval. Adapters with an asynchronous approval round trip
   * (for example ACP's reverse request) may return a promise; Agent Core awaits
   * it before continuing the tool call.
   */
  approvalHandler?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  approvalDecisionLookup?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => [boolean, boolean];
  maxIterations?: number;
  contextPressure?: number;
  budgetPressure?: number;
  iterationBudget?: IterationBudgetPolicy;
  beforeToolCall?: (
    ctx: BeforeToolCallContext,
  ) => ToolCallBlockResult | undefined;
  beforeToolExecute?: (
    ctx: BeforeToolExecuteContext,
  ) => ToolCallBlockResult | undefined;
  afterToolCall?: (ctx: AfterToolCallContext) => ToolCallResult | undefined;
  getSteeringMessages?: () => import("../provider/types.ts").Message[];
  conversationTurnId?: string;
  intentId?: string;
  runId?: string;
  conversationTurn?: boolean;
  runtimeOwnsTurnEnd?: boolean;
  runtimeOwnsUserEntry?: boolean;
  userEntryId?: string;
  auxiliaryRole?: boolean;
  /**
   * Hydrates the built Agent with the replayed session history (messages and
   * entry IDs) from the bound manager. Adapters that replay history
   * themselves after the build must keep this off to avoid double loading.
   */
  hydrateHistory?: boolean;
}

/** Converts the legacy `agent.Config` shape into Runtime-owned build inputs. */
export function agentBuildOptionsFromConfig(
  cfg: AgentLoopConfig,
): AgentBuildOptions {
  return {
    id: cfg.id,
    parentId: cfg.parentId,
    provider: cfg.provider,
    providerName: cfg.vendor,
    model: cfg.model,
    settings: cfg.settings,
    allow: cfg.allow,
    mode: cfg.mode,
    ruleContent: cfg.ruleContent,
    extraContext: cfg.extraContext,
    thinkingLevel: cfg.thinkingLevel,
    maxTokens: cfg.maxTokens,
    maxTokensSet: cfg.maxTokensUserSet,
    multiAgent: cfg.multiAgent,
    delegateMode: cfg.delegateMode,
    workflows: cfg.workflows,
    conversationTurnId: cfg.conversationTurnId,
    intentId: cfg.intentId,
    runId: cfg.runId,
    conversationTurn: cfg.conversationTurn,
    runtimeOwnsTurnEnd: cfg.runtimeOwnsTurnEnd,
    runtimeOwnsUserEntry: cfg.runtimeOwnsUserEntry,
    userEntryId: cfg.userEntryId,
    approvalHandler: cfg.approvalHandler,
    approvalDecisionLookup: cfg.approvalDecisionLookup,
  };
}

/** A hook that injects adapter-specific tools into a shared runtime. */
export type RegistryHook = (runtime: SessionRuntime) => void;

/** The resource-affecting session capabilities for a build. */
export interface BuildOptions {
  id?: string;
  source?: RuntimeSource;
  workDir: string;
  manager?: SessionManager;
  workflows: boolean;
  browser: boolean;
  artifactEnabled: boolean;
  registryHooks?: RegistryHook[];
}

/** Mutable resource-affecting session capabilities. */
export interface RefreshOptions {
  workflows: boolean;
  browser: boolean;
  activeSkills: Record<string, boolean>;
}

/** The shared context/skill inputs used by a session runtime. */
export interface ContextResources {
  skillsMgr: SkillsManager;
  extraContext: string;
  ruleContent: string;
}

/** Constructs context, skills, sandbox, tools, and MCP for one session. */
export class Builder {
  settings: Settings;
  sandboxLevel: Level;

  constructor(settings: Settings, sandboxLevel: Level) {
    this.settings = settings;
    this.sandboxLevel = sandboxLevel;
  }

  /**
   * Constructs context, skills, sandbox, tools and MCP connections for one
   * session. The caller owns the returned runtime.
   */
  async build(
    signal: AbortSignal | undefined,
    opts: BuildOptions,
  ): Promise<SessionRuntime> {
    const settings = this.settings;
    if (settings === null || settings === undefined) {
      throw new Error("agent runtime settings are required");
    }
    if ((opts.workDir ?? "") === "") {
      throw new Error("agent runtime work directory is required");
    }
    const expertBundle = resolveBoundExpertBundle(opts.workDir, opts.manager);
    const resources = await loadContextResourcesWithExpert(
      settings,
      opts.workDir,
      opts.workflows,
      opts.browser,
      expertBundle,
    );
    const skillsMgr = resources.skillsMgr;
    const sandboxMgr = createManager(
      opts.workDir,
      sandboxOptionsFromSettings(settings.sandbox),
    );
    sandboxMgr.setLevel(this.sandboxLevel);
    const registry = createRegistry(opts.workDir, sandboxMgr.getActive());
    registry.registerDefaultsWithPlanTool(isPlanToolEnabled(settings));
    if (isImageGenerationEnabled(settings)) {
      registry.register(new ImageGenerationTool(settings));
    }
    if (skillsMgr !== null && skillsMgr !== undefined) {
      registry.register(new SkillRefTool(skillsMgr));
    }
    if (opts.browser) {
      registerBrowserTool(registry);
    }
    const resolved = resolveManagerSource(opts.manager, {
      requested: opts.source ?? SOURCE_UNKNOWN,
    });
    let inputs: InputMaterializer | null = null;
    let attachments: AttachmentService | null = null;
    if (opts.manager !== undefined) {
      inputs = createInputMaterializer(
        opts.manager.getSessionDir(),
        opts.workDir,
        defaultInputPolicy(),
      );
      attachments = createAttachmentService(
        opts.manager.getSessionDir(),
        defaultAttachmentPolicy(),
      );
    }
    const runtime = new SessionRuntime({
      id: opts.id ?? "",
      source: resolved.source,
      entrySource: opts.source ?? SOURCE_UNKNOWN,
      policy: policyForSource(resolved.source, ""),
      workDir: opts.workDir,
      manager: opts.manager,
      inputs,
      attachments,
      registry,
      sandboxMgr,
      skillsMgr,
      extraContext: resources.extraContext,
      ruleContent: resources.ruleContent,
      artifactEnabled: opts.artifactEnabled,
      resourceSettings: settings,
      resourceWorkflows: opts.workflows,
      resourceBrowser: opts.browser,
    });
    runtime.mailbox = createMemberMailbox();
    runtime.expertCenter = new Center(opts.workDir);
    runtime.refreshExpertBinding();
    runtime.applyRegistryHooks(opts.registryHooks ?? []);
    const servers = loadConfiguredServers(opts.workDir);
    const clients = await connectServers(
      signal ?? new AbortController().signal,
      servers,
      registry,
      {},
    );
    runtime.mcpClients = clients;
    return runtime;
  }
}

/** Loads context files, project/global skills, and rules. */
export async function loadContextResources(
  settings: Settings,
  workDir: string,
  workflows: boolean,
  browserEnabled: boolean,
): Promise<ContextResources> {
  return await loadContextResourcesWithExpert(
    settings,
    workDir,
    workflows,
    browserEnabled,
    null,
  );
}

/**
 * Additionally loads skills packaged with a resolved expert bundle. Expert
 * skills shadow ordinary project/global skills of the same name.
 */
export async function loadContextResourcesWithExpert(
  settings: Settings,
  workDir: string,
  workflows: boolean,
  browserEnabled: boolean,
  expertBundle: Bundle | null,
): Promise<ContextResources> {
  if (workflows) {
    await ensureProjectSkill(workDir);
  }
  let projectDirs = projectSkillDirs(workDir);
  if (
    expertBundle !== null &&
    expertBundle.skillsDir !== "" &&
    expertBundle.skillsFS === null
  ) {
    projectDirs = [expertBundle.skillsDir, ...projectDirs];
  }
  const skillsMgr = createSkillsManager(
    getGlobalSkillsDir(settings),
    projectDirs,
  );
  skillsMgr.load();
  if (
    expertBundle !== null &&
    expertBundle.skillsDir !== "" &&
    expertBundle.skillsFS !== null
  ) {
    skillsMgr.loadFS(expertBundle.skillsFS, expertBundle.skillsDir, "expert");
  }
  let extraContext = "";
  if (settings.contextFiles?.enabled) {
    const result = loadContextFiles(
      workDir,
      configDir(),
      settings.contextFiles?.extraFiles ?? null,
    );
    extraContext = buildContextString(result);
  }
  extraContext += skillsMgr.buildAllSkillsContext();
  if (workflows) {
    extraContext += skillsMgr.buildSkillContext(WorkflowSkillName);
  }
  if (browserEnabled) {
    extraContext += skillsMgr.buildSkillContext(BrowserSkillName);
  }
  return {
    skillsMgr,
    extraContext,
    ruleContent: loadRuleFile(workDir),
  };
}

/** Builds the concatenated context string for the active skill set. */
export function activeSkillsContext(
  manager: SkillsManager | null | undefined,
  active: Record<string, boolean>,
): string {
  if (
    active === null ||
    active === undefined ||
    Object.keys(active).length === 0
  ) {
    return "";
  }
  const names = Object.keys(active)
    .filter((name) => active[name])
    .sort();
  let context = "";
  for (const name of names) {
    if (
      manager === undefined ||
      manager === null ||
      manager.get(name) === undefined
    ) {
      throw new Error(`skill not found: ${name}`);
    }
    context += manager.buildSkillContext(name);
  }
  return context;
}

/** Reports whether the sub-agent tool set should be registered. */
export function subAgentToolsEnabled(
  runtime: SessionRuntime | null | undefined,
  requested: boolean,
): boolean {
  return (
    requested ||
    (runtime !== null && runtime !== undefined && runtime.teamExpertActive())
  );
}

// --- Internal helpers -------------------------------------------------------

function createAttachmentService(
  sessionDir: string,
  policy: ReturnType<typeof defaultAttachmentPolicy>,
): AttachmentService {
  return new AttachmentService(sessionDir, policy);
}

function createInputMaterializer(
  sessionDir: string,
  workDir: string,
  policy: ReturnType<typeof defaultInputPolicy>,
): InputMaterializer {
  return new InputMaterializer(sessionDir, workDir, policy);
}

function createArtifactCollector(
  runtime: SessionRuntime,
  runID: string,
): ArtifactCollector {
  return new ArtifactCollector(runtime, runID);
}

function cloneProviderCatalog(src: ProviderCatalog): ProviderCatalog | null {
  const names = Object.keys(src);
  if (names.length === 0) return null;
  const dst: ProviderCatalog = {};
  for (const name of names) dst[name] = src[name];
  return dst;
}

function isZeroIterationBudget(p: IterationBudgetPolicy): boolean {
  return (
    p.soft === 0 &&
    p.hard === 0 &&
    p.renewFactor === 0 &&
    p.maxRenewals === 0 &&
    p.minInterval === 0 &&
    p.maxWallClock === 0
  );
}

function emptySubmission(text: string): InputSubmission {
  return {
    text,
    resources: [],
    knowledgeBaseReferences: [],
    knowledgeCapsules: [],
    idempotencyKey: "",
  };
}

function emptyCapabilities(sessionId: string): SessionCapabilities {
  return {
    sessionId,
    mode: "",
    displayMode: "",
    delegateMode: false,
    multiAgent: false,
    workflows: false,
    webSearch: false,
    browser: false,
    updatedAt: new Date(0),
  };
}

/** Maps the settings.json sandbox block to sandbox Options (Go's `Options()`). */
export function sandboxOptionsFromSettings(
  s: SandboxSettings | undefined,
): SandboxOptions {
  if (s === undefined) return {};
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

/** Applies `projectExpertBuild`'s team-forcing side effect. */
function projectedMultiAgent(
  binding: ExpertBinding | null,
  multiAgent: boolean,
): boolean {
  if (binding !== null && binding.team) return true;
  return multiAgent;
}
