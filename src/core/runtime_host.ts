import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import * as path from "@std/path";
import { AttachmentService } from "../agentruntime/input.ts";
import {
  ATTACHMENT_AUDIO,
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
  defaultAttachmentPolicy,
} from "../agentruntime/attachment.ts";
import type {
  CoreAgentView,
  CoreCapabilityView,
  CoreEsmCommandInput,
  CoreEsmObjectiveView,
  CoreEsmView,
  CoreExpertBundleView,
  CoreExpertStateView,
  CoreExpertSummaryView,
  CoreExtensionHandler,
  CorePreparedInput,
  CorePrepareInput,
  CorePromptExecution,
  CorePromptInput,
  CoreProviderCatalogView,
  CoreReverseRequest,
  CoreRuntimeDependencies,
  CoreRuntimeEvent,
  CoreRuntimeHost,
  CoreRuntimeHostOptions,
  CoreRunView,
  CoreSessionContextView,
  CoreSessionCreateInput,
  CoreSessionRuntime,
  CoreSessionView,
  CoreSkillView,
  CoreTransientPromptInput,
  CoreTransientPromptResult,
} from "./runtime.ts";
import { CoreSessionNotResidentError } from "./runtime_protocol.ts";
import {
  Builder,
  type SessionRuntime,
} from "../agentruntime/session_runtime.ts";
import {
  deleteSession as deletePersistedSession,
  listPersistedSessions as listPersistedSessionInfos,
  openOrCreateSession,
  openSession as openPersistedSession,
} from "../agentruntime/session_lifecycle.ts";
import { DecisionService } from "../agentruntime/decision.ts";
import { fork } from "../agentruntime/fork.ts";
import {
  createSessionExecutionRuntime,
  createSessionRunDescriptor,
} from "../agentruntime/session_run.ts";
import {
  type PreparedInput,
  resourceIds,
} from "../agentruntime/input_materializer.ts";
import {
  fromAgentEvent,
  serializeAgentEvent,
} from "../agentruntime/session_executor.ts";
import {
  create as createProvider,
  resolvedModels,
  sortProviderIDs,
} from "../provider/factory/factory.ts";
import { discoverModels } from "../provider/discover.ts";
import { DB as StatsDB, type Query as StatsQuery } from "../stats/stats.ts";
import {
  normalizeThinkingLevel,
  streamDone,
  streamError,
  thinkingOff,
} from "../provider/types.ts";
import {
  defaultProviderConfigsAll,
  defaultSettings,
  defaultSkillHubOfficialHandle,
  getGlobalSkillsDir,
  getProviderConfig,
  getSessionDir,
  globalSettingsPath,
  isACPArtifactEnabled,
  isArtifactEnabled,
  isWebSearchEnabled,
  loadGlobalSettingsOrDefault,
  loadGlobalSettingsSparse,
  loadSettingsFor,
  resolveImageGenerationToken,
  resolveProviderConfig,
  sandboxLevelFromSettings,
  saveGlobalSettingsPatch,
  saveProjectSettingsPatchFor,
  type Settings,
  skillsDisabled,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
} from "../config/settings.ts";
import { configDir } from "../config/mod.ts";
import { normalizeJobSchedule } from "../cron/schedule.ts";
import { userVisibleJobs } from "../cron/maintenance.ts";
import {
  createSQLiteCronStore,
  type CronJob,
  type CronStore,
} from "../cron/mod.ts";
import { loadAllow } from "../config/allow.ts";
import {
  globalMCPPath,
  loadMCPConfig,
  type MCPConfig,
  type MCPServer,
  mcpServerEnabled,
  normalizeMCPConfig,
  saveMCPConfig,
} from "../config/mcp.ts";
import { run as runDoctor } from "../doctor/doctor.ts";
import { Store as MemoryStore } from "../memory/store.ts";
import {
  applyEnvPatch,
  envList,
  loadEnv,
  validateEnvName,
} from "../config/env.ts";
import {
  currentRuntimeLeaseBinding,
  DeliveryOperationAbsentError,
  generateID,
  getDeliveryOperation,
  listAllDetailed,
  listDeliveryFailures,
  type Manager,
  openByIDExact,
  reopenFailedDeliveryOperation,
  type RuntimeLeaseGuard,
} from "../session/mod.ts";
import { acquireExecutionAdmission } from "../agentruntime/execution_admission.ts";
import { RecoveryCoordinator } from "../agentruntime/recovery_coordinator.ts";
import { deliveryFailureRetryable } from "../agentruntime/delivery_coordinator.ts";
import { knowledgeBaseCronJobID } from "../agentruntime/knowledge_cron.ts";
import {
  createKnowledgeBaseService,
  defaultKnowledgeBaseIndexPolicy,
  type KnowledgeBaseService,
} from "../agentruntime/knowledgebase.ts";
import { resolveUnattendedMode, SOURCE_ACP } from "../agentruntime/source.ts";
import {
  clientsForSettings,
  createLocalIndex,
  type InstallRequest,
  Service as SkillHubService,
} from "../skillhub/mod.ts";
import {
  createManager as createSkillsManager,
  projectSkillDirs,
} from "../skills/skills.ts";
import {
  createProject,
  deleteProject,
  listProjects,
  projectSessionCounts,
  renameProject,
} from "../session/projects.ts";
import { listSessionAttachments } from "../session/artifacts.ts";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  getKnowledgeSnapshot,
  type KnowledgeBase,
  type KnowledgeBaseSpec,
  type KnowledgeSnapshot,
  listKnowledgeBases,
  updateKnowledgeBase,
} from "../session/knowledge_bases.ts";
import {
  type ManagedBundle,
  Manager as ExpertManager,
  type Scope,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
} from "../expert/mod.ts";
import type { RunState } from "../agentruntime/run_state.ts";
import {
  EVENT_ERROR,
  EVENT_QUESTION_REQUEST,
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_APPROVAL_REQUEST,
} from "../agent/events.ts";
import type { AgentManager } from "../agent/manager.ts";
import { createRunContext } from "../agent/run_context.ts";
import { registerDelegateSubAgentTool } from "../agent/subagent.ts";
import { createAgentManager } from "../agentruntime/agent_manager.ts";
import {
  AgentManagerESMAdapter,
  type ESMRoleEventSink,
} from "../agentruntime/esm_role_adapter.ts";
import {
  canAutoRun,
  ESMStore,
  type Objective,
  Supervisor,
} from "../esm/mod.ts";
import { createRegistry } from "../tools/tool.ts";

/** Read-only tool set granted to a transient side query (TUI /btw). */
const TRANSIENT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "skill_ref"];

const TRANSIENT_SYSTEM_HINT =
  "[Side question mode] You are answering a quick side question for the user. " +
  "Treat the prior conversation as read-only context. Do NOT modify any files. " +
  "Your answer will be shown in a temporary overlay and will NOT be remembered by the main task. " +
  "Be concise and directly answer the question.";

/** One queued Core event item before the host assigns its sequence. */
interface QueuedCoreEvent {
  eventType: string;
  payload: Record<string, unknown>;
  terminal?: boolean;
}

/**
 * Minimal async queue bridging worker callbacks to an event generator so the
 * host can publish them through the canonical event stream.
 */
class AsyncEventQueue<T> {
  #items: T[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *stream(): AsyncGenerator<T> {
    for (;;) {
      while (this.#items.length > 0) yield this.#items.shift()!;
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        if (this.#items.length > 0 || this.#closed) {
          this.#wake = undefined;
          resolve();
        }
      });
      this.#wake = undefined;
    }
  }
}

/** Projects one persisted ESM objective row into its JSON-safe view. */
function esmObjectiveView(obj: Objective): CoreEsmObjectiveView {
  return {
    sessionId: obj.sessionId,
    esmId: obj.esmId,
    objective: obj.objective,
    status: obj.status,
    tokensUsed: obj.tokensUsed,
    timeUsedMs: obj.timeUsedMs,
    blockedCount: obj.blockedCount,
    blockedReason: obj.blockedReason,
    blockedRunId: obj.blockedRunId,
    completionReason: obj.completionReason,
    completionRunId: obj.completionRunId,
    completionReview: obj.completionReview,
    phase: obj.phase,
    progressSummary: obj.progressSummary,
    remainingWork: [...obj.remainingWork],
    rejectionCount: obj.rejectionCount,
    rejectionRunId: obj.rejectionRunId,
    recoveryCount: obj.recoveryCount,
    recoveryReason: obj.recoveryReason,
    createdAt: validDate(obj.createdAt),
    updatedAt: validDate(obj.updatedAt),
  };
}

interface SessionRecord {
  view: CoreSessionView;
  runtime: CoreSessionRuntime;
  events: CoreRuntimeEvent[];
  runs: Map<string, CoreRunView>;
  activeSkills: Map<string, boolean>;
  eventWaiters: Set<() => void>;
}

function defaultId(): string {
  return crypto.randomUUID();
}

function cloneEvent(event: CoreRuntimeEvent): CoreRuntimeEvent {
  return {
    ...event,
    payload: { ...event.payload },
  };
}

function cloneRun(run: CoreRunView): CoreRunView {
  return {
    ...run,
    startedAt: new Date(run.startedAt),
    updatedAt: new Date(run.updatedAt),
  };
}

function cloneSession(session: CoreSessionView): CoreSessionView {
  return {
    ...session,
    capabilities: { ...session.capabilities },
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  };
}

function sessionSkillState(record: SessionRecord): Record<string, unknown> {
  return {
    sessionId: record.view.sessionId,
    workDir: record.view.workDir,
    activeSkills: [...record.activeSkills.entries()]
      .filter(([, active]) => active)
      .map(([name]) => name)
      .sort(),
  };
}

function coreEventType(type: number): string {
  if (type === EVENT_TEXT_DELTA) return "text_delta";
  if (type === EVENT_THINK_DELTA) return "thinking_delta";
  if (type === EVENT_RUN_FINISHED || type === EVENT_ERROR) {
    return "run_finished";
  }
  return "agent_event";
}

const MAX_EXTENSION_ATTACHMENT_BYTES = 10 << 20;
const MAX_MANAGEMENT_MEMORY_BYTES = 1 << 20;

/**
 * Creates the production Core-owned extension surface. The ACP adapter only
 * maps method names and params; all persistence and projections stay here.
 */
export interface ProductionCoreExtensionOptions {
  createProvider?: typeof createProvider;
  runCronJob?: (job: CronJob, signal: AbortSignal) => Promise<string>;
  triggerCronJob?: (id: string, signal: AbortSignal) => void;
  cronRunning?: () => boolean;
  knowledgeServiceFactory?: (settings: Settings) => KnowledgeBaseService;
  skillHubServiceFactory?: (
    settings: Settings,
    workDir: string,
  ) => SkillHubService;
  setSessionSkill?: (
    sessionId: string,
    name: string,
    active: boolean,
  ) => Promise<Record<string, unknown>>;
  getSessionSkillState?: (
    sessionId: string,
  ) => Promise<Record<string, unknown>>;
}

