import {
  CORE_METHODS,
  coreError,
  coreResult,
  type CoreRpcMessage,
  type CoreRpcResponse,
} from "./protocol.ts";
import {
  CORE_ERROR_SESSION_NOT_RESIDENT,
  CORE_RUNTIME_METHODS,
  CoreSessionNotResidentError,
  parseAgentParams,
  parseCapabilitySetParams,
  parseConfigParams,
  parseContextUpdateParams,
  parseDelegateParams,
  parseEnvUpdateParams,
  parseEsmCommandParams,
  parseEventParams,
  parseExpertParams,
  parseForkParams,
  parsePrepareParams,
  parsePromptParams,
  parseProviderValidateParams,
  parseRunParams,
  parseSessionCreateParams,
  parseSessionIdParams,
  parseSessionListPersistedParams,
  parseSettingsReadParams,
  parseSettingsUpdateParams,
  parseSkillParams,
  parseTransientPromptParams,
  parseWorkDirParams,
  runtimeParamsObject,
} from "./runtime_protocol.ts";
import type { CoreRuntimeHost } from "./runtime.ts";
import { CoreEventStream } from "./event_stream.ts";

export interface CoreRuntimeDispatcherOptions {
  host: CoreRuntimeHost;
  events: CoreEventStream;
}

/** Dispatches authenticated Core domain requests to the Runtime Host. */
export class CoreRuntimeDispatcher {
  readonly #host: CoreRuntimeHost;
  readonly #events: CoreEventStream;

  constructor(options: CoreRuntimeDispatcherOptions) {
    this.#host = options.host;
    this.#events = options.events;
  }

