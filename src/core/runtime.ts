import type { Settings } from "../config/settings.ts";
import type { CoreRpcId, CoreRpcParams, CoreRpcResponse } from "./protocol.ts";

/** A front-end-neutral runtime source identifier. */
export type CoreRuntimeSource = string;

export type CoreReverseRequest = (
  id: CoreRpcId,
  method: string,
  params?: CoreRpcParams,
) => Promise<CoreRpcResponse>;

/** A front-end-neutral session creation request. */
export interface CoreSessionCreateInput {
  workDir: string;
  providerName?: string;
  modelID?: string;
  mode?: string;
  thinkingLevel?: string;
  capabilities?: Record<string, boolean>;
}

/** The public, adapter-neutral view of a Core-owned session. */
export interface CoreSessionView {
  sessionId: string;
  workDir: string;
  source: CoreRuntimeSource;
  providerName: string;
  modelID: string;
  mode: string;
  thinkingLevel: string;
  capabilities: Record<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}

/** A prompt accepted by the Core Runtime Host. */
export interface CorePromptInput {
  sessionId: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
}

/** The admission result for a prompt. */
export interface CorePromptAccepted {
  sessionId: string;
  runId: string;
  status: "running";
}

/** A front-end-neutral Run status projection. */
export interface CoreRunView {
  sessionId: string;
  runId: string;
  status: "running" | "completed" | "cancelled" | "failed" | "timed_out";
  sequence: number;
  error?: string;
  startedAt: Date;
  updatedAt: Date;
}

/** One canonical event emitted by a Core-owned Run. */
export interface CoreRuntimeEvent {
  sessionId: string;
  runId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  terminal: boolean;
}

/** A prompt execution returned by a Core-owned session runtime. */
export interface CorePromptExecution {
  runId: string;
  events?: AsyncIterable<CoreRuntimeEvent>;
}

/** A Core-owned session runtime dependency used by the host. */
export interface CoreSessionRuntime {
  readonly sessionId: string;
  prompt(input: CorePromptInput): Promise<CorePromptExecution>;
  cancelRun(runId: string): Promise<void>;
  close(): Promise<void>;
  setSkillActive?(input: { name: string; active: boolean }): Promise<void>;
}

/** Construction dependencies for the Core Runtime Host. */
export interface CoreRuntimeDependencies {
  createSessionRuntime(input: {
    sessionId: string;
    workDir: string;
    source: CoreRuntimeSource;
    providerName: string;
    modelID: string;
    mode?: string;
    thinkingLevel?: string;
    settings: Settings;
    reverseRequest?: CoreReverseRequest;
  }): CoreSessionRuntime;
  openSessionRuntime?(input: {
    sessionId: string;
    workDir: string;
    source: CoreRuntimeSource;
    providerName: string;
    modelID: string;
    mode?: string;
    thinkingLevel?: string;
    settings: Settings;
    reverseRequest?: CoreReverseRequest;
  }): CoreSessionRuntime;
  newId?: () => string;
  now?: () => Date;
}

export type CoreExtensionHandler = (
  method: string,
  params: CoreRpcParams,
  signal: AbortSignal,
) => Promise<unknown>;

/** Construction options for the shared Core Runtime Host. */
export interface CoreRuntimeHostOptions {
  source: CoreRuntimeSource;
  workDir: string;
  settings: Settings;
  providerName: string;
  modelID: string;
  dependencies: CoreRuntimeDependencies;
  extension?: CoreExtensionHandler;
  eventSink?: (event: CoreRuntimeEvent) => void;
  reverseRequest?: CoreReverseRequest;
}

/** The shared Core-owned runtime facade. */
export interface CoreRuntimeHost {
  createSession(input: CoreSessionCreateInput): Promise<CoreSessionView>;
  openSession(input: { sessionId: string }): Promise<CoreSessionView>;
  closeSession(input: { sessionId: string }): Promise<void>;
  history(input: { sessionId: string }): Promise<CoreRuntimeEvent[]>;
  prompt(input: CorePromptInput): Promise<CorePromptAccepted>;
  cancelRun(input: { sessionId: string; runId: string }): Promise<CoreRunView>;
  getRun(
    input: { sessionId: string; runId: string },
  ): Promise<CoreRunView | undefined>;
  listSessions(): Promise<CoreSessionView[]>;
  setSessionConfig(input: {
    sessionId: string;
    mode?: string;
    thinkingLevel?: string;
    providerName?: string;
    modelID?: string;
    capabilities?: Record<string, boolean>;
  }): Promise<CoreSessionView>;
  setSessionSkill?(input: {
    sessionId: string;
    name: string;
    active: boolean;
  }): Promise<Record<string, unknown>>;
  getSessionSkillState?(input: {
    sessionId: string;
  }): Promise<Record<string, unknown>>;
  subscribeRunEvents(
    sessionId: string,
    runId: string,
    cursor?: number,
  ): AsyncIterableIterator<CoreRuntimeEvent>;
  close(): Promise<void>;
  extension?: CoreExtensionHandler;
}
