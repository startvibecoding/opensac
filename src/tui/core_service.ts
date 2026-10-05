// The Core Client transport adapter for the TUI service port.
//
// The TUI uses this adapter as a thin client of the single shared `opensac
// core`: every service call maps to one Core JSON-RPC method and every run
// event is a canonical `CoreRuntimeEvent` projection. The adapter owns no
// session, run, or decision state and never fills policy defaults — effective
// mode and related policy stay Core-owned.

import type {
  CoreRuntimeEvent,
  CoreRunView,
  CoreSessionView,
} from "../core/runtime.ts";
import type { Settings } from "../config/settings.ts";
import { CORE_RUNTIME_METHODS } from "../core/runtime_protocol.ts";
import {
  coreResult,
  type CoreRpcId,
  type CoreRpcNotification,
  type CoreRpcRequest,
} from "../core/protocol.ts";
import {
  decisionNotFoundError,
  type TUIAgentView,
  TUIAskInput,
  TUIAskResult,
  TUIAttachmentInput,
  TUIAttachmentView,
  TUICancelInput,
  TUICapabilityView,
  TUICompactAccepted,
  type TUICoreConnectionState,
  TUIDecisionAnswer,
  TUIDecisionRequest,
  TUIEsmCommandInput,
  TUIEsmContinuation,
  TUIEsmObjectiveView,
  TUIEsmView,
  TUIExpertBundleView,
  TUIExpertStateView,
  TUIExpertSummaryView,
  TUIPreparedInput,
  TUIPrepareInput,
  TUIPromptAccepted,
  TUIPromptInput,
  TUIProviderCatalogEntry,
  TUIProviderView,
  TUIRunView,
  TUIService,
  TUIServiceError,
  TUISessionConfig,
  TUISessionContextView,
  TUISessionInput,
  TUISessionListEntry,
  TUISessionView,
  TUISettingsReadScope,
  TUISettingsView,
  TUISettingsWriteScope,
  TUISkillInput,
  TUISkillView,
  TUITranscriptMessage,
} from "./service.ts";

/** Message for service methods the shared Core does not expose yet. */
export const TUI_CAPABILITY_UNAVAILABLE =
  "TUI capability is not available in the Core Runtime";

/** The neutral Core management method behind the secret-safe settings view. */
const TUI_SETTINGS_METHOD = "manage.settings.get";

/** The event-connection surface the adapter needs from `CoreClient`. */
export interface TUICoreEventConnection {
  subscribe(sessionId: string, runId: string, cursor?: number): Promise<void>;
  replay(sessionId: string, runId: string, cursor?: number): Promise<unknown>;
  onNotification(
    listener: (notification: CoreRpcNotification) => void,
  ): () => void;
  /** Reverse requests (approval/question) issued by the Core Runtime. */
  onRequest(listener: (request: CoreRpcRequest) => void): () => void;
  /**
   * Reports that the Core dropped the socket on its own, which is what a Core
   * restart looks like from here.
   */
  onClose(listener: () => void): () => void;
  /** Sends one reverse-request response back to the Core Runtime. */
  respond(response: ReturnType<typeof coreResult>): void;
}

/** The Core Client surface the adapter needs; `CoreClient` satisfies it. */
export interface TUICoreClient {
  call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  connectEvents(): Promise<TUICoreEventConnection>;
}

/** Adapter options that only affect projection, never policy. */
export interface CoreTUIServiceOptions {
  /** Clock used when a Core view omits a valid timestamp. */
  now?: () => Date;
  /**
   * Work directory whose project settings join the effective settings
   * document. Defaults to the Core's own working directory.
   */
  workDir?: string;
}

/**
 * Creates the production `TUIService` over a Core Client connection. Callers
 * own the client lifecycle: the adapter never starts or stops the Core.
 */
