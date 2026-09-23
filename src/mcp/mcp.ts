//
// Deliberate deviations from the Go original:
//   - `context.Context` maps to `AbortSignal`; timeouts use `AbortSignal.timeout`.
//   - goroutines/channels map to Promises plus async stream readers.
//   - `*exec.Cmd`/`io.WriteCloser` map to `Deno.ChildProcess` and its stdin
//     writer; `net/http.Client` maps to `fetch`.
//   - build-time image preprocessing (`imageproc.PrepareBytes`) is async, so the
//     image-projection helpers and tool `execute` return Promises.
//   - environment maps use a `Record<string, string>` (Deno's `Deno.Command`
//     env shape) instead of a `[]string`.

import {
  defaultPolicy,
  type Mode,
  type Policy,
  prepareBytes,
} from "../imageproc/mod.ts";
import type { ContentBlock, ImageContent } from "../provider/types.ts";
import {
  createTextToolResult,
  operationIDFromContext,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/mod.ts";
import { type MCPServer } from "../config/mcp.ts";
import {
  mcpMaxResponseBytes,
  mcpProtocolVersion,
  parseRPCMessage,
  RPCError,
  type RPCRequest,
  rpcResponseIDKey,
} from "./rpc.ts";

const mcpInitializeTimeoutMS = 15_000;
const mcpListToolsTimeoutMS = 15_000;
const mcpCallTimeoutMS = 60_000;
const mcpMaxListPages = 100;

/**
 * Caps how many images a single MCP tool result may carry into the
 * conversation. Matches the ACP tool-call projection cap so the Desktop
 * renderer never receives more image blocks than it can project.
 */
const mcpMaxProjectedImages = 4;

/** One configured MCP server (alias of the config schema). */
export type ServerConfig = MCPServer;

/** Host-provided callbacks for inbound server traffic. */
export interface Callbacks {
  onNotification?: (
    serverName: string,
    method: string,
    params: unknown,
  ) => void;
  onSamplingCreateMessage?: (
    signal: AbortSignal,
    serverName: string,
    params: unknown,
  ) =>
    | { result?: unknown; error?: RPCError }
    | Promise<{ result?: unknown; error?: RPCError }>;
}

interface McpResponse {
  result?: unknown;
  error?: RPCError;
}

interface Pending {
  resolve: (r: McpResponse) => void;
}

interface MCPKeyValueLike {
  name: string;
  value: string;
}

interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface MCPListToolsResult {
  tools?: MCPToolInfo[];
  nextCursor?: string;
}

export interface MCPContentBlock {
  type?: string;
  text?: string;
  data?: string;
  blob?: string;
  uri?: string;
  mimeType?: string;
  json?: unknown;
}

interface MCPCallToolResult {
  content?: MCPContentBlock[];
  isError?: boolean;
}

interface MCPResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface MCPListResourcesResult {
  resources?: MCPResourceInfo[];
  nextCursor?: string;
}

interface MCPResourceReadResult {
  contents?: MCPContentBlock[];
}

interface MCPPromptInfo {
  name: string;
  description?: string;
}

interface MCPListPromptsResult {
  prompts?: MCPPromptInfo[];
  nextCursor?: string;
}

interface MCPPromptSample {
  role: string;
  content: MCPContentBlock;
}

interface MCPPromptGetResult {
  description?: string;
  messages?: MCPPromptSample[];
}

/** Combines any number of optional abort signals. */
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  if (list.length === 0) return new AbortController().signal;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

function isWindows(): boolean {
  return Deno.build.os === "windows";
}

/** Reads newline-delimited text from a byte stream. */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** The sole owner of one MCP server connection. */
export class Client {
  name: string;
  readonly transport: string;
  private cmd?: Deno.ChildProcess;
  // The members below are package-visible (Go has no `private`) so the
  // translated in-package tests can construct and drive a Client directly.
  stdinWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private writeChain: Promise<void> = Promise.resolve();
  pending = new Map<string, Pending>();
  private closed = false;
  private nextID = 0;
  httpURL = "";
  messageURL = "";
  private headers: Record<string, string> = {};
  private sessionID = "";
  callbacks: Callbacks;
  private controller: AbortController;
  imagePolicy?: (mode: Mode) => Policy;

  constructor(
    name: string,
    transport: string,
    callbacks: Callbacks,
    parentSignal?: AbortSignal,
  ) {
    this.name = name;
    this.transport = transport;
    this.callbacks = callbacks;
    this.controller = new AbortController();
    if (parentSignal) {
      if (parentSignal.aborted) {
        this.controller.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          "abort",
          () => this.controller.abort(parentSignal.reason),
          { once: true },
        );
      }
    }
  }

  /** The connection's own abort signal. */
  context(): AbortSignal {
    return this.controller.signal;
  }

  /** Resolves the image policy for one tool call. */
  imagePolicyFor(mode: Mode): Policy {
    if (this.imagePolicy) return this.imagePolicy(mode);
    return defaultPolicy(mode);
  }

  currentSessionID(): string {
    return this.sessionID;
  }

  setSessionID(sid: string): void {
    const trimmed = (sid ?? "").trim();
    if (trimmed === "") return;
    this.sessionID = trimmed;
  }

  setHeaders(headers: Record<string, string>): void {
    this.headers = headers;
  }

  /** Starts the legacy HTTP+SSE inbound stream. */
  startSSE(ctx: AbortSignal, streamURL: string): void {
    void this.readSSELoop(ctx, streamURL);
  }

  private requestSignal(ctx: AbortSignal | undefined): AbortSignal {
    return combineSignals(ctx, this.context());
  }

  attachStdio(
    cmd: Deno.ChildProcess,
    stdout: ReadableStream<Uint8Array>,
  ): void {
    this.cmd = cmd;
    this.stdinWriter = cmd.stdin!.getWriter();
    void this.readLoop(stdout);
    void cmd.status.then(() => {
      this.closePending(new Error(`MCP server ${this.name} exited`));
    }).catch(() => {
      this.closePending(new Error(`MCP server ${this.name} exited`));
    });
  }

  private toResponse(msg: RPCRequest): McpResponse {
    const resp: McpResponse = { result: msg.result };
    if (msg.error !== undefined && msg.error !== null) {
      const e = msg.error as { code?: number; message?: string };
      if (typeof e.code === "number" && typeof e.message === "string") {
        resp.error = new RPCError(e.code, e.message);
      } else {
        resp.error = new RPCError(-32000, JSON.stringify(msg.error));
      }
    }
    return resp;
  }

  async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const line of readLines(stream)) {
        if (line.trim() === "") continue;
        const msg = parseRPCMessage(line);
        if (msg === undefined) continue;
        if ((msg.method ?? "") !== "") {
          void this.handleInboundRequest(msg);
          continue;
        }
        if (msg.id === undefined || msg.id === null) continue;
        const key = rpcResponseIDKey(msg.id);
        const entry = this.pending.get(key);
        if (entry) {
          this.pending.delete(key);
          entry.resolve(this.toResponse(msg));
        }
      }
      this.closePending(new Error(`MCP server ${this.name} output closed`));
    } catch (err) {
      this.closePending(
        new Error(
          `MCP server ${this.name} output error: ${(err as Error).message}`,
        ),
      );
    }
  }

  private removePending(key: string): void {
    this.pending.delete(key);
  }

  private closePending(err: Error): void {
    const pending = this.pending;
    this.pending = new Map();
    for (const entry of pending.values()) {
      entry.resolve({ error: new RPCError(-32000, err.message) });
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    if (this.stdinWriter) {
      void this.stdinWriter.close().catch(() => {});
    }
    this.closePending(new Error(`MCP client ${this.name} closed`));
    if (this.cmd) {
      try {
        this.cmd.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  }

  // --- transport-agnostic calls ---

  async listTools(ctx: AbortSignal | undefined): Promise<MCPToolInfo[]> {
    const signal = combineSignals(
      ctx,
      AbortSignal.timeout(mcpListToolsTimeoutMS),
    );
    const all: MCPToolInfo[] = [];
    let cursor = "";
    for (let page = 0; page < mcpMaxListPages; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== "") params.cursor = cursor;
      const result = await this.call(signal, "tools/list", params);
      const out = (result ?? {}) as MCPListToolsResult;
      all.push(...(out.tools ?? []));
      if (!out.nextCursor) return all;
      cursor = out.nextCursor;
    }
    throw new Error(`list MCP tools for ${this.name}: too many pages`);
  }

  async callTool(
    ctxSignal: AbortSignal | undefined,
    operationID: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallToolResult> {
    const result = await this.call(
      ctxSignal,
      "tools/call",
      { name, arguments: args },
      operationID,
    );
    const out = (result ?? {}) as MCPCallToolResult;
    if (out.isError) {
      throw new Error(mcpContentToText(out.content ?? []));
    }
    return out;
  }

  async listResources(
    ctx: AbortSignal | undefined,
  ): Promise<MCPResourceInfo[]> {
    const signal = combineSignals(
      ctx,
      AbortSignal.timeout(mcpListToolsTimeoutMS),
    );
    const all: MCPResourceInfo[] = [];
    let cursor = "";
    for (let page = 0; page < mcpMaxListPages; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== "") params.cursor = cursor;
      const result = await this.call(signal, "resources/list", params);
      const out = (result ?? {}) as MCPListResourcesResult;
      all.push(...(out.resources ?? []));
      if (!out.nextCursor) return all;
      cursor = out.nextCursor;
    }
    throw new Error(`list MCP resources for ${this.name}: too many pages`);
  }

  async readResource(
    ctx: AbortSignal | undefined,
    uri: string,
  ): Promise<MCPResourceReadResult> {
    const result = await this.call(ctx, "resources/read", { uri });
    return (result ?? {}) as MCPResourceReadResult;
  }

  async listPrompts(ctx: AbortSignal | undefined): Promise<MCPPromptInfo[]> {
    const signal = combineSignals(
      ctx,
      AbortSignal.timeout(mcpListToolsTimeoutMS),
    );
    const all: MCPPromptInfo[] = [];
    let cursor = "";
    for (let page = 0; page < mcpMaxListPages; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== "") params.cursor = cursor;
      const result = await this.call(signal, "prompts/list", params);
      const out = (result ?? {}) as MCPListPromptsResult;
      all.push(...(out.prompts ?? []));
      if (!out.nextCursor) return all;
      cursor = out.nextCursor;
    }
    throw new Error(`list MCP prompts for ${this.name}: too many pages`);
  }

  async getPrompt(
    ctx: AbortSignal | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPPromptGetResult> {
    const params: Record<string, unknown> = { name };
    if (Object.keys(args).length > 0) params.arguments = args;
    const result = await this.call(ctx, "prompts/get", params);
    return (result ?? {}) as MCPPromptGetResult;
  }

  async call(
    ctx: AbortSignal | undefined,
    method: string,
    params: unknown,
    operationID = "",
  ): Promise<unknown> {
    if (this.transport === "http") {
      return await this.callHTTP(ctx, method, params, operationID);
    }
    if (this.transport === "sse") {
      return await this.callSSE(ctx, method, params, operationID);
    }
    const id = ++this.nextID;
    const key = String(id);
    const p = new Promise<McpResponse>((resolve) => {
      this.pending.set(key, { resolve });
    });
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined && params !== null) msg.params = params;
    try {
      await this.writeMessage(msg);
    } catch (err) {
      this.removePending(key);
      throw err;
    }
    try {
      const resp = await this.awaitResponse(ctx, p);
      if (resp.error) throw resp.error;
      return resp.result;
    } catch (err) {
      this.removePending(key);
      throw err;
    }
  }

  private async awaitResponse(
    ctx: AbortSignal | undefined,
    p: Promise<McpResponse>,
  ): Promise<McpResponse> {
    if (!ctx) return await p;
    if (ctx.aborted) throw ctx.reason ?? new Error("aborted");
    const aborted = new Promise<never>((_, reject) => {
      ctx.addEventListener(
        "abort",
        () => reject(ctx.reason ?? new Error("aborted")),
        { once: true },
      );
    });
    return await Promise.race([p, aborted]);
  }

  private async callSSE(
    ctx: AbortSignal | undefined,
    method: string,
    params: unknown,
    operationID: string,
  ): Promise<unknown> {
    const id = ++this.nextID;
    const key = String(id);
    const p = new Promise<McpResponse>((resolve) => {
      this.pending.set(key, { resolve });
    });
    let result: unknown;
    try {
      result = await this.callHTTPInternal(
        ctx,
        method,
        params,
        false,
        id,
        operationID,
      );
    } catch (err) {
      this.removePending(key);
      throw err;
    }
    if (
      result !== undefined &&
      result !== null &&
      !(typeof result === "object" &&
        Object.keys(result as object).length === 0)
    ) {
      this.removePending(key);
      return result;
    }
    try {
      const resp = await this.awaitResponse(ctx, p);
      if (resp.error) throw resp.error;
      return resp.result;
    } catch (err) {
      this.removePending(key);
      throw err;
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.transport === "http" || this.transport === "sse") {
      await this.callHTTPInternal(
        AbortSignal.timeout(mcpCallTimeoutMS),
        method,
        params,
        true,
        undefined,
        "",
      );
      return;
    }
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined && params !== null) msg.params = params;
    await this.writeMessage(msg);
  }

  callHTTP(
    ctx: AbortSignal | undefined,
    method: string,
    params: unknown,
    operationID = "",
  ): Promise<unknown> {
    return this.callHTTPInternal(
      ctx,
      method,
      params,
      false,
      undefined,
      operationID,
    );
  }

  private async callHTTPInternal(
    ctx: AbortSignal | undefined,
    method: string,
    params: unknown,
    isNotification: boolean,
    reqID: number | undefined,
    operationID: string,
  ): Promise<unknown> {
    const signal = this.requestSignal(ctx);
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    let id = 0;
    if (!isNotification) {
      id = reqID !== undefined ? reqID : ++this.nextID;
      msg.id = id;
    }
    if (params !== undefined && params !== null) msg.params = params;
    const body = JSON.stringify(msg);

    const target = this.transport === "sse" ? this.messageURL : this.httpURL;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
    };
    if (operationID) headers["Idempotency-Key"] = operationID;
    if (this.sessionID) headers["Mcp-Session-Id"] = this.sessionID;

    const resp = await fetch(target, {
      method: "POST",
      headers,
      body,
      signal,
    });
    const sid = (resp.headers.get("Mcp-Session-Id") ?? "").trim();
    if (sid) this.setSessionID(sid);
    if (resp.status < 200 || resp.status >= 300) {
      const data = (await resp.text()).slice(0, 8192);
      throw new Error(`HTTP ${resp.status}: ${data.trim()}`);
    }
    if (isNotification || resp.status === 202) {
      await resp.body?.cancel();
      return {};
    }
    const ct = (resp.headers.get("Content-Type") ?? "").toLowerCase();
    if (ct.includes("text/event-stream")) {
      if (!resp.body) throw new Error("empty SSE response body");
      return await parseSSECallResponse(resp.body, id);
    }
    const text = await resp.text();
    if (new TextEncoder().encode(text).length > mcpMaxResponseBytes) {
      throw new Error(`MCP response exceeds ${mcpMaxResponseBytes} bytes`);
    }
    if (text.trim() === "") return {};
    const rpcResp = parseRPCMessage(text);
    if (rpcResp === undefined) {
      throw new Error("decode MCP response: malformed or non-object JSON");
    }
    if (rpcResp.jsonrpc !== "2.0") {
      throw new Error(
        `invalid JSON-RPC version ${JSON.stringify(rpcResp.jsonrpc)}`,
      );
    }
    if (
      rpcResp.id === undefined ||
      rpcResponseIDKey(rpcResp.id) !== String(id)
    ) {
      throw new Error(
        `JSON-RPC response id ${
          JSON.stringify(rpcResp.id)
        } does not match request id ${id}`,
      );
    }
    if (rpcResp.error !== undefined && rpcResp.error !== null) {
      const e = rpcResp.error as { code?: number; message?: string };
      if (typeof e.code === "number" && typeof e.message === "string") {
        throw new RPCError(e.code, e.message);
      }
      throw new Error(JSON.stringify(rpcResp.error));
    }
    return rpcResp.result;
  }

  private async writeMessage(msg: unknown): Promise<void> {
    if (this.closed) throw new Error("MCP client is closed");
    if (this.transport === "http" || this.transport === "sse") {
      const signal = combineSignals(
        this.context(),
        AbortSignal.timeout(mcpCallTimeoutMS),
      );
      await this.postRPCMessage(signal, msg);
      return;
    }
    if (!this.stdinWriter) throw new Error("MCP stdin is not available");
    const data = new TextEncoder().encode(JSON.stringify(msg) + "\n");
    this.writeChain = this.writeChain.then(() => this.stdinWriter!.write(data));
    await this.writeChain;
  }

  private async postRPCMessage(
    ctx: AbortSignal,
    msg: unknown,
  ): Promise<void> {
    const data = JSON.stringify(msg);
    const target = this.transport === "sse" && this.messageURL
      ? this.messageURL
      : this.httpURL;
    const signal = this.requestSignal(ctx);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...this.headers,
    };
    if (this.sessionID) headers["Mcp-Session-Id"] = this.sessionID;
    const resp = await fetch(target, {
      method: "POST",
      headers,
      body: data,
      signal,
    });
    const sid = (resp.headers.get("Mcp-Session-Id") ?? "").trim();
    if (sid) this.setSessionID(sid);
    if (resp.status < 200 || resp.status >= 300) {
      const body = (await resp.text()).slice(0, 8192);
      throw new Error(`HTTP ${resp.status}: ${body.trim()}`);
    }
    await resp.body?.cancel();
  }

  private async readSSELoop(
    ctx: AbortSignal,
    streamURL: string,
  ): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(streamURL, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.headers },
        signal: ctx,
      });
    } catch (err) {
      this.closePending(
        new Error(
          `MCP server ${this.name} sse connect: ${(err as Error).message}`,
        ),
      );
      return;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const data = (await resp.text().catch(() => "")).slice(0, 8192);
      this.closePending(
        new Error(
          `MCP server ${this.name} sse HTTP ${resp.status}: ${data.trim()}`,
        ),
      );
      return;
    }
    const sid = (resp.headers.get("Mcp-Session-Id") ?? "").trim();
    if (sid) this.setSessionID(sid);
    if (!resp.body) {
      this.closePending(new Error(`MCP server ${this.name} sse stream closed`));
      return;
    }
    let dataLines: string[] = [];
    try {
      for await (const line of readLines(resp.body)) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
          continue;
        }
        if (line !== "") continue;
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        dataLines = [];
        const msg = parseRPCMessage(payload);
        if (msg === undefined) continue;
        if ((msg.method ?? "") !== "") {
          void this.handleInboundRequest(msg);
          continue;
        }
        if (msg.id === undefined || msg.id === null) continue;
        const key = rpcResponseIDKey(msg.id);
        const entry = this.pending.get(key);
        if (!entry) continue;
        this.pending.delete(key);
        entry.resolve(this.toResponse(msg));
      }
    } catch (err) {
      this.closePending(
        new Error(
          `MCP server ${this.name} sse stream error: ${(err as Error).message}`,
        ),
      );
      return;
    }
    this.closePending(new Error(`MCP server ${this.name} sse stream closed`));
  }

  /** Fire-and-forget inbound dispatch (matches the race-free Go sink). */
  async handleInboundRequest(msg: RPCRequest): Promise<void> {
    if (msg.id === undefined || msg.id === null) {
      this.handleInboundNotification(msg);
      return;
    }
    switch (msg.method) {
      case "ping":
        await this.writeMessageSafely({
          jsonrpc: "2.0",
          id: msg.id,
          result: {},
        });
        return;
      case "sampling/createMessage":
        if (this.callbacks.onSamplingCreateMessage) {
          const { result, error } = await this.callbacks
            .onSamplingCreateMessage(
              this.context(),
              this.name,
              msg.params,
            );
          if (error) {
            await this.writeMessageSafely({
              jsonrpc: "2.0",
              id: msg.id,
              error,
            });
            return;
          }
          await this.writeMessageSafely({
            jsonrpc: "2.0",
            id: msg.id,
            result: result ?? {},
          });
          return;
        }
        await this.writeMessageSafely({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message:
              "sampling/createMessage is not enabled in this ACP runtime yet",
          },
        });
        return;
      default:
        await this.writeMessageSafely({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "method not found" },
        });
    }
  }

  private async writeMessageSafely(msg: unknown): Promise<void> {
    try {
      await this.writeMessage(msg);
    } catch {
      // best effort: the peer may already be gone
    }
  }

  handleInboundNotification(msg: RPCRequest): void {
    if (this.callbacks.onNotification) {
      this.callbacks.onNotification(this.name, msg.method ?? "", msg.params);
    }
    // notifications/progress, notifications/message, logging/message and
    // notifications/cancelled are all acknowledged by doing nothing.
  }

  /** Projects MCP content blocks into text plus provider content blocks. */
  async projectMCPContent(
    blocks: MCPContentBlock[],
  ): Promise<{ text: string; contents?: ContentBlock[] }> {
    const parts: string[] = [];
    const images: ContentBlock[] = [];
    for (const block of blocks) {
      const [kind, payload, mimeType] = classifyMCPBlock(block);
      switch (kind) {
        case "text":
          if (block.text) parts.push(block.text);
          break;
        case "json":
          if (block.json !== undefined && block.json !== null) {
            parts.push(
              typeof block.json === "string"
                ? block.json
                : JSON.stringify(block.json),
            );
          }
          break;
        case "image": {
          const [image, note] = await this.projectMCPImage(
            payload,
            mimeType,
            images.length,
          );
          if (image) images.push({ type: "image", image });
          if (note) parts.push(note);
          break;
        }
        case "audio":
          parts.push(`[${block.type} content: ${mimeType}]`);
          break;
        case "blob":
          parts.push(`[binary content: ${mimeType}]`);
          break;
        default:
          parts.push(JSON.stringify(block));
      }
    }
    const text = parts.join("\n");
    if (images.length === 0) return { text };
    const contents: ContentBlock[] = [];
    if (text !== "") contents.push({ type: "text", text });
    contents.push(...images);
    return { text, contents };
  }

  private async projectMCPImage(
    payload: string,
    mimeType: string,
    already: number,
  ): Promise<[ImageContent | undefined, string]> {
    const label = (mimeType ?? "").trim() || "unknown";
    if ((payload ?? "").trim() === "") {
      return [undefined, `[Image ${label} omitted: empty payload]`];
    }
    if (already >= mcpMaxProjectedImages) {
      return [
        undefined,
        `[Image ${label} omitted: at most ${mcpMaxProjectedImages} images per tool result]`,
      ];
    }
    let raw: Uint8Array;
    try {
      raw = base64Decode(payload);
    } catch {
      return [undefined, `[Image ${label} omitted: invalid base64 payload]`];
    }
    let result;
    try {
      result = await prepareBytes(raw, this.imagePolicyFor("auto"));
    } catch (err) {
      return [undefined, `[Image ${label} omitted: ${(err as Error).message}]`];
    }
    const image: ImageContent = {
      data: base64Encode(result.data),
      mimeType: result.mimeType,
      width: result.meta.width,
      height: result.meta.height,
      bytes: result.meta.bytes,
      originalWidth: result.meta.originalWidth,
      originalHeight: result.meta.originalHeight,
      originalBytes: result.meta.originalBytes,
      detail: result.meta.detail,
      scale: result.meta.scale,
      cropped: result.meta.cropped,
      cropX: result.meta.cropX,
      cropY: result.meta.cropY,
      cropWidth: result.meta.cropWidth,
      cropHeight: result.meta.cropHeight,
    };
    return [
      image,
      `[Image: ${result.mimeType} ${result.meta.width}x${result.meta.height}, ${
        mcpFormatBytes(result.meta.bytes)
      }]`,
    ];
  }
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  return btoa(bin);
}