export function createProductionCoreExtensionHandler(
  settings: Settings,
  options: ProductionCoreExtensionOptions = {},
): CoreExtensionHandler {
  const providerFactory = options.createProvider ?? createProvider;
  const runCronJob = options.runCronJob;
  const triggerCronJob = options.triggerCronJob;
  const cronRunning = options.cronRunning ?? (() => false);
  const knowledgeServiceFactory = options.knowledgeServiceFactory ??
    ((currentSettings: Settings) =>
      createKnowledgeBaseService(
        getSessionDir(currentSettings),
        defaultKnowledgeBaseIndexPolicy(),
        currentSettings,
      ));
  let knowledgeService: KnowledgeBaseService | undefined;
  const getKnowledgeService = (): KnowledgeBaseService => {
    knowledgeService ??= knowledgeServiceFactory(settings);
    return knowledgeService;
  };
  const skillHubServiceFactory = options.skillHubServiceFactory ??
    ((currentSettings: Settings, workDir: string) => {
      const handles = currentSettings.skillHub?.officialHandles ?? [];
      return SkillHubService.forWorkDir(
        getGlobalSkillsDir(currentSettings),
        workDir,
        handles.length === 0 ? [defaultSkillHubOfficialHandle] : handles,
        ...clientsForSettings(currentSettings.skillHub ?? {}),
      );
    });
  let skillHubService: SkillHubService | undefined;
  let skillHubServiceKey = "";
  const setSessionSkill = options.setSessionSkill ??
    ((sessionId: string) =>
      Promise.resolve({ sessionId, workDir: "", activeSkills: [] }));
  const getSessionSkillState = options.getSessionSkillState ??
    ((sessionId: string) =>
      Promise.resolve({ sessionId, workDir: "", activeSkills: [] }));
  const getSkillHubService = (
    input: Record<string, unknown>,
  ): SkillHubService => {
    const workDir = typeof input.workDir === "string"
      ? input.workDir
      : typeof input.cwd === "string"
      ? input.cwd
      : Deno.cwd();
    const key = `${getSessionDir(settings)}:${workDir}`;
    if (skillHubService === undefined || skillHubServiceKey !== key) {
      skillHubService = skillHubServiceFactory(settings, workDir);
      skillHubServiceKey = key;
    }
    return skillHubService;
  };
  return async (method, params, signal) => {
    if (signal.aborted) throw new Error("Core extension request aborted");
    const input = extensionParams(params);
    switch (method) {
      case "project.create": {
        const name = requiredString(input, "name");
        const project = createProject(getSessionDir(settings), name);
        return projectResult(project, 0);
      }
      case "project.rename": {
        const id = requiredString(input, "id");
        const name = requiredString(input, "name");
        const project = renameProject(getSessionDir(settings), id, name);
        return projectResult(project, 0);
      }
      case "project.delete": {
        const id = requiredString(input, "id");
        deleteProject(getSessionDir(settings), id);
        return null;
      }
      case "project.list": {
        const projects = listProjects(getSessionDir(settings));
        const counts = projectSessionCounts(getSessionDir(settings));
        return {
          projects: projects.map((project) =>
            projectResult(project, counts.get(project.id) ?? 0)
          ),
        };
      }
      case "manage.experts.create": {
        const context = expertContext(input);
        const bundle = expertDraft(input.bundle);
        return {
          scope: context.scope,
          cwd: context.cwd,
          bundle: context.manager.create(context.scope, {
            ...bundle,
            scope: context.scope,
          }),
        };
      }
      case "manage.experts.get": {
        const context = expertContext(input);
        return {
          scope: context.scope,
          cwd: context.cwd,
          bundle: context.manager.get(
            context.scope,
            requiredString(input, "name"),
          ),
        };
      }
      case "manage.experts.list": {
        const context = expertContext(input);
        return {
          scope: context.scope,
          cwd: context.cwd,
          experts: context.manager.listScope(context.scope),
          effectiveExperts: context.manager.list(),
        };
      }
      case "manage.experts.update": {
        const context = expertContext(input);
        const bundle = expertDraft(input.bundle);
        return {
          scope: context.scope,
          cwd: context.cwd,
          bundle: context.manager.update(context.scope, {
            ...bundle,
            scope: context.scope,
          }),
        };
      }
      case "manage.experts.delete": {
        const context = expertContext(input);
        context.manager.delete(context.scope, requiredString(input, "name"));
        return null;
      }
      case "doctor":
        return runDoctor(
          typeof input.cwd === "string" ? input.cwd : Deno.cwd(),
          "",
        );
      case "manage.stats.summary": {
        return statsSummary(settings, input);
      }
      case "manage.stats.timeseries": {
        return statsTimeseries(settings, input);
      }
      case "manage.memory.get": {
        return memoryGet(input);
      }
      case "manage.memory.put": {
        return memoryPut(input);
      }
      case "manage.skillhub.get": {
        return skillHubView(settings);
      }
      case "manage.skillhub.patch": {
        const view = skillHubPatch(settings, input);
        skillHubService = undefined;
        skillHubServiceKey = "";
        return view;
      }
      case "manage.skillhub.markets": {
        requiredString(input, "sessionId");
        const service = getSkillHubService(input);
        return {
          markets: service.markets(),
          defaultMarket: settings.skillHub?.defaultMarket?.trim() ||
            defaultSettings().skillHub?.defaultMarket ||
            "skillhub.cn",
        };
      }
      case "manage.skillhub.categories": {
        requiredString(input, "sessionId");
        return {
          categories: await getSkillHubService(input).categories(
            signal,
            skillHubMarket(input, settings),
          ),
        };
      }
      case "manage.skillhub.official": {
        requiredString(input, "sessionId");
        const market = skillHubMarket(
          { ...input, market: input.market ?? "skillhub.cn" },
          settings,
        );
        if (market !== "skillhub.cn") {
          throw new Error(
            "official recommendations are available on SkillHub.cn only",
          );
        }
        return await getSkillHubService(input).official(signal, {
          query: typeof input.query === "string" ? input.query : undefined,
          limit: skillHubLimit(input.limit),
          page: typeof input.page === "number" ? input.page : undefined,
        });
      }
      case "manage.skillhub.search": {
        requiredString(input, "sessionId");
        return await getSkillHubService(input).search(
          signal,
          skillHubMarket(input, settings),
          {
            query: typeof input.query === "string" ? input.query : undefined,
            limit: skillHubLimit(input.limit),
            page: typeof input.page === "number" ? input.page : undefined,
            cursor: typeof input.cursor === "string" ? input.cursor : undefined,
            sort: typeof input.sort === "string" ? input.sort : undefined,
            order: typeof input.order === "string" ? input.order : undefined,
            category: typeof input.category === "string"
              ? input.category
              : undefined,
          },
        );
      }
      case "manage.skillhub.detail": {
        requiredString(input, "sessionId");
        const id = typeof input.id === "string" ? input.id.trim() : "";
        if (id === "") throw new Error("skill id is required");
        return await getSkillHubService(input).detail(
          signal,
          skillHubMarket(input, settings),
          id,
        );
      }
      case "manage.skillhub.targets": {
        const sessionId = requiredString(input, "sessionId");
        const workDir = skillHubWorkDir(input);
        const labels = [
          "OpenSAC project skills",
          "Project skills",
          "Agents skills",
          "Generic project skills",
        ];
        const targets = projectSkillDirs(workDir).map((pathValue, index) => ({
          path: pathValue,
          scope: "project",
          label: labels[index] ?? "Project skills",
        }));
        const globalDir = getGlobalSkillsDir(settings);
        if (globalDir !== "") {
          targets.push({
            path: globalDir,
            scope: "global",
            label: "Global skills",
          });
        }
        return {
          sessionId,
          workDir,
          targets,
        };
      }
      case "manage.skillhub.installed": {
        const workDir = skillHubWorkDir(input);
        const index = createLocalIndex(
          getGlobalSkillsDir(settings),
          projectSkillDirs(workDir),
        );
        const sessionId = requiredString(input, "sessionId");
        return {
          sessionId,
          workDir,
          installed: index.list(),
          session: await getSessionSkillState(sessionId),
        };
      }
      case "manage.skillhub.install": {
        const id = requiredString(input, "id").trim();
        const targetDir = requiredString(input, "targetDir").trim();
        if (id === "" || !path.isAbsolute(targetDir)) {
          throw new Error("skill id and an absolute targetDir are required");
        }
        const scope =
          typeof input.scope === "string" && input.scope.trim() !== ""
            ? input.scope.trim()
            : settings.skillHub?.defaultInstallScope?.trim() || "project";
        if (scope !== "project" && scope !== "global") {
          throw new Error("scope must be project or global");
        }
        const request: InstallRequest = {
          market: skillHubMarket(input, settings),
          id,
          version: typeof input.version === "string"
            ? input.version
            : undefined,
          scope,
          targetDir,
          overwrite: input.overwrite === true,
        };
        const result = await getSkillHubService(input).install(signal, request);
        const activated = input.activate === true;
        const session = activated
          ? await setSessionSkill(
            requiredString(input, "sessionId"),
            result.name,
            true,
          )
          : undefined;
        return {
          install: result,
          activated,
          ...(session === undefined ? {} : { session }),
        };
      }
      case "manage.skillhub.activate": {
        const id = requiredString(input, "id").trim();
        if (id === "") throw new Error("skill name is required");
        const session = await setSessionSkill(
          requiredString(input, "sessionId"),
          id,
          true,
        );
        return { activated: true, session };
      }
      case "manage.skillhub.uninstall": {
        const market = skillHubMarket(input, settings);
        const id = requiredString(input, "id").trim();
        if (id === "") throw new Error("market and skill id are required");
        const sessionId = requiredString(input, "sessionId");
        const workDir = skillHubWorkDir(input);
        const index = createLocalIndex(
          getGlobalSkillsDir(settings),
          projectSkillDirs(workDir),
        );
        const activeName = index.state(market, id)?.name ?? "";
        const scope = typeof input.scope === "string" ? input.scope.trim() : "";
        getSkillHubService(input).uninstall(market, id, scope);
        const session = activeName === ""
          ? undefined
          : await setSessionSkill(sessionId, activeName, false);
        return {
          uninstalled: true,
          ...(session === undefined ? {} : { session }),
        };
      }
      case "manage.knowledge-bases.list": {
        return knowledgeBasesList(settings);
      }
      case "manage.knowledge-bases.get": {
        return knowledgeBaseGet(settings, input);
      }
      case "manage.knowledge-bases.create": {
        return knowledgeBaseCreate(settings, input);
      }
      case "manage.knowledge-bases.update": {
        return knowledgeBaseUpdate(settings, input);
      }
      case "manage.knowledge-bases.delete": {
        return knowledgeBaseDelete(settings, input);
      }
      case "manage.knowledge-bases.scan": {
        return knowledgeBaseScan(input, signal, getKnowledgeService);
      }
      case "manage.knowledge-bases.status": {
        return knowledgeBaseGet(settings, input);
      }
      case "manage.knowledge-bases.query": {
        return knowledgeBaseQuery(input, signal, getKnowledgeService);
      }
      case "manage.knowledge-bases.mcp.apply": {
        return knowledgeBaseMCPApply(settings, input);
      }
      case "manage.cron.list": {
        return cronList(settings, cronRunning);
      }
      case "manage.cron.create": {
        return cronCreate(settings, input);
      }
      case "manage.cron.update": {
        return cronUpdate(settings, input);
      }
      case "manage.cron.remove": {
        return cronRemove(settings, input);
      }
      case "manage.cron.run": {
        return cronRun(settings, input, signal, runCronJob, triggerCronJob);
      }
      case "manage.deliveries.list": {
        return deliveriesList(settings, input);
      }
      case "manage.deliveries.retry": {
        return deliveriesRetry(settings, input);
      }
      case "manage.mcp.set": {
        return setMCP(settings, input);
      }
      case "manage.mcp.list": {
        return listMCP(settings, input);
      }
      case "manage.skills.set": {
        return setSkill(settings, input);
      }
      case "manage.skills.list": {
        return listSkills(settings, input);
      }
      case "manage.application.get":
        return applicationView(settings);
      case "manage.application.patch": {
        const patched = applicationPatch(settings, input.patch);
        saveGlobalSettingsPatch(patched.updates);
        return applicationView(patched.settings);
      }
      case "manage.settings.patch": {
        const patched = settingsPatch(settings, input.patch);
        saveGlobalSettingsPatch(patched.updates);
        return settingsView(patched.settings);
      }
      case "manage.providers.test": {
        return testProvider(settings, input, providerFactory);
      }
      case "manage.providers.discover": {
        return discoverProvider(input);
      }
      case "manage.providers.save": {
        const result = saveProvider(settings, input);
        return result;
      }
      case "manage.providers.delete": {
        const result = deleteProvider(settings, input);
        return result;
      }
      case "manage.providers.list":
        return { providers: providerViews(settings) };
      case "manage.settings.get":
        return settingsView(settings);
      case "manage.env.get":
        return envView();
      case "manage.env.patch": {
        const set = decodeEnvSet(input.set);
        const unset = decodeEnvUnset(input.unset);
        if (Object.keys(set).length === 0 && unset.length === 0) {
          throw new Error("set or unset must contain at least one variable");
        }
        for (const name of Object.keys(set)) {
          if (unset.includes(name)) {
            throw new Error(
              `environment variable ${name} cannot be both set and unset`,
            );
          }
        }
        const config = loadEnv();
        applyEnvPatch(config, set, unset);
        return envView(config);
      }
      case "attachment.store": {
        const sessionId = requiredString(input, "sessionId");
        const runId = requiredString(input, "runId");
        const filename = requiredString(input, "filename");
        const kind = input.kind === undefined ? "file" : input.kind;
        if (
          kind !== "file" && kind !== "image" && kind !== "audio" &&
          kind !== "video"
        ) {
          throw new Error("attachment kind is not supported");
        }
        const content = attachmentBytes(input);
        const service = new AttachmentService(
          getSessionDir(settings),
          defaultAttachmentPolicy(),
        );
        const record = await service.acceptArtifact(sessionId, runId, {
          origin: "acp",
          reference: `acp://${filename}`,
          kind,
          filename,
          mediaType: typeof input.mediaType === "string" ? input.mediaType : "",
          sizeHint: content.byteLength,
          open: () => ({ bytes: content }),
        }, signal);
        return {
          attachmentId: record.id,
          filename: record.filename,
          kind: record.kind,
          mediaType: record.mediaType,
          size: record.bytes,
          status: record.status,
          runId: record.runId,
          createdAt: validDate(record.createdAt),
        };
      }
      case "attachment.fetch": {
        const sessionId = requiredString(input, "sessionId");
        const attachmentId = requiredString(input, "attachmentId");
        const service = new AttachmentService(
          getSessionDir(settings),
          defaultAttachmentPolicy(),
        );
        const opened = await service.Open(sessionId, attachmentId);
        try {
          const chunks: Uint8Array[] = [];
          let total = 0;
          const buffer = new Uint8Array(64 * 1024);
          while (total <= MAX_EXTENSION_ATTACHMENT_BYTES) {
            const read = await opened.file.read(buffer);
            if (read === null) break;
            chunks.push(buffer.slice(0, read));
            total += read;
          }
          if (total > MAX_EXTENSION_ATTACHMENT_BYTES) {
            throw new Error("attachment exceeds the extension fetch limit");
          }
          const content = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            content.set(chunk, offset);
            offset += chunk.length;
          }
          return {
            filename: opened.record.filename,
            mediaType: opened.record.mediaType,
            size: opened.record.bytes,
            contentBase64: encodeBase64(content),
          };
        } finally {
          opened.file.close();
        }
      }
      case "attachment.list": {
        const sessionId = requiredString(input, "sessionId");
        const status = optionalStatus(input.status);
        const records = listSessionAttachments(
          getSessionDir(settings),
          sessionId,
          status,
        );
        return {
          attachments: records.map((record) => ({
            attachmentId: record.id,
            filename: record.filename,
            kind: record.kind,
            mediaType: record.mediaType,
            size: record.bytes,
            status: record.status,
            runId: record.runId,
            createdAt: validDate(record.createdAt),
          })),
        };
      }
      default:
        throw new Error(`Core extension method not implemented: ${method}`);
    }
  };
}

function extensionParams(value: unknown): Record<string, unknown> {
  if (
    value === undefined || value === null || typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Core extension params must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalStatus(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (value !== "generated" && value !== "input") {
    throw new Error("attachment status must be generated or input");
  }
  return value === "input" ? "accepted" : value;
}

function projectResult(
  project: { id: string; name: string; createdAt: Date; updatedAt: Date },
  sessionCount: number,
): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    createdAt: validDate(project.createdAt),
    updatedAt: validDate(project.updatedAt),
    sessionCount,
  };
}

function expertContext(params: Record<string, unknown>): {
  manager: ExpertManager;
  scope: Scope;
  cwd: string;
} {
  const rawScope = params.scope;
  const scope = rawScope === undefined || rawScope === ""
    ? SCOPE_GLOBAL
    : rawScope;
  if (scope !== SCOPE_GLOBAL && scope !== SCOPE_PROJECT) {
    throw new Error(`expert scope ${String(scope)} is not writable`);
  }
  const cwd = scope === SCOPE_PROJECT ? requiredString(params, "cwd") : "";
  return {
    manager: new ExpertManager(cwd),
    scope,
    cwd: cwd === "" ? "" : path.normalize(cwd),
  };
}

function expertDraft(value: unknown): ManagedBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bundle is required");
  }
  return value as ManagedBundle;
}

function attachmentBytes(params: Record<string, unknown>): Uint8Array {
  const encoded = params.contentBase64;
  if (typeof encoded === "string") return decodeBase64(encoded);
  const content = params.content;
  if (typeof content === "string") return new TextEncoder().encode(content);
  throw new Error("contentBase64 or content is required");
}

function settingsPatch(
  settings: Settings,
  value: unknown,
): { settings: Settings; updates: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("patch object with at least one allowed field is required");
  }
  const patch = value as Record<string, unknown>;
  const allowed = new Set([
    "defaultProvider",
    "defaultModel",
    "defaultMode",
    "thinkingLevel",
    "sandboxEnabled",
    "sandboxLevel",
    "webSearchEnabled",
  ]);
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    throw new Error("patch object with at least one allowed field is required");
  }
  for (const field of fields) {
    if (!allowed.has(field)) {
      throw new Error(
        `settings field ${JSON.stringify(field)} is not writable`,
      );
    }
  }
  const next: Settings = {
    ...settings,
    sandbox: settings.sandbox === undefined
      ? undefined
      : { ...settings.sandbox },
    webSearch: settings.webSearch === undefined
      ? undefined
      : { ...settings.webSearch },
  };
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = patch[field];
    switch (field) {
      case "defaultProvider":
      case "defaultModel": {
        if (typeof raw !== "string" || raw.trim() === "") {
          throw new Error(`${field} must be a non-empty string`);
        }
        const text = raw.trim();
        if (field === "defaultProvider") next.defaultProvider = text;
        else next.defaultModel = text;
        updates[field] = text;
        break;
      }
      case "defaultMode": {
        if (
          raw !== "agent" && raw !== "plan" && raw !== "yolo" && raw !== "os"
        ) {
          throw new Error("defaultMode must be agent, plan, yolo, or os");
        }
        next.defaultMode = raw;
        updates.defaultMode = raw;
        break;
      }
      case "thinkingLevel": {
        const levels = new Set([
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]);
        if (typeof raw !== "string" || !levels.has(raw)) {
          throw new Error("thinkingLevel is invalid");
        }
        next.defaultThinkingLevel = raw;
        updates.defaultThinkingLevel = raw;
        break;
      }
      case "sandboxEnabled": {
        if (typeof raw !== "boolean") {
          throw new Error("sandboxEnabled must be boolean");
        }
        next.sandbox = {
          ...(next.sandbox ??
            { level: "off", enabled: false, allowNetwork: false }),
          enabled: raw,
        };
        updates.sandbox = next.sandbox;
        break;
      }
      case "sandboxLevel": {
        if (typeof raw !== "string" || raw.trim() === "") {
          throw new Error("sandboxLevel must be a non-empty string");
        }
        next.sandbox = {
          ...(next.sandbox ??
            { level: "off", enabled: false, allowNetwork: false }),
          level: raw.trim(),
        };
        updates.sandbox = next.sandbox;
        break;
      }
      case "webSearchEnabled": {
        if (typeof raw !== "boolean") {
          throw new Error("webSearchEnabled must be boolean");
        }
        next.webSearch = { ...(next.webSearch ?? {}), enabled: raw };
        updates.webSearch = next.webSearch;
        break;
      }
    }
  }
  return { settings: next, updates };
}

function memoryStore(input: Record<string, unknown>): MemoryStore {
  const workDir = typeof input.cwd === "string"
    ? input.cwd
    : typeof input.workDir === "string"
    ? input.workDir
    : Deno.cwd();
  return new MemoryStore(path.join(configDir(), "memory.md"), workDir);
}

function memoryUpdatedAt(memoryPath: string): string {
  if (memoryPath === "") return "";
  try {
    return Deno.statSync(memoryPath).mtime?.toISOString() ?? "";
  } catch {
    return "";
  }
}

function memorySize(content: string): number {
  return new TextEncoder().encode(content).length;
}

function memoryGet(input: Record<string, unknown>): Record<string, unknown> {
  const read = memoryStore(input).read();
  return {
    content: read.content,
    path: read.path,
    source: read.source,
    size: memorySize(read.content),
    updatedAt: memoryUpdatedAt(read.path),
  };
}

