import {
  type CoreRpcId,
  type CoreRpcParams,
  type CoreRpcRequest,
  type CoreRpcResponse,
} from "../core/protocol.ts";
import type { CoreRuntimeEvent } from "../core/runtime.ts";
import type { ACPRPCRequest } from "./wire.ts";
import { mapACPExtensionToCore } from "./bridge_extensions.ts";

/** Context shared by ACP request projections. */
export interface ACPBridgeContext {
  source: string;
  workDir: string;
  sessionIds?: ReadonlyMap<string, string>;
}

/** A response in the ACP server's raw-ID representation. */
export interface ACPRPCResponse {
  jsonrpc: "2.0";
  idRaw: string | null;
  result?: unknown;
  error?: unknown;
}

/** An ACP JSON-RPC notification. */
export interface ACPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** A Core request that is projected to an ACP reverse request. */
export type CoreServerRequest = CoreRpcRequest;

/** Converts one ACP request into the neutral Core request envelope. */
export function mapACPRequestToCore(
  request: ACPRPCRequest,
  context: ACPBridgeContext,
): CoreRpcRequest {
  const id = parseACPID(request.idRaw);
  const params = objectParams(request.params);
  if (
    request.method.startsWith("fs/") ||
    request.method.startsWith("opensac/") ||
    request.method === "permission/request" ||
    request.method === "question/request"
  ) {
    return mapACPExtensionToCore(request, context);
  }
  switch (request.method) {
    case "initialize":
      return coreRequest(id, "core.info");
    case "session/new":
      return coreRequest(id, "session.create", {
        workDir: stringValue(params.workDir ?? params.cwd) ?? context.workDir,
        // The entry declares its RuntimeSource once; run policy resolves from
        // this identity instead of the shared Core's fallback.
        source: context.source,
        ...optionalString(params, "providerName", "provider"),
        ...optionalString(params, "modelID", "model"),
        ...optionalString(params, "mode", "mode"),
        ...optionalString(params, "thinkingLevel", "thinking"),
      });
    case "session/load":
      return coreRequest(id, "session.open", {
        sessionId: stringValue(params.sessionId ?? params.sessionID) ?? "",
      });
    case "session/prompt":
      return coreRequest(id, "session.prompt", {
        sessionId: stringValue(params.sessionId ?? params.sessionID) ?? "",
        text: promptText(params.prompt ?? params.text),
        ...(Array.isArray(params.attachments)
          ? {
            attachments: params.attachments.filter((v): v is string =>
              typeof v === "string"
            ),
          }
          : {}),
      });
    case "session/updates":
      return coreRequest(id, "run.events.replay", {
        sessionId: stringValue(params.sessionId ?? params.sessionID) ?? "",
        runId: stringValue(params.runId ?? params.runID) ?? "",
        cursor: typeof params.cursor === "number" ? params.cursor : 0,
      });
    case "session/cancel":
      return coreRequest(id, "run.cancel", {
        sessionId: stringValue(params.sessionId ?? params.sessionID) ?? "",
        runId: stringValue(params.runId ?? params.runID) ?? "",
      });
    case "session/set_config_option":
    case "session/set_mode":
      return coreRequest(id, "session.config.set", {
        sessionId: stringValue(params.sessionId ?? params.sessionID) ?? "",
        ...(typeof params.configId === "string"
          ? { configId: params.configId }
          : {}),
        ...(typeof params.value === "string" ? { value: params.value } : {}),
        ...(typeof params.mode === "string" ? { mode: params.mode } : {}),
      });
    case "permission/request":
      return coreRequest(id, "approval.resolve", params);
    case "question/request":
      return coreRequest(id, "question.resolve", params);
    case "fs/read_text_file":
      return coreRequest(id, "attachment.fetch", params);
    case "fs/write_text_file":
      return coreRequest(id, "attachment.store", params);
    default:
      if (request.method.startsWith("opensac/manage/")) {
        return coreRequest(
          id,
          request.method.replace("opensac/manage/", "manage."),
          params,
        );
      }
      throw new Error(`unsupported ACP method: ${request.method}`);
  }
}

/** Maps a Core response back to the original ACP raw-ID envelope. */
export function mapCoreResponseToACP(
  response: CoreRpcResponse,
  request: ACPRPCRequest,
): ACPRPCResponse {
  if ("error" in response) {
    return {
      jsonrpc: "2.0",
      idRaw: request.idRaw,
      error: response.error,
    };
  }
  return {
    jsonrpc: "2.0",
    idRaw: request.idRaw,
    result: response.result,
  };
}

/** Projects one canonical Core event onto an ACP session update. */
export function mapCoreEventToACP(event: CoreRuntimeEvent): ACPNotification {
  const update = projectUpdate(event);
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: event.sessionId, update },
  };
}

/** Projects a Core reverse request onto the ACP reverse-request vocabulary. */
export function mapCoreReverseRequestToACP(
  request: CoreServerRequest,
): ACPRPCRequest {
  const method = request.method === "approval.request"
    ? "session/requestPermission"
    : request.method === "question.request"
    ? "session/requestQuestion"
    : request.method;
  return {
    jsonrpc: "2.0",
    idRaw: JSON.stringify(request.id),
    method,
    params: request.params,
  };
}

function projectUpdate(event: CoreRuntimeEvent): Record<string, unknown> {
  const payload = event.payload;
  switch (event.eventType) {
    case "text_delta":
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: stringValue(payload.messageId) ?? `acp_${event.runId}_text`,
        content: payload.content ??
          { type: "text", text: stringValue(payload.text) ?? "" },
        runId: event.runId,
      };
    case "reasoning_delta":
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId: stringValue(payload.messageId) ??
          `acp_${event.runId}_thought`,
        content: payload.content ??
          { type: "text", text: stringValue(payload.text) ?? "" },
        runId: event.runId,
      };
    case "tool_call":
    case "tool_call_update":
      return {
        sessionUpdate: event.eventType === "tool_call"
          ? "tool_call"
          : "tool_call_update",
        toolCallId: stringValue(payload.toolCallId) ?? "",
        ...(stringValue(payload.status) === undefined
          ? {}
          : { status: stringValue(payload.status)! }),
        ...(payload.content === undefined ? {} : { content: payload.content }),
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.rawInput === undefined
          ? {}
          : { rawInput: payload.rawInput }),
        ...(payload.rawOutput === undefined
          ? {}
          : { rawOutput: payload.rawOutput }),
        ...(payload.locations === undefined
          ? {}
          : { locations: payload.locations }),
        runId: event.runId,
      };
    case "run_finished":
      return {
        sessionUpdate: "run_finished",
        status: stringValue(payload.status) ?? "completed",
        runId: event.runId,
      };
    default:
      return {
        sessionUpdate: event.eventType,
        runId: event.runId,
        _meta: { sequence: event.sequence },
      };
  }
}

function coreRequest(
  id: CoreRpcId,
  method: string,
  params?: Record<string, unknown>,
): CoreRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params: params as CoreRpcParams }),
  };
}

function parseACPID(raw: string | null): CoreRpcId {
  if (raw === null || raw.trim() === "" || raw.trim() === "null") return null;
  const value = JSON.parse(raw);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("ACP request id must be a string, number, or null");
  }
  return value;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ACP request params must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalString(
  object: Record<string, unknown>,
  target: string,
  source: string,
): Record<string, string> {
  const value = stringValue(object[source]);
  return value === undefined ? {} : { [target]: value };
}

function promptText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (typeof block === "string") return block;
    if (block === null || typeof block !== "object") return "";
    const text = (block as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }).join("");
}
