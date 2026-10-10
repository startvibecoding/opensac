// (the ACP stdio JSON-RPC transport).
//
// Go reads newline-delimited JSON with a `bufio.Reader` and writes JSON lines
// to a `io.Writer` it optionally flushes. The Deno projection keeps the same
// wire contract (one JSON document per line, JSON-RPC ids echoed verbatim) but
// exposes the reader/writer as small classes so the server can bind them to
// stdin/stdout or an in-memory fixture.
//
// Deviations: `json.RawMessage` ids are carried as their raw JSON text (so the
// scalar domain, `null` vs. absent, and verbatim echo are preserved), and
// `bufio.Reader.ReadSlice` maps to `ACPLineReader.readLine()`.

import type { RPCError } from "../mcp/rpc.ts";
import { type SessionUpdate } from "./protocol.ts";

/** Advertised ACP protocol revision (matches the Go constant). */
export const acpProtocolVersion = 1;

/** Maximum size of a single ACP request line (10 MiB). */
export const acpMaxRequestBytes = 10 << 20;

/** Raised for a blank (non-JSON) input line, mirroring Go's `errEmptyMessage`. */
export class EmptyMessageError extends Error {
  constructor() {
    super("empty message");
    this.name = "EmptyMessageError";
  }
}

/**
 * One decoded ACP JSON-RPC request.
 *
 * `idRaw` carries the raw JSON text of the `id` member (`null` when the member
 * is absent, the literal `"null"`, `"\"request-1\""`, `"1"`, …). Responses echo
 * this text verbatim, and pending-response correlation keys on it, matching Go's
 * `json.RawMessage` semantics.
 */