/** Parses one SSE `data:` response and returns its matching JSON-RPC result. */
export async function parseSSECallResponse(
  input: ReadableStream<Uint8Array>,
  expectID: number,
): Promise<unknown> {
  let payload: string[] = [];
  const flush = (): unknown | undefined => {
    if (payload.length === 0) return undefined;
    const joined = payload.join("\n");
    payload = [];
    const rpcResp = parseRPCMessage(joined);
    if (rpcResp === undefined) return undefined;
    if (
      rpcResp.jsonrpc !== "2.0" ||
      rpcResponseIDKey(rpcResp.id) !== String(expectID)
    ) {
      return undefined;
    }
    if (rpcResp.error !== undefined && rpcResp.error !== null) {
      const e = rpcResp.error as { code?: number; message?: string };
      if (typeof e.code === "number" && typeof e.message === "string") {
        throw new RPCError(e.code, e.message);
      }
      throw new Error(JSON.stringify(rpcResp.error));
    }
    return rpcResp.result;
  };
  for await (const line of readLines(input)) {
    if (line.startsWith("data:")) {
      payload.push(line.slice("data:".length).trim());
      continue;
    }
    if (line === "" && payload.length > 0) {
      const result = flush();
      if (result !== undefined) return result;
    }
  }
  throw new Error("no RPC response found in SSE stream");
}

