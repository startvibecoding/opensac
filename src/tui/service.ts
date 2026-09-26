// The front-end-neutral TUI service port.
//
// The TUI consumes this port instead of constructing Providers, Builders,
// SessionRuntimes, AgentManagers, DecisionServices, or persistence handles.
// The production implementation is the Core Client transport adapter in
// `core_service.ts`, which makes the TUI a client of the single shared
// `opensac core`; tests use `createFakeTUIService()`. The port exposes only
// plain values, dates, and canonical `CoreRuntimeEvent` events, so every
// adapter projects the same session/run semantics.

import type {
  CoreAgentView,
  CoreEsmCommandInput,
  CoreEsmObjectiveView,
  CoreEsmView,
  CoreExpertBundleView,
  CoreExpertStateView,
  CoreExpertSummaryView,
  CorePreparedInput,
  CorePromptAccepted,
  CorePromptInput,
  CoreProviderCatalogView,
  CoreRuntimeEvent,
  CoreRunView,
  CoreSessionContextView,
  CoreSessionCreateInput,
  CoreSessionListEntry,
  CoreSessionView,
} from "../core/runtime.ts";
import type { Settings } from "../config/settings.ts";

/** Session creation input: work directory plus optional resolved policy. */
export type TUISessionInput = CoreSessionCreateInput;

/** The adapter-neutral view of a Core-owned session. */
export type TUISessionView = CoreSessionView;

/** The adapter-neutral summary of one persisted session row. */
export type TUISessionListEntry = CoreSessionListEntry;

/** Prompt input normalized for the Runtime. */
export type TUIPromptInput = CorePromptInput;

/** The admission result for a prompt. */
export type TUIPromptAccepted = CorePromptAccepted;

/** Run status projection. */
export type TUIRunView = CoreRunView;

/** Identifies the run to cancel. */
export interface TUICancelInput {
  sessionId: string;
  runId: string;
}

/** Session configuration update projected by the Core. */
export interface TUISessionConfig {
  sessionId: string;
  mode?: string;
  thinkingLevel?: string;
  providerName?: string;
  modelID?: string;
  capabilities?: Record<string, boolean>;
}

/** Skill activation request for one session. */
export interface TUISkillInput {
  sessionId: string;
  name: string;
  active: boolean;
}

/** Attachment intake request; content travels base64-encoded. */
export interface TUIAttachmentInput {
  sessionId: string;
  name: string;
  mediaType: string;
  contentBase64: string;
}

/** The Core-owned attachment identity projection. */
export interface TUIAttachmentView {
  attachmentId: string;
  name: string;
  mediaType: string;
  size: number;
}

/** The adapter-neutral projection of one Runtime-materialized input. */
export type TUIPreparedInput = CorePreparedInput;

/** Input for one prepared-input materialization request. */
export interface TUIPrepareInput {
  sessionId: string;
  name: string;
  mediaType: string;
  contentBase64: string;
  kind?: string;
}

/** The neutral projection of one discovered skill. */
export interface TUISkillView {
  name: string;
  source: string;
  description: string;
  active: boolean;
}

/** Scope of a settings document read (effective merge or global sparse). */
export type TUISettingsReadScope = "effective" | "global";

/** Scope of a settings document write (global or project settings file). */
export type TUISettingsWriteScope = "global" | "project";

/**
 * One entry of the Core-owned provider catalog. The catalog is secret-safe:
 * credential state stays behind the masked provider views.
 */
export type TUIProviderCatalogEntry = CoreProviderCatalogView;

/** The session-owned rule/extra system-prompt context. */
export type TUISessionContextView = CoreSessionContextView;

/** The neutral projection of one discoverable expert bundle. */
export type TUIExpertSummaryView = CoreExpertSummaryView;

/** The neutral projection of one expert bundle's details. */
export type TUIExpertBundleView = CoreExpertBundleView;

/** The resolved expert binding of one session. */
export type TUIExpertStateView = CoreExpertStateView;

/** The neutral projection of one managed agent (delegate/ESM sub-agent). */
export type TUIAgentView = CoreAgentView;

/** The neutral, JSON-safe projection of one ESM objective row. */
export type TUIEsmObjectiveView = CoreEsmObjectiveView;

/** The ESM supervisor projection for one session. */
export type TUIEsmView = CoreEsmView;

/** One ESM supervisor mutation request. */
export type TUIEsmCommandInput = CoreEsmCommandInput;

/** One accepted ESM continuation worker. */
export interface TUIEsmContinuation {
  runId: string;
  /** False when no new worker started (idle or already running). */
  started: boolean;
}

/** One transient side query (TUI /btw). */
export interface TUIAskInput {
  sessionId: string;
  question: string;
  /** Per-query policy overrides; empty fields fall back to session config. */
  providerName?: string;
  modelID?: string;
  thinkingLevel?: string;
}

/** The collected answer of one transient side query. */
export interface TUIAskResult {
  answer: string;
}

/** A forced conversation compaction accepted by the service. */
export interface TUICompactAccepted {
  sessionId: string;
  runId: string;
  status: "running";
}

/** One provider entry of the secret-safe settings view. */
export interface TUIProviderView {
  name: string;
  apiKeyConfigured: boolean;
  modelCount: number;
  models: Array<{ id: string; name: string }>;
}

