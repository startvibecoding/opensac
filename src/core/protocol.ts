/** The JSON-RPC protocol version used by the Core application protocol. */
const CORE_JSONRPC_VERSION = "2.0" as const;

/** A JSON-RPC identifier accepted by the Core protocol. */
export type CoreRpcId = string | number | null;

/** JSON-RPC 2.0 permits only an object or array for request parameters. */
export type CoreRpcParams = Record<string, unknown> | unknown[];

/** A request sent to the Core and expected to receive a response. */
export interface CoreRpcRequest {
  jsonrpc: typeof CORE_JSONRPC_VERSION;
  id: CoreRpcId;
  method: string;
  params?: CoreRpcParams;
  /** Response-only fields are intentionally excluded from requests. */
  result?: never;
  error?: never;
}

/** An error object in a JSON-RPC error response. */
export interface CoreRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A successful JSON-RPC response. */
export interface CoreRpcSuccessResponse {
  jsonrpc: typeof CORE_JSONRPC_VERSION;
  id: CoreRpcId;
  result: unknown;
  method?: never;
  params?: never;
  error?: never;
}

/** An unsuccessful JSON-RPC response. */
export interface CoreRpcErrorResponse {
  jsonrpc: typeof CORE_JSONRPC_VERSION;
  id: CoreRpcId;
  result?: never;
  method?: never;
  params?: never;
  error: CoreRpcError;
}

/** A JSON-RPC response, represented as a success/error discriminated union. */
export type CoreRpcResponse = CoreRpcSuccessResponse | CoreRpcErrorResponse;

/** A request without an id, used for one-way Core events. */
export interface CoreRpcNotification {
  jsonrpc: typeof CORE_JSONRPC_VERSION;
  method: string;
  params?: CoreRpcParams;
  id?: never;
  result?: never;
  error?: never;
}

/** One decoded Core JSON-RPC envelope. */
export type CoreRpcMessage =
  | CoreRpcRequest
  | CoreRpcResponse
  | CoreRpcNotification;

/** Health information returned by the Core health method. */
export interface CoreHealth {
  healthy: boolean;
  version: string;
  protocolVersion: number;
}

/** Acknowledgement returned by a successful Core shutdown request. */
export interface CoreShutdownResult {
  ok: true;
}

/** Capability and version information returned by the Core info method. */
export interface CoreInfo {
  version: string;
  protocolVersion: number;
  coreProtocolVersion: number;
  features: string[];
}

/** One client currently connected to the Core event stream. */
export interface CoreClientConnection {
  clientId: string;
  remoteAddress?: string;
  connectedAt: number;
  subscriptions: Array<{ sessionId: string; runId: string }>;
}

/** Result of `core.clients.list`. */
export interface CoreClientsResult {
  clients: CoreClientConnection[];
}

/** Method names understood by the initial Core protocol. */
export const CORE_METHODS = {
  health: "core.health",
  info: "core.info",
  shutdown: "core.shutdown",
  clientsList: "core.clients.list",
} as const;

type CoreRpcObject = Record<string, unknown>;

function asObject(value: unknown): CoreRpcObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as CoreRpcObject;
}