/** Connects every configured server and registers its tools. */
export async function connectServers(
  ctx: AbortSignal,
  configs: ServerConfig[],
  registry: Registry,
  callbacks: Callbacks,
): Promise<Client[]> {
  const clients: Client[] = [];
  const seenServers = new Set<string>();
  const registeredToolNames = new Set<string>();
  for (const t of registry.all()) registeredToolNames.add(t.name());
  try {
    for (const cfg of configs) {
      const trimmedName = (cfg.name ?? "").trim();
      if (seenServers.has(trimmedName)) {
        throw new Error(
          `duplicate MCP server name ${JSON.stringify(cfg.name)}`,
        );
      }
      seenServers.add(trimmedName);
      const client = await createMCPClient(ctx, cfg, callbacks);
      // Bind the image policy lazily through the registry method value.
      client.imagePolicy = (mode) => registry.imagePolicy(mode);
      clients.push(client);
      const toolInfos = await client.listTools(ctx);
      for (const info of toolInfos) {
        if ((info.name ?? "").trim() === "") continue;
        const tool = createMCPTool(client, info, registeredToolNames);
        registeredToolNames.add(tool.name());
        registry.register(tool);
      }
      let resourceInfos: MCPResourceInfo[];
      try {
        resourceInfos = await client.listResources(ctx);
      } catch (err) {
        if (!isMCPMethodNotFound(err)) {
          throw new Error(
            `list MCP resources for ${client.name}: ${(err as Error).message}`,
          );
        }
        resourceInfos = [];
      }
      for (const info of resourceInfos) {
        if ((info.uri ?? "").trim() === "") continue;
        const tool = createMCPResourceTool(client, info, registeredToolNames);
        registeredToolNames.add(tool.name());
        registry.register(tool);
      }
      let promptInfos: MCPPromptInfo[];
      try {
        promptInfos = await client.listPrompts(ctx);
      } catch (err) {
        if (!isMCPMethodNotFound(err)) {
          throw new Error(
            `list MCP prompts for ${client.name}: ${(err as Error).message}`,
          );
        }
        promptInfos = [];
      }
      for (const info of promptInfos) {
        if ((info.name ?? "").trim() === "") continue;
        const tool = createMCPPromptTool(client, info, registeredToolNames);
        registeredToolNames.add(tool.name());
        registry.register(tool);
      }
    }
  } catch (err) {
    closeClients(clients);
    throw err;
  }
  return clients;
}

