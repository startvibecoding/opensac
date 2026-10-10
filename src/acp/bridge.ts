import { coreError, coreResult, type CoreRpcId } from "../core/protocol.ts";
import { type CoreRuntimeEvent } from "../core/runtime.ts";
import {
  type ACPBridgeContext,
  type ACPRPCResponse,
  type CoreServerRequest,
  mapACPRequestToCore,
  mapCoreEventToACP,
  mapCoreResponseToACP,
  mapCoreReverseRequestToACP,
} from "./bridge_protocol.ts";
import { type BridgeCoreClient } from "./bridge_client.ts";
import { type ACPRPCRequest } from "./wire.ts";
import { acpProtocolVersion } from "./wire.ts";

export interface ACPBridgeOptions {
  client: BridgeCoreClient;
  context: ACPBridgeContext;
  initialized?: boolean;
  write(data: string): void | Promise<void>;
}

/** Protocol-only ACP bridge over a Core client. */
export class ACPBridge {
  readonly #client: BridgeCoreClient;
  readonly #context: ACPBridgeContext;
  readonly #writeLine: (data: string) => void | Promise<void>;
  readonly #reverseIds = new Map<string, CoreRpcId>();
  #initialized: boolean;
  #connected = true;
  #writeQueue: Promise<void> = Promise.resolve();
  #stopEvents: (() => void) | undefined;
  #stopReverse: (() => void) | undefined;

  constructor(options: ACPBridgeOptions) {
    this.#client = options.client;
    this.#context = options.context;
    this.#initialized = options.initialized ?? false;
    this.#writeLine = options.write;
    this.#stopEvents = this.#client.onEvent((event) =>
      this.#forwardEvent(event),
    );
    this.#stopReverse = this.#client.onReverseRequest((request) =>
      this.#forwardReverseRequest(request),
    );
  }

  get connected(): boolean {
    return this.#connected;
  }

  async handle(request: ACPRPCRequest): Promise<void> {
    if (request.method === "") {
      this.#handleReverseResponse(request);
      return;
    }
    if (!this.#initialized && request.method !== "initialize") {
      await this.#writeACPError(
        request.idRaw,
        -32600,
        "initialize must be called first",
      );
      return;
    }

    try {
      if (request.method === "initialize") await this.#client.connect();
      const coreRequest = mapACPRequestToCore(request, this.#context);
      const coreResponse = await this.#client.callCore(coreRequest);
      if (request.method === "initialize" && !("error" in coreResponse)) {
        this.#initialized = true;
        await this.#write(
          mapCoreResponseToACP(
            coreResult(coreRequest.id, {
              protocolVersion: acpProtocolVersion,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, audio: false },
              },
              authMethods: [],
            }),
            request,
          ),
        );
        return;
      }
      await this.#write(mapCoreResponseToACP(coreResponse, request));
      if (request.method === "session/prompt" && !("error" in coreResponse)) {
        const result = coreResponse.result as {
          sessionId?: string;
          runId?: string;
        };
        if (result.sessionId !== undefined && result.runId !== undefined) {
          await this.#client.subscribe(result.sessionId, result.runId, 0);
        }
      }
    } catch (error) {
      await this.#writeACPError(
        request.idRaw,
        -32000,
        error instanceof Error ? error.message : "ACP bridge request failed",
      );
    }
  }

  handleNotification(request: ACPRPCRequest): Promise<void> {
    return this.handle(request);
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    this.#stopEvents?.();
    this.#stopReverse?.();
    this.#stopEvents = undefined;
    this.#stopReverse = undefined;
    await this.#writeQueue.catch(() => undefined);
    await this.#client.close();
    this.#reverseIds.clear();
  }

  #handleReverseResponse(request: ACPRPCRequest): void {
    if (request.idRaw === null) return;
    const id = this.#reverseIds.get(request.idRaw);
    if (id === undefined) return;
    this.#reverseIds.delete(request.idRaw);
    if (request.error !== undefined) {
      const error = request.error as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      this.#client.respondToReverseRequest(
        coreError(
          id,
          typeof error.code === "number" ? error.code : -32000,
          typeof error.message === "string"
            ? error.message
            : "ACP reverse request failed",
          error.data,
        ),
      );
      return;
    }
    this.#client.respondToReverseRequest(
      coreResult(id, request.result ?? null),
    );
  }

  #forwardEvent(event: CoreRuntimeEvent): void {
    if (!this.#connected) return;
    void this.#write(mapCoreEventToACP(event));
  }

  #forwardReverseRequest(request: CoreServerRequest): void {
    if (!this.#connected) return;
    const projected = mapCoreReverseRequestToACP(request);
    this.#reverseIds.set(projected.idRaw!, request.id);
    void this.#write(projected);
  }

  #writeACPError(
    idRaw: string | null,
    code: number,
    message: string,
  ): Promise<void> {
    return this.#write({
      jsonrpc: "2.0",
      idRaw,
      error: { code, message },
    });
  }

  #write(
    value:
      ACPRPCResponse | ReturnType<typeof mapCoreEventToACP> | ACPRPCRequest,
  ): Promise<void> {
    const line =
      "idRaw" in value
        ? "method" in value && value.method !== ""
          ? `${JSON.stringify({
              jsonrpc: "2.0",
              id: value.idRaw === null ? null : JSON.parse(value.idRaw),
              method: value.method,
              ...(value.params === undefined ? {} : { params: value.params }),
            })}\n`
          : `{"jsonrpc":"2.0","id":${value.idRaw ?? "null"},${
              "error" in value
                ? `"error":${JSON.stringify(value.error)}`
                : `"result":${JSON.stringify(value.result ?? null)}`
            }}\n`
        : `${JSON.stringify(value)}\n`;
    this.#writeQueue = this.#writeQueue.then(() => this.#writeLine(line));
    return this.#writeQueue;
  }
}