  async dispatch(
    message: CoreRpcMessage,
    signal: AbortSignal,
  ): Promise<CoreRpcResponse | undefined> {
    if (signal.aborted) {
      return "method" in message
        ? coreError(message.id ?? null, -32800, "request aborted")
        : undefined;
    }
    if (!("method" in message) || typeof message.method !== "string") {
      return undefined;
    }
    const id = message.id ?? null;
    try {
      const result = await this.#dispatchMethod(
        message.method,
        message.params,
        signal,
      );
      return message.id === undefined ? undefined : coreResult(id, result);
    } catch (error) {
      if (message.id === undefined) return undefined;
      if (error instanceof CoreDispatchError) {
        return coreError(id, error.code, error.message, error.data);
      }
      if (error instanceof CoreSessionNotResidentError) {
        // A not-resident session is an expected, replayable condition rather
        // than a server fault, so it keeps its own code and names the session
        // the client must re-open.
        return coreError(
          id,
          CORE_ERROR_SESSION_NOT_RESIDENT,
          error.message,
          { sessionId: error.sessionId },
        );
      }
      return coreError(
        id,
        -32000,
        error instanceof Error ? error.message : "Core runtime request failed",
      );
    }
  }

  async #dispatchMethod(
    method: string,
    params: import("./protocol.ts").CoreRpcParams | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (method === CORE_METHODS.health) {
      return { healthy: true, version: "", protocolVersion: 1 };
    }
    if (method === CORE_METHODS.info) {
      return {
        version: "",
        protocolVersion: 1,
        coreProtocolVersion: 1,
        features: ["runtime"],
      };
    }
    switch (method) {
      case CORE_RUNTIME_METHODS.sessionCreate: {
        const input = parseSessionCreateParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.createSession(input);
      }
      case CORE_RUNTIME_METHODS.sessionOpen: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.openSession(input);
      }
      case CORE_RUNTIME_METHODS.sessionClose: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        await this.#host.closeSession(input);
        return null;
      }
      case CORE_RUNTIME_METHODS.sessionDelete: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        await this.#host.deleteSession(input);
        return null;
      }
      case CORE_RUNTIME_METHODS.sessionList:
        if (params !== undefined && runtimeParamsObject(params) === undefined) {
          throw invalidParams();
        }
        return await this.#host.listSessions();
      case CORE_RUNTIME_METHODS.sessionListPersisted: {
        const input = parseSessionListPersistedParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.listPersistedSessions(input);
      }
      case CORE_RUNTIME_METHODS.sessionHistory: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.history(input);
      }
      case CORE_RUNTIME_METHODS.sessionConfigGet: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        const sessions = await this.#host.listSessions();
        return sessions.find((session) =>
          session.sessionId === input.sessionId
        ) ?? null;
      }
      case CORE_RUNTIME_METHODS.sessionConfigSet: {
        const input = parseConfigParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.setSessionConfig(input);
      }
      case CORE_RUNTIME_METHODS.sessionPrompt: {
        const input = parsePromptParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.prompt(input);
      }
      case CORE_RUNTIME_METHODS.sessionSkillsList: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.listSessionSkills(input);
      }
      case CORE_RUNTIME_METHODS.sessionSkillSet: {
        const input = parseSkillParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.setSessionSkill?.(input) ?? null;
      }
      case CORE_RUNTIME_METHODS.sessionSkillState: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.getSessionSkillState?.(input) ?? null;
      }
      case CORE_RUNTIME_METHODS.sessionCapabilities: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.sessionCapabilities(input);
      }
      case CORE_RUNTIME_METHODS.inputPrepare: {
        const input = parsePrepareParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.prepareInput(input);
      }
      case CORE_RUNTIME_METHODS.sessionContextGet: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.sessionContext(input);
      }
      case CORE_RUNTIME_METHODS.sessionContextSet: {
        const input = parseContextUpdateParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.setSessionContext(input);
      }
      case CORE_RUNTIME_METHODS.expertList: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.listExperts(input);
      }
      case CORE_RUNTIME_METHODS.expertShow: {
        const input = parseExpertParams(params);
        if (input === undefined || input.expertId === "") throw invalidParams();
        return await this.#host.inspectExpert(input);
      }
      case CORE_RUNTIME_METHODS.expertState: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.expertState(input);
      }
      case CORE_RUNTIME_METHODS.expertSet: {
        const input = parseExpertParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.setExpert(input);
      }
      case CORE_RUNTIME_METHODS.sessionFork: {
        const input = parseForkParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.forkSession(input);
      }
      case CORE_RUNTIME_METHODS.agentList: {
        const input = parseAgentParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.listAgents(input);
      }
      case CORE_RUNTIME_METHODS.agentDestroy: {
        const input = parseAgentParams(params);
        if (input === undefined || input.agentId === undefined) {
          throw invalidParams();
        }
        await this.#host.destroyAgent({
          sessionId: input.sessionId,
          agentId: input.agentId,
        });
        return null;
      }
      case CORE_RUNTIME_METHODS.delegateSet: {
        const input = parseDelegateParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.setDelegate(input);
      }
      case CORE_RUNTIME_METHODS.delegateGet: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.delegateState(input);
      }
      case CORE_RUNTIME_METHODS.capabilitySet: {
        const input = parseCapabilitySetParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.setSessionCapability(input);
      }
      case CORE_RUNTIME_METHODS.esmState: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.esmState(input);
      }
      case CORE_RUNTIME_METHODS.esmUpdate: {
        const input = parseEsmCommandParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.esmUpdate(input);
      }
      case CORE_RUNTIME_METHODS.esmContinue: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.esmContinue(input);
      }
      case CORE_RUNTIME_METHODS.esmStop: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        await this.#host.esmStop(input);
        return null;
      }
      case CORE_RUNTIME_METHODS.transientPrompt: {
        const input = parseTransientPromptParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.transientPrompt(input);
      }
      case CORE_RUNTIME_METHODS.sessionCompact: {
        const input = parseSessionIdParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.compact(input);
      }
      case CORE_RUNTIME_METHODS.settingsGet: {
        const input = parseSettingsReadParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.settingsDocument(input);
      }
      case CORE_RUNTIME_METHODS.settingsUpdate: {
        const input = parseSettingsUpdateParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.updateSettingsDocument(input);
      }
      case CORE_RUNTIME_METHODS.modelCatalog: {
        const input = parseWorkDirParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.providerCatalog(input);
      }
      case CORE_RUNTIME_METHODS.modelValidate: {
        const input = parseProviderValidateParams(params);
        if (input === undefined) throw invalidParams();
        await this.#host.validateProviderModel(input);
        return null;
      }
      case CORE_RUNTIME_METHODS.envList:
        if (params !== undefined && runtimeParamsObject(params) === undefined) {
          throw invalidParams();
        }
        return await this.#host.envDocument();
      case CORE_RUNTIME_METHODS.envUpdate: {
        const input = parseEnvUpdateParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.updateEnvDocument(input);
      }
      case CORE_RUNTIME_METHODS.runStatus: {
        const input = parseRunParams(params);
        if (input === undefined) throw invalidParams();
        return (await this.#host.getRun(input)) ?? null;
      }
      case CORE_RUNTIME_METHODS.runCancel: {
        const input = parseRunParams(params);
        if (input === undefined) throw invalidParams();
        return await this.#host.cancelRun(input);
      }
      case CORE_RUNTIME_METHODS.runEventsSubscribe: {
        const input = parseEventParams(params);
        if (input === undefined) throw invalidParams();
        this.#events.subscribe(input.sessionId, input.runId, input.cursor);
        return input;
      }
      case CORE_RUNTIME_METHODS.runEventsReplay: {
        const input = parseEventParams(params);
        if (input === undefined) throw invalidParams();
        return this.#events.replay(input.sessionId, input.runId, input.cursor);
      }
      default: {
        if (isExtensionMethod(method)) {
          const extension = this.#host.extension;
          if (extension === undefined) {
            throw new CoreDispatchError(
              -32601,
              "Core extension handler is not configured",
              method,
            );
          }
          return await extension(method, params ?? {}, signal);
        }
        throw new CoreDispatchError(-32601, "method not found", method);
      }
    }
  }
}

class CoreDispatchError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CoreDispatchError";
  }
}

function isExtensionMethod(method: string): boolean {
  return method === "doctor" ||
    method.startsWith("approval.") ||
    method.startsWith("question.") ||
    method.startsWith("attachment.") ||
    method.startsWith("project.") ||
    method.startsWith("manage.");
}

function invalidParams(): CoreDispatchError {
  return new CoreDispatchError(-32602, "invalid Core runtime params");
}