function memoryPut(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.content !== "string") throw new Error("content is required");
  const size = memorySize(input.content);
  if (size > MAX_MANAGEMENT_MEMORY_BYTES) {
    throw new Error(
      `memory content exceeds the ${MAX_MANAGEMENT_MEMORY_BYTES} byte limit`,
    );
  }
  const store = memoryStore(input);
  try {
    store.writeAll(input.content);
  } catch (err) {
    throw new Error(`memory unavailable: ${(err as Error).message}`);
  }
  const read = store.read();
  return {
    size: memorySize(read.content),
    updatedAt: memoryUpdatedAt(read.path),
    path: read.path,
    source: read.source,
  };
}

function skillHubWorkDir(input: Record<string, unknown>): string {
  const value = typeof input.workDir === "string"
    ? input.workDir
    : typeof input.cwd === "string"
    ? input.cwd
    : Deno.cwd();
  return value.trim() === "" ? Deno.cwd() : value;
}

function skillHubMarket(
  input: Record<string, unknown>,
  settings: Settings,
): "skillhub.cn" | "clawhub.ai" {
  const value = typeof input.market === "string" && input.market.trim() !== ""
    ? input.market.trim()
    : settings.skillHub?.defaultMarket?.trim() ||
      defaultSettings().skillHub?.defaultMarket ||
      "skillhub.cn";
  if (value !== "skillhub.cn" && value !== "clawhub.ai") {
    throw new Error(`unsupported skill market ${JSON.stringify(value)}`);
  }
  return value;
}

function skillHubLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 20;
  }
  return Math.min(Math.floor(value), 100);
}

function skillHubSecretConfigured(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text !== "" && !text.startsWith("${") && !text.startsWith("!");
}

function skillHubView(settings: Settings): Record<string, unknown> {
  const current = settings.skillHub ?? {};
  const defaults = defaultSettings().skillHub ?? {};
  const markets = (current.markets ?? []).map((market) => ({
    id: market.id ?? "",
    ...(market.name === undefined ? {} : { name: market.name }),
    ...(market.siteURL === undefined ? {} : { siteURL: market.siteURL }),
    ...(market.apiURL === undefined ? {} : { apiURL: market.apiURL }),
    enabled: market.enabled ?? false,
    apiTokenConfigured: skillHubSecretConfigured(market.apiToken),
  }));
  return {
    defaultMarket: current.defaultMarket?.trim() || defaults.defaultMarket ||
      "",
    defaultInstallScope: current.defaultInstallScope?.trim() ||
      defaults.defaultInstallScope || "",
    officialHandles: current.officialHandles ?? [],
    markets,
  };
}

function skillHubPatch(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const patch = input.patch;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(
      "patch object with at least one supported skillHub field is required",
    );
  }
  const fields = patch as Record<string, unknown>;
  const allowed = new Set([
    "defaultMarket",
    "defaultInstallScope",
    "officialHandles",
    "markets",
  ]);
  for (const field of Object.keys(fields)) {
    if (!allowed.has(field)) {
      throw new Error(
        `skillhub field ${JSON.stringify(field)} is not writable`,
      );
    }
  }
  if (Object.keys(fields).length === 0) {
    throw new Error(
      "patch object with at least one supported skillHub field is required",
    );
  }
  if (
    Object.hasOwn(fields, "defaultMarket") &&
    (typeof fields.defaultMarket !== "string" ||
      fields.defaultMarket.trim() === "")
  ) {
    throw new Error("defaultMarket must be a non-empty string");
  }
  if (
    Object.hasOwn(fields, "defaultInstallScope") &&
    (typeof fields.defaultInstallScope !== "string" ||
      !["project", "global"].includes(fields.defaultInstallScope.trim()))
  ) {
    throw new Error("defaultInstallScope must be project or global");
  }
  if (Object.hasOwn(fields, "officialHandles")) {
    if (
      !Array.isArray(fields.officialHandles) ||
      fields.officialHandles.some((value) =>
        typeof value !== "string" || value.trim() === ""
      )
    ) {
      throw new Error("officialHandles must be an array of non-empty strings");
    }
  }

  let root: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(globalSettingsPath()));
    if (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ) {
      root = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const current = root.skillHub !== null && typeof root.skillHub === "object" &&
      !Array.isArray(root.skillHub)
    ? { ...(root.skillHub as Record<string, unknown>) }
    : {};
  if (Object.hasOwn(fields, "defaultMarket")) {
    current.defaultMarket = (fields.defaultMarket as string).trim();
  }
  if (Object.hasOwn(fields, "defaultInstallScope")) {
    current.defaultInstallScope = (fields.defaultInstallScope as string).trim();
  }
  if (Object.hasOwn(fields, "officialHandles")) {
    current.officialHandles = fields.officialHandles;
  }
  if (Object.hasOwn(fields, "markets")) {
    if (!Array.isArray(fields.markets)) {
      throw new Error("markets must be an array");
    }
    const existing = Array.isArray(current.markets)
      ? current.markets.filter((value): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value)
      )
      : [];
    const byId = new Map(
      existing.map((market) => [String(market.id ?? ""), market]),
    );
    const next: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const raw of fields.markets) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("each market must be an object");
      }
      const market = raw as Record<string, unknown>;
      const id = typeof market.id === "string" ? market.id.trim() : "";
      if (id === "") throw new Error("market id is required");
      if (seen.has(id)) {
        throw new Error(`duplicate market id ${JSON.stringify(id)}`);
      }
      seen.add(id);
      const merged: Record<string, unknown> = {
        ...(byId.get(id) ?? {}),
        ...market,
        id,
      };
      if (Object.hasOwn(market, "apiToken") && market.apiToken !== undefined) {
        if (typeof market.apiToken !== "string") {
          throw new Error("apiToken must be a string");
        }
        if (market.clearApiToken === true) {
          throw new Error("apiToken and clearApiToken cannot be combined");
        }
        merged.apiToken = market.apiToken;
      }
      if (market.clearApiToken === true) delete merged.apiToken;
      if (
        Object.hasOwn(market, "enabled") && typeof market.enabled !== "boolean"
      ) {
        throw new Error("enabled must be a boolean");
      }
      if (merged.enabled === undefined) merged.enabled = false;
      next.push(merged);
    }
    current.markets = next;
  }
  saveGlobalSettingsPatch({ skillHub: current });
  settings.skillHub = current as Settings["skillHub"];
  return skillHubView(settings);
}

function syncKnowledgeBaseSchedule(
  settings: Settings,
  base: KnowledgeBase,
): void {
  const store = cronStore(settings);
  const jobID = knowledgeBaseCronJobID(base.id);
  const raw = base.schedule.trim().toLowerCase();
  const disabled = !base.enabled || raw === "" || raw === "manual" ||
    raw === "off" || raw === "disabled";
  if (disabled) {
    try {
      store.delete(jobID);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("not found")) {
        throw err;
      }
    }
    return;
  }
  const aliases: Record<string, string> = {
    hourly: "@hourly",
    daily: "@daily",
    weekly: "@weekly",
    monthly: "@monthly",
  };
  const schedule = aliases[raw] ?? base.schedule.trim();
  const job: CronJob = {
    id: jobID,
    name: `Knowledge base: ${base.name}`,
    prompt: `Reindex the knowledge base ${base.id}.`,
    schedule,
    mode: "yolo",
    workDir: base.rootDir,
    enabled: true,
  };
  try {
    const existing = store.get(jobID);
    job.createdAt = existing.createdAt ?? null;
    job.lastRun = existing.lastRun ?? null;
    job.nextRun = existing.nextRun ?? null;
    job.runCount = existing.runCount ?? 0;
    job.lastStatus = existing.lastStatus ?? "";
    job.lastError = existing.lastError ?? "";
    store.update(normalizeJobSchedule(job));
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      store.create(normalizeJobSchedule(job));
      return;
    }
    throw err;
  }
}

function knowledgeBaseSpec(
  value: unknown,
  base?: KnowledgeBaseSpec,
): KnowledgeBaseSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("knowledgeBase object is required");
  }
  const raw = value as Record<string, unknown>;
  const next: KnowledgeBaseSpec = {
    name: base?.name ?? "",
    rootDir: base?.rootDir ?? "",
    preprocessProfile: base?.preprocessProfile ?? "",
    provider: base?.provider ?? "",
    model: base?.model ?? "",
    mode: base?.mode ?? "",
    thinkingLevel: base?.thinkingLevel ?? "",
    schedule: base?.schedule ?? "",
    enabled: base?.enabled ?? true,
  };
  for (
    const field of [
      "name",
      "rootDir",
      "preprocessProfile",
      "provider",
      "model",
      "mode",
      "thinkingLevel",
      "schedule",
    ] as const
  ) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== "string") {
        throw new Error(`${field} must be a string`);
      }
      next[field] = raw[field] as string;
    }
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    next.enabled = raw.enabled;
  }
  return next;
}

function knowledgeBaseView(
  settings: Settings,
  base: KnowledgeBase,
): Record<string, unknown> {
  let snapshot: KnowledgeSnapshot | null = null;
  let status = "unindexed";
  if (base.activeSnapshotId.trim() !== "") {
    snapshot = getKnowledgeSnapshot(
      getSessionDir(settings),
      base.activeSnapshotId,
    );
    status = snapshot.status;
  }
  return { knowledgeBase: base, snapshot, status };
}

function knowledgeBasesList(settings: Settings): Record<string, unknown> {
  return {
    knowledgeBases: listKnowledgeBases(getSessionDir(settings)).map((base) =>
      knowledgeBaseView(settings, base)
    ),
  };
}

function knowledgeBaseGet(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return knowledgeBaseView(
    settings,
    getKnowledgeBase(
      getSessionDir(settings),
      requiredString(input, "id"),
    ),
  );
}

function knowledgeBaseCreate(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const spec = knowledgeBaseSpec(input.knowledgeBase);
  const base = createKnowledgeBase(getSessionDir(settings), spec);
  syncKnowledgeBaseSchedule(settings, base);
  return knowledgeBaseView(settings, base);
}

function knowledgeBaseUpdate(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = requiredString(input, "id");
  const base = getKnowledgeBase(getSessionDir(settings), id);
  const updated = updateKnowledgeBase(
    getSessionDir(settings),
    id,
    knowledgeBaseSpec(input.knowledgeBase, base),
  );
  syncKnowledgeBaseSchedule(settings, updated);
  return knowledgeBaseView(settings, updated);
}

function knowledgeBaseDelete(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = requiredString(input, "id");
  const base = getKnowledgeBase(getSessionDir(settings), id);
  syncKnowledgeBaseSchedule(settings, { ...base, enabled: false });
  deleteKnowledgeBase(getSessionDir(settings), id);
  return { id, deleted: true };
}

function knowledgeBaseMCPApply(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = requiredString(input, "id");
  getKnowledgeBase(getSessionDir(settings), id);
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  let config: MCPConfig;
  try {
    config = loadMCPConfig(globalMCPPath());
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    config = {};
  }
  const entry: MCPServer = {
    name: `knowledge-${id}`,
    type: "stdio",
    command: Deno.execPath(),
    args: ["knowledge-mcp", "serve", "--knowledge-base", id],
    enabled,
  };
  const servers = config.mcpServers ?? [];
  const index = servers.findIndex((server) => server.name === entry.name);
  if (index < 0) servers.push(entry);
  else servers[index] = entry;
  config.mcpServers = servers;
  normalizeMCPConfig(config);
  saveMCPConfig(globalMCPPath(), config);
  return { id, name: entry.name, enabled };
}

function knowledgeBaseQuery(
  input: Record<string, unknown>,
  signal: AbortSignal,
  getService: () => KnowledgeBaseService,
): Record<string, unknown> {
  const id = requiredString(input, "id");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query === "") throw new Error("id and query are required");
  let limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.trunc(input.limit)
    : 8;
  if (limit <= 0) limit = 8;
  if (limit > 20) limit = 20;
  return {
    query: getService().query(signal, id, query, limit),
  };
}

function knowledgeBaseScan(
  input: Record<string, unknown>,
  signal: AbortSignal,
  getService: () => KnowledgeBaseService,
): Record<string, unknown> {
  const id = requiredString(input, "id");
  const service = getService();
  const existing = service.indexJob(id);
  const alreadyRunning = existing !== null && !existing.finished;
  const job = service.startIndex(signal, id, SOURCE_ACP);
  const progress = job.viewProgress();
  const indexing: Record<string, unknown> = {
    running: progress.running,
    filesTotal: progress.filesTotal,
    filesDone: progress.filesDone,
    chunks: progress.chunks,
  };
  if (progress.phase !== undefined) indexing.phase = progress.phase;
  if (progress.startedAt !== undefined) {
    indexing.startedAt = progress.startedAt.toISOString();
  }
  if (progress.runId !== undefined) indexing.runId = progress.runId;
  if (progress.error !== undefined) indexing.error = progress.error;
  return {
    started: true,
    alreadyRunning,
    id,
    status: "indexing",
    indexing,
  };
}

function cronStore(settings: Settings): CronStore {
  return createSQLiteCronStore(getSessionDir(settings));
}

function cronJobView(job: CronJob): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: job.id ?? "",
    name: job.name ?? "",
    prompt: job.prompt ?? "",
    schedule: job.schedule ?? "",
    oneshot: job.oneShot ?? false,
    mode: job.mode ?? "",
    enabled: job.enabled ?? false,
    runCount: job.runCount ?? 0,
    lastStatus: job.lastStatus ?? "",
  };
  if (job.sessionId) view.sessionId = job.sessionId;
  if (job.workDir) view.workDir = job.workDir;
  if (job.createdAt) view.createdAt = job.createdAt.toISOString();
  if (job.lastRun) view.lastRun = job.lastRun.toISOString();
  if (job.nextRun) view.nextRun = job.nextRun.toISOString();
  if (job.lastError) view.lastError = job.lastError;
  return view;
}

function cronList(
  settings: Settings,
  isRunning: () => boolean,
): Record<string, unknown> {
  const jobs = userVisibleJobs(cronStore(settings).list()).sort((a, b) => {
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    if (at === bt) return (a.id ?? "").localeCompare(b.id ?? "");
    return bt - at;
  });
  return { enabled: true, running: isRunning(), jobs: jobs.map(cronJobView) };
}

function cronFields(input: Record<string, unknown>, includeID: boolean): void {
  const allowed = new Set([
    "name",
    "prompt",
    "schedule",
    "mode",
    "enabled",
    ...(includeID ? ["id"] : []),
  ]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw new Error(`cron field ${JSON.stringify(field)} is not writable`);
    }
  }
}

function cronJobFromInput(
  base: CronJob,
  input: Record<string, unknown>,
): CronJob {
  const job: CronJob = { ...base };
  if (Object.hasOwn(input, "name")) {
    if (typeof input.name !== "string") {
      throw new Error("name must be a string");
    }
    job.name = input.name.trim();
  }
  if (Object.hasOwn(input, "prompt")) {
    if (typeof input.prompt !== "string") {
      throw new Error("prompt must be a string");
    }
    job.prompt = input.prompt;
  }
  if (Object.hasOwn(input, "schedule")) {
    if (typeof input.schedule !== "string") {
      throw new Error("schedule must be a string");
    }
    job.schedule = input.schedule.trim();
  }
  if (Object.hasOwn(input, "mode")) {
    if (typeof input.mode !== "string") {
      throw new Error("mode must be a string");
    }
    job.mode = input.mode.trim();
  }
  if (Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    job.enabled = input.enabled;
  }
  if ((job.name ?? "").trim() === "") throw new Error("name is required");
  if ((job.prompt ?? "").trim() === "") throw new Error("prompt is required");
  if (job.mode !== "" && job.mode !== "agent" && job.mode !== "yolo") {
    throw new Error(`mode ${JSON.stringify(job.mode)} must be agent or yolo`);
  }
  return normalizeJobSchedule(job);
}

function cronCreate(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  cronFields(input, false);
  const workDir = typeof input.workDir === "string"
    ? input.workDir
    : typeof input.cwd === "string"
    ? input.cwd
    : Deno.cwd();
  const job = cronJobFromInput(
    { enabled: true, workDir },
    input,
  );
  return { job: cronJobView(cronStore(settings).create(job)) };
}