/** Reports whether the error is a JSON-RPC method-not-found error. */
export function isMCPMethodNotFound(err: unknown): boolean {
  return err instanceof RPCError && err.code === -32601;
}

/** Closes every client. */
export function closeClients(clients: Client[]): void {
  for (const client of clients) client.close();
}

async function createMCPClient(
  ctx: AbortSignal,
  cfg: ServerConfig,
  callbacks: Callbacks,
): Promise<Client> {
  if ((cfg.name ?? "").trim() === "") {
    throw new Error("MCP server name is required");
  }
  let transport = (cfg.type ?? "").trim();
  if (transport === "") transport = "stdio";
  switch (transport) {
    case "stdio":
      return await createMCPStdioClient(ctx, cfg, callbacks);
    case "http":
      return await createMCPHTTPClient(ctx, cfg, false, callbacks);
    case "sse":
      return await createMCPHTTPClient(ctx, cfg, true, callbacks);
    default:
      throw new Error(
        `unsupported MCP transport ${JSON.stringify(cfg.type)} for server ${
          JSON.stringify(cfg.name)
        }`,
      );
  }
}

async function createMCPStdioClient(
  ctx: AbortSignal,
  cfg: ServerConfig,
  callbacks: Callbacks,
): Promise<Client> {
  const command = (cfg.command ?? "").trim();
  if (command === "") {
    throw new Error(
      `MCP server ${JSON.stringify(cfg.name)} command is required`,
    );
  }
  const env = mergeMCPEnvironment(cfg.env ?? []);
  let resolvedCommand: string;
  try {
    resolvedCommand = resolveMCPCommand(command, env);
  } catch (err) {
    throw new Error(
      `resolve MCP server ${JSON.stringify(cfg.name)} command ${
        JSON.stringify(command)
      }: ${(err as Error).message}`,
    );
  }

  const client = new Client(cfg.name, "stdio", callbacks, ctx);
  let cmd: Deno.ChildProcess;
  try {
    cmd = new Deno.Command(resolvedCommand, {
      args: cfg.args ?? [],
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
  } catch (err) {
    client.close();
    throw new Error(
      `start MCP server ${JSON.stringify(cfg.name)}: ${(err as Error).message}`,
    );
  }
  client.attachStdio(cmd, cmd.stdout);

  try {
    await client.call(
      combineSignals(ctx, AbortSignal.timeout(mcpInitializeTimeoutMS)),
      "initialize",
      {
        protocolVersion: mcpProtocolVersion,
        capabilities: {},
        clientInfo: { name: "vibecoding", title: "VibeCoding", version: "dev" },
      },
    );
    await client.notify("notifications/initialized", undefined);
  } catch (err) {
    client.close();
    throw new Error(
      `initialize MCP server ${JSON.stringify(cfg.name)}: ${
        (err as Error).message
      }`,
    );
  }
  return client;
}

/** Merges configured overrides into the inherited process environment. */
export function mergeMCPEnvironment(
  overrides: MCPKeyValueLike[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) env[k] = v;
  const canonical = new Map<string, string>();
  for (const key of Object.keys(env)) {
    canonical.set(normalizeMCPEnvName(key), key);
  }
  for (const override of overrides) {
    const name = (override.name ?? "").trim();
    if (name === "") throw new Error("environment variable name is empty");
    if (
      name.includes("=") || name.includes("\0") || override.value.includes("\0")
    ) {
      throw new Error(`invalid environment variable ${JSON.stringify(name)}`);
    }
    const key = normalizeMCPEnvName(name);
    const existing = canonical.get(key);
    if (existing !== undefined && existing !== name) delete env[existing];
    canonical.set(key, name);
    env[name] = override.value;
  }
  return env;
}

function normalizeMCPEnvName(name: string): string {
  return isWindows() ? name.toUpperCase() : name;
}

function mcpEnvValue(env: Record<string, string>, name: string): string {
  const key = normalizeMCPEnvName(name);
  for (const [k, v] of Object.entries(env)) {
    if (normalizeMCPEnvName(k) === key) return v;
  }
  return "";
}

/** Resolves an MCP server command against a configured PATH. */
export function resolveMCPCommand(
  command: string,
  env: Record<string, string>,
): string {
  if (command.includes("\0")) throw new Error("command contains NUL byte");
  if (
    command.includes("/") ||
    (isWindows() && (command.includes("/") || command.includes("\\")))
  ) {
    try {
      checkMCPExecutable(command);
      return command;
    } catch (err) {
      throw new Error(
        `exec: ${JSON.stringify(command)}: ${(err as Error).message}`,
      );
    }
  }
  const pathValue = mcpEnvValue(env, "PATH");
  const sep = isWindows() ? ";" : ":";
  for (let dir of pathValue.split(sep)) {
    if (dir === "") dir = ".";
    const candidate = joinPath(dir, command);
    for (const p of mcpCommandCandidates(candidate, env)) {
      try {
        checkMCPExecutable(p);
        return p;
      } catch {
        // keep searching
      }
    }
  }
  throw new Error(
    `exec: ${JSON.stringify(command)}: executable file not found in $PATH`,
  );
}

function mcpCommandCandidates(
  candidate: string,
  env: Record<string, string>,
): string[] {
  if (!isWindows() || extname(candidate) !== "") return [candidate];
  let extensions = mcpEnvValue(env, "PATHEXT").split(";").filter(Boolean);
  if (extensions.length === 0) extensions = [".COM", ".EXE", ".BAT", ".CMD"];
  return extensions.map((ext) => candidate + ext);
}

function checkMCPExecutable(path: string): void {
  const info = Deno.statSync(path);
  if (info.isDirectory) throw new Error("path is a directory");
  if (!isWindows() && ((info.mode ?? 0) & 0o111) === 0) {
    throw new Deno.errors.PermissionDenied("permission denied");
  }
}

function joinPath(dir: string, name: string): string {
  const sep = isWindows() ? "\\" : "/";
  if (dir.endsWith(sep)) return dir + name;
  return dir + sep + name;
}

function extname(p: string): string {
  const base = p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

async function createMCPHTTPClient(
  ctx: AbortSignal,
  cfg: ServerConfig,
  legacySSE: boolean,
  callbacks: Callbacks,
): Promise<Client> {
  const rawURL = (cfg.url ?? "").trim();
  if (rawURL === "") {
    throw new Error(
      `MCP server ${
        JSON.stringify(cfg.name)
      } url is required for ${cfg.type} transport`,
    );
  }
  let parsedURL: URL;
  try {
    parsedURL = new URL(rawURL);
  } catch {
    throw new Error(
      `MCP server ${JSON.stringify(cfg.name)} url must be a valid http(s) URL`,
    );
  }
  if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
    throw new Error(
      `MCP server ${JSON.stringify(cfg.name)} url must be a valid http(s) URL`,
    );
  }

  const client = new Client(cfg.name, cfg.type ?? "", callbacks, ctx);
  const headers: Record<string, string> = {};
  for (const h of cfg.headers ?? []) {
    const name = (h.name ?? "").trim();
    if (name === "") continue;
    headers[name] = h.value;
  }
  client.httpURL = rawURL;
  client.setHeaders(headers);

  if (legacySSE) {
    const msgURL = (cfg.messageUrl ?? "").trim();
    if (msgURL === "") {
      client.close();
      throw new Error(
        `MCP server ${
          JSON.stringify(cfg.name)
        } messageUrl is required for sse transport`,
      );
    }
    let parsedMessageURL: URL;
    try {
      parsedMessageURL = new URL(msgURL);
    } catch {
      client.close();
      throw new Error(
        `MCP server ${
          JSON.stringify(cfg.name)
        } messageUrl must be a valid http(s) URL`,
      );
    }
    if (
      parsedMessageURL.protocol !== "http:" &&
      parsedMessageURL.protocol !== "https:"
    ) {
      client.close();
      throw new Error(
        `MCP server ${
          JSON.stringify(cfg.name)
        } messageUrl must be a valid http(s) URL`,
      );
    }
    client.messageURL = msgURL;
    client.startSSE(client.context(), rawURL);
  }

  try {
    await client.call(
      combineSignals(ctx, AbortSignal.timeout(mcpInitializeTimeoutMS)),
      "initialize",
      {
        protocolVersion: mcpProtocolVersion,
        capabilities: {},
        clientInfo: { name: "vibecoding", title: "VibeCoding", version: "dev" },
      },
    );
    await client.notify("notifications/initialized", undefined);
  } catch (err) {
    client.close();
    throw new Error(
      `initialize MCP server ${JSON.stringify(cfg.name)}: ${
        (err as Error).message
      }`,
    );
  }
  return client;
}

/** -- Tool projections -- */

class MCPTool implements Tool {
  private client: Client;
  private info: MCPToolInfo;
  private toolName: string;

  constructor(client: Client, info: MCPToolInfo, toolName: string) {
    this.client = client;
    this.info = info;
    this.toolName = toolName;
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    if (this.info.description) return this.info.description;
    return "Tool provided by MCP server " + this.client.name;
  }

  promptSnippet(): string {
    return `${this.toolName}: MCP tool ${
      JSON.stringify(this.info.name)
    } from server ${JSON.stringify(this.client.name)}`;
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    if (this.info.inputSchema === undefined || this.info.inputSchema === null) {
      return { type: "object" };
    }
    return this.info.inputSchema;
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const op = operationIDFromContext(ctx);
    const result = await this.client.callTool(
      ctx.signal,
      op ?? "",
      this.info.name,
      params,
    );
    const { text, contents } = await this.client.projectMCPContent(
      result.content ?? [],
    );
    if (contents === undefined) return createTextToolResult(text);
    return { text, contents };
  }
}

class MCPResourceTool implements Tool {
  private client: Client;
  private info: MCPResourceInfo;
  private toolName: string;

  constructor(client: Client, info: MCPResourceInfo, toolName: string) {
    this.client = client;
    this.info = info;
    this.toolName = toolName;
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    if ((this.info.description ?? "").trim() !== "") {
      return this.info.description!;
    }
    return `Read MCP resource ${this.info.uri} from server ${this.client.name}`;
  }

  promptSnippet(): string {
    return `${this.toolName}: MCP resource reader for ${
      JSON.stringify(this.info.uri)
    } on ${JSON.stringify(this.client.name)}`;
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "Override resource URI (optional).",
        },
      },
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    let uri = this.info.uri;
    const override = params["uri"];
    if (typeof override === "string" && override.trim() !== "") uri = override;
    const out = await this.client.readResource(ctx.signal, uri);
    const { text, contents } = await this.client.projectMCPContent(
      out.contents ?? [],
    );
    if (contents === undefined) return createTextToolResult(text);
    return { text, contents };
  }
}