export interface ACPRPCRequest {
  jsonrpc: string;
  idRaw: string | null;
  method: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** A destination for one JSON line (stdout or an in-memory fixture). */
export interface ACPMessageSink {
  write(data: string): void | Promise<void>;
}

/** Splits an async byte source into newline-delimited lines. */
export class ACPLineReader {
  #iterator: AsyncIterator<Uint8Array>;
  #pending: Uint8Array = new Uint8Array(0);
  #done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Returns the next line's bytes (newline excluded), or null at EOF. */
  async readLine(): Promise<Uint8Array | null> {
    while (true) {
      const newline = indexOfByte(this.#pending, 0x0a);
      if (newline >= 0) {
        const line = this.#pending.subarray(0, newline);
        this.#pending = this.#pending.subarray(newline + 1);
        return line;
      }
      if (this.#done) {
        if (this.#pending.length === 0) return null;
        const line = this.#pending;
        this.#pending = new Uint8Array(0);
        return line;
      }
      const { value, done } = await this.#iterator.next();
      if (done) {
        this.#done = true;
        continue;
      }
      if (value !== undefined && value.length > 0) {
        this.#pending = concatBytes(this.#pending, value);
      }
    }
  }
}

/**
 * Reads one request line. Returns null at EOF, throws `EmptyMessageError` for a
 * blank line, throws on an oversized line, and throws on invalid JSON.
 */
export async function readRequest(
  reader: ACPLineReader,
): Promise<ACPRPCRequest | null> {
  const line = await reader.readLine();
  if (line === null) return null;
  if (line.length > acpMaxRequestBytes) {
    throw new Error(
      `message exceeds maximum size of ${acpMaxRequestBytes} bytes`,
    );
  }
  const payload = new TextDecoder().decode(line).replace(/[\r\n]+$/, "");
  if (payload.trim() === "") throw new EmptyMessageError();
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `parse ACP request: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (
    decoded === null || typeof decoded !== "object" || Array.isArray(decoded)
  ) {
    throw new Error("parse ACP request: not a JSON-RPC object");
  }
  const record = decoded as Record<string, unknown>;
  return {
    jsonrpc: typeof record.jsonrpc === "string" ? record.jsonrpc : "",
    idRaw: topLevelRawField(payload, "id") ?? null,
    method: typeof record.method === "string" ? record.method : "",
    params: record.params,
    result: record.result,
    error: record.error,
  };
}

/**
 * Accepts the JSON-RPC scalar ID domain and notifications. Objects, arrays,
 * booleans, fractional numbers, and exponent forms are invalid ids and must not
 * be echoed back in an error response.
 */
export function validRPCID(idRaw: string | null): boolean {
  if (idRaw === null) return true;
  const trimmed = idRaw.trim();
  if (trimmed === "" || trimmed === "null") return true;
  if (trimmed.startsWith('"')) {
    try {
      return typeof JSON.parse(trimmed) === "string";
    } catch {
      return false;
    }
  }
  // JSON-RPC permits integer numeric ids. A fractional or exponent form is
  // rejected, matching Go's `json.Number.Int64()`.
  return /^-?\d+$/.test(trimmed);
}

/** Writes one JSON value as a single newline-terminated message. */
export async function writeMessage(
  sink: ACPMessageSink,
  value: unknown,
): Promise<void> {
  await sink.write(JSON.stringify(value) + "\n");
}

/**
 * Writes a response, echoing the raw request id verbatim. A notification (an
 * absent or blank id) never receives a response; an explicit `null` id remains
 * a request id and is preserved.
 */
export async function writeACPResponse(
  sink: ACPMessageSink,
  idRaw: string | null,
  result: unknown,
  errResp: RPCError | null,
): Promise<void> {
  if (idRaw === null || idRaw.trim() === "") return;
  const body = errResp !== null
    ? `"error":${JSON.stringify(acpErrorEnvelope(errResp))}`
    : `"result":${JSON.stringify(result ?? null)}`;
  await sink.write(`{"jsonrpc":"2.0","id":${idRaw.trim()},${body}}\n`);
}

/** Projects an `RPCError` onto the JSON-RPC error envelope. */
export function acpErrorEnvelope(err: RPCError): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    code: err.code,
    message: err.message,
  };
  if (err.data !== undefined) envelope.data = err.data;
  return envelope;
}

/** Writes a `session/update` notification. */
export async function notifySessionUpdate(
  sink: ACPMessageSink,
  sessionID: string,
  update: SessionUpdate,
): Promise<void> {
  await writeMessage(sink, {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: sessionID, update },
  });
}

/** Writes an extension notification under its method name. */
export async function notifyExtension(
  sink: ACPMessageSink,
  method: string,
  params: unknown,
): Promise<void> {
  await writeMessage(sink, { jsonrpc: "2.0", method, params });
}

/** Writes a standard ACP reverse request with a string id. */
export async function notifyRequest(
  sink: ACPMessageSink,
  id: string,
  method: string,
  params: unknown,
): Promise<void> {
  await writeMessage(sink, { jsonrpc: "2.0", id, method, params });
}

/** The process-wide ACP request-id counter (`acp-N`). */
export class ACPRequestIDCounter {
  #next = 0;

  next(): string {
    this.#next++;
    return `acp-${this.#next}`;
  }
}

function indexOfByte(bytes: Uint8Array, target: number): number {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === target) return i;
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * Returns the raw JSON text of one top-level object member, or undefined when
 * the member is absent. The line is already known to be valid JSON.
 */
export function topLevelRawField(
  line: string,
  name: string,
): string | undefined {
  let i = 0;
  const n = line.length;
  const skipWhitespace = () => {
    while (
      i < n && (line[i] === " " || line[i] === "\t" || line[i] === "\r" ||
        line[i] === "\n")
    ) i++;
  };
  skipWhitespace();
  if (line[i] !== "{") return undefined;
  i++;
  while (i < n) {
    skipWhitespace();
    if (line[i] === "}") return undefined;
    if (line[i] !== '"') return undefined;
    const keyEnd = scanString(line, i);
    if (keyEnd < 0) return undefined;
    let key: string;
    try {
      key = JSON.parse(line.slice(i, keyEnd)) as string;
    } catch {
      return undefined;
    }
    i = keyEnd;
    skipWhitespace();
    if (line[i] !== ":") return undefined;
    i++;
    skipWhitespace();
    const valueStart = i;
    const valueEnd = skipRawValue(line, i);
    if (valueEnd < 0) return undefined;
    if (key === name) return line.slice(valueStart, valueEnd);
    i = valueEnd;
    skipWhitespace();
    if (line[i] === ",") {
      i++;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function scanString(value: string, start: number): number {
  let i = start + 1;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return -1;
}

function skipRawValue(value: string, start: number): number {
  const ch = value[start];
  if (ch === undefined) return -1;
  if (ch === '"') return scanString(value, start);
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    let depth = 0;
    let i = start;
    while (i < value.length) {
      const current = value[i];
      if (current === '"') {
        const end = scanString(value, i);
        if (end < 0) return -1;
        i = end;
        continue;
      }
      if (current === ch) depth++;
      else if (current === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }
  let i = start;
  while (
    i < value.length && ",}] \t\r\n".indexOf(value[i]) < 0
  ) i++;
  return i;
}