/** The secret-safe settings projection owned by the Core. */
export interface TUISettingsView {
  defaultProvider: string;
  defaultModel: string;
  defaultMode: string;
  thinkingLevel: string;
  sandboxEnabled: boolean;
  sandboxLevel: string;
  webSearchEnabled: boolean;
  skillsDisabled: string[];
  providers: TUIProviderView[];
}

/** Capability discovery metadata keyed by capability name. */
export type TUICapabilityView = Record<
  string,
  { enabled: boolean; available: boolean }
>;

/** Stable service-level failure shared by the port and every adapter. */
export class TUIServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TUIServiceError";
  }
}

/** The stable unknown-session error produced by every adapter. */
export function sessionNotFoundError(sessionId: string): TUIServiceError {
  return new TUIServiceError(`TUI session not found: ${sessionId}`);
}

/** The stable unknown-run error produced by every adapter. */
export function runNotFoundError(
  sessionId: string,
  runId: string,
): TUIServiceError {
  return new TUIServiceError(
    `TUI run not found: ${sessionId}/${runId}`,
  );
}

/** The decision vocabulary shared by every adapter (approval/question). */
export type TUIDecisionKind = "approval" | "question";

/** One Core-requested human decision surfaced to the TUI. */
export interface TUIDecisionRequest {
  requestId: string;
  sessionId: string;
  runId: string;
  kind: TUIDecisionKind;
  /** Approval fields. */
  toolName?: string;
  args?: Record<string, unknown>;
  /** Question fields. */
  question?: string;
  options?: string[];
  context?: string;
}

/** The human answer to one decision request. */
export interface TUIDecisionAnswer {
  requestId: string;
  kind: TUIDecisionKind;
  approved?: boolean;
  answer?: string;
}

/** The stable unknown-decision error produced by every adapter. */
export function decisionNotFoundError(requestId: string): TUIServiceError {
  return new TUIServiceError(`TUI decision not found: ${requestId}`);
}

/** Reports whether a failure is the stable unknown-decision error. */
export function isDecisionNotFound(error: unknown): boolean {
  return error instanceof TUIServiceError &&
    error.message.startsWith("TUI decision not found:");
}

/**
 * The TUI's view of the Core Runtime. Every method is a projection of shared
 * Runtime semantics: implementations translate transports and render results,
 * they never own session, run, or decision state.
 */
export interface TUIService {
  createSession(input: TUISessionInput): Promise<TUISessionView>;
  openSession(input: { sessionId: string }): Promise<TUISessionView>;
  closeSession(input: { sessionId: string }): Promise<void>;
  deleteSession(input: { sessionId: string }): Promise<void>;
  /** Lists the persisted sessions of one working directory. */
  listPersistedSessions(
    input?: { workDir?: string },
  ): Promise<TUISessionListEntry[]>;
  prompt(input: TUIPromptInput): Promise<TUIPromptAccepted>;
  subscribeRunEvents(
    sessionId: string,
    runId: string,
    cursor?: number,
  ): AsyncIterableIterator<CoreRuntimeEvent>;
  cancelRun(input: TUICancelInput): Promise<TUIRunView>;
  setSessionConfig(input: TUISessionConfig): Promise<TUISessionView>;
  setSkillActive(input: TUISkillInput): Promise<TUISessionView>;
  /** Projects the discovered skill index for one session. */
  listSkills(input: { sessionId: string }): Promise<TUISkillView[]>;
  addAttachment(input: TUIAttachmentInput): Promise<TUIAttachmentView>;
  /** Lists the session's stored attachments (Core-owned projections). */
  listAttachments(
    input: { sessionId: string },
  ): Promise<TUIAttachmentView[]>;
  /** Materializes one input resource before a run exists. */
  prepareInput(input: TUIPrepareInput): Promise<TUIPreparedInput>;
  /** The secret-safe settings/provider/model projection. */
  settings(): Promise<TUISettingsView>;
  /**
   * Reads one settings document for editor round-trips. `"effective"` merges
   * global and project settings; `"global"` returns only the fields explicitly
   * present in the global settings file.
   */
  getSettings(input?: {
    scope?: TUISettingsReadScope;
  }): Promise<Settings>;
  /**
   * Applies one sparse settings patch (global or project scope) through the
   * Core so its runtime settings refresh with the on-disk files; returns the
   * fresh effective document.
   */
  updateSettings(input: {
    scope: TUISettingsWriteScope;
    updates: Record<string, unknown>;
  }): Promise<Settings>;
  /** Projects the built-in-plus-configured provider catalog. */
  listProviders(): Promise<TUIProviderCatalogEntry[]>;
  /** Validates one provider/model pair; rejects with the raw cause. */
  validateProviderModel(input: {
    providerID: string;
    modelID: string;
  }): Promise<void>;
  /** Reads the environment-variable document. */
  listEnv(): Promise<Record<string, string>>;
  /** Replaces the environment-variable document. */
  updateEnv(
    input: { vars: Record<string, string> },
  ): Promise<Record<string, string>>;
  /** Projects one session's rule/extra system-prompt context. */
  getSessionContext(
    input: { sessionId: string },
  ): Promise<TUISessionContextView>;
  /** Updates one session's rule/extra system-prompt context. */
  setSessionContext(input: {
    sessionId: string;
    ruleContent?: string;
    extraContext?: string;
  }): Promise<TUISessionContextView>;
  /** Projects the discoverable expert bundles of one session. */
  listExperts(
    input: { sessionId: string },
  ): Promise<TUIExpertSummaryView[]>;
  /** Resolves one expert bundle for display. */
  showExpert(
    input: { sessionId: string; expertId: string },
  ): Promise<TUIExpertBundleView>;
  /** Projects one session's resolved expert binding. */
  expertState(input: { sessionId: string }): Promise<TUIExpertStateView>;
  /** Binds or unbinds one session's expert (empty id unbinds). */
  setExpert(input: {
    sessionId: string;
    expertId: string;
  }): Promise<TUIExpertStateView>;
  /**
   * Forks one session's history into a child branch. A non-null `expertId`
   * applies the expert binding only to the child (empty string unbinds it).
   */
  forkSession(input: {
    sessionId: string;
    expertId?: string;
    titleMode?: string;
  }): Promise<TUISessionView>;
  /** Projects the managed agent registry (delegate/ESM sub-agents). */
  listAgents(input: { sessionId: string }): Promise<TUIAgentView[]>;
  /** Destroys one managed agent and its children. */
  destroyAgent(input: { sessionId: string; agentId: string }): Promise<void>;
  /** Enables/disables the blocking delegate tool; returns the effective state. */
  setDelegate(
    input: { sessionId: string; enabled: boolean },
  ): Promise<{ enabled: boolean }>;
  /** Projects the blocking delegate tool state. */
  delegateState(
    input: { sessionId: string },
  ): Promise<{ enabled: boolean }>;
  /** Enables/disables one named capability option (for example `browser`). */
  setCapability(input: {
    sessionId: string;
    id: string;
    enabled: boolean;
  }): Promise<TUICapabilityView>;
  /** Projects the ESM supervisor state. */
  esmState(input: { sessionId: string }): Promise<TUIEsmView>;
  /** Applies one ESM supervisor mutation and re-projects the state. */
  esmCommand(input: TUIEsmCommandInput): Promise<TUIEsmView>;
  /** Starts (or reports) the ESM continuation worker of one session. */
  esmContinue(
    input: { sessionId: string },
  ): Promise<TUIEsmContinuation>;
  /** Stops the running ESM continuation worker of one session. */
  esmStop(input: { sessionId: string }): Promise<void>;
  /** Runs one transient side query over a read-only tool registry. */
  askTransient(input: TUIAskInput): Promise<TUIAskResult>;
  /** Runs one forced conversation compaction as a canonical run. */
  compact(input: { sessionId: string }): Promise<TUICompactAccepted>;
  capabilities(input: { sessionId: string }): Promise<TUICapabilityView>;
  /**
   * Subscribes to Core-requested human decisions (approvals and questions).
   * The listener returns an unsubscribe function; requests carry their
   * canonical request ID so answers correlate to the originating Core request.
   */
  onDecisionRequest(
    listener: (request: TUIDecisionRequest) => void,
  ): () => void;
  /** Answers one pending decision; the first response wins. */
  answerDecision(input: TUIDecisionAnswer): Promise<void>;
}

