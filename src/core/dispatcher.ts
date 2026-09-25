import {
  CORE_METHODS,
  coreError,
  coreResult,
  type CoreRpcMessage,
  type CoreRpcResponse,
} from "./protocol.ts";
import {
  CORE_RUNTIME_METHODS,
  parseConfigParams,
  parseEventParams,
  parsePromptParams,
  parseRunParams,
  parseSessionCreateParams,
  parseSessionIdParams,
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
      case CORE_RUNTIME_METHODS.sessionList:
        if (params !== undefined && runtimeParamsObject(params) === undefined) {
          throw invalidParams();
        }
        return await this.#host.listSessions();
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