class MCPPromptTool implements Tool {
  private client: Client;
  private info: MCPPromptInfo;
  private toolName: string;

  constructor(client: Client, info: MCPPromptInfo, toolName: string) {
    this.client = client;
    this.info = info;
    this.toolName = toolName;
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    if ((this.info.description ?? "").trim() !== "") {
      return this.info.description!;
    }
    return `Render MCP prompt ${this.info.name} from server ${this.client.name}`;
  }

  promptSnippet(): string {
    return `${this.toolName}: MCP prompt ${
      JSON.stringify(this.info.name)
    } from server ${JSON.stringify(this.client.name)}`;
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      additionalProperties: true,
      description: "Arguments passed to prompts/get.",
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const out = await this.client.getPrompt(ctx.signal, this.info.name, params);
    const parts: string[] = [];
    if ((out.description ?? "").trim() !== "") parts.push(out.description!);
    for (const msg of out.messages ?? []) {
      const content = mcpContentToText([msg.content]);
      if (content.trim() === "") continue;
      parts.push(`[${msg.role}]\n${content}`);
    }
    return createTextToolResult(parts.join("\n\n"));
  }
}

function createMCPTool(
  client: Client,
  info: MCPToolInfo,
  existing: Set<string>,
): Tool {
  const base = "mcp_" + sanitizeToolName(client.name) + "_" +
    sanitizeToolName(info.name);
  return new MCPTool(client, info, uniqueToolName(base, existing));
}