export function createCoreClientTUIService(
  client: TUICoreClient,
  options: CoreTUIServiceOptions = {},
): TUIService {
  const now = options.now ?? (() => new Date());
  const workDir = options.workDir ?? "";
  const workDirParams = (): Record<string, unknown> =>
    workDir === "" ? {} : { workDir };
  const decisionListeners = new Set<(request: TUIDecisionRequest) => void>();
  const connectionListeners = new Set<
    (state: TUICoreConnectionState) => void
  >();
  // The decision bridge is this front end's one long-lived Core connection, so
  // its lifecycle is the connection state. A Core restart drops that socket,
  // and the state stays `reconnecting` until a replacement endpoint answers.
  let connectionState: TUICoreConnectionState = "connected";
  const publishConnection = (state: TUICoreConnectionState): void => {
    if (state === connectionState) return;
    connectionState = state;
    for (const listener of [...connectionListeners]) listener(state);
  };
  const pendingDecisions = new Map<
    string,
    { id: CoreRpcId; connection: TUICoreEventConnection }
  >();
  let decisionBridge: Promise<void> | undefined;

  // One shared event connection carries Core reverse requests (human
  // decisions). It is established before the first prompt so a decision can
  // never be issued while no client is listening.
  const ensureDecisionBridge = (): Promise<void> => {
    if (decisionBridge !== undefined) return decisionBridge;
    const bridge = (async () => {
      const connection = await client.connectEvents();
      // The replacement endpoint answered, so the Core is reachable again.
      publishConnection("connected");
      connection.onRequest((request) => {
        const projected = projectDecisionRequest(request);
        if (projected === undefined) return;
        if (pendingDecisions.has(projected.requestId)) return;
        pendingDecisions.set(projected.requestId, {
          id: request.id,
          connection,
        });
        for (const listener of [...decisionListeners]) listener(projected);
      });
      // A restarted Core drops this socket. Forget it so the next use re-dials
      // the replacement endpoint, and drop the pending decisions it can no
      // longer answer: the run that asked for them died with that process.
      connection.onClose(() => {
        if (decisionBridge === bridge) decisionBridge = undefined;
        pendingDecisions.clear();
        publishConnection("reconnecting");
      });
    })();
    decisionBridge = bridge;
    // A failed dial must not be cached, or every later prompt would reuse the
    // rejection and no decision could ever be received again.
    void bridge.catch(() => {
      if (decisionBridge === bridge) decisionBridge = undefined;
    });
    return bridge;
  };

  return {
    async createSession(input: TUISessionInput): Promise<TUISessionView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionCreate,
        {
          workDir: input.workDir,
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: input.approvalPolicy }),
          ...(input.questionPolicy === undefined
            ? {}
            : { questionPolicy: input.questionPolicy }),
          ...(input.providerName === undefined
            ? {}
            : { providerName: input.providerName }),
          ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: input.thinkingLevel }),
          ...(input.capabilities === undefined
            ? {}
            : { capabilities: input.capabilities }),
        },
      );
      return toSessionView(raw, now);
    },

    async openSession(
      input: { sessionId: string; workDir?: string },
    ): Promise<TUISessionView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionOpen,
        input.workDir === undefined || input.workDir === ""
          ? { sessionId: input.sessionId }
          : { sessionId: input.sessionId, workDir: input.workDir },
      );
      return toSessionView(raw, now);
    },

    async closeSession(input: { sessionId: string }): Promise<void> {
      await client.call<unknown>(CORE_RUNTIME_METHODS.sessionClose, {
        sessionId: input.sessionId,
      });
    },

    async deleteSession(input: { sessionId: string }): Promise<void> {
      await client.call<unknown>(CORE_RUNTIME_METHODS.sessionDelete, {
        sessionId: input.sessionId,
      });
    },

    async listPersistedSessions(
      input?: { workDir?: string },
    ): Promise<TUISessionListEntry[]> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionListPersisted,
        input?.workDir === undefined ? workDirParams() : {
          workDir: input.workDir,
        },
      );
      if (!Array.isArray(raw)) throw invalidView("session list");
      return raw.map((entry) => toSessionListEntry(entry, now));
    },

    async getTranscript(
      input: { sessionId: string },
    ): Promise<TUITranscriptMessage[]> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionTranscript,
        { sessionId: input.sessionId },
      );
      if (!Array.isArray(raw)) throw invalidView("session transcript");
      return raw.map(toTranscriptMessage);
    },

    async prompt(input: TUIPromptInput): Promise<TUIPromptAccepted> {
      // Awaited so the socket is listening before the Core can raise a
      // decision for this prompt. A bridge that cannot be established must not
      // fail the prompt: the run still starts and simply cannot ask.
      await ensureDecisionBridge().catch(() => undefined);
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionPrompt,
        {
          sessionId: input.sessionId,
          text: input.text,
          ...(input.providerName === undefined
            ? {}
            : { providerName: input.providerName }),
          ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: input.thinkingLevel }),
          ...(input.preparedInputs === undefined
            ? {}
            : { preparedInputs: input.preparedInputs }),
          ...(input.attachments === undefined
            ? {}
            : { attachments: input.attachments }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      );
      return toPromptAccepted(raw);
    },

    subscribeRunEvents(
      sessionId: string,
      runId: string,
      cursor = 0,
    ): AsyncIterableIterator<CoreRuntimeEvent> {
      return streamRunEvents(client, sessionId, runId, cursor);
    },

    async cancelRun(input: TUICancelInput): Promise<TUIRunView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.runCancel, {
        sessionId: input.sessionId,
        runId: input.runId,
      });
      return toRunView(raw, now);
    },

    async setSessionConfig(
      input: TUISessionConfig,
    ): Promise<TUISessionView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionConfigSet,
        {
          sessionId: input.sessionId,
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: input.thinkingLevel }),
          ...(input.providerName === undefined
            ? {}
            : { providerName: input.providerName }),
          ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
          ...(input.capabilities === undefined
            ? {}
            : { capabilities: input.capabilities }),
        },
      );
      return toSessionView(raw, now);
    },

    async setSkillActive(
      input: TUISkillInput,
    ): Promise<TUISessionView> {
      await client.call<unknown>(CORE_RUNTIME_METHODS.sessionSkillSet, {
        sessionId: input.sessionId,
        name: input.name,
        active: input.active,
      });
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionConfigGet,
        { sessionId: input.sessionId },
      );
      return toSessionView(raw, now);
    },

    async listSkills(
      input: { sessionId: string },
    ): Promise<TUISkillView[]> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionSkillsList,
        { sessionId: input.sessionId },
      );
      if (!Array.isArray(raw)) throw invalidView("skill list");
      return raw.map((entry) => {
        const object = asRecord(entry, "skill");
        return {
          name: asString(object.name, "skill"),
          source: asString(object.source, "skill"),
          description: asString(object.description, "skill"),
          active: object.active === true,
        } satisfies TUISkillView;
      });
    },

    addAttachment(_input: TUIAttachmentInput): Promise<TUIAttachmentView> {
      // Attachment intake has no Core-owned run-free path yet; staged inputs
      // go through `prepareInput` and this stays an explicit missing capability.
      return Promise.reject(new TUIServiceError(TUI_CAPABILITY_UNAVAILABLE));
    },

    async listAttachments(
      input: { sessionId: string },
    ): Promise<TUIAttachmentView[]> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.attachmentList,
        { sessionId: input.sessionId },
      );
      const object = asRecord(raw, "attachment list");
      const records = object.attachments;
      if (!Array.isArray(records)) throw invalidView("attachment list");
      return records.map((entry) => {
        const record = asRecord(entry, "attachment");
        return {
          attachmentId: asString(record.attachmentId, "attachment"),
          name: asString(record.filename, "attachment"),
          mediaType: typeof record.mediaType === "string"
            ? record.mediaType
            : "",
          size: typeof record.size === "number" ? record.size : 0,
        } satisfies TUIAttachmentView;
      });
    },

    async prepareInput(input: TUIPrepareInput): Promise<TUIPreparedInput> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.inputPrepare,
        {
          sessionId: input.sessionId,
          name: input.name,
          mediaType: input.mediaType,
          contentBase64: input.contentBase64,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        },
      );
      const object = asRecord(raw, "prepared input");
      return {
        resourceId: asString(object.resourceId, "prepared input"),
        kind: asString(object.kind, "prepared input"),
        relativePath: asString(object.relativePath, "prepared input"),
        filename: asString(object.filename, "prepared input"),
        mediaType: asString(object.mediaType, "prepared input"),
        bytes: typeof object.bytes === "number" ? object.bytes : 0,
      };
    },

    async settings(): Promise<TUISettingsView> {
      const raw = await client.call<unknown>(TUI_SETTINGS_METHOD);
      const object = asRecord(raw, "settings");
      const providersRaw = object.providers;
      if (!Array.isArray(providersRaw)) throw invalidView("settings");
      const providers = providersRaw.map((entry) => {
        const provider = asRecord(entry, "provider");
        const modelsRaw = Array.isArray(provider.models) ? provider.models : [];
        return {
          name: asString(provider.name, "provider"),
          apiKeyConfigured: provider.apiKeyConfigured === true,
          modelCount: typeof provider.modelCount === "number"
            ? provider.modelCount
            : modelsRaw.length,
          models: modelsRaw.map((model) => {
            const record = asRecord(model, "model");
            return {
              id: asString(record.id, "model"),
              name: asString(record.name, "model"),
            };
          }),
        } satisfies TUIProviderView;
      });
      return {
        defaultProvider: asString(object.defaultProvider, "settings"),
        defaultModel: asString(object.defaultModel, "settings"),
        defaultMode: asString(object.defaultMode, "settings"),
        thinkingLevel: asString(object.thinkingLevel, "settings"),
        sandboxEnabled: object.sandboxEnabled === true,
        sandboxLevel: asString(object.sandboxLevel, "settings"),
        webSearchEnabled: object.webSearchEnabled === true,
        skillsDisabled: Array.isArray(object.skillsDisabled)
          ? object.skillsDisabled.filter(
            (entry): entry is string => typeof entry === "string",
          )
          : [],
        providers,
      };
    },

    async getSettings(
      input?: { scope?: TUISettingsReadScope },
    ): Promise<Settings> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.settingsGet, {
        scope: input?.scope ?? "effective",
        ...workDirParams(),
      });
      return projectSettingsDocument(raw);
    },

    async updateSettings(input: {
      scope: TUISettingsWriteScope;
      updates: Record<string, unknown>;
    }): Promise<Settings> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.settingsUpdate,
        {
          scope: input.scope,
          updates: input.updates,
          ...workDirParams(),
        },
      );
      return projectSettingsDocument(raw);
    },

    async listProviders(): Promise<TUIProviderCatalogEntry[]> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.modelCatalog,
        workDirParams(),
      );
      if (!Array.isArray(raw)) throw invalidView("provider catalog");
      return projectProviderCatalog(raw);
    },

    async validateProviderModel(input: {
      providerID: string;
      modelID: string;
    }): Promise<void> {
      // Rethrow the original Core error: the dialog renders the raw cause.
      await client.call<unknown>(
        CORE_RUNTIME_METHODS.modelValidate,
        {
          providerID: input.providerID,
          modelID: input.modelID,
          ...workDirParams(),
        },
      );
    },

    async listEnv(): Promise<Record<string, string>> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.envList);
      return projectEnvDocument(raw);
    },

    async updateEnv(
      input: { vars: Record<string, string> },
    ): Promise<Record<string, string>> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.envUpdate, {
        vars: input.vars,
      });
      return projectEnvDocument(raw);
    },

    async getSessionContext(
      input: { sessionId: string },
    ): Promise<TUISessionContextView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionContextGet,
        { sessionId: input.sessionId },
      );
      return projectSessionContext(raw);
    },

    async setSessionContext(input: {
      sessionId: string;
      ruleContent?: string;
      extraContext?: string;
    }): Promise<TUISessionContextView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionContextSet,
        {
          sessionId: input.sessionId,
          ...(input.ruleContent === undefined
            ? {}
            : { ruleContent: input.ruleContent }),
          ...(input.extraContext === undefined
            ? {}
            : { extraContext: input.extraContext }),
        },
      );
      return projectSessionContext(raw);
    },

    async listExperts(
      input: { sessionId: string },
    ): Promise<TUIExpertSummaryView[]> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.expertList, {
        sessionId: input.sessionId,
      });
      if (!Array.isArray(raw)) throw invalidView("expert list");
      return raw.map((entry) => {
        const object = asRecord(entry, "expert summary");
        const displayName = asRecord(object.displayName, "expert summary");
        return {
          name: asString(object.name, "expert summary"),
          displayName: {
            zh: asString(displayName.zh, "expert summary"),
            en: asString(displayName.en, "expert summary"),
          },
          expertType: asString(object.expertType, "expert summary"),
          source: asString(object.source, "expert summary"),
          invalid: object.invalid === true,
          invalidReason: asString(object.invalidReason, "expert summary"),
        } satisfies TUIExpertSummaryView;
      });
    },

    async showExpert(
      input: { sessionId: string; expertId: string },
    ): Promise<TUIExpertBundleView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.expertShow, {
        sessionId: input.sessionId,
        expertId: input.expertId,
      });
      return projectExpertBundle(raw);
    },

    async expertState(
      input: { sessionId: string },
    ): Promise<TUIExpertStateView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.expertState, {
        sessionId: input.sessionId,
      });
      const object = asRecord(raw, "expert state");
      return { expertId: asString(object.expertId, "expert state") };
    },

    async setExpert(input: {
      sessionId: string;
      expertId: string;
    }): Promise<TUIExpertStateView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.expertSet, {
        sessionId: input.sessionId,
        expertId: input.expertId,
      });
      const object = asRecord(raw, "expert state");
      return { expertId: asString(object.expertId, "expert state") };
    },

    async forkSession(input: {
      sessionId: string;
      expertId?: string;
      titleMode?: string;
    }): Promise<TUISessionView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.sessionFork, {
        sessionId: input.sessionId,
        ...(input.expertId === undefined ? {} : { expertId: input.expertId }),
        ...(input.titleMode === undefined
          ? {}
          : { titleMode: input.titleMode }),
      });
      return toSessionView(raw, now);
    },

    async capabilities(
      input: { sessionId: string },
    ): Promise<TUICapabilityView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionCapabilities,
        { sessionId: input.sessionId },
      );
      return projectCapabilities(raw);
    },

    async listAgents(
      input: { sessionId: string },
    ): Promise<TUIAgentView[]> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.agentList, {
        sessionId: input.sessionId,
      });
      if (!Array.isArray(raw)) throw invalidView("agent list");
      return raw.map((entry) => {
        const object = asRecord(entry, "agent");
        const children = object.children;
        if (!Array.isArray(children)) throw invalidView("agent");
        return {
          id: asString(object.id, "agent"),
          parent: asString(object.parent, "agent"),
          children: children.map((child) => asString(child, "agent")),
          state: asString(object.state, "agent"),
        } satisfies TUIAgentView;
      });
    },

    async destroyAgent(input: {
      sessionId: string;
      agentId: string;
    }): Promise<void> {
      await client.call<unknown>(CORE_RUNTIME_METHODS.agentDestroy, {
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
    },

    async setDelegate(input: {
      sessionId: string;
      enabled: boolean;
    }): Promise<{ enabled: boolean }> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.delegateSet,
        { sessionId: input.sessionId, enabled: input.enabled },
      );
      const object = asRecord(raw, "delegate state");
      return { enabled: object.enabled === true };
    },

    async delegateState(
      input: { sessionId: string },
    ): Promise<{ enabled: boolean }> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.delegateGet,
        { sessionId: input.sessionId },
      );
      const object = asRecord(raw, "delegate state");
      return { enabled: object.enabled === true };
    },

    async setCapability(input: {
      sessionId: string;
      id: string;
      enabled: boolean;
    }): Promise<TUICapabilityView> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.capabilitySet,
        {
          sessionId: input.sessionId,
          id: input.id,
          enabled: input.enabled,
        },
      );
      return projectCapabilities(raw);
    },

    async esmState(
      input: { sessionId: string },
    ): Promise<TUIEsmView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.esmState, {
        sessionId: input.sessionId,
      });
      return projectEsmView(raw);
    },

    async esmCommand(input: TUIEsmCommandInput): Promise<TUIEsmView> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.esmUpdate, {
        sessionId: input.sessionId,
        action: input.action,
        ...(input.objective === undefined
          ? {}
          : { objective: input.objective }),
        ...(input.guide === undefined ? {} : { guide: input.guide }),
      });
      return projectEsmView(raw);
    },

    async esmContinue(
      input: { sessionId: string },
    ): Promise<TUIEsmContinuation> {
      const raw = await client.call<unknown>(CORE_RUNTIME_METHODS.esmContinue, {
        sessionId: input.sessionId,
      });
      const object = asRecord(raw, "esm continuation");
      return {
        runId: asString(object.runId, "esm continuation"),
        started: object.started === true,
      };
    },

    async esmStop(input: { sessionId: string }): Promise<void> {
      await client.call<unknown>(CORE_RUNTIME_METHODS.esmStop, {
        sessionId: input.sessionId,
      });
    },

    async askTransient(input: TUIAskInput): Promise<TUIAskResult> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.transientPrompt,
        {
          sessionId: input.sessionId,
          question: input.question,
          ...(input.providerName === undefined
            ? {}
            : { providerName: input.providerName }),
          ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
          ...(input.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: input.thinkingLevel }),
        },
      );
      const object = asRecord(raw, "transient answer");
      return { answer: asString(object.answer, "transient answer") };
    },

    async compact(
      input: { sessionId: string },
    ): Promise<TUICompactAccepted> {
      const raw = await client.call<unknown>(
        CORE_RUNTIME_METHODS.sessionCompact,
        { sessionId: input.sessionId },
      );
      const object = asRecord(raw, "compact run");
      return {
        sessionId: asString(object.sessionId, "compact run"),
        runId: asString(object.runId, "compact run"),
        status: "running",
      };
    },

    onDecisionRequest(
      listener: (request: TUIDecisionRequest) => void,
    ): () => void {
      decisionListeners.add(listener);
      void ensureDecisionBridge().catch(() => undefined);
      return () => decisionListeners.delete(listener);
    },

    onConnectionState(
      listener: (state: TUICoreConnectionState) => void,
    ): () => void {
      connectionListeners.add(listener);
      // A subscriber that arrives mid-outage must see the outage, not the
      // initial state it would otherwise assume.
      listener(connectionState);
      // Make sure the connection is actually being watched: the bridge is also
      // what notices a Core that goes away.
      void ensureDecisionBridge().catch(() => undefined);
      return () => connectionListeners.delete(listener);
    },

    async answerDecision(input: TUIDecisionAnswer): Promise<void> {
      const pending = pendingDecisions.get(input.requestId);
      if (pending === undefined) {
        throw decisionNotFoundError(input.requestId);
      }
      pendingDecisions.delete(input.requestId);
      pending.connection.respond(coreResult(
        pending.id,
        input.kind === "approval"
          ? { approved: input.approved === true }
          : { answer: input.answer ?? "" },
      ));
      await Promise.resolve();
    },
  };
}