function cronUpdate(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  cronFields(input, true);
  const id = requiredString(input, "id");
  const store = cronStore(settings);
  const job = cronJobFromInput(store.get(id), input);
  store.update(job);
  return { job: cronJobView(job) };
}

function cronRemove(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  cronFields(input, true);
  const id = requiredString(input, "id");
  cronStore(settings).delete(id);
  return { id, deleted: true };
}

async function cronRun(
  settings: Settings,
  input: Record<string, unknown>,
  signal: AbortSignal,
  runCronJob:
    | ((job: CronJob, signal: AbortSignal) => Promise<string>)
    | undefined,
  triggerCronJob: ((id: string, signal: AbortSignal) => void) | undefined,
): Promise<Record<string, unknown>> {
  cronFields(input, true);
  const id = requiredString(input, "id");
  const job = cronStore(settings).get(id);
  if (triggerCronJob !== undefined) {
    triggerCronJob(id, signal);
  } else {
    if (runCronJob === undefined) {
      throw new Error("cron runtime is unavailable");
    }
    await runCronJob(job, signal);
  }
  return { ok: true, jobId: id, triggered: true };
}

function deliveriesList(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.trunc(input.limit)
    : 0;
  const failures = listDeliveryFailures(
    getSessionDir(settings),
    sessionId,
    limit,
  );
  const deliveries = failures.map((failure) => ({
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
  return { deliveries, count: deliveries.length };
}

function deliveriesRetry(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const operationId = requiredString(input, "operationId");
  let operation: ReturnType<typeof getDeliveryOperation>;
  try {
    operation = getDeliveryOperation(getSessionDir(settings), operationId);
  } catch (err) {
    if (err instanceof DeliveryOperationAbsentError) {
      throw new Error(`delivery operation ${operationId} does not exist`);
    }
    throw new Error(
      `delivery operation ${operationId} is not readable: ${
        (err as Error).message
      }`,
    );
  }
  if (operation === null) {
    throw new Error(`delivery operation ${operationId} does not exist`);
  }
  if (operation.status !== "failed") {
    throw new Error(
      `delivery operation ${operationId} is ${operation.status}, only a failed operation can be retried`,
    );
  }
  if (!deliveryFailureRetryable(operation.failureCode)) {
    throw new Error(
      `delivery operation ${operationId} failed permanently (${operation.failureCode})`,
    );
  }
  const retried = reopenFailedDeliveryOperation(
    getSessionDir(settings),
    operationId,
    new Date(),
  );
  return { operationId, retried };
}

function statsQuery(input: Record<string, unknown>): StatsQuery {
  const query: StatsQuery = { groupBy: "day" };
  for (const field of ["vendor", "protocol", "model"] as const) {
    if (typeof input[field] === "string" && input[field] !== "") {
      query[field] = input[field] as string;
    }
  }
  const group = typeof input.group === "string"
    ? input.group.trim()
    : typeof input.groupBy === "string"
    ? input.groupBy.trim()
    : "day";
  if (!["day", "1h", "week", "month"].includes(group)) {
    throw new Error("group must be one of day, 1h, week, month");
  }
  query.groupBy = group;

  for (const field of ["from", "to"] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") continue;
    const date = parseStatsDate(value, field === "to");
    if (date === null) {
      throw new Error(`${field} must use YYYY-MM-DD or RFC3339`);
    }
    query[field] = date;
  }
  return query;
}

function parseStatsDate(value: string, endOfDay: boolean): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) return null;
    if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function openStatsDB(settings: Settings): StatsDB | null {
  const dbPath = path.join(getSessionDir(settings), "sessions.db");
  try {
    Deno.statSync(dbPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  return StatsDB.open(dbPath);
}

function statsSummary(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const query = statsQuery(input);
  let sessions = 0;
  try {
    sessions = listAllDetailed(getSessionDir(settings)).length;
  } catch {
    sessions = 0;
  }
  let summary = {
    totalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const db = openStatsDB(settings);
  if (db !== null) {
    try {
      summary = db.summary(query);
    } finally {
      db.close();
    }
  }
  const result: Record<string, unknown> = {
    sessions,
    runs: summary.totalRequests,
    tokens: {
      input: summary.inputTokens,
      output: summary.outputTokens,
      total: summary.totalTokens,
    },
    cost: 0,
  };
  if (query.from !== undefined) result.since = query.from.toISOString();
  if (query.to !== undefined) result.until = query.to.toISOString();
  return result;
}

function statsTimeseries(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const query = statsQuery(input);
  if (query.from === undefined) {
    query.from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  }
  const points: Record<string, unknown>[] = [];
  const db = openStatsDB(settings);
  if (db !== null) {
    try {
      for (const aggregate of db.timeSeries(query)) {
        points.push({
          date: aggregate.label,
          runs: aggregate.requests,
          tokens: aggregate.totalTokens,
          cost: 0,
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
  if (query.to !== undefined) result.to = query.to.toISOString();
  return result;
}

function setMCP(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const serversRaw = input.servers;
  if (!Array.isArray(serversRaw)) throw new Error("servers array is required");
  const target = mcpTarget(settings, input);
  const existing = loadMCPConfigAtPath(target.path);
  const byName = new Map((existing.mcpServers ?? []).map((server) => [
    server.name,
    server,
  ]));
  const next: MCPServer[] = [];
  const seen = new Set<string>();
  for (const raw of serversRaw) {
    const fields = requireObject(raw, "MCP server entry");
    for (const field of Object.keys(fields)) {
      if (!mcpWritableFields.has(field)) {
        throw new Error(
          `MCP server field ${JSON.stringify(field)} is not writable`,
        );
      }
    }
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    if (name === "") {
      throw new Error("each server entry requires a non-empty name");
    }
    if (seen.has(name)) {
      throw new Error(`duplicate MCP server name ${JSON.stringify(name)}`);
    }
    seen.add(name);
    const server: MCPServer = { ...(byName.get(name) ?? { name }), name };
    if (fields.type !== undefined) {
      if (typeof fields.type !== "string") {
        throw new Error(`server ${name}: type must be a string`);
      }
      const type = fields.type.trim();
      if (
        type !== "" && type !== "stdio" && type !== "http" && type !== "sse"
      ) {
        throw new Error(`server ${name}: type must be one of stdio, http, sse`);
      }
      server.type = type;
    }
    for (const field of ["command", "url", "messageUrl"] as const) {
      if (fields[field] === undefined) continue;
      if (typeof fields[field] !== "string") {
        throw new Error(`server ${name}: ${field} must be a string`);
      }
      server[field] = fields[field].trim();
    }
    if (fields.args !== undefined) {
      if (
        !Array.isArray(fields.args) ||
        fields.args.some((v) => typeof v !== "string")
      ) {
        throw new Error(`server ${name}: args must be an array of strings`);
      }
      server.args = fields.args as string[];
    }
    for (const field of ["headers", "env"] as const) {
      if (fields[field] === undefined) continue;
      if (!Array.isArray(fields[field])) {
        throw new Error(
          `server ${name}: ${field} must be an array of name/value objects`,
        );
      }
      const pairs: { name: string; value: string }[] = [];
      for (const rawPair of fields[field]) {
        const pair = requireObject(rawPair, `${field} entry`);
        if (
          typeof pair.name !== "string" || pair.name.trim() === "" ||
          typeof pair.value !== "string"
        ) {
          throw new Error(
            `server ${name}: ${field} must be an array of name/value objects`,
          );
        }
        pairs.push({ name: pair.name.trim(), value: pair.value });
      }
      server[field] = pairs;
    }
    if (fields.enabled !== undefined) {
      if (typeof fields.enabled !== "boolean") {
        throw new Error(`server ${name}: enabled must be a boolean`);
      }
      server.enabled = fields.enabled;
    }
    next.push(server);
  }
  const config: MCPConfig = { mcpServers: next };
  normalizeMCPConfig(config);
  for (const server of config.mcpServers ?? []) {
    const type = server.type ?? "stdio";
    if (type === "stdio" && (server.command ?? "").trim() === "") {
      throw new Error(
        `server ${server.name}: stdio transport requires a command`,
      );
    }
    if (
      (type === "http" || type === "sse") && (server.url ?? "").trim() === ""
    ) {
      throw new Error(
        `server ${server.name}: ${type} transport requires a url`,
      );
    }
  }
  saveMCPConfig(target.path, config);
  const saved = loadMCPConfigAtPath(target.path);
  return {
    scope: target.scope,
    sessionId: target.sessionId,
    path: target.path,
    servers: mcpViews(saved),
  };
}

const mcpWritableFields = new Set([
  "name",
  "type",
  "command",
  "args",
  "url",
  "messageUrl",
  "enabled",
  "headers",
  "env",
]);

function loadMCPConfigAtPath(targetPath: string): MCPConfig {
  try {
    const config = loadMCPConfig(targetPath);
    normalizeMCPConfig(config);
    return config;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw new Error(`load MCP config: ${(err as Error).message}`);
  }
}

function mcpTarget(
  settings: Settings,
  input: Record<string, unknown>,
): { scope: string; sessionId: string; path: string } {
  const rawScope = typeof input.scope === "string"
    ? input.scope.trim()
    : "global";
  const scope = rawScope === "" ? "global" : rawScope;
  const sessionId = typeof input.sessionId === "string"
    ? input.sessionId.trim()
    : "";
  if (scope === "global") {
    return { scope, sessionId: "", path: globalMCPPath() };
  }
  if (scope !== "project") {
    throw new Error("MCP scope must be global or project");
  }
  if (sessionId === "") {
    throw new Error("project MCP management requires sessionId");
  }
  const session = openByIDExact(getSessionDir(settings), sessionId);
  return { scope, sessionId, path: path.join(session.cwd, "mcp.json") };
}

function listMCP(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const scope = typeof input.scope === "string" ? input.scope.trim() : "global";
  const sessionId = typeof input.sessionId === "string"
    ? input.sessionId.trim()
    : "";
  const resolvedScope = scope === "" ? "global" : scope;
  let targetPath: string;
  if (resolvedScope === "global") {
    targetPath = globalMCPPath();
  } else if (resolvedScope === "project") {
    if (sessionId === "") {
      throw new Error("project MCP management requires sessionId");
    }
    const session = openByIDExact(getSessionDir(settings), sessionId);
    targetPath = path.join(session.cwd, "mcp.json");
  } else {
    throw new Error("MCP scope must be global or project");
  }
  let config: MCPConfig;
  try {
    config = loadMCPConfig(targetPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) config = {};
    else throw new Error(`load MCP config: ${(err as Error).message}`);
  }
  normalizeMCPConfig(config);
  return {
    scope: resolvedScope,
    sessionId: resolvedScope === "project" ? sessionId : "",
    path: targetPath,
    servers: mcpViews(config),
  };
}

function mcpViews(config: MCPConfig): Record<string, unknown>[] {
  return (config.mcpServers ?? []).map((server) => {
    const view: Record<string, unknown> = {
      name: server.name,
      type: server.type ?? "",
      enabled: mcpServerEnabled(server),
    };
    if ((server.command ?? "") !== "") view.command = server.command;
    if (server.args && server.args.length > 0) view.args = [...server.args];
    if ((server.url ?? "") !== "") view.url = server.url;
    if ((server.messageUrl ?? "") !== "") view.messageUrl = server.messageUrl;
    if (server.env && server.env.length > 0) {
      view.env = server.env.map((entry) => ({
        name: entry.name,
        valueConfigured: true,
      }));
    }
    if (server.headers && server.headers.length > 0) {
      view.headers = server.headers.map((entry) => ({
        name: entry.name,
        valueConfigured: true,
      }));
    }
    return view;
  });
}

function listSkills(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const target = cwd === "" ? Deno.cwd() : cwd;
  if (!path.isAbsolute(target)) throw new Error("cwd must be an absolute path");
  const manager = createSkillsManager(
    getGlobalSkillsDir(settings),
    projectSkillDirs(target),
  );
  manager.load();
  return {
    cwd: target,
    skills: manager.listAll().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: !manager.isSkillDisabled(skill.name),
    })),
  };
}

function setSkill(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const enabled = input.enabled;
  if (name === "" || typeof enabled !== "boolean") {
    throw new Error("name and enabled are required");
  }
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const target = cwd === "" ? Deno.cwd() : cwd;
  if (!path.isAbsolute(target)) throw new Error("cwd must be an absolute path");
  const manager = createSkillsManager(
    getGlobalSkillsDir(settings),
    projectSkillDirs(target),
  );
  manager.load();
  if (!manager.listAll().some((skill) => skill.name === name)) {
    throw new Error(`skill ${JSON.stringify(name)} is not available`);
  }
  const raw = readRawGlobalSettings();
  const existing = raw.skills;
  let current: string[] = [];
  if (existing !== undefined && existing !== null) {
    const object = requireObject(existing, "skills settings");
    const disabled = object.disabled;
    if (disabled !== undefined && disabled !== null) {
      if (
        !Array.isArray(disabled) ||
        disabled.some((value) => typeof value !== "string")
      ) {
        throw new Error("parse skills settings");
      }
      current = disabled as string[];
    }
  }
  const next = [
    ...new Set(
      current.map((value) => value.trim()).filter((value) => value !== ""),
    ),
  ];
  const existingIndex = next.indexOf(name);
  if (enabled && existingIndex >= 0) next.splice(existingIndex, 1);
  if (!enabled && existingIndex < 0) next.push(name);
  next.sort();
  saveGlobalSettingsPatch({
    skills: next.length === 0 ? null : { disabled: next },
  });
  return { name, enabled, skillsDisabled: next };
}

const applicationSectionFields: Record<string, ReadonlySet<string>> = {
  defaults: new Set([
    "defaultMode",
    "enablePlanTool",
    "enableArtifact",
    "enableACPArtifact",
    "authored",
    "updateCheck",
  ]),
  contextFiles: new Set(["enabled", "extraFiles"]),
  compaction: new Set([
    "enabled",
    "reserveTokens",
    "keepRecentTokens",
    "tokenizer",
    "tokenizerModel",
    "template",
  ]),
  toolExecution: new Set(["mode", "maxConcurrency"]),
  webSearch: new Set(["enabled", "provider", "providerType", "model"]),
  imageGeneration: new Set([
    "enabled",
    "provider",
    "apiType",
    "baseUrl",
    "model",
    "token",
  ]),
  retry: new Set(["enabled", "maxRetries", "baseDelayMs"]),
  statusLine: new Set([
    "enabled",
    "type",
    "command",
    "padding",
    "refreshInterval",
    "timeoutMs",
    "fallback",
  ]),
  sandbox: new Set([
    "enabled",
    "level",
    "bwrapPath",
    "allowNetwork",
    "allowedRead",
    "allowedWrite",
    "deniedPaths",
    "tmpSize",
    "protectGit",
  ]),
  approval: new Set([
    "bashWhitelist",
    "bashBlacklist",
    "confirmBeforeWrite",
  ]),
};

function applicationPatch(
  settings: Settings,
  value: unknown,
): { settings: Settings; updates: Record<string, unknown> } {
  const patch = requireObject(value, "application patch");
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "patch object with at least one application section is required",
    );
  }
  const next: Settings = {
    ...settings,
    contextFiles: settings.contextFiles === undefined
      ? undefined
      : { ...settings.contextFiles },
    compaction: settings.compaction === undefined
      ? undefined
      : { ...settings.compaction },
    toolExecution: settings.toolExecution === undefined
      ? undefined
      : { ...settings.toolExecution },
    webSearch: settings.webSearch === undefined
      ? undefined
      : { ...settings.webSearch },
    imageGeneration: settings.imageGeneration === undefined
      ? undefined
      : { ...settings.imageGeneration },
    retry: settings.retry === undefined ? undefined : { ...settings.retry },
    statusLine: settings.statusLine === undefined
      ? undefined
      : { ...settings.statusLine },
    sandbox: settings.sandbox === undefined
      ? undefined
      : { ...settings.sandbox },
    approval: settings.approval === undefined
      ? undefined
      : { ...settings.approval },
  };
  const raw = readRawGlobalSettings();
  const updates: Record<string, unknown> = {};
  for (const [section, sectionRaw] of Object.entries(patch)) {
    const allowed = applicationSectionFields[section];
    if (allowed === undefined) {
      throw new Error(
        `application section ${JSON.stringify(section)} is not supported`,
      );
    }
    const fields = requireObject(sectionRaw, `application section ${section}`);
    for (const field of Object.keys(fields)) {
      if (!allowed.has(field)) {
        throw new Error(
          `application field ${section}.${field} is not writable`,
        );
      }
      validateApplicationField(section, field, fields[field]);
    }
    if (section === "defaults") {
      for (const [field, fieldValue] of Object.entries(fields)) {
        (next as unknown as Record<string, unknown>)[field] = fieldValue;
        updates[field] = fieldValue;
      }
      continue;
    }
    const currentRaw = raw[section];
    const current = currentRaw === undefined || currentRaw === null
      ? {}
      : requireObject(currentRaw, `application section ${section}`);
    const persisted = { ...current, ...fields };
    updates[section] = persisted;
    const target = next as unknown as Record<string, unknown>;
    target[section] = persisted;
  }
  return { settings: next, updates };
}

function validateApplicationField(
  section: string,
  field: string,
  value: unknown,
): void {
  const bool = (): void => {
    if (typeof value !== "boolean") {
      throw new Error(`application field ${section}.${field} must be boolean`);
    }
  };
  const string = (): void => {
    if (typeof value !== "string") {
      throw new Error(`application field ${section}.${field} must be a string`);
    }
  };
  const integer = (min: number): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
      throw new Error(
        `application field ${section}.${field} must be an integer >= ${min}`,
      );
    }
  };
  const strings = (): void => {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || item.trim() === "")
    ) {
      throw new Error(
        `application field ${section}.${field} must be a string array`,
      );
    }
  };
  if (section === "defaults") {
    if (field === "defaultMode") {
      string();
      if (!new Set(["agent", "plan", "yolo", "os"]).has(value as string)) {
        throw new Error(`application field defaults.defaultMode is invalid`);
      }
    } else bool();
    return;
  }
  if (
    (section === "contextFiles" && field === "enabled") ||
    (section === "compaction" && field === "enabled") ||
    (section === "webSearch" && field === "enabled") ||
    (section === "imageGeneration" && field === "enabled") ||
    (section === "retry" && field === "enabled") ||
    (section === "statusLine" && field === "enabled") ||
    (["enabled", "allowNetwork", "protectGit"].includes(field) &&
      section === "sandbox") ||
    (section === "approval" && field === "confirmBeforeWrite")
  ) {
    bool();
    return;
  }
  if (
    (section === "contextFiles" && field === "extraFiles") ||
    (["allowedRead", "allowedWrite", "deniedPaths"].includes(field) &&
      section === "sandbox") ||
    (["bashWhitelist", "bashBlacklist"].includes(field) &&
      section === "approval")
  ) {
    strings();
    return;
  }
  if (section === "toolExecution" && field === "maxConcurrency") {
    integer(1);
    return;
  }
  if (section === "toolExecution" && field === "mode") {
    string();
    if (value !== "parallel" && value !== "sequential") {
      throw new Error("application field toolExecution.mode is invalid");
    }
    return;
  }
  if (
    (section === "compaction" &&
      ["reserveTokens", "keepRecentTokens"].includes(field)) ||
    (section === "retry" && ["maxRetries", "baseDelayMs"].includes(field)) ||
    (section === "statusLine" &&
      ["padding", "refreshInterval", "timeoutMs"].includes(field))
  ) {
    integer(0);
    return;
  }
  string();
}

function applicationView(settings: Settings): Record<string, unknown> {
  const defaults = {
    defaultMode: settings.defaultMode?.trim() || "yolo",
    enablePlanTool: settings.enablePlanTool === true,
    enableArtifact: isArtifactEnabled(settings),
    enableACPArtifact: isACPArtifactEnabled(settings),
    authored: settings.authored ?? false,
    updateCheck: settings.updateCheck === undefined || settings.updateCheck,
  };
  const contextFiles = settings.contextFiles;
  const compaction = settings.compaction;
  const toolExecution = settings.toolExecution ?? {};
  const webSearch = settings.webSearch;
  const imageGeneration = settings.imageGeneration;
  const retry = settings.retry;
  const statusLine = settings.statusLine;
  const sandbox = settings.sandbox;
  const approval = settings.approval;
  return {
    defaults,
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
      mode: toolExecutionEffectiveMode(toolExecution),
      maxConcurrency: toolExecutionEffectiveMaxConcurrency(toolExecution),
    },
    webSearch: {
      enabled: isWebSearchEnabled(settings),
      provider: webSearch?.provider ?? "",
      providerType: webSearch?.providerType ?? "",
      model: webSearch?.model ?? "",
    },
    imageGeneration: {
      enabled: imageGeneration?.enabled ?? false,
      provider: imageGeneration?.provider ?? "",
      apiType: imageGeneration?.apiType ?? "",
      baseUrl: imageGeneration?.baseUrl ?? "",
      model: imageGeneration?.model ?? "",
      tokenConfigured: resolveImageGenerationToken(settings).trim() !== "",
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
      confirmBeforeWrite: approval?.confirmBeforeWrite === true,
    },
  };
}

