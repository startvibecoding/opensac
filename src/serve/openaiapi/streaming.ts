// Ported from internal/serve/openaiapi/streaming.go. Go writes to an
// `http.ResponseWriter` with a `http.Flusher`; the port writes SSE frames to a
// synchronous sink (`{ write(chunk) }`) so both the live Deno.serve response
// stream and tests share one writer. The header set and frame shapes are
// byte-faithful.

import {
  type ChatCompletionChoice,
  type ChatCompletionChunk,
  type CompletionUsage,
  type HostedItemEvent,
  newCompletionID,
  type ResponseMessage,
  type ToolStatusEvent,
  type TranscriptStreamEvent,
} from "./types.ts";
import type { Attachment } from "../../provider/types.ts";
import { formatToolResult, type toolCallInfo } from "./tool_format.ts";

/** The byte sink SSEWriter writes frames to (Go's ResponseWriter + Flusher). */
export interface SSEWriterSink {
  write(chunk: string): void;
}

/** The response headers Go sets on the SSE response (Net/http header map). */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "connection": "keep-alive",
  // disable nginx buffering
  "x-accel-buffering": "no",
};

export class SSEWriter {
  readonly #sink: SSEWriterSink;
  readonly model: string;
  readonly id: string;
  readonly created: number;
  readonly sessID: string;

  constructor(sink: SSEWriterSink, model: string, sessionID: string) {
    this.#sink = sink;
    this.model = model;
    this.id = newCompletionID();
    this.created = Math.floor(Date.now() / 1000);
    this.sessID = sessionID;
  }

  /**
   * Creates an SSE writer. The caller sets `SSE_HEADERS` on the HTTP response
   * (Go's NewSSEWriter sets them on the ResponseWriter).
   */
  static create(
    sink: SSEWriterSink,
    model: string,
    sessionID: string,
  ): SSEWriter {
    return new SSEWriter(sink, model, sessionID);
  }

  /** WriteContentDelta sends a text content delta chunk. */
  writeContentDelta(content: string): void {
    this.#writeData(this.#chunk({ index: 0, delta: { content } }));
  }

  /** WriteRoleDelta sends the initial role delta. */
  writeRoleDelta(): void {
    this.#writeData(this.#chunk({ index: 0, delta: { role: "assistant" } }));
  }

  /**
   * WriteToolStatusContent sends a tool status in content mode (text in
   * content delta).
   */
  writeToolStatusContent(title: string, status: string): void {
    this.writeContentDelta(`[${status}] ${title}\n`);
  }

  /** WriteToolResult sends formatted tool output based on detail level. */
  writeToolResult(tc: toolCallInfo, detail: string): void {
    this.writeContentDelta(formatToolResult(tc, detail));
  }

  /** WriteToolStatusEvent sends a tool status as an SSE event (sse_event mode). */
  writeToolStatusEvent(evt: ToolStatusEvent): void {
    this.#writeNamedEvent("tool_status", evt);
  }

  /**
   * WriteTranscriptEvent sends a WebUI transcript event that can be rendered
   * with the same components used for persisted session history.
   */
  writeTranscriptEvent(evt: TranscriptStreamEvent): void {
    if (evt.x_session_id === undefined || evt.x_session_id === "") {
      evt.x_session_id = this.sessID;
    }
    this.#writeNamedEvent("transcript", evt);
  }

  /** WriteAttachments sends provider-neutral artifacts as a dedicated SSE event. */
  writeAttachments(items: Attachment[]): void {
    if (items.length === 0) return;
    this.#writeNamedEvent("attachments", items);
  }

  /**
   * WriteHostedItem sends a native hosted-tool lifecycle event without
   * exposing the provider's unbounded canonical payload to the live client.
   */
  writeHostedItem(item: HostedItemEvent | null): void {
    if (item === null) return;
    this.#writeNamedEvent("hosted_item", item);
  }

  /**
   * WriteApprovalRequest sends a pending tool approval to the client that
   * initiated this streaming completion.
   */
  writeApprovalRequest(request: unknown): void {
    this.#writeNamedEvent("approval_request", request);
  }

  /** WriteStatusEvent sends a non-error progress/status event. */
  writeStatusEvent(message: string): void {
    this.#writeNamedEvent("status", { message });
  }

  writeDone(usage: CompletionUsage | null): void {
    this.writeDoneReason(usage, "stop");
  }

  /**
   * WriteDoneReason sends the final completion chunk with the
   * provider-compatible finish reason.
   */
  writeDoneReason(usage: CompletionUsage | null, finishReason: string): void {
    if (finishReason === "") finishReason = "stop";

    const choice: ChatCompletionChoice = {
      index: 0,
      delta: {},
      finish_reason: finishReason,
    };
    const chunk: ChatCompletionChunk = {
      ...this.#chunk(choice),
      usage: usage ?? undefined,
    };
    this.#writeData(chunk);

    // Send [DONE] sentinel
    this.#sink.write("data: [DONE]\n\n");
  }

  /** WriteError sends an error as a regular SSE data frame. */
  writeError(errMsg: string): void {
    this.#sink.write(
      `data: ${
        JSON.stringify({ error: { message: errMsg, type: "server_error" } })
      }\n\n`,
    );
  }

  #chunk(
    choice: {
      index: number;
      delta?: ResponseMessage;
      finish_reason?: string | null;
    },
  ): ChatCompletionChunk {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{
        index: choice.index,
        delta: choice.delta,
        finish_reason: choice.finish_reason ?? null,
      }],
    };
  }

  #writeData(value: unknown): void {
    this.#sink.write(`data: ${JSON.stringify(value)}\n\n`);
  }

  #writeNamedEvent(name: string, value: unknown): void {
    this.#sink.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }
}

/** Keeps the ResponseMessage delta shape internal to the writer. */
export type SSEDelta = ResponseMessage;