function hasOwn(object: CoreRpcObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isCoreRpcId(value: unknown): value is CoreRpcId {
  return value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

function isStructuredParams(value: unknown): value is CoreRpcParams {
  return value !== null && typeof value === "object";
}

function isErrorObject(value: unknown): value is CoreRpcError {
  const error = asObject(value);
  if (
    error === undefined ||
    typeof error.code !== "number" ||
    !Number.isInteger(error.code) ||
    !Number.isFinite(error.code) ||
    typeof error.message !== "string"
  ) {
    return false;
  }
  if (hasOwn(error, "data") && error.data === undefined) return false;
  return true;
}

function copyParams(
  object: CoreRpcObject,
): Pick<CoreRpcRequest, "params"> | Pick<CoreRpcNotification, "params"> {
  if (!hasOwn(object, "params") || !isStructuredParams(object.params)) {
    return {};
  }
  return { params: object.params };
}

function parseError(value: unknown): CoreRpcError | undefined {
  const object = asObject(value);
  if (object === undefined || !isErrorObject(object)) return undefined;
  return hasOwn(object, "data")
    ? {
      code: object.code,
      message: object.message,
      data: object.data,
    }
    : { code: object.code, message: object.message };
}

/**
 * Decodes one untrusted Core JSON-RPC envelope.
 *
 * The function accepts only a single JSON-compatible object. It does not
 * coerce identifiers, accept batches, or combine request and response fields.
 * Request and notification params, when present, must be objects or arrays;
 * other optional values are retained as-is so callers can apply
 * domain-specific validation after decoding the envelope.
 */
export function parseCoreRpcMessage(
  input: unknown,
): CoreRpcMessage | undefined {
  const object = asObject(input);
  if (
    object === undefined ||
    !hasOwn(object, "jsonrpc") ||
    object.jsonrpc !== CORE_JSONRPC_VERSION
  ) {
    return undefined;
  }

  const hasId = hasOwn(object, "id");
  const hasMethod = hasOwn(object, "method");
  const hasResult = hasOwn(object, "result");
  const hasError = hasOwn(object, "error");
  const hasParams = hasOwn(object, "params");

  if (hasMethod) {
    // A method envelope is either a request or a notification. It cannot
    // carry response fields, even when those fields are present but invalid.
    if (hasResult || hasError || typeof object.method !== "string") {
      return undefined;
    }
    if (hasParams && !isStructuredParams(object.params)) return undefined;
    if (hasId) {
      if (!isCoreRpcId(object.id)) return undefined;
      return {
        jsonrpc: CORE_JSONRPC_VERSION,
        id: object.id,
        method: object.method,
        ...copyParams(object),
      };
    }
    return {
      jsonrpc: CORE_JSONRPC_VERSION,
      method: object.method,
      ...copyParams(object),
    };
  }

  // A response has an id and exactly one of result or error. Params and
  // method are request/notification fields and are not silently ignored.
  if (!hasId || hasParams || hasResult === hasError) return undefined;
  if (!isCoreRpcId(object.id)) return undefined;

  if (hasResult) {
    if (object.result === undefined) return undefined;
    return {
      jsonrpc: CORE_JSONRPC_VERSION,
      id: object.id,
      result: object.result,
    };
  }

  const error = parseError(object.error);
  if (error === undefined) return undefined;
  return {
    jsonrpc: CORE_JSONRPC_VERSION,
    id: object.id,
    error,
  };
}

/** Builds a successful Core JSON-RPC response without changing its id.
 * A response result is required, so `undefined` is rejected. */
export function coreResult(id: unknown, result: unknown): CoreRpcResponse {
  if (!isCoreRpcId(id)) {
    throw new TypeError(
      "Core JSON-RPC response id must be a string, number, or null",
    );
  }
  if (result === undefined) {
    throw new TypeError("Core JSON-RPC result must not be undefined");
  }
  return {
    jsonrpc: CORE_JSONRPC_VERSION,
    id,
    result,
  };
}

/** Builds a Core JSON-RPC error response without changing its id. */
export function coreError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): CoreRpcResponse {
  if (!isCoreRpcId(id)) {
    throw new TypeError(
      "Core JSON-RPC response id must be a string, number, or null",
    );
  }
  if (!Number.isInteger(code) || !Number.isFinite(code)) {
    throw new TypeError("Core JSON-RPC error code must be a finite integer");
  }
  if (typeof message !== "string") {
    throw new TypeError("Core JSON-RPC error message must be a string");
  }

  const error: CoreRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return {
    jsonrpc: CORE_JSONRPC_VERSION,
    id,
    error,
  };
}

/** Builds a one-way Core JSON-RPC notification. Undefined params are omitted. */
export function coreNotification(
  method: string,
  params: unknown,
): CoreRpcNotification {
  if (typeof method !== "string") {
    throw new TypeError("Core JSON-RPC notification method must be a string");
  }
  const notification: CoreRpcNotification = {
    jsonrpc: CORE_JSONRPC_VERSION,
    method,
  };
  if (params !== undefined) {
    if (!isStructuredParams(params)) {
      throw new TypeError(
        "Core JSON-RPC notification params must be an object or array",
      );
    }
    notification.params = params;
  }
  return notification;
}