/** Reads one settings document (effective merge or global sparse). */
function settingsDocumentFor(
  scope: "effective" | "global",
  workDir: string,
): Settings {
  return scope === "global"
    ? loadGlobalSettingsSparse()
    : loadSettingsFor(workDir === "" ? "." : workDir);
}

/**
 * Applies one sparse settings patch in the requested scope and returns the
 * refreshed effective document for the work directory. Every settings edit
 * flows through this path so the on-disk files and the Core-owned settings
 * snapshot refresh together.
 */
function updateSettingsDocumentFor(
  scope: "global" | "project",
  updates: Record<string, unknown>,
  workDir: string,
): Settings {
  const cwd = workDir === "" ? "." : workDir;
  if (scope === "global") saveGlobalSettingsPatch(updates);
  else saveProjectSettingsPatchFor(cwd, updates);
  return loadSettingsFor(cwd);
}

/**
 * Refreshes the shared Core settings snapshot in place after a settings edit.
 * Every Core closure (session runtimes, extension handler, host defaults) holds
 * this same object, so an in-place refresh keeps prompt-time provider
 * construction and management reads current (the settings staleness bug that
 * motivated routing TUI settings edits through the service).
 */
function refreshSharedSettings(shared: Settings, fresh: Settings): Settings {
  Object.assign(shared, fresh);
  return shared;
}

/** Projects the built-in-plus-configured provider catalog. */
function providerCatalogView(settings: Settings): CoreProviderCatalogView[] {
  const ids = new Set<string>();
  for (const id of Object.keys(defaultProviderConfigsAll())) ids.add(id);
  for (const id of Object.keys(settings.providers ?? {})) ids.add(id);
  const sorted = [...ids];
  sortProviderIDs(sorted);
  return sorted.map((id) => {
    const configured = getProviderConfig(settings, id);
    return {
      id,
      configured: configured !== undefined,
      isDefault: id === settings.defaultProvider,
      api: configured?.api ?? "openai-chat",
      baseUrl: configured?.baseUrl ?? "",
      modelCount: configured?.models.length ?? 0,
      models: resolvedModels(settings, id).map((model) => ({
        id: model.id,
        name: model.name,
      })),
    };
  });
}

/** Reads the global environment-variable document. */
function envDocumentView(): Record<string, string> {
  return envList(loadEnv());
}

/**
 * Replaces the global environment-variable document: variables missing from
 * `vars` are removed and present values round-trip exactly.
 */
function updateEnvDocumentVars(
  vars: Record<string, string>,
): Record<string, string> {
  const config = loadEnv();
  const existing = envList(config);
  const unset = Object.keys(existing).filter((name) => !(name in vars));
  applyEnvPatch(config, { ...vars }, unset);
  return envList(config);
}

function settingsView(settings: Settings): Record<string, unknown> {
  return {
    defaultProvider: settings.defaultProvider ?? "",
    defaultModel: settings.defaultModel ?? "",
    defaultMode: settings.defaultMode?.trim() || "yolo",
    thinkingLevel: settings.defaultThinkingLevel ?? "",
    providers: providerViews(settings),
    sandboxEnabled: settings.sandbox?.enabled ?? false,
    sandboxLevel: settings.sandbox?.level ?? "",
    webSearchEnabled: isWebSearchEnabled(settings),
    skillsDisabled: [...(skillsDisabled(settings) ?? [])],
    memoryEnabled: true,
  };
}

function providerViews(settings: Settings): Record<string, unknown>[] {
  const providers = Object.keys(settings.providers ?? {});
  sortProviderIDs(providers);
  return providers.map((name) => {
    const provider = resolveProviderConfig(name, settings);
    const maskedKey = maskProviderKey(provider.apiKey);
    const view: Record<string, unknown> = {
      name,
      maskedKey,
      modelCount: resolvedModels(settings, name).length,
      models: resolvedModels(settings, name).map((model) => ({
        id: model.id,
        name: model.name,
      })),
      apiKeyConfigured: maskedKey !== null,
    };
    if (provider.baseUrl !== undefined && provider.baseUrl !== "") {
      view.baseUrl = provider.baseUrl;
    }
    if (name === settings.defaultProvider) view.isDefault = true;
    return view;
  });
}

