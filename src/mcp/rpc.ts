// Shared JSON-RPC vocabulary for the MCP client and server (ported from the
// RPCRequest/RPCError types and protocol constants in internal/mcp/mcp.go).

/** Advertised MCP protocol revision (matches the Go constant byte for byte). */
export const mcpProtocolVersion = "2025-11-25";

/** Maximum size of a single MCP response body in bytes. */
export const mcpMaxResponseBytes = 16 << 20;

/** One MCP JSON-RPC envelope (request, response, or notification). */
export interface RPCRequest {
  jsonrpc?: string;
  /** JSON-RPC id (left untyped so numeric and string ids round-trip). */
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** One MCP JSON-RPC error object. */
export class RPCError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RPCError";
    this.code = code;
    this.data = data;
  }
}

/** Builds a response envelope for `serveStdio`. */
export function serverResult(
  id: unknown,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** Builds an error envelope for `serveStdio`. */
export function serverError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Removes surrounding quotes from a raw JSON-RPC id. */
export function rawIDKey(id: unknown): string {
  return String(id).replace(/^"|"$/g, "");
}

/** Canonical pending-response key for a JSON-RPC id. */
export function rpcResponseIDKey(id: unknown): string {
  // Mirrors Go's raw `json.RawMessage` comparison: a numeric id keys as its
  // decimal string, while a string id keeps its quotes so `"1"` never matches
  // the request id `1`.
  if (typeof id === "number") return String(id);
  if (id === undefined) return "";
  return JSON.stringify(id);
}