/** The deterministic in-memory service used by TUI tests. */
export interface FakeTUIService extends TUIService {
  /**
   * Test-only: appends one canonical event to a run's stream with a
   * monotonically increasing sequence value, creating the run when needed.
   */
  emit(
    sessionId: string,
    runId: string,
    eventType: string,
    payload?: Record<string, unknown>,
    terminal?: boolean,
  ): CoreRuntimeEvent;
  /** Test-only: issues one decision request and tracks it as pending. */
  requestDecision(input: {
    sessionId: string;
    runId: string;
    requestId: string;
    kind: TUIDecisionKind;
    toolName?: string;
    args?: Record<string, unknown>;
    question?: string;
    options?: string[];
    context?: string;
  }): TUIDecisionRequest;
  /** Test-only: registers one managed agent in the fake registry. */
  addAgent(input: {
    sessionId: string;
    id: string;
    parent?: string;
  }): TUIAgentView;
  /** Test-only: the answer returned by `askTransient`. */
  transientAnswer: string;
}

const BASE_TIME_MS = 1_700_000_000_000;

interface FakeSession {
  view: TUISessionView;
  skills: Map<string, boolean>;
  attachments: TUIAttachmentView[];
  prepared: TUIPreparedInput[];
  context: TUISessionContextView;
  expertId: string;
  closed: boolean;
  agents: Map<string, TUIAgentView>;
  delegateEnabled: boolean;
  esmObjective: TUIEsmObjectiveView | null;
  esmWorkerRunning: boolean;
  esmActiveAgentId: string;
  messageCount: number;
  preview: string;
}

interface FakeRun {
  sessionId: string;
  runId: string;
  status: TUIRunView["status"];
  error?: string;
  startedAt: Date;
  updatedAt: Date;
  events: CoreRuntimeEvent[];
  waiters: Set<() => void>;
}

/**
 * Creates a deterministic `TUIService` double for TUI tests. It owns no
 * filesystem, database, provider, Agent, or Runtime implementation: sessions,
 * runs, and events live in memory with stable IDs (`session-1`, `run-1`) and
 * stable timestamps.
 */