async function testProvider(
  settings: Settings,
  input: Record<string, unknown>,
  providerFactory: typeof createProvider,
): Promise<Record<string, unknown>> {
  const providerID = typeof input.provider === "string"
    ? input.provider.trim()
    : "";
  if (providerID === "") throw new Error("provider is required");
  let modelID = typeof input.model === "string" ? input.model.trim() : "";
  if (modelID === "" && providerID === settings.defaultProvider) {
    modelID = settings.defaultModel ?? "";
  }
  let created: ReturnType<typeof createProvider>;
  try {
    created = providerFactory(settings, providerID, modelID);
  } catch (err) {
    throw new Error(
      `provider test failed: ${
        redactProviderError(settings, (err as Error).message)
      }`,
    );
  }
  const targetModel = created.model.id || modelID;
  const started = Date.now();
  try {
    for await (
      const event of created.provider.chat({
        modelId: targetModel,
        thinkingLevel: thinkingOff,
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
      if (event.type === streamError) {
        return {
          ok: false,
          provider: providerID,
          model: targetModel,
          error: redactProviderError(
            settings,
            event.error === undefined
              ? "model request failed"
              : String(event.error),
          ),
        };
      }
      if (event.type === streamDone) {
        return {
          ok: true,
          provider: providerID,
          model: targetModel,
          latencyMs: Date.now() - started,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      provider: providerID,
      model: targetModel,
      error: redactProviderError(settings, (err as Error).message),
    };
  }
  return {
    ok: false,
    provider: providerID,
    model: targetModel,
    error: "model request ended without a completion",
  };
}

function redactProviderError(settings: Settings, message: string): string {
  let result = message;
  for (const provider of Object.values(settings.providers ?? {})) {
    for (
      const secret of [
        provider.apiKey,
        ...Object.values(provider.headers ?? {}),
      ]
    ) {
      if (typeof secret === "string" && secret.length >= 4) {
        result = result.split(secret).join("***");
      }
    }
  }
  return result;
}

async function discoverProvider(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const api = typeof input.api === "string" ? input.api.trim() : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (api === "" || baseUrl === "") {
    throw new Error("api and baseUrl are required");
  }
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
  const httpProxy = typeof input.httpProxy === "string" ? input.httpProxy : "";
  const forceHTTP11 = input.forceHTTP11 === true;
  const headers = input.headers !== undefined && input.headers !== null &&
      typeof input.headers === "object" && !Array.isArray(input.headers)
    ? input.headers as Record<string, string>
    : undefined;
  try {
    const models = await discoverModels(AbortSignal.timeout(30_000), {
      api,
      baseUrl,
      apiKey,
      httpProxy,
      forceHTTP11,
      headers,
    });
    return {
      models: models.map((model) => {
        const projected: Record<string, unknown> = { id: model.id };
        if (model.name !== undefined) projected.name = model.name;
        if (model.contextWindow !== undefined) {
          projected.contextWindow = model.contextWindow;
        }
        if (model.maxTokens !== undefined) {
          projected.maxTokens = model.maxTokens;
        }
        if (model.input !== undefined && model.input.length > 0) {
          projected.input = model.input;
        }
        if (model.reasoning === true) projected.reasoning = true;
        return projected;
      }),
    };
  } catch (err) {
    throw new Error(`provider discovery failed: ${(err as Error).message}`);
  }
}

const providerWritableFields = new Set([
  "vendor",
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

function saveProvider(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const previousId = typeof input.previousId === "string"
    ? input.previousId.trim()
    : "";
  const providerRaw = input.provider;
  if (
    id === "" || providerRaw === undefined || providerRaw === null ||
    typeof providerRaw !== "object" || Array.isArray(providerRaw) ||
    Object.keys(providerRaw).length === 0
  ) {
    throw new Error("id and provider are required");
  }
  if (id.includes("/")) {
    throw new Error("provider id must not contain '/'");
  }
  const fields = decodeProviderFields(providerRaw);
  const raw = readRawGlobalSettings();
  const rawProviders = raw.providers === undefined
    ? {}
    : requireObject(raw.providers, "settings.providers");
  const sourceId = previousId === "" ? id : previousId;
  if (
    sourceId !== id && !Object.prototype.hasOwnProperty.call(
      rawProviders,
      sourceId,
    )
  ) {
    throw new Error(`provider ${JSON.stringify(sourceId)} is not configured`);
  }
  const existing = rawProviders[sourceId];
  const entry: Record<string, unknown> = existing === undefined
    ? {}
    : { ...requireObject(existing, `provider ${sourceId}`) };
  for (const key of Object.keys(fields)) delete entry[key];
  Object.assign(entry, fields);
  if (Object.prototype.hasOwnProperty.call(input, "apiKey")) {
    if (typeof input.apiKey !== "string") {
      throw new Error("apiKey must be a string");
    }
    entry.apiKey = input.apiKey;
  }
  if (
    sourceId !== id && Object.prototype.hasOwnProperty.call(rawProviders, id)
  ) {
    throw new Error(`provider ${JSON.stringify(id)} already exists`);
  }
  rawProviders[id] = entry;
  if (sourceId !== id) delete rawProviders[sourceId];
  const updates: Record<string, unknown> = { providers: rawProviders };
  if (sourceId !== id && settings.defaultProvider === sourceId) {
    updates.defaultProvider = id;
  }
  saveGlobalSettingsPatch(updates);
  return { providers: providerViews(loadGlobalSettingsOrDefault()) };
}

function deleteProvider(
  settings: Settings,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (id === "") throw new Error("provider id is required");
  if (settings.defaultProvider === id) {
    throw new Error("choose another default provider before deleting this one");
  }
  const raw = readRawGlobalSettings();
  const rawProviders = raw.providers === undefined
    ? {}
    : requireObject(raw.providers, "settings.providers");
  if (!Object.prototype.hasOwnProperty.call(rawProviders, id)) {
    throw new Error(
      `provider ${JSON.stringify(id)} has no global override to delete`,
    );
  }
  delete rawProviders[id];
  saveGlobalSettingsPatch({ providers: rawProviders });
  return { providers: providerViews(loadGlobalSettingsOrDefault()) };
}

function decodeProviderFields(raw: object): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!providerWritableFields.has(key)) {
      throw new Error(`provider field ${JSON.stringify(key)} is not allowed`);
    }
    if (
      ["vendor", "baseUrl", "httpProxy", "api", "thinkingFormat"].includes(
        key,
      ) &&
      value !== undefined && typeof value !== "string"
    ) {
      throw new Error(`provider field ${key} must be a string`);
    }
    if (
      ["forceHTTP11", "cacheControl"].includes(key) &&
      value !== undefined && typeof value !== "boolean"
    ) {
      throw new Error(`provider field ${key} must be a boolean`);
    }
    if (
      key === "maxImagesPerRequest" && value !== undefined &&
      typeof value !== "number"
    ) {
      throw new Error("provider field maxImagesPerRequest must be a number");
    }
    if (
      ["headers", "responses"].includes(key) &&
      value !== undefined &&
      (value === null || typeof value !== "object" || Array.isArray(value))
    ) {
      throw new Error(`provider field ${key} must be an object`);
    }
    if (key === "models" && value !== undefined) {
      if (!Array.isArray(value)) {
        throw new Error("provider field models must be an array");
      }
      const seen = new Set<string>();
      for (const model of value) {
        if (
          model === null || typeof model !== "object" || Array.isArray(model)
        ) {
          throw new Error("each model must be an object");
        }
        const modelId = (model as Record<string, unknown>).id;
        if (typeof modelId !== "string" || modelId.trim() === "") {
          throw new Error("model id is required");
        }
        const normalized = modelId.trim();
        if (seen.has(normalized)) {
          throw new Error(`duplicate model id ${JSON.stringify(normalized)}`);
        }
        seen.add(normalized);
      }
    }
    fields[key] = value;
  }
  return fields;
}

function readRawGlobalSettings(): Record<string, unknown> {
  let text: string;
  try {
    text = Deno.readTextFileSync(globalSettingsPath());
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw new Error(`read global settings: ${(err as Error).message}`);
  }
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  return requireObject(parsed, "global settings");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function maskProviderKey(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (
    trimmed === "" || trimmed.startsWith("${") || trimmed.startsWith("!")
  ) {
    return null;
  }
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}

function envView(config = loadEnv()): Record<string, unknown> {
  const variables = Object.keys(envList(config)).sort().map((name) => ({
    name,
    valueConfigured: true,
  }));
  return { variables };
}

function decodeEnvSet(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new Error("set must be an array of {name, value} objects");
  }
  const result: Record<string, string> = {};
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each set entry requires name and value strings");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.value !== "string") {
      throw new Error("each set entry requires name and value strings");
    }
    const name = record.name.trim();
    validateEnvName(name);
    if (Object.prototype.hasOwnProperty.call(result, name)) {
      throw new Error(`duplicate environment variable name ${name}`);
    }
    result[name] = record.value;
  }
  return result;
}

function decodeEnvUnset(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("unset must be an array of variable names");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("unset must contain only names");
    }
    const name = entry.trim();
    validateEnvName(name);
    if (seen.has(name)) {
      throw new Error(`duplicate environment variable name ${name}`);
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

function validDate(value: Date): string {
  return Number.isNaN(value.getTime()) ? "" : value.toISOString();
}

/** Maps a wire attachment kind (or media type) onto the canonical kind. */
function attachmentKindFor(
  kind: string | undefined,
  mediaType: string,
): "image" | "file" | "audio" | "video" {
  switch (kind) {
    case "image":
      return ATTACHMENT_IMAGE;
    case "audio":
      return ATTACHMENT_AUDIO;
    case "video":
      return ATTACHMENT_VIDEO;
    case "file":
      return ATTACHMENT_FILE;
    default:
      break;
  }
  return mediaType.startsWith("image/") ? ATTACHMENT_IMAGE : ATTACHMENT_FILE;
}

class ProductionCoreSessionRuntime implements CoreSessionRuntime {
  readonly sessionId: string;
  readonly #settings: Settings;
  readonly #workDir: string;
  readonly #source: string;
  readonly #providerName: string;
  readonly #modelID: string;
  readonly #mode: string;
  readonly #thinkingLevel: string;
  readonly #providerFactory: typeof createProvider;
  readonly #reverseRequest: CoreReverseRequest | undefined;
  readonly #openExisting: boolean;
  readonly #approvalPolicy: string;
  readonly #questionPolicy: string;
  #manager: Manager | undefined;
  #runtime: SessionRuntime | undefined;
  readonly #activeSkills = new Map<string, boolean>();
  /** Lazily-built shared AgentManager (delegate tool + ESM role agents). */
  #agentManager: AgentManager | undefined;
  #delegateEnabled = false;
  #multiAgentEnabled = false;
  /** The running ESM continuation worker, if any. */
  #esmWorker:
    | { runId: string; cancel: () => void; done: Promise<void> }
    | undefined;
  /** The ESM role agent currently executing, if any. */
  #esmActiveAgentId = "";

  constructor(input: {
    sessionId: string;
    workDir: string;
    source: string;
    providerName: string;
    modelID: string;
    mode?: string;
    thinkingLevel?: string;
    capabilities?: Record<string, boolean>;
    approvalPolicy?: string;
    questionPolicy?: string;
    settings: Settings;
    providerFactory?: typeof createProvider;
    reverseRequest?: CoreReverseRequest;
    openExisting?: boolean;
  }) {
    this.sessionId = input.sessionId;
    this.#settings = input.settings;
    this.#workDir = input.workDir;
    this.#source = input.source;
    this.#providerName = input.providerName;
    this.#modelID = input.modelID;
    this.#mode = input.mode ?? input.settings.defaultMode ?? "yolo";
    this.#thinkingLevel = input.thinkingLevel ??
      input.settings.defaultThinkingLevel ?? "";
    this.#multiAgentEnabled = input.capabilities?.multiAgent === true;
    this.#approvalPolicy = (input.approvalPolicy ?? "").trim() !== ""
      ? (input.approvalPolicy as string)
      : "runtime";
    this.#questionPolicy = (input.questionPolicy ?? "").trim() !== ""
      ? (input.questionPolicy as string)
      : "runtime";
    this.#providerFactory = input.providerFactory ?? createProvider;
    this.#reverseRequest = input.reverseRequest;
    this.#openExisting = input.openExisting === true;
  }

  /** Opens (or creates) this session's persisted identity exactly once. */
  #ensureManager(): Manager {
    if (this.#manager !== undefined) return this.#manager;
    const sessionDir = this.#settings.sessionDir ?? "";
    const manager = this.#openExisting
      ? openPersistedSession(sessionDir, this.sessionId)
      : openOrCreateSession({
        workDir: this.#workDir,
        sessionDir,
        id: this.sessionId,
      });
    this.#manager = manager;
    return manager;
  }

  /**
   * Projects the persisted session identity (work directory and persisted
   * mode) so one canonical binding reaches the host session view. Establishing
   * the summary also creates the persisted row of a fresh session, so its
   * identity is Core-owned and visible to session listings immediately.
   */
  persistedSummary(): { workDir?: string; mode?: string } {
    const manager = this.#ensureManager();
    const header = manager.getHeader();
    const mode = manager.getLatestModeChange()?.mode ?? "";
    return {
      workDir: header?.cwd ?? this.#workDir,
      ...(mode.trim() === "" ? {} : { mode }),
    };
  }

  async #ensureRuntime(): Promise<{
    manager: Manager;
    runtime: SessionRuntime;
  }> {
    if (this.#manager !== undefined && this.#runtime !== undefined) {
      return { manager: this.#manager, runtime: this.#runtime };
    }
    const manager = this.#ensureManager();
    const runtime = await new Builder(
      this.#settings,
      sandboxLevelFromSettings(this.#settings),
    ).build(undefined, {
      id: this.sessionId,
      source: this.#source,
      workDir: this.#workDir,
      workflows: false,
      browser: false,
      artifactEnabled: isArtifactEnabled(this.#settings),
      manager,
    });
    runtime.setDecisions(new DecisionService());
    this.#runtime = runtime;
    return { manager, runtime };
  }

  async setSkillActive(
    input: { name: string; active: boolean },
  ): Promise<void> {
    const name = input.name.trim();
    if (name === "") throw new Error("skill name is required");
    if (input.active) this.#activeSkills.set(name, true);
    else this.#activeSkills.delete(name);
    const { runtime } = await this.#ensureRuntime();
    await runtime.refreshResources(this.#settings, {
      workflows: false,
      browser: false,
      activeSkills: Object.fromEntries(this.#activeSkills),
    });
  }

  async listSkills(): Promise<CoreSkillView[]> {
    const { runtime } = await this.#ensureRuntime();
    const manager = runtime.skillsMgr;
    if (manager === undefined) return [];
    return manager.list().map((skill) => ({
      name: skill.name,
      source: skill.source,
      description: skill.description,
      active: this.#activeSkills.get(skill.name) === true,
    }));
  }

  async prepareInput(
    input: CorePrepareInput & { sessionId: string },
  ): Promise<CorePreparedInput> {
    const { runtime } = await this.#ensureRuntime();
    const bytes = decodeBase64(input.contentBase64);
    const kind = attachmentKindFor(input.kind, input.mediaType);
    const prepared = await runtime.prepareInput(undefined, {
      origin: this.#source,
      eventId: `core-input-${generateID()}`,
      itemIndex: 0,
      reference: "",
      kind,
      filenameHint: input.name,
      mediaTypeHint: input.mediaType,
      sizeHint: bytes.byteLength,
      open: () => ({
        bytes,
        filename: input.name,
        mediaType: input.mediaType,
        contentSize: bytes.byteLength,
      }),
    });
    return {
      resourceId: prepared.resourceId,
      kind: prepared.kind,
      relativePath: prepared.relativePath,
      filename: prepared.filename,
      mediaType: prepared.mediaType,
      bytes: prepared.bytes,
    };
  }

  async capabilityView(): Promise<CoreCapabilityView> {
    const { runtime } = await this.#ensureRuntime();
    const snapshot = runtime.capabilitySnapshot();
    return {
      sandbox: { enabled: snapshot.sandboxEnabled, available: true },
      browser: { enabled: snapshot.browserEnabled, available: true },
      webSearch: { enabled: snapshot.webSearchEnabled, available: true },
      artifact: {
        enabled: runtime.artifactCapabilitySnapshot(),
        available: true,
      },
    };
  }

  async contextView(): Promise<CoreSessionContextView> {
    const { runtime } = await this.#ensureRuntime();
    return {
      ruleContent: runtime.ruleContent,
      extraContext: runtime.extraContext,
    };
  }

  async setContext(input: {
    ruleContent?: string;
    extraContext?: string;
  }): Promise<void> {
    const { runtime } = await this.#ensureRuntime();
    if (input.ruleContent !== undefined) {
      runtime.ruleContent = input.ruleContent;
    }
    if (input.extraContext !== undefined) {
      runtime.extraContext = input.extraContext;
    }
  }

  async listExperts(): Promise<CoreExpertSummaryView[]> {
    const { runtime } = await this.#ensureRuntime();
    return runtime.listExperts().map((summary) => ({
      name: summary.name,
      displayName: {
        zh: summary.displayName.zh ?? "",
        en: summary.displayName.en ?? "",
      },
      expertType: summary.expertType,
      source: summary.source,
      invalid: summary.invalid === true,
      invalidReason: summary.invalidReason ?? "",
    }));
  }

  async inspectExpert(expertId: string): Promise<CoreExpertBundleView> {
    const { runtime } = await this.#ensureRuntime();
    const bundle = runtime.inspectExpert(expertId);
    return {
      name: bundle.name,
      displayName: {
        zh: bundle.manifest.displayName.zh ?? "",
        en: bundle.manifest.displayName.en ?? "",
      },
      expertType: bundle.manifest.expertType,
      invalid: bundle.invalid === true,
      invalidReason: bundle.invalidReason,
      members: (bundle.manifest.members ?? []).map((member) => ({
        id: member.id,
        name: { zh: member.name?.zh ?? "", en: member.name?.en ?? "" },
        profession: {
          zh: member.profession?.zh ?? "",
          en: member.profession?.en ?? "",
        },
        role: member.role ?? "",
      })),
    };
  }

  async expertState(): Promise<CoreExpertStateView> {
    const { runtime } = await this.#ensureRuntime();
    return { expertId: runtime.expertState().binding?.id ?? "" };
  }

  async setExpert(expertId: string): Promise<void> {
    const { runtime } = await this.#ensureRuntime();
    await runtime.setExpert(expertId);
  }

  // --- Managed agents (delegate tool + ESM role agents) ---------------------

  /** Lazily builds the shared AgentManager on the session Runtime. */
  async #ensureAgentManager(): Promise<AgentManager> {
    if (this.#agentManager !== undefined) return this.#agentManager;
    const { runtime } = await this.#ensureRuntime();
    const created = this.#providerFactory(
      this.#settings,
      this.#providerName,
      this.#modelID,
      { requireModel: true },
    );
    this.#agentManager = createAgentManager({
      runtime,
      provider: created.provider,
      model: created.model,
      settings: this.#settings,
      providerName: this.#providerName,
      delegateEnabled: true,
      multiAgentEnabled: this.#multiAgentEnabled,
    });
    return this.#agentManager;
  }

  async listAgents(): Promise<CoreAgentView[]> {
    const manager = await this.#ensureAgentManager();
    return manager.list().map((id) => ({
      id,
      parent: manager.parent(id) ?? "",
      children: [...manager.childrenOf(id)],
      state: manager.statuses.get(id)?.state ?? "",
    }));
  }

  async destroyAgent(agentId: string): Promise<void> {
    const manager = await this.#ensureAgentManager();
    manager.destroy(agentId);
  }

  async setDelegate(enabled: boolean): Promise<boolean> {
    const { runtime } = await this.#ensureRuntime();
    const registry = runtime.registry;
    if (registry === null) {
      throw new Error("agent manager runtime is unavailable");
    }
    if (enabled) {
      const manager = await this.#ensureAgentManager();
      registerDelegateSubAgentTool(registry, manager);
      this.#delegateEnabled = true;
    } else {
      registry.remove("delegate_subagent");
      this.#delegateEnabled = false;
    }
    return this.#delegateEnabled;
  }

  delegateState(): Promise<boolean> {
    return Promise.resolve(this.#delegateEnabled);
  }

  async setCapability(input: {
    id: string;
    enabled: boolean;
  }): Promise<CoreCapabilityView> {
    const { runtime } = await this.#ensureRuntime();
    runtime.setCapabilityOption(input.id, input.enabled);
    return await this.capabilityView();
  }

  /** Applies session capability changes mirrored through `session.config.set`. */
  setCapabilities(capabilities: Record<string, boolean>): void {
    if (typeof capabilities.multiAgent === "boolean") {
      this.#multiAgentEnabled = capabilities.multiAgent;
    }
  }

  // --- ESM supervisor --------------------------------------------------------

  #esmStore(sessionDir: string): ESMStore {
    return new ESMStore(sessionDir);
  }

  #esmView(objective: Objective | null): CoreEsmView {
    return {
      objective: objective === null || objective.esmId === ""
        ? null
        : esmObjectiveView(objective),
      workerRunning: this.#esmWorker !== undefined,
      activeAgentId: this.#esmActiveAgentId,
    };
  }

  #esmObjective(store: ESMStore): Objective | null {
    try {
      return store.get(this.sessionId);
    } catch {
      return null;
    }
  }

  async esmState(): Promise<CoreEsmView> {
    const { manager } = await this.#ensureRuntime();
    return this.#esmView(
      this.#esmObjective(this.#esmStore(manager.getSessionDir())),
    );
  }

  async esmCommand(
    input: Omit<CoreEsmCommandInput, "sessionId">,
  ): Promise<CoreEsmView> {
    const { manager } = await this.#ensureRuntime();
    const store = this.#esmStore(manager.getSessionDir());
    const sessionId = this.sessionId;
    switch (input.action) {
      case "create":
        store.create(sessionId, input.objective ?? "");
        break;
      case "edit":
        store.edit(sessionId, input.objective ?? "");
        break;
      case "pause":
        store.pause(sessionId);
        break;
      case "resume":
        store.resume(sessionId);
        break;
      case "guide":
        store.addGuidance(sessionId, input.guide ?? "");
        break;
      case "clear":
        store.clear(sessionId);
        break;
    }
    return this.#esmView(this.#esmObjective(store));
  }

  async esmContinue(): Promise<CorePromptExecution & { started: boolean }> {
    const { manager, runtime } = await this.#ensureRuntime();
    const sessionId = this.sessionId;
    const existing = this.#esmWorker;
    if (existing !== undefined) {
      return { runId: existing.runId, started: false };
    }
    const store = this.#esmStore(manager.getSessionDir());
    const objective = this.#esmObjective(store);
    if (objective === null || !canAutoRun(objective)) {
      return { runId: "", started: false };
    }
    const runId = `esm_${generateID()}`;
    const queue = new AsyncEventQueue<QueuedCoreEvent>();
    const mode = resolveUnattendedMode(this.#mode);
    const sink: ESMRoleEventSink = {
      teamExpertActive: () => runtime.teamExpertActive(),
      setActiveAgent: (agentId) => {
        this.#esmActiveAgentId = agentId;
      },
      clearActiveAgent: (agentId) => {
        if (this.#esmActiveAgentId === agentId) this.#esmActiveAgentId = "";
      },
      publishRoleEvent: (event) => {
        const shared = fromAgentEvent(event);
        queue.push({
          eventType: "agent_event",
          payload: {
            ...shared.payload,
            agentEvent: serializeAgentEvent(event),
          },
        });
      },
      publishMessage: (message) => {
        queue.push({ eventType: "esm_status", payload: { text: message } });
      },
    };
    const adapter = new AgentManagerESMAdapter(
      await this.#ensureAgentManager(),
      sink,
      this.#workDir,
      mode,
    );
    const supervisor = new Supervisor({ store, adapter, events: adapter });
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    const done = (async () => {
      try {
        let iterationRunId = runId;
        for (;;) {
          const result = await supervisor.run(
            sessionId,
            iterationRunId,
            this.#workDir,
            mode,
            controller.signal,
          );
          if (controller.signal.aborted) {
            queue.push({
              eventType: "esm_finished",
              payload: { status: "cancelled" },
              terminal: true,
            });
            return;
          }
          if (result.error !== undefined && result.error !== null) {
            const message = result.error instanceof Error
              ? result.error.message
              : String(result.error);
            queue.push({
              eventType: "esm_finished",
              payload: {
                status: "failed",
                text: `ESM continuation stopped: ${message}`,
                error: message,
              },
              terminal: true,
            });
            return;
          }
          const next = this.#esmObjective(store);
          if (next === null || !canAutoRun(next)) {
            queue.push({
              eventType: "esm_finished",
              payload: { status: "completed" },
              terminal: true,
            });
            return;
          }
          iterationRunId = `esm_${generateID()}`;
        }
      } finally {
        if (this.#esmWorker?.runId === runId) this.#esmWorker = undefined;
        queue.close();
      }
    })();
    this.#esmWorker = { runId, cancel, done };
    const events = (async function* () {
      for await (const item of queue.stream()) {
        yield {
          sessionId,
          runId,
          sequence: 0,
          eventType: item.eventType,
          payload: item.payload,
          terminal: item.terminal === true,
        };
      }
    })();
    return { runId, started: true, events };
  }

  async esmStop(): Promise<void> {
    const worker = this.#esmWorker;
    if (worker === undefined) return;
    this.#esmWorker = undefined;
    worker.cancel();
    await worker.done.catch(() => {});
  }

  // --- Transient side queries (TUI /btw) ------------------------------------

  async askTransient(
    input: Omit<CoreTransientPromptInput, "sessionId">,
  ): Promise<CoreTransientPromptResult> {
    const { runtime } = await this.#ensureRuntime();
    const providerName = input.providerName ?? this.#providerName;
    const modelID = input.modelID ?? this.#modelID;
    const created = this.#providerFactory(
      this.#settings,
      providerName,
      modelID,
      {
        requireModel: true,
      },
    );
    const registry = createRegistry(
      this.#workDir,
      runtime.sandboxMgr?.getActive(),
      // The side query must resolve its shell exactly like the session's
      // canonical run does.
      this.#settings.shellPath ?? "",
    );
    // A read-only registry keeps the side query from mutating the workspace.
    for (const tool of registry.all()) {
      if (!TRANSIENT_READ_ONLY_TOOLS.includes(tool.name())) {
        registry.remove(tool.name());
      }
    }
    // The rule/extra context is Core-owned session state.
    const extra = runtime.extraContext === ""
      ? TRANSIENT_SYSTEM_HINT
      : `${runtime.extraContext}\n\n${TRANSIENT_SYSTEM_HINT}`;
    const agent = runtime.buildTransientAgent(registry, {
      id: "btw",
      provider: created.provider,
      providerName,
      model: created.model,
      mode: "agent",
      settings: this.#settings,
      allow: loadAllow(),
      extraContext: extra,
      thinkingLevel: normalizeThinkingLevel(
        input.thinkingLevel ?? this.#thinkingLevel,
      ),
    });
    let answer = "";
    for await (const ev of agent.run(input.question)) {
      if (ev.type === EVENT_TEXT_DELTA && ev.textDelta) {
        answer += ev.textDelta;
      }
    }
    return { answer };
  }

  // --- Conversation compaction ----------------------------------------------

  async compact(): Promise<CorePromptExecution> {
    const { runtime } = await this.#ensureRuntime();
    const created = this.#providerFactory(
      this.#settings,
      this.#providerName,
      this.#modelID,
      { requireModel: true },
    );
    const runId = `compact_${generateID()}`;
    const sessionId = this.sessionId;
    // Compaction hydrates the persisted conversation onto a fresh agent; it is
    // an event-only run (no durable conversation turn) exactly like the
    // in-process compaction it replaces.
    const agent = runtime.buildAgent({
      provider: created.provider,
      providerName: this.#providerName,
      model: created.model,
      settings: this.#settings,
      allow: loadAllow(),
      mode: this.#mode,
      thinkingLevel: normalizeThinkingLevel(this.#thinkingLevel),
      extraContext: runtime.extraContext,
      ruleContent: runtime.ruleContent,
      hydrateHistory: true,
    });
    const events = (async function* () {
      if (!agent.canForceCompact()) {
        yield {
          sessionId,
          runId,
          sequence: 0,
          eventType: "run_finished",
          payload: { status: "completed", compact: "skipped" },
          terminal: true,
        };
        return;
      }
      const queue = new AsyncEventQueue<QueuedCoreEvent>();
      const compactDone = (async () => {
        try {
          const error = await agent.compact(
            createRunContext(),
            (ev) => {
              const shared = fromAgentEvent(ev);
              queue.push({
                eventType: "agent_event",
                payload: {
                  ...shared.payload,
                  agentEvent: serializeAgentEvent(ev),
                },
              });
              return true;
            },
            true,
          );
          if (error !== undefined && error !== null) {
            queue.push({
              eventType: "run_finished",
              payload: { status: "failed", error: error.message },
              terminal: true,
            });
          } else {
            queue.push({
              eventType: "run_finished",
              payload: { status: "completed", compact: "done" },
              terminal: true,
            });
          }
        } catch (error) {
          queue.push({
            eventType: "run_finished",
            payload: {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
            terminal: true,
          });
        } finally {
          queue.close();
        }
      })();
      for await (const item of queue.stream()) {
        yield {
          sessionId,
          runId,
          sequence: 0,
          eventType: item.eventType,
          payload: item.payload,
          terminal: item.terminal === true,
        };
      }
      await compactDone;
    })();
    return { runId, agentId: agent.id(), events };
  }

  async prompt(input: CorePromptInput): Promise<CorePromptExecution> {
    const { manager, runtime } = await this.#ensureRuntime();
    const sessionDir = manager.getSessionDir();
    // The Runtime ownership fence revalidates a held execution lease before
    // any side effect. Acquire this run's admission here — the run-begin
    // transaction binds it to the run — unless the caller already holds this
    // session's lease (cron and knowledge-index runs wrap the call).
    // The admission wrapper reconciles a durable Run orphaned by an earlier
    // Core process through the shared lease-first recovery path, then retries,
    // so a restart surfaces a real recovery result instead of a raw
    // recovery-required error.
    const admission = currentRuntimeLeaseBinding(sessionDir, this.sessionId) ===
        null
      ? await acquireExecutionAdmission(undefined, sessionDir, this.sessionId)
      : null;
    try {
      return await this.#promptOwned(input, manager, runtime, admission);
    } catch (error) {
      // Setup failed before a run exists: the generator never starts, so the
      // admission must be released here or the session wedges.
      admission?.release();
      throw error;
    }
  }

  async #promptOwned(
    input: CorePromptInput,
    manager: Manager,
    runtime: SessionRuntime,
    admission: RuntimeLeaseGuard | null,
  ): Promise<CorePromptExecution> {
    const created = this.#providerFactory(
      this.#settings,
      input.providerName ?? this.#providerName,
      input.modelID ?? this.#modelID,
      { requireModel: true },
    );
    const mode = input.mode ?? this.#mode;
    const thinkingLevel = input.thinkingLevel ?? this.#thinkingLevel;
    const runId = `core_${generateID()}`;
    const execution = createSessionExecutionRuntime(manager.getSessionDir());
    runtime.setExecution(execution);
    const preparedInputs = input.preparedInputs ?? [];
    const submission = preparedInputs.length > 0
      ? runtime.attachPreparedInput(
        undefined,
        input.text,
        preparedInputs as PreparedInput[],
      )
      : await runtime.acceptInput(undefined, runId, input.text, []);
    let userMessage;
    try {
      userMessage = runtime.buildUserMessage(undefined, submission);
    } catch (error) {
      runtime.discardInput(submission);
      throw error;
    }
    const descriptor = await createSessionRunDescriptor({
      sessionId: this.sessionId,
      runId,
      source: this.#source,
      model: created.model.id,
      mode,
      workDir: this.#workDir,
      text: input.text,
      userMessage,
      resourceIds: resourceIds(submission),
      startedAt: new Date(),
      // Per-session run policy travels with every canonical run record so
      // print/unattended sessions keep their decision semantics on replay.
      policy: {
        source: this.#source,
        mode,
        workDir: this.#workDir,
        approvalPolicy: this.#approvalPolicy,
        questionPolicy: this.#questionPolicy,
      },
    });
    const signal = execution.beginIntentDurable(
      undefined,
      descriptor.intent,
      descriptor.run,
      descriptor.startEvent,
    );
    const agent = runtime.buildAgent({
      provider: created.provider,
      providerName: input.providerName ?? this.#providerName,
      model: created.model,
      settings: this.#settings,
      allow: loadAllow(),
      mode,
      thinkingLevel: normalizeThinkingLevel(thinkingLevel),
      extraContext: runtime.extraContext,
      ruleContent: runtime.ruleContent,
      hydrateHistory: true,
      conversationTurnId: descriptor.turnId,
      intentId: descriptor.intent.id,
      runId,
      conversationTurn: true,
      runtimeOwnsTurnEnd: true,
    });
    execution.setAgent(agent);
    const sessionId = this.sessionId;
    const reverseRequest = this.#reverseRequest;
    const events = (async function* () {
      let terminal = false;
      let terminalState: RunState = "completed";
      try {
        for await (
          const event of agent.runWithUserMessage(userMessage, signal)
        ) {
          if (
            reverseRequest !== undefined &&
            (event.type === EVENT_TOOL_APPROVAL_REQUEST ||
              event.type === EVENT_QUESTION_REQUEST)
          ) {
            const requestId = event.type === EVENT_TOOL_APPROVAL_REQUEST
              ? event.approvalId ?? `${runId}:approval`
              : event.questionId ?? `${runId}:question`;
            const response = await reverseRequest(
              requestId,
              event.type === EVENT_TOOL_APPROVAL_REQUEST
                ? "approval.request"
                : "question.request",
              {
                sessionId,
                runId,
                approvalId: event.approvalId,
                approvalTool: event.approvalTool,
                approvalArgs: event.approvalArgs,
                questionId: event.questionId,
                questionText: event.questionText,
                questionOptions: event.questionOptions,
                questionContext: event.questionContext,
              },
            );
            if ("error" in response) {
              throw new Error(
                response.error === undefined
                  ? "Core reverse request failed"
                  : JSON.stringify(response.error),
              );
            }
            const result = response.result;
            if (event.type === EVENT_TOOL_APPROVAL_REQUEST) {
              const approved = typeof result === "boolean"
                ? result
                : typeof result === "object" && result !== null &&
                  (result as Record<string, unknown>).approved === true;
              agent.handleApprovalResponse(requestId, approved);
            } else {
              const answer = typeof result === "string"
                ? result
                : typeof result === "object" && result !== null &&
                    typeof (result as Record<string, unknown>).answer ===
                      "string"
                ? (result as Record<string, string>).answer
                : "";
              agent.handleQuestionResponse(requestId, answer);
            }
            continue;
          }
          const shared = fromAgentEvent(event);
          const payload: Record<string, unknown> = {
            ...shared.payload,
            // Canonical wire projection: the full agent event travels with the
            // flattened payload so adapters can render exact event semantics.
            agentEvent: serializeAgentEvent(event),
          };
          if (event.type === EVENT_ERROR) payload.status = "failed";
          if (shared.terminal) {
            terminal = true;
            const status = payload.status;
            terminalState = status === "cancelled" || status === "canceled"
              ? "cancelled"
              : status === "failed" || status === "error"
              ? "failed"
              : status === "timed_out"
              ? "timed_out"
              : "completed";
          }
          yield {
            sessionId,
            runId,
            sequence: 0,
            eventType: coreEventType(event.type),
            payload,
            terminal: shared.terminal,
          };
        }
        if (!terminal) {
          throw new Error("agent event stream ended without terminal event");
        }
        execution.finishWithState(runId, terminalState);
      } catch (error) {
        execution.finishWithState(runId, "failed");
        yield {
          sessionId,
          runId,
          sequence: 0,
          eventType: "run_finished",
          payload: {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
          terminal: true,
        };
      } finally {
        // The admission guards this run's side effects until it is terminal;
        // abandoning the stream releases it the same way.
        admission?.release();
      }
    })();
    return { runId, agentId: agent.id(), events };
  }

  async cancelRun(_runId: string): Promise<void> {
    await this.#ensureRuntime();
    this.#runtime?.execution?.cancel();
  }

  async close(): Promise<void> {
    const worker = this.#esmWorker;
    if (worker !== undefined) {
      this.#esmWorker = undefined;
      worker.cancel();
      await worker.done.catch(() => {});
    }
    if (this.#runtime !== undefined) await this.#runtime.shutdown();
  }
}

/** Creates the production Core Runtime dependencies backed by SessionRuntime. */
export function createProductionCoreRuntimeDependencies(
  settings: Settings,
  providerFactory: typeof createProvider = createProvider,
): CoreRuntimeDependencies {
  return {
    createSessionRuntime: (input) =>
      new ProductionCoreSessionRuntime({
        ...input,
        // The host-owned snapshot wins so a refreshed shared settings object
        // reaches every new session runtime; the closure is the fallback.
        settings: input.settings ?? settings,
        providerFactory,
      }),
    openSessionRuntime: (input) =>
      new ProductionCoreSessionRuntime({
        ...input,
        settings: input.settings ?? settings,
        providerFactory,
        openExisting: true,
      }),
  };
}

/** Creates the front-end-neutral facade over Core-owned session runtimes. */
export async function createCoreRuntimeHost(
  options: CoreRuntimeHostOptions,
): Promise<CoreRuntimeHost> {
  await Promise.resolve();
  const dependencies = options.dependencies;
  const newId = dependencies.newId ?? defaultId;
  const now = dependencies.now ?? (() => new Date());
  const sessions = new Map<string, SessionRecord>();
  let closed = false;

  // A Core that restarts inherits durable Runs that its previous process left
  // non-terminal. Convergence is lease-first, so a live owner is never
  // displaced: the startup scan skips a run whose lease is still valid and the
  // periodic sweep picks it up once that lease lapses.
  const recovery = new RecoveryCoordinator(getSessionDir(options.settings), {
    onError: (error) => {
      // A failed sweep is retried on the next tick; the host must stay usable.
      options.onRecoveryError?.(error);
    },
  });
  const recoveryStarted = recovery.start();
  void recoveryStarted.catch(() => undefined);

  const ensureOpen = () => {
    if (closed) throw new Error("core runtime host is closed");
  };

  const requireSession = (sessionId: string): SessionRecord => {
    ensureOpen();
    const session = sessions.get(sessionId);
    if (session === undefined) {
      // Persisted identity survives a Core restart; residency does not. The
      // typed error lets a client re-open this exact session and replay the
      // request, which is safe because no work was started.
      throw new CoreSessionNotResidentError(sessionId);
    }
    return session;
  };

  const notifyEventWaiters = (record: SessionRecord): void => {
    for (const resolve of record.eventWaiters) resolve();
    record.eventWaiters.clear();
  };

  const createRecord = (
    input: CoreSessionCreateInput,
    sessionId = "",
    openExisting = false,
  ): SessionRecord => {
    ensureOpen();
    const timestamp = now();
    const explicit = sessionId.trim() !== ""
      ? sessionId.trim()
      : (input.sessionId ?? "").trim();
    const resolvedId = explicit !== "" ? explicit : newId();
    const resolvedSource = (input.source ?? "").trim() !== ""
      ? (input.source as string)
      : options.source;
    const view: CoreSessionView = {
      sessionId: resolvedId,
      workDir: input.workDir,
      source: resolvedSource,
      providerName: input.providerName ?? options.providerName,
      modelID: input.modelID ?? options.modelID,
      mode: input.mode ?? "",
      thinkingLevel: input.thinkingLevel ?? "",
      capabilities: { ...(input.capabilities ?? {}) },
      approvalPolicy: (input.approvalPolicy ?? "").trim() !== ""
        ? (input.approvalPolicy as string)
        : "runtime",
      questionPolicy: (input.questionPolicy ?? "").trim() !== ""
        ? (input.questionPolicy as string)
        : "runtime",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const createRuntime = openExisting
      ? dependencies.openSessionRuntime ?? dependencies.createSessionRuntime
      : dependencies.createSessionRuntime;
    const runtime = createRuntime({
      sessionId: resolvedId,
      workDir: view.workDir,
      source: view.source,
      providerName: view.providerName,
      modelID: view.modelID,
      mode: view.mode,
      thinkingLevel: view.thinkingLevel,
      capabilities: { ...(input.capabilities ?? {}) },
      approvalPolicy: view.approvalPolicy,
      questionPolicy: view.questionPolicy,
      settings: options.settings,
      reverseRequest: options.reverseRequest,
    });
    // The runtime projects its persisted identity (work directory and
    // persisted mode) so one canonical binding reaches the session view.
    const persisted = runtime.persistedSummary?.();
    if (persisted?.workDir !== undefined && persisted.workDir.trim() !== "") {
      view.workDir = persisted.workDir;
    }
    if (
      persisted?.mode !== undefined && persisted.mode.trim() !== "" &&
      (input.mode ?? "").trim() === ""
    ) {
      view.mode = persisted.mode;
    }
    const record: SessionRecord = {
      view,
      runtime,
      events: [],
      runs: new Map(),
      activeSkills: new Map(),
      eventWaiters: new Set(),
    };
    sessions.set(resolvedId, record);
    return record;
  };

  const publish = (
    record: SessionRecord,
    run: CoreRunView,
    eventType: string,
    payload: Record<string, unknown>,
    terminal = false,
  ): CoreRuntimeEvent => {
    const event: CoreRuntimeEvent = {
      sessionId: record.view.sessionId,
      runId: run.runId,
      sequence: ++run.sequence,
      eventType,
      payload,
      terminal,
    };
    record.events.push(event);
    run.updatedAt = now();
    record.view.updatedAt = run.updatedAt;
    if (terminal && typeof payload.status === "string") {
      const status = payload.status;
      if (
        status === "completed" || status === "cancelled" ||
        status === "failed" || status === "timed_out"
      ) {
        run.status = status;
      }
    }
    notifyEventWaiters(record);
    try {
      options.eventSink?.(event);
    } catch {
      // Event delivery is transport-only and must not fail domain execution.
    }
    return event;
  };

  const consumeRuntimeEvents = async (
    record: SessionRecord,
    run: CoreRunView,
    events: AsyncIterable<CoreRuntimeEvent>,
  ): Promise<void> => {
    try {
      for await (const event of events) {
        publish(record, run, event.eventType, event.payload, event.terminal);
      }
    } catch (error) {
      publish(
        record,
        run,
        "run_finished",
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  };

  const host: CoreRuntimeHost = {
    async createSession(input) {
      await Promise.resolve();
      // Adopting an existing identity is open-or-create: one session ID maps to
      // exactly one host record even when a client rebinds to it.
      const adopted = (input.sessionId ?? "").trim();
      if (adopted !== "") {
        const existing = sessions.get(adopted);
        if (existing !== undefined) return cloneSession(existing.view);
      }
      return cloneSession(createRecord(input).view);
    },

    async openSession(input) {
      await Promise.resolve();
      const existing = sessions.get(input.sessionId);
      if (existing !== undefined) return cloneSession(existing.view);
      return cloneSession(
        createRecord({ workDir: options.workDir }, input.sessionId, true).view,
      );
    },

    async closeSession(input) {
      const record = requireSession(input.sessionId);
      await record.runtime.close();
      sessions.delete(input.sessionId);
    },

    async deleteSession(input) {
      const record = sessions.get(input.sessionId);
      if (record !== undefined) {
        await record.runtime.close();
        sessions.delete(input.sessionId);
      }
      // Deleting is Core-owned even when the session was never opened here.
      await deletePersistedSession(
        getSessionDir(options.settings),
        input.sessionId,
      );
    },

    async history(input) {
      await Promise.resolve();
      return requireSession(input.sessionId).events.map(cloneEvent);
    },

    async prompt(input: CorePromptInput) {
      const record = requireSession(input.sessionId);
      const accepted = await record.runtime.prompt(input);
      const timestamp = now();
      const run: CoreRunView = {
        sessionId: input.sessionId,
        runId: accepted.runId,
        status: "running",
        sequence: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      record.runs.set(run.runId, run);
      publish(record, run, "run_started", { text: input.text });
      if (accepted.events !== undefined) {
        void consumeRuntimeEvents(record, run, accepted.events);
      }
      return {
        sessionId: input.sessionId,
        runId: run.runId,
        status: "running",
        ...(accepted.agentId === undefined
          ? {}
          : { agentId: accepted.agentId }),
      };
    },

    async cancelRun(input) {
      const record = requireSession(input.sessionId);
      const run = record.runs.get(input.runId);
      if (run === undefined) throw new Error(`run not found: ${input.runId}`);
      await record.runtime.cancelRun(input.runId);
      run.status = "cancelled";
      publish(record, run, "run_finished", { status: run.status }, true);
      return cloneRun(run);
    },

    async getRun(input) {
      await Promise.resolve();
      const run = requireSession(input.sessionId).runs.get(input.runId);
      return run === undefined ? undefined : cloneRun(run);
    },

    async listSessions() {
      await Promise.resolve();
      ensureOpen();
      return [...sessions.values()].map((record) => cloneSession(record.view));
    },

    async listPersistedSessions(input) {
      await Promise.resolve();
      ensureOpen();
      const workDir = (input.workDir ?? "").trim() !== ""
        ? input.workDir!
        : options.workDir;
      return listPersistedSessionInfos(
        workDir,
        getSessionDir(options.settings),
      ).map((info) => ({
        sessionId: info.id,
        workDir: info.workDir,
        modTime: info.modTime,
        messageCount: info.messageCount,
        preview: info.preview,
      }));
    },

    async setSessionConfig(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      if (input.providerName !== undefined) {
        record.view.providerName = input.providerName;
      }
      if (input.modelID !== undefined) record.view.modelID = input.modelID;
      if (input.mode !== undefined) record.view.mode = input.mode;
      if (input.thinkingLevel !== undefined) {
        record.view.thinkingLevel = input.thinkingLevel;
      }
      if (input.capabilities !== undefined) {
        record.view.capabilities = { ...input.capabilities };
        record.runtime.setCapabilities?.(record.view.capabilities);
      }
      record.view.updatedAt = now();
      return cloneSession(record.view);
    },

    async setSessionSkill(input) {
      const record = requireSession(input.sessionId);
      const name = input.name.trim();
      if (name === "") throw new Error("skill name is required");
      if (input.active) record.activeSkills.set(name, true);
      else record.activeSkills.delete(name);
      if (record.runtime.setSkillActive !== undefined) {
        await record.runtime.setSkillActive({ name, active: input.active });
      }
      return sessionSkillState(record);
    },

    getSessionSkillState(input) {
      return Promise.resolve(
        sessionSkillState(requireSession(input.sessionId)),
      );
    },

    async listSessionSkills(input) {
      const record = requireSession(input.sessionId);
      return await record.runtime.listSkills?.() ?? [];
    },

    async prepareInput(input) {
      const record = requireSession(input.sessionId);
      const prepare = record.runtime.prepareInput;
      if (prepare === undefined) {
        throw new Error(
          "input preparation is not available in the Core Runtime",
        );
      }
      return await prepare.call(record.runtime, input);
    },

    async sessionCapabilities(input) {
      const record = requireSession(input.sessionId);
      return await record.runtime.capabilityView?.() ?? {};
    },

    async sessionContext(input) {
      const record = requireSession(input.sessionId);
      return await record.runtime.contextView?.() ?? {
        ruleContent: "",
        extraContext: "",
      };
    },

    async setSessionContext(input) {
      const record = requireSession(input.sessionId);
      const setContext = record.runtime.setContext;
      if (setContext === undefined) {
        throw new Error(
          "session context is not available in the Core Runtime",
        );
      }
      await setContext.call(record.runtime, input);
      return await record.runtime.contextView?.() ?? {
        ruleContent: "",
        extraContext: "",
      };
    },

    async listExperts(input) {
      const record = requireSession(input.sessionId);
      const listExperts = record.runtime.listExperts;
      if (listExperts === undefined) {
        throw new Error(
          "expert discovery is not available in the Core Runtime",
        );
      }
      return await listExperts.call(record.runtime);
    },

    async inspectExpert(input) {
      const record = requireSession(input.sessionId);
      const inspectExpert = record.runtime.inspectExpert;
      if (inspectExpert === undefined) {
        throw new Error(
          "expert discovery is not available in the Core Runtime",
        );
      }
      return await inspectExpert.call(record.runtime, input.expertId);
    },

    async expertState(input) {
      const record = requireSession(input.sessionId);
      return await record.runtime.expertState?.() ?? { expertId: "" };
    },

    async setExpert(input) {
      const record = requireSession(input.sessionId);
      const setExpert = record.runtime.setExpert;
      if (setExpert === undefined) {
        throw new Error("expert binding is not available in the Core Runtime");
      }
      await setExpert.call(record.runtime, input.expertId);
      return await record.runtime.expertState?.() ?? {
        expertId: input.expertId,
      };
    },

    async forkSession(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      // The Runtime-owned fork preserves the source identity and history; a
      // non-null expertId applies only to the child branch.
      const result = fork(getSessionDir(options.settings), {
        sourceSessionId: input.sessionId,
        requestId: `core-fork-${generateID()}`,
        titleMode: input.titleMode ?? "",
        ...(input.expertId === undefined
          ? {}
          : { expertId: input.expertId.trim() }),
      });
      // The child branch becomes a Core-owned session the client can bind.
      return cloneSession(
        createRecord({ workDir: record.view.workDir }, result.sessionId, true)
          .view,
      );
    },

    async listAgents(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      return await record.runtime.listAgents?.() ?? [];
    },

    async destroyAgent(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      const destroy = record.runtime.destroyAgent;
      if (destroy === undefined) {
        throw new Error(
          "agent management is not available in the Core Runtime",
        );
      }
      await destroy.call(record.runtime, input.agentId);
    },

    async setDelegate(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      const setDelegate = record.runtime.setDelegate;
      if (setDelegate === undefined) {
        throw new Error("delegate mode is not available in the Core Runtime");
      }
      return { enabled: await setDelegate.call(record.runtime, input.enabled) };
    },

    async delegateState(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      return {
        enabled: await record.runtime.delegateState?.() ?? false,
      };
    },

    async setSessionCapability(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      const setCapability = record.runtime.setCapability;
      if (setCapability === undefined) {
        throw new Error(
          "capability updates are not available in the Core Runtime",
        );
      }
      return await setCapability.call(record.runtime, {
        id: input.id,
        enabled: input.enabled,
      });
    },

    async esmState(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      return await record.runtime.esmState?.() ?? {
        objective: null,
        workerRunning: false,
        activeAgentId: "",
      };
    },

    async esmUpdate(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      const command = record.runtime.esmCommand;
      if (command === undefined) {
        throw new Error("ESM supervisor is not available in the Core Runtime");
      }
      return await command.call(record.runtime, {
        action: input.action,
        ...(input.objective === undefined
          ? {}
          : { objective: input.objective }),
        ...(input.guide === undefined ? {} : { guide: input.guide }),
      });
    },

    async esmContinue(input) {
      const record = requireSession(input.sessionId);
      const cont = record.runtime.esmContinue;
      if (cont === undefined) {
        throw new Error("ESM supervisor is not available in the Core Runtime");
      }
      const execution = await cont.call(record.runtime);
      if (!execution.started || execution.runId === "") {
        return { runId: execution.runId, started: false };
      }
      const timestamp = now();
      const run: CoreRunView = {
        sessionId: input.sessionId,
        runId: execution.runId,
        status: "running",
        sequence: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      record.runs.set(run.runId, run);
      publish(record, run, "run_started", { text: "" });
      if (execution.events !== undefined) {
        void consumeRuntimeEvents(record, run, execution.events);
      }
      return { runId: run.runId, started: true };
    },

    async esmStop(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      await record.runtime.esmStop?.();
    },

    async transientPrompt(input) {
      await Promise.resolve();
      const record = requireSession(input.sessionId);
      const ask = record.runtime.askTransient;
      if (ask === undefined) {
        throw new Error(
          "transient prompts are not available in the Core Runtime",
        );
      }
      return await ask.call(record.runtime, {
        question: input.question,
        ...(input.providerName === undefined
          ? {}
          : { providerName: input.providerName }),
        ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
        ...(input.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: input.thinkingLevel }),
      });
    },

    async compact(input) {
      const record = requireSession(input.sessionId);
      const runCompact = record.runtime.compact;
      if (runCompact === undefined) {
        throw new Error(
          "conversation compaction is not available in the Core Runtime",
        );
      }
      const execution = await runCompact.call(record.runtime);
      const timestamp = now();
      const run: CoreRunView = {
        sessionId: input.sessionId,
        runId: execution.runId,
        status: "running",
        sequence: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      record.runs.set(run.runId, run);
      publish(record, run, "run_started", { text: "", compact: true });
      if (execution.events !== undefined) {
        void consumeRuntimeEvents(record, run, execution.events);
      }
      return {
        sessionId: input.sessionId,
        runId: run.runId,
        status: "running" as const,
      };
    },

    async settingsDocument(input) {
      await Promise.resolve();
      return settingsDocumentFor(
        input.scope ?? "effective",
        input.workDir ?? options.workDir,
      );
    },

    async updateSettingsDocument(input) {
      await Promise.resolve();
      const workDir = input.workDir === undefined || input.workDir === ""
        ? options.workDir
        : input.workDir;
      const fresh = updateSettingsDocumentFor(
        input.scope,
        input.updates,
        workDir,
      );
      refreshSharedSettings(options.settings, fresh);
      return fresh;
    },

    async providerCatalog(input) {
      await Promise.resolve();
      return providerCatalogView(
        settingsDocumentFor("effective", input.workDir ?? options.workDir),
      );
    },

    async validateProviderModel(input) {
      await Promise.resolve();
      const settings = settingsDocumentFor(
        "effective",
        input.workDir ?? options.workDir,
      );
      // Validation mirrors the TUI editor exactly: construct the pair against
      // the effective document with the candidate defaults and rethrow the raw
      // factory cause so the dialog can render it.
      createProvider(
        {
          ...settings,
          defaultProvider: input.providerID,
          defaultModel: input.modelID,
        },
        input.providerID,
        input.modelID,
      );
    },

    async envDocument() {
      await Promise.resolve();
      return envDocumentView();
    },

    async updateEnvDocument(input) {
      await Promise.resolve();
      return updateEnvDocumentVars(input.vars);
    },

    subscribeRunEvents(sessionId, runId, cursor = 0) {
      const record = requireSession(sessionId);
      const run = record.runs.get(runId);
      if (run === undefined) throw new Error(`run not found: ${runId}`);
      return (async function* () {
        let position = cursor;
        while (true) {
          const event = record.events.find((candidate) =>
            candidate.runId === runId && candidate.sequence > position
          );
          if (event !== undefined) {
            position = event.sequence;
            yield cloneEvent(event);
            if (event.terminal) return;
            continue;
          }
          if (run.status !== "running") return;
          await new Promise<void>((resolve) =>
            record.eventWaiters.add(resolve)
          );
        }
      })();
    },

    async close() {
      if (closed) return;
      closed = true;
      // Stop the sweep before the runtimes so no scan races a shutdown.
      await recoveryStarted.catch(() => undefined);
      await recovery.stop();
      await Promise.all(
        [...sessions.values()].map((record) => record.runtime.close()),
      );
      sessions.clear();
    },
    extension: options.extension,
  };

  return host;
}