function createMCPResourceTool(
  client: Client,
  info: MCPResourceInfo,
  existing: Set<string>,
): Tool {
  let id = info.name;
  if ((id ?? "").trim() === "") id = info.uri;
  const base = "mcp_" +
    sanitizeToolName(client.name) +
    "_resource_" +
    sanitizeToolName(id ?? "");
  return new MCPResourceTool(client, info, uniqueToolName(base, existing));
}

function createMCPPromptTool(
  client: Client,
  info: MCPPromptInfo,
  existing: Set<string>,
): Tool {
  const base = "mcp_" + sanitizeToolName(client.name) + "_prompt_" +
    sanitizeToolName(info.name);
  return new MCPPromptTool(client, info, uniqueToolName(base, existing));
}

/** Replaces every non-alphanumeric character with `_`. */
export function sanitizeToolName(name: string): string {
  let out = "";
  for (const r of name) {
    if (
      (r >= "a" && r <= "z") ||
      (r >= "A" && r <= "Z") ||
      (r >= "0" && r <= "9")
    ) {
      out += r;
    } else {
      out += "_";
    }
  }
  out = out.replace(/^_+|_+$/g, "");
  return out === "" ? "tool" : out;
}

export function mcpContentToText(blocks: MCPContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "image":
      case "audio":
        parts.push(`[${block.type} content: ${block.mimeType}]`);
        break;
      default:
        if (
          block.type === "json" && block.json !== undefined &&
          block.json !== null
        ) {
          parts.push(
            typeof block.json === "string"
              ? block.json
              : JSON.stringify(block.json),
          );
          continue;
        }
        parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

/**
 * Normalizes the two MCP content spellings. tools/call results carry an
 * explicit type, while resources/read contents omit "type" and distinguish
 * text from binary through "text" versus "blob".
 */
export function classifyMCPBlock(
  block: MCPContentBlock,
): [kind: string, payload: string, mimeType: string] {
  const type = block.type ?? "";
  switch (type) {
    case "text":
    case "json":
    case "audio":
      return [type, "", block.mimeType ?? ""];
    case "image":
      return ["image", block.data ?? "", block.mimeType ?? ""];
    case "":
      if (block.blob) {
        if ((block.mimeType ?? "").trim().toLowerCase().startsWith("image/")) {
          return ["image", block.blob, block.mimeType ?? ""];
        }
        return ["blob", "", block.mimeType ?? ""];
      }
      if (block.data) return ["image", block.data, block.mimeType ?? ""];
      return ["text", "", block.mimeType ?? ""];
    default:
      return [type, "", block.mimeType ?? ""];
  }
}

function mcpFormatBytes(n: number): string {
  const unit = 1024;
  if (n < unit) return `${n}B`;
  const kb = n / unit;
  if (kb < unit) return `${kb.toFixed(1)}KB`;
  return `${(kb / unit).toFixed(1)}MB`;
}

export function uniqueToolName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1_000_000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/** Extracts the concatenated text from a sampling/createMessage request. */
export function extractSamplingPrompt(params: unknown): string {
  const req = params as {
    messages?: Array<{ content?: unknown }>;
  };
  if (!req || !Array.isArray(req.messages)) return "";
  const parts: string[] = [];
  for (const msg of req.messages) {
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim() !== "") parts.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item !== "object" || item === null) continue;
        const block = item as Record<string, unknown>;
        const blockType = block["type"];
        if (
          typeof blockType === "string" && blockType !== "" &&
          blockType !== "text"
        ) {
          continue;
        }
        const text = block["text"];
        if (typeof text === "string" && text.trim() !== "") parts.push(text);
      }
    } else if (typeof content === "object" && content !== null) {
      const text = (content as Record<string, unknown>)["text"];
      if (typeof text === "string" && text.trim() !== "") parts.push(text);
    }
  }
  return parts.join("\n");
}