/** Projects one Core reverse request onto the decision vocabulary. */
function projectDecisionRequest(
  request: CoreRpcRequest,
): TUIDecisionRequest | undefined {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const sessionId = typeof params.sessionId === "string"
    ? params.sessionId
    : "";
  const runId = typeof params.runId === "string" ? params.runId : "";
  if (request.method === "approval.request") {
    const requestId = typeof params.approvalId === "string"
      ? params.approvalId
      : `${runId}:approval`;
    return {
      requestId,
      sessionId,
      runId,
      kind: "approval",
      toolName: typeof params.approvalTool === "string"
        ? params.approvalTool
        : "",
      ...(isRecord(params.approvalArgs) ? { args: params.approvalArgs } : {}),
    };
  }
  if (request.method === "question.request") {
    const requestId = typeof params.questionId === "string"
      ? params.questionId
      : `${runId}:question`;
    const options = Array.isArray(params.questionOptions)
      ? params.questionOptions.filter((entry): entry is string =>
        typeof entry === "string"
      )
      : undefined;
    return {
      requestId,
      sessionId,
      runId,
      kind: "question",
      question: typeof params.questionText === "string"
        ? params.questionText
        : "",
      ...(options === undefined ? {} : { options }),
      ...(typeof params.questionContext === "string"
        ? { context: params.questionContext }
        : {}),
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Streams one run's canonical events: replay from the cursor first, then live
 * `run.event` notifications in arrival order, de-duplicated by sequence and
 * finished after a terminal event.
 */
async function* streamRunEvents(
  client: TUICoreClient,
  sessionId: string,
  runId: string,
  cursor: number,
): AsyncGenerator<CoreRuntimeEvent> {
  const connection = await client.connectEvents();
  const buffered: CoreRuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  const stopListening = connection.onNotification((notification) => {
    if (notification.method !== "run.event") return;
    const event = notification.params as unknown as CoreRuntimeEvent;
    if (event.sessionId !== sessionId || event.runId !== runId) return;
    buffered.push(event);
    wake?.();
  });
  // A Core that restarts drops this socket, and the run it was streaming died
  // with that process. Nothing will ever arrive on it again, so the stream has
  // to end rather than wait for a notification that cannot come.
  let dropped = false;
  const stopWatchingClose = connection.onClose(() => {
    dropped = true;
    wake?.();
  });
  try {
    await connection.subscribe(sessionId, runId, cursor);
    const replayed = toEventList(
      await connection.replay(sessionId, runId, cursor),
    );

    let lastSequence = cursor;
    for (const event of replayed) {
      if (event.sequence <= lastSequence) continue;
      lastSequence = event.sequence;
      yield event;
      if (event.terminal) return;
    }

    let index = 0;
    while (true) {
      while (index < buffered.length) {
        const event = buffered[index++];
        if (event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        yield event;
        if (event.terminal) return;
      }
      if (dropped) throw runEventStreamClosed(runId);
      await new Promise<void>((resolve) => {
        wake = resolve;
        // Re-check after registering to close the notify/await race.
        if (index < buffered.length) {
          wake = undefined;
          resolve();
        }
      });
      wake = undefined;
    }
  } finally {
    wake = undefined;
    stopListening();
    stopWatchingClose();
  }
}

/** The Core closed a run's event stream, which a restart is the only cause of. */
function runEventStreamClosed(runId: string): TUIServiceError {
  return new TUIServiceError(
    `the Core closed the event stream for run ${runId}; it most likely restarted`,
  );
}

/** Projects one persisted session listing row. */
function toTranscriptMessage(raw: unknown): TUITranscriptMessage {
  const object = asRecord(raw, "transcript message");
  const role = asString(object.role, "transcript message role");
  // The transport is untrusted, so an unknown role is a broken projection
  // rather than something to render verbatim.
  if (role !== "user" && role !== "assistant") {
    throw new Error(`invalid transcript message role: ${role}`);
  }
  return { role, text: asString(object.text, "transcript message text") };
}

function toSessionListEntry(
  raw: unknown,
  now: () => Date,
): TUISessionListEntry {
  const object = asRecord(raw, "session list entry");
  return {
    sessionId: asString(object.sessionId, "session list entry"),
    workDir: asString(object.workDir, "session list entry"),
    modTime: asDate(object.modTime, now),
    messageCount: asNumber(object.messageCount, "session list entry"),
    preview: asString(object.preview, "session list entry"),
  };
}

function toSessionView(
  raw: unknown,
  now: () => Date,
): TUISessionView {
  const object = asRecord(raw, "session");
  const capabilitiesRaw = object.capabilities ?? {};
  const capabilitiesRecord = asRecord(capabilitiesRaw, "session");
  const capabilities: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(capabilitiesRecord)) {
    if (typeof value !== "boolean") {
      throw invalidView("session");
    }
    capabilities[key] = value;
  }
  const view: CoreSessionView = {
    sessionId: asString(object.sessionId, "session"),
    workDir: asString(object.workDir, "session"),
    source: asString(object.source, "session"),
    providerName: asString(object.providerName, "session"),
    modelID: asString(object.modelID, "session"),
    mode: asString(object.mode, "session"),
    thinkingLevel: asString(object.thinkingLevel, "session"),
    capabilities,
    approvalPolicy: typeof object.approvalPolicy === "string"
      ? object.approvalPolicy
      : "runtime",
    questionPolicy: typeof object.questionPolicy === "string"
      ? object.questionPolicy
      : "runtime",
    createdAt: asDate(object.createdAt, now),
    updatedAt: asDate(object.updatedAt, now),
  };
  return view;
}

function toPromptAccepted(raw: unknown): TUIPromptAccepted {
  const object = asRecord(raw, "prompt");
  const status = object.status;
  if (status !== "running") throw invalidView("prompt");
  return {
    sessionId: asString(object.sessionId, "prompt"),
    runId: asString(object.runId, "prompt"),
    status: "running",
    ...(typeof object.agentId === "string" && object.agentId !== ""
      ? { agentId: object.agentId }
      : {}),
  };
}

function toRunView(raw: unknown, now: () => Date): TUIRunView {
  const object = asRecord(raw, "run");
  const status = object.status;
  if (
    status !== "running" && status !== "completed" && status !== "cancelled" &&
    status !== "failed" && status !== "timed_out"
  ) {
    throw invalidView("run");
  }
  const view: CoreRunView = {
    sessionId: asString(object.sessionId, "run"),
    runId: asString(object.runId, "run"),
    status,
    sequence: typeof object.sequence === "number" ? object.sequence : 0,
    startedAt: asDate(object.startedAt, now),
    updatedAt: asDate(object.updatedAt, now),
  };
  if (typeof object.error === "string") view.error = object.error;
  return view;
}

function toEventList(raw: unknown): CoreRuntimeEvent[] {
  if (!Array.isArray(raw)) throw invalidView("event replay");
  return raw.map((entry) => entry as CoreRuntimeEvent);
}

/** Projects one settings document without rewriting its fields. */
function projectSettingsDocument(raw: unknown): Settings {
  return asRecord(raw, "settings document") as Settings;
}

/** Projects the built-in-plus-configured provider catalog. */
function projectProviderCatalog(raw: unknown[]): TUIProviderCatalogEntry[] {
  return raw.map((entry) => {
    const object = asRecord(entry, "provider catalog entry");
    const modelsRaw = Array.isArray(object.models) ? object.models : [];
    return {
      id: asString(object.id, "provider catalog entry"),
      configured: object.configured === true,
      isDefault: object.isDefault === true,
      api: asString(object.api, "provider catalog entry"),
      baseUrl: asString(object.baseUrl, "provider catalog entry"),
      modelCount: typeof object.modelCount === "number"
        ? object.modelCount
        : modelsRaw.length,
      models: modelsRaw.map((model) => {
        const record = asRecord(model, "model");
        return {
          id: asString(record.id, "model"),
          name: asString(record.name, "model"),
        };
      }),
    } satisfies TUIProviderCatalogEntry;
  });
}

/** Projects the environment-variable document (values round-trip as-is). */
function projectEnvDocument(raw: unknown): Record<string, string> {
  const object = asRecord(raw, "env document");
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(object)) {
    vars[name] = asString(value, "env document");
  }
  return vars;
}

/** Projects one session rule/extra context view. */
function projectSessionContext(raw: unknown): TUISessionContextView {
  const object = asRecord(raw, "session context");
  return {
    ruleContent: asString(object.ruleContent, "session context"),
    extraContext: asString(object.extraContext, "session context"),
  };
}

/** Projects one capability-discovery view. */
function projectCapabilities(raw: unknown): TUICapabilityView {
  const record = asRecord(raw, "capabilities");
  const view: TUICapabilityView = {};
  for (const [name, value] of Object.entries(record)) {
    const entry = asRecord(value, "capability");
    view[name] = {
      enabled: entry.enabled === true,
      available: entry.available === true,
    };
  }
  return view;
}

/** Projects one ESM supervisor view. */
function projectEsmView(raw: unknown): TUIEsmView {
  const object = asRecord(raw, "esm view");
  const objective = object.objective;
  return {
    objective: objective === null || objective === undefined
      ? null
      : projectEsmObjective(objective),
    workerRunning: object.workerRunning === true,
    activeAgentId: asString(object.activeAgentId, "esm view"),
  };
}

/** Projects one JSON-safe ESM objective row. */
function projectEsmObjective(raw: unknown): TUIEsmObjectiveView {
  const object = asRecord(raw, "esm objective");
  const remainingWork = object.remainingWork;
  if (!Array.isArray(remainingWork)) throw invalidView("esm objective");
  return {
    sessionId: asString(object.sessionId, "esm objective"),
    esmId: asString(object.esmId, "esm objective"),
    objective: asString(object.objective, "esm objective"),
    status: asString(object.status, "esm objective"),
    tokensUsed: asNumber(object.tokensUsed, "esm objective"),
    timeUsedMs: asNumber(object.timeUsedMs, "esm objective"),
    blockedCount: asNumber(object.blockedCount, "esm objective"),
    blockedReason: asString(object.blockedReason, "esm objective"),
    blockedRunId: asString(object.blockedRunId, "esm objective"),
    completionReason: asString(object.completionReason, "esm objective"),
    completionRunId: asString(object.completionRunId, "esm objective"),
    completionReview: asString(object.completionReview, "esm objective"),
    phase: asString(object.phase, "esm objective"),
    progressSummary: asString(object.progressSummary, "esm objective"),
    remainingWork: remainingWork.map((entry) =>
      asString(entry, "esm objective")
    ),
    rejectionCount: asNumber(object.rejectionCount, "esm objective"),
    rejectionRunId: asString(object.rejectionRunId, "esm objective"),
    recoveryCount: asNumber(object.recoveryCount, "esm objective"),
    recoveryReason: asString(object.recoveryReason, "esm objective"),
    createdAt: asString(object.createdAt, "esm objective"),
    updatedAt: asString(object.updatedAt, "esm objective"),
  };
}

/** Validates one finite number field of a projected view. */
function asNumber(value: unknown, kind: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidView(kind);
  }
  return value;
}

/** Projects one expert bundle details view. */
function projectExpertBundle(raw: unknown): TUIExpertBundleView {
  const object = asRecord(raw, "expert bundle");
  const displayName = asRecord(object.displayName, "expert bundle");
  const membersRaw = Array.isArray(object.members) ? object.members : [];
  return {
    name: asString(object.name, "expert bundle"),
    displayName: {
      zh: asString(displayName.zh, "expert bundle"),
      en: asString(displayName.en, "expert bundle"),
    },
    expertType: asString(object.expertType, "expert bundle"),
    invalid: object.invalid === true,
    invalidReason: asString(object.invalidReason, "expert bundle"),
    members: membersRaw.map((entry) => {
      const member = asRecord(entry, "expert member");
      const name = asRecord(member.name, "expert member");
      const profession = asRecord(member.profession, "expert member");
      return {
        id: asString(member.id, "expert member"),
        name: {
          zh: asString(name.zh, "expert member"),
          en: asString(name.en, "expert member"),
        },
        profession: {
          zh: asString(profession.zh, "expert member"),
          en: asString(profession.en, "expert member"),
        },
        role: asString(member.role, "expert member"),
      };
    }),
  };
}

function asRecord(
  value: unknown,
  kind = "response",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidView(kind);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, kind: string): string {
  if (typeof value !== "string") throw invalidView(kind);
  return value;
}

function asDate(value: unknown, now: () => Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return now();
}

function invalidView(kind: string): TUIServiceError {
  return new TUIServiceError(`Core returned an invalid ${kind} view`);
}