export function createFakeTUIService(): FakeTUIService {
  const sessions = new Map<string, FakeSession>();
  const runs = new Map<string, FakeRun>();
  const decisions = new Map<string, TUIDecisionRequest>();
  const decisionListeners = new Set<
    (request: TUIDecisionRequest) => void
  >();
  let sessionCount = 0;
  let runCount = 0;
  let attachmentCount = 0;
  let resourceCount = 0;
  let tick = 0;
  const skillCatalog: Array<
    { name: string; source: string; description: string }
  > = [
    { name: "demo", source: "project", description: "Demo skill" },
  ];
  let settingsDoc: Settings = {
    defaultProvider: "test-provider",
    defaultModel: "test-model",
    defaultMode: "yolo",
    providers: {},
  };
  let envVars: Record<string, string> = {};
  const providerCatalog: TUIProviderCatalogEntry[] = [{
    id: "test-provider",
    configured: true,
    isDefault: true,
    api: "openai-chat",
    baseUrl: "https://example.invalid",
    modelCount: 1,
    models: [{ id: "test-model", name: "Test Model" }],
  }];
  let transientAnswerValue = "stub answer";
  const expertCatalog: TUIExpertSummaryView[] = [{
    name: "demo-expert",
    displayName: { zh: "演示专家", en: "Demo Expert" },
    expertType: "agent",
    source: "builtin",
    invalid: false,
    invalidReason: "",
  }];

  const now = (): Date => new Date(BASE_TIME_MS + tick++);
  const runKey = (sessionId: string, runId: string): string =>
    `${sessionId}\u0000${runId}`;

  const requireSession = (sessionId: string): FakeSession => {
    const session = sessions.get(sessionId);
    if (session === undefined || session.closed) {
      throw sessionNotFoundError(sessionId);
    }
    return session;
  };

  const rejectUnknownSession = (
    sessionId: string,
  ): Promise<never> | undefined => {
    const session = sessions.get(sessionId);
    if (session !== undefined && !session.closed) return undefined;
    return Promise.reject(sessionNotFoundError(sessionId));
  };

  // Runs one session-scoped projection, rejecting (never throwing
  // synchronously) with the port's stable unknown-session error.
  const withSession = <T>(
    sessionId: string,
    project: (session: FakeSession) => T,
  ): Promise<T> => {
    const rejection = rejectUnknownSession(sessionId);
    if (rejection !== undefined) return rejection;
    try {
      return Promise.resolve(project(requireSession(sessionId)));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const requireRun = (sessionId: string, runId: string): FakeRun => {
    const run = runs.get(runKey(sessionId, runId));
    if (run === undefined) throw runNotFoundError(sessionId, runId);
    return run;
  };

  const appendEvent = (
    run: FakeRun,
    eventType: string,
    payload: Record<string, unknown>,
    terminal: boolean,
  ): CoreRuntimeEvent => {
    const event: CoreRuntimeEvent = {
      sessionId: run.sessionId,
      runId: run.runId,
      sequence: run.events.length + 1,
      eventType,
      payload,
      terminal,
    };
    run.events.push(event);
    if (terminal) {
      if (run.status === "running") {
        run.status = String(
          payload.status ?? "completed",
        ) as TUIRunView["status"];
        run.updatedAt = now();
      }
      // Mirror the canonical run store: the run view carries the recorded
      // failure reason, not only the transient event payload.
      if (run.error === undefined && typeof payload.error === "string") {
        run.error = payload.error;
      }
    }
    for (const waiter of [...run.waiters]) waiter();
    return event;
  };

  const subscribeRunEvents = (
    sessionId: string,
    runId: string,
    cursor = 0,
  ): AsyncIterableIterator<CoreRuntimeEvent> => {
    // Reject unknown sessions consistently with the other session methods.
    const run = runs.get(runKey(sessionId, runId));
    if (run === undefined) {
      throw runNotFoundError(sessionId, runId);
    }
    let index = run.events.findIndex((event) => event.sequence > cursor);
    if (index < 0) index = run.events.length;
    let done = false;
    const next = async (): Promise<IteratorResult<CoreRuntimeEvent>> => {
      if (done) return { done: true, value: undefined };
      while (true) {
        if (index < run.events.length) {
          const event = run.events[index++];
          if (event.terminal) done = true;
          return { done: false, value: event };
        }
        // A terminal event already completed the stream: nothing else can
        // arrive, so a cursor at (or beyond) the end completes immediately.
        if (run.events.at(-1)?.terminal === true) {
          done = true;
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => {
          run.waiters.add(resolve);
          // Re-check after registering to close the emit/await race.
          if (index < run.events.length) {
            run.waiters.delete(resolve);
            resolve();
          }
        });
      }
    };
    const iterator: AsyncIterableIterator<CoreRuntimeEvent> = {
      next,
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  };

  // Creates the run on first emission, then appends the canonical event.
  const emitEvent = (
    sessionId: string,
    runId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    terminal = false,
  ): CoreRuntimeEvent => {
    let run = runs.get(runKey(sessionId, runId));
    if (run === undefined) {
      runCount++;
      const startedAt = now();
      run = {
        sessionId,
        runId,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        events: [],
        waiters: new Set(),
      };
      runs.set(runKey(sessionId, runId), run);
    }
    return appendEvent(run, eventType, payload, terminal);
  };

  return {
    createSession(input: TUISessionInput): Promise<TUISessionView> {
      sessionCount++;
      const adopted = (input.sessionId ?? "").trim();
      if (adopted !== "") {
        const existing = sessions.get(adopted);
        if (existing !== undefined && !existing.closed) {
          return Promise.resolve(existing.view);
        }
      }
      const createdAt = now();
      const view: TUISessionView = {
        sessionId: adopted !== "" ? adopted : `session-${sessionCount}`,
        workDir: input.workDir,
        source: "tui",
        providerName: input.providerName ?? "",
        modelID: input.modelID ?? "",
        // Effective-mode resolution is Core-owned; the fake mirrors the
        // product default rather than letting adapters fill it in.
        mode: input.mode ?? "yolo",
        thinkingLevel: input.thinkingLevel ?? "",
        capabilities: { ...(input.capabilities ?? {}) },
        approvalPolicy: (input.approvalPolicy ?? "").trim() !== ""
          ? (input.approvalPolicy as string)
          : "runtime",
        questionPolicy: (input.questionPolicy ?? "").trim() !== ""
          ? (input.questionPolicy as string)
          : "runtime",
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(view.sessionId, {
        view,
        skills: new Map(),
        attachments: [],
        prepared: [],
        context: { ruleContent: "", extraContext: "" },
        expertId: "",
        closed: false,
        agents: new Map(),
        delegateEnabled: false,
        esmObjective: null,
        esmWorkerRunning: false,
        esmActiveAgentId: "",
        messageCount: 0,
        preview: "",
      });
      return Promise.resolve(view);
    },

    openSession(
      input: { sessionId: string },
    ): Promise<TUISessionView> {
      // Reopening a persisted session (the production host keeps the row
      // after `closeSession`) rebinds it instead of rejecting.
      const session = sessions.get(input.sessionId);
      if (session === undefined) {
        return Promise.reject(sessionNotFoundError(input.sessionId));
      }
      session.closed = false;
      return Promise.resolve(session.view);
    },

    closeSession(input: { sessionId: string }): Promise<void> {
      return withSession(input.sessionId, (session) => {
        session.closed = true;
      });
    },

    deleteSession(input: { sessionId: string }): Promise<void> {
      return withSession(input.sessionId, (session) => {
        session.closed = true;
        sessions.delete(input.sessionId);
      });
    },

    listPersistedSessions(
      input?: { workDir?: string },
    ): Promise<TUISessionListEntry[]> {
      const workDir = (input?.workDir ?? "").trim();
      const entries = [...sessions.values()]
        .filter((session) => workDir === "" || session.view.workDir === workDir)
        .map((session) => ({
          sessionId: session.view.sessionId,
          workDir: session.view.workDir,
          modTime: session.view.updatedAt,
          messageCount: session.messageCount,
          preview: session.preview,
        }));
      return Promise.resolve(entries);
    },

    prompt(input: TUIPromptInput): Promise<TUIPromptAccepted> {
      const rejection = rejectUnknownSession(input.sessionId);
      if (rejection !== undefined) return rejection;
      runCount++;
      const runId = `run-${runCount}`;
      const startedAt = now();
      const run: FakeRun = {
        sessionId: input.sessionId,
        runId,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        events: [],
        waiters: new Set(),
      };
      runs.set(runKey(input.sessionId, runId), run);
      const session = sessions.get(input.sessionId);
      if (session !== undefined) {
        session.messageCount++;
        session.preview = input.text;
      }
      appendEvent(run, "run_started", { text: input.text }, false);
      appendEvent(
        run,
        "run_finished",
        { status: "completed" },
        true,
      );
      return Promise.resolve({
        sessionId: input.sessionId,
        runId,
        status: "running",
        agentId: `agent-${runCount}`,
      });
    },

    subscribeRunEvents,

    cancelRun(input: TUICancelInput): Promise<TUIRunView> {
      const rejection = rejectUnknownSession(input.sessionId);
      if (rejection !== undefined) return rejection;
      try {
        const run = requireRun(input.sessionId, input.runId);
        if (run.status === "running") {
          appendEvent(run, "run_finished", { status: "cancelled" }, true);
        }
        return Promise.resolve(toRunView(run));
      } catch (error) {
        return Promise.reject(error);
      }
    },

    setSessionConfig(
      input: TUISessionConfig,
    ): Promise<TUISessionView> {
      return withSession(input.sessionId, (session) => {
        const view = session.view;
        if (input.mode !== undefined) view.mode = input.mode;
        if (input.thinkingLevel !== undefined) {
          view.thinkingLevel = input.thinkingLevel;
        }
        if (input.providerName !== undefined) {
          view.providerName = input.providerName;
        }
        if (input.modelID !== undefined) view.modelID = input.modelID;
        if (input.capabilities !== undefined) {
          view.capabilities = { ...input.capabilities };
        }
        view.updatedAt = now();
        return view;
      });
    },

    setSkillActive(input: TUISkillInput): Promise<TUISessionView> {
      return withSession(input.sessionId, (session) => {
        const name = input.name.trim();
        if (name === "") {
          throw new TUIServiceError("skill name is required");
        }
        if (input.active) session.skills.set(name, true);
        else session.skills.delete(name);
        session.view.updatedAt = now();
        return session.view;
      });
    },

    listSkills(
      input: { sessionId: string },
    ): Promise<TUISkillView[]> {
      return withSession(input.sessionId, (session) => {
        const views: TUISkillView[] = [];
        const seen = new Set<string>();
        for (const entry of skillCatalog) {
          seen.add(entry.name);
          views.push({
            ...entry,
            active: session.skills.get(entry.name) === true,
          });
        }
        for (const name of session.skills.keys()) {
          if (seen.has(name)) continue;
          views.push({
            name,
            source: "session",
            description: "",
            active: session.skills.get(name) === true,
          });
        }
        return views;
      });
    },

    settings(): Promise<TUISettingsView> {
      return Promise.resolve({
        defaultProvider: "test-provider",
        defaultModel: "test-model",
        defaultMode: "yolo",
        thinkingLevel: "",
        sandboxEnabled: false,
        sandboxLevel: "",
        webSearchEnabled: false,
        skillsDisabled: [],
        providers: [{
          name: "test-provider",
          apiKeyConfigured: true,
          modelCount: 1,
          models: [{ id: "test-model", name: "Test Model" }],
        }],
      });
    },

    getSettings(
      input?: { scope?: TUISettingsReadScope },
    ): Promise<Settings> {
      void (input?.scope ?? "effective");
      const clone: Settings = {
        ...settingsDoc,
        ...(settingsDoc.providers === undefined
          ? {}
          : { providers: { ...settingsDoc.providers } }),
      };
      return Promise.resolve(clone);
    },

    updateSettings(input: {
      scope: TUISettingsWriteScope;
      updates: Record<string, unknown>;
    }): Promise<Settings> {
      if (Object.keys(input.updates).length === 0) {
        return Promise.reject(
          new TUIServiceError(
            "settings patch with at least one field is required",
          ),
        );
      }
      settingsDoc = { ...settingsDoc, ...input.updates } as Settings;
      return Promise.resolve({
        ...settingsDoc,
        ...(settingsDoc.providers === undefined
          ? {}
          : { providers: { ...settingsDoc.providers } }),
      });
    },

    listProviders(): Promise<TUIProviderCatalogEntry[]> {
      return Promise.resolve(providerCatalog.map((entry) => ({
        ...entry,
        models: entry.models.map((model) => ({ ...model })),
      })));
    },

    validateProviderModel(input: {
      providerID: string;
      modelID: string;
    }): Promise<void> {
      const entry = providerCatalog.find((candidate) =>
        candidate.id === input.providerID
      );
      const model = entry?.models.find((candidate) =>
        candidate.id === input.modelID
      );
      if (entry === undefined || model === undefined) {
        return Promise.reject(
          new TUIServiceError(
            `provider model validation failed: ${input.providerID}/${input.modelID}`,
          ),
        );
      }
      return Promise.resolve();
    },

    listEnv(): Promise<Record<string, string>> {
      return Promise.resolve({ ...envVars });
    },

    updateEnv(
      input: { vars: Record<string, string> },
    ): Promise<Record<string, string>> {
      envVars = { ...input.vars };
      return Promise.resolve({ ...envVars });
    },

    getSessionContext(
      input: { sessionId: string },
    ): Promise<TUISessionContextView> {
      return withSession(input.sessionId, (session) => ({
        ...session.context,
      }));
    },

    setSessionContext(input: {
      sessionId: string;
      ruleContent?: string;
      extraContext?: string;
    }): Promise<TUISessionContextView> {
      return withSession(input.sessionId, (session) => {
        if (input.ruleContent !== undefined) {
          session.context.ruleContent = input.ruleContent;
        }
        if (input.extraContext !== undefined) {
          session.context.extraContext = input.extraContext;
        }
        return { ...session.context };
      });
    },

    listExperts(
      input: { sessionId: string },
    ): Promise<TUIExpertSummaryView[]> {
      return withSession(input.sessionId, () =>
        expertCatalog.map((entry) => ({
          ...entry,
          displayName: { ...entry.displayName },
        })));
    },

    showExpert(
      input: { sessionId: string; expertId: string },
    ): Promise<TUIExpertBundleView> {
      return withSession(input.sessionId, () => {
        const entry = expertCatalog.find((candidate) =>
          candidate.name === input.expertId
        );
        if (entry === undefined) {
          throw new TUIServiceError(
            `expert bundle not found: ${input.expertId}`,
          );
        }
        return {
          name: entry.name,
          displayName: { ...entry.displayName },
          expertType: entry.expertType,
          invalid: entry.invalid,
          invalidReason: entry.invalidReason,
          members: [],
        };
      });
    },

    expertState(input: { sessionId: string }): Promise<TUIExpertStateView> {
      return withSession(input.sessionId, (session) => ({
        expertId: session.expertId,
      }));
    },

    setExpert(input: {
      sessionId: string;
      expertId: string;
    }): Promise<TUIExpertStateView> {
      return withSession(input.sessionId, (session) => {
        const nextID = input.expertId.trim();
        const currentID = session.expertId.trim();
        if (
          currentID !== "" && nextID !== "" && currentID !== nextID
        ) {
          throw new TUIServiceError(
            `expert switch requires fork: ${JSON.stringify(currentID)} -> ${
              JSON.stringify(nextID)
            }`,
          );
        }
        session.expertId = nextID;
        return { expertId: session.expertId };
      });
    },

    forkSession(input: {
      sessionId: string;
      expertId?: string;
      titleMode?: string;
    }): Promise<TUISessionView> {
      return withSession(input.sessionId, (session) => {
        sessionCount++;
        const createdAt = now();
        const view: TUISessionView = {
          ...session.view,
          sessionId: `session-${sessionCount}`,
          createdAt,
          updatedAt: createdAt,
        };
        sessions.set(view.sessionId, {
          view,
          skills: new Map(),
          attachments: [],
          prepared: [],
          context: { ...session.context },
          expertId: input.expertId ?? session.expertId,
          closed: false,
          agents: new Map(),
          delegateEnabled: session.delegateEnabled,
          esmObjective: null,
          esmWorkerRunning: false,
          esmActiveAgentId: "",
          messageCount: session.messageCount,
          preview: session.preview,
        });
        return { ...view };
      });
    },

    prepareInput(input: TUIPrepareInput): Promise<TUIPreparedInput> {
      const rejection = rejectUnknownSession(input.sessionId);
      if (rejection !== undefined) return rejection;
      try {
        const session = requireSession(input.sessionId);
        resourceCount++;
        const prepared: TUIPreparedInput = {
          resourceId: `resource-${resourceCount}`,
          kind: input.kind ?? "file",
          relativePath: `.opensac/inputs/resource-${resourceCount}`,
          filename: input.name,
          mediaType: input.mediaType,
          bytes: base64ByteLength(input.contentBase64),
        };
        session.prepared.push(prepared);
        return Promise.resolve(prepared);
      } catch (error) {
        return Promise.reject(error);
      }
    },

    listAttachments(
      input: { sessionId: string },
    ): Promise<TUIAttachmentView[]> {
      return withSession(
        input.sessionId,
        (session) =>
          session.attachments.map((attachment) => ({
            ...attachment,
          })),
      );
    },

    addAttachment(
      input: TUIAttachmentInput,
    ): Promise<TUIAttachmentView> {
      return withSession(input.sessionId, (session) => {
        attachmentCount++;
        const view: TUIAttachmentView = {
          attachmentId: `attachment-${attachmentCount}`,
          name: input.name,
          mediaType: input.mediaType,
          size: base64ByteLength(input.contentBase64),
        };
        session.attachments.push(view);
        return view;
      });
    },

    capabilities(
      input: { sessionId: string },
    ): Promise<TUICapabilityView> {
      return withSession(input.sessionId, (session) => {
        const view: TUICapabilityView = {};
        for (
          const [name, enabled] of Object.entries(session.view.capabilities)
        ) {
          view[name] = { enabled, available: true };
        }
        return view;
      });
    },

    listAgents(
      input: { sessionId: string },
    ): Promise<TUIAgentView[]> {
      return withSession(
        input.sessionId,
        (session) =>
          [...session.agents.values()].map((agent) => ({
            ...agent,
            children: [...agent.children],
          })),
      );
    },

    destroyAgent(
      input: { sessionId: string; agentId: string },
    ): Promise<void> {
      return withSession(input.sessionId, (session) => {
        if (!session.agents.delete(input.agentId)) {
          throw new TUIServiceError(`agent ${input.agentId} not found`);
        }
        for (const agent of session.agents.values()) {
          agent.children = agent.children.filter((id) => id !== input.agentId);
        }
      });
    },

    setDelegate(
      input: { sessionId: string; enabled: boolean },
    ): Promise<{ enabled: boolean }> {
      return withSession(input.sessionId, (session) => {
        session.delegateEnabled = input.enabled;
        return { enabled: session.delegateEnabled };
      });
    },

    delegateState(
      input: { sessionId: string },
    ): Promise<{ enabled: boolean }> {
      return withSession(input.sessionId, (session) => ({
        enabled: session.delegateEnabled,
      }));
    },

    setCapability(input: {
      sessionId: string;
      id: string;
      enabled: boolean;
    }): Promise<TUICapabilityView> {
      return withSession(input.sessionId, (session) => {
        session.view.capabilities[input.id] = input.enabled;
        const view: TUICapabilityView = {};
        for (
          const [name, enabled] of Object.entries(session.view.capabilities)
        ) {
          view[name] = { enabled, available: true };
        }
        return view;
      });
    },

    esmState(input: { sessionId: string }): Promise<TUIEsmView> {
      return withSession(input.sessionId, (session) => esmViewOf(session));
    },

    esmCommand(input: TUIEsmCommandInput): Promise<TUIEsmView> {
      return withSession(input.sessionId, (session) => {
        const objective = session.esmObjective;
        switch (input.action) {
          case "create": {
            const text = (input.objective ?? "").trim();
            if (text === "") {
              throw new TUIServiceError("esm objective cannot be empty");
            }
            if (
              objective !== null &&
              (objective.status === "active" ||
                objective.status === "complete_candidate")
            ) {
              throw new TUIServiceError("esm objective already exists");
            }
            session.esmObjective = fakeObjective(
              input.sessionId,
              text,
              "active",
            );
            break;
          }
          case "edit": {
            const text = (input.objective ?? "").trim();
            if (objective === null) {
              throw new TUIServiceError("esm objective not found");
            }
            if (text === "") {
              throw new TUIServiceError("esm objective cannot be empty");
            }
            session.esmObjective = {
              ...objective,
              objective: text,
              updatedAt: new Date(BASE_TIME_MS + tick++).toISOString(),
            };
            break;
          }
          case "pause": {
            if (objective === null) {
              throw new TUIServiceError("esm objective not found");
            }
            session.esmObjective = {
              ...objective,
              status: "paused",
              updatedAt: new Date(BASE_TIME_MS + tick++).toISOString(),
            };
            break;
          }
          case "resume": {
            if (objective === null) {
              throw new TUIServiceError("esm objective not found");
            }
            session.esmObjective = {
              ...objective,
              status: "active",
              updatedAt: new Date(BASE_TIME_MS + tick++).toISOString(),
            };
            break;
          }
          case "guide": {
            if (objective === null) {
              throw new TUIServiceError("esm objective not found");
            }
            session.esmObjective = {
              ...objective,
              progressSummary: (input.guide ?? "").trim() === ""
                ? objective.progressSummary
                : input.guide ?? "",
              updatedAt: new Date(BASE_TIME_MS + tick++).toISOString(),
            };
            break;
          }
          case "clear":
            session.esmObjective = null;
            break;
        }
        return esmViewOf(session);
      });
    },

    esmContinue(
      input: { sessionId: string },
    ): Promise<TUIEsmContinuation> {
      const rejection = rejectUnknownSession(input.sessionId);
      if (rejection !== undefined) return rejection;
      const session = requireSession(input.sessionId);
      const objective = session.esmObjective;
      if (
        objective === null ||
        (objective.status !== "active" &&
          objective.status !== "complete_candidate")
      ) {
        return Promise.resolve({ runId: "", started: false });
      }
      runCount++;
      // The fake keeps the worker stream open with a stable run ID; tests
      // drive the worker's lifecycle projection through `emit`.
      const runId = "esm-continuation";
      emitEvent(input.sessionId, runId, "run_started", { text: "" });
      return Promise.resolve({ runId, started: true });
    },

    esmStop(input: { sessionId: string }): Promise<void> {
      return withSession(input.sessionId, (session) => {
        session.esmWorkerRunning = false;
        session.esmActiveAgentId = "";
      });
    },

    askTransient(input: TUIAskInput): Promise<TUIAskResult> {
      return withSession(input.sessionId, () => ({
        answer: transientAnswerValue,
      }));
    },

    compact(input: { sessionId: string }): Promise<TUICompactAccepted> {
      const rejection = rejectUnknownSession(input.sessionId);
      if (rejection !== undefined) return rejection;
      runCount++;
      const runId = `compact-${runCount}`;
      emitEvent(
        input.sessionId,
        runId,
        "run_finished",
        { status: "completed", compact: "done" },
        true,
      );
      return Promise.resolve({
        sessionId: input.sessionId,
        runId,
        status: "running",
      });
    },

    onDecisionRequest(
      listener: (request: TUIDecisionRequest) => void,
    ): () => void {
      decisionListeners.add(listener);
      return () => decisionListeners.delete(listener);
    },

    answerDecision(input: TUIDecisionAnswer): Promise<void> {
      const pending = decisions.get(input.requestId);
      if (pending === undefined || pending.kind !== input.kind) {
        return Promise.reject(decisionNotFoundError(input.requestId));
      }
      decisions.delete(input.requestId);
      return Promise.resolve();
    },

    requestDecision(input: {
      sessionId: string;
      runId: string;
      requestId: string;
      kind: TUIDecisionKind;
      toolName?: string;
      args?: Record<string, unknown>;
      question?: string;
      options?: string[];
      context?: string;
    }): TUIDecisionRequest {
      const request: TUIDecisionRequest = { ...input };
      decisions.set(request.requestId, request);
      for (const listener of [...decisionListeners]) listener(request);
      return request;
    },

    emit(
      sessionId: string,
      runId: string,
      eventType: string,
      payload: Record<string, unknown> = {},
      terminal = false,
    ): CoreRuntimeEvent {
      return emitEvent(sessionId, runId, eventType, payload, terminal);
    },

    addAgent(input: {
      sessionId: string;
      id: string;
      parent?: string;
    }): TUIAgentView {
      const session = requireSession(input.sessionId);
      const view: TUIAgentView = {
        id: input.id,
        parent: input.parent ?? "",
        children: [],
        state: "running",
      };
      session.agents.set(view.id, view);
      if (view.parent !== "") {
        session.agents.get(view.parent)?.children.push(view.id);
      }
      return { ...view, children: [...view.children] };
    },

    get transientAnswer(): string {
      return transientAnswerValue;
    },
    set transientAnswer(value: string) {
      transientAnswerValue = value;
    },
  };
}

/** Projects the fake ESM session state into its neutral view. */
function esmViewOf(session: FakeSession): TUIEsmView {
  return {
    objective: session.esmObjective === null ? null : {
      ...session.esmObjective,
      remainingWork: [...session.esmObjective.remainingWork],
    },
    workerRunning: session.esmWorkerRunning,
    activeAgentId: session.esmActiveAgentId,
  };
}

/** Builds one deterministic fake ESM objective row. */
function fakeObjective(
  sessionId: string,
  objective: string,
  status: string,
): TUIEsmObjectiveView {
  const timestamp = new Date(BASE_TIME_MS).toISOString();
  return {
    sessionId,
    esmId: "esm-1",
    objective,
    status,
    tokensUsed: 0,
    timeUsedMs: 0,
    blockedCount: 0,
    blockedReason: "",
    blockedRunId: "",
    completionReason: "",
    completionRunId: "",
    completionReview: "",
    phase: "worker",
    progressSummary: "",
    remainingWork: [],
    rejectionCount: 0,
    rejectionRunId: "",
    recoveryCount: 0,
    recoveryReason: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function toRunView(run: FakeRun): TUIRunView {
  const view: TUIRunView = {
    sessionId: run.sessionId,
    runId: run.runId,
    status: run.status,
    sequence: run.events.length,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
  if (run.error !== undefined) view.error = run.error;
  return view;
}

function base64ByteLength(contentBase64: string): number {
  try {
    return atob(contentBase64).length;
  } catch {
    throw new TUIServiceError("attachment content is not valid base64");
  }
}
