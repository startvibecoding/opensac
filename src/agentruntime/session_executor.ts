import {
  type Event,
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_RUN_FINISHED,
} from "../agent/events.ts";
import { generateID } from "../session/entry.ts";

/** One front-end-neutral event emitted by a shared session executor. */
export interface SessionExecutorEvent {
  type: number;
  payload: Record<string, unknown>;
  terminal: boolean;
  agentEvent?: Event;
}

/** Converts one Agent event into the shared executor vocabulary. */
export function fromAgentEvent(event: Event): SessionExecutorEvent {
  const payload: Record<string, unknown> = {};
  if (event.textDelta !== undefined) payload.text = event.textDelta;
  if (event.thinkDelta !== undefined) payload.thinking = event.thinkDelta;
  if (event.status !== undefined) payload.status = event.status;
  if (event.stopReason !== undefined) payload.stopReason = event.stopReason;
  if (event.toolCallId !== undefined) payload.toolCallId = event.toolCallId;
  if (event.toolName !== undefined) payload.toolName = event.toolName;
  if (event.approvalId !== undefined) payload.approvalId = event.approvalId;
  if (event.approvalTool !== undefined) {
    payload.approvalTool = event.approvalTool;
  }
  if (event.approvalArgs !== undefined) {
    payload.approvalArgs = event.approvalArgs;
  }
  if (event.questionId !== undefined) payload.questionId = event.questionId;
  if (event.questionText !== undefined) {
    payload.questionText = event.questionText;
  }
  if (event.questionOptions !== undefined) {
    payload.questionOptions = event.questionOptions;
  }
  if (event.questionContext !== undefined) {
    payload.questionContext = event.questionContext;
  }
  if (event.error !== undefined) payload.error = event.error.message;
  if (event.done !== undefined) payload.done = event.done;
  return {
    type: event.type,
    payload,
    terminal: event.type === EVENT_RUN_FINISHED || event.type === EVENT_DONE ||
      event.type === EVENT_ERROR,
    agentEvent: event,
  };
}

const ERROR_VALUE_KEY = "__errorValue";

/**
 * JSON-safe projection of one canonical Agent event. `Error` values (the
 * `error`/`toolError` fields) become tagged records so a transport round-trip
 * preserves their messages; every other field is plain data already.
 */
export function serializeAgentEvent(event: Event): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(event, (_key, value) =>
      value instanceof Error
        ? {
          [ERROR_VALUE_KEY]: { name: value.name, message: value.message },
        }
        : value),
  ) as Record<string, unknown>;
}

/** Rebuilds one Agent event from its serialized projection. */
export function deserializeAgentEvent(
  record: Record<string, unknown>,
): Event {
  return JSON.parse(JSON.stringify(record), (_key, value) => {
    if (
      value !== null && typeof value === "object" &&
      ERROR_VALUE_KEY in (value as Record<string, unknown>)
    ) {
      const raw = (value as Record<string, unknown>)[ERROR_VALUE_KEY] as
        | { name?: unknown; message?: unknown }
        | undefined;
      const error = new Error(
        typeof raw?.message === "string" ? raw.message : "",
      );
      if (typeof raw?.name === "string" && raw.name !== "") {
        error.name = raw.name;
      }
      return error;
    }
    return value;
  }) as Event;
}

/** Runtime operations required by the shared prompt executor. */
export interface SessionExecutionDriver {
  admit(): Promise<() => void>;
  createRun(input: {
    runId: string;
    text: string;
  }): Promise<{
    runId: string;
    events: AsyncIterable<SessionExecutorEvent>;
    cancel: () => void;
  }>;
  finish(runId: string, state: string): void | Promise<void>;
}

export interface SessionExecutorOptions {
  driver: SessionExecutionDriver;
  publish(event: SessionExecutorEvent): void | Promise<void>;
  newId?: () => string;
}

/** Coordinates one admitted prompt Run without depending on a UI surface. */
export class SessionExecutor {
  readonly #driver: SessionExecutionDriver;
  readonly #publish: (event: SessionExecutorEvent) => void | Promise<void>;
  readonly #newId: () => string;
  readonly #running = new Map<
    string,
    { cancel: () => void; done: Promise<void> }
  >();

  constructor(options: SessionExecutorOptions) {
    this.#driver = options.driver;
    this.#publish = options.publish;
    this.#newId = options.newId ?? (() => `run_${generateID()}`);
  }

  async prompt(text: string): Promise<{ runId: string }> {
    const runId = this.#newId();
    const release = await this.#driver.admit();
    let created: Awaited<ReturnType<SessionExecutionDriver["createRun"]>>;
    try {
      created = await this.#driver.createRun({ runId, text });
    } catch (error) {
      release();
      await this.#publish({
        type: -1,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
        terminal: true,
      });
      throw error;
    }
    await this.#publish({
      type: -2,
      payload: { text },
      terminal: false,
    });
    const done = this.#consume(runId, text, created.events, release);
    this.#running.set(runId, { cancel: created.cancel, done });
    return { runId: created.runId };
  }

  cancel(runId: string): boolean {
    const running = this.#running.get(runId);
    if (running === undefined) return false;
    running.cancel();
    return true;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#running.values()].map((run) => run.done));
  }

  async close(): Promise<void> {
    for (const run of this.#running.values()) run.cancel();
    await this.waitForIdle();
  }

  async #consume(
    runId: string,
    _text: string,
    events: AsyncIterable<SessionExecutorEvent>,
    release: () => void,
  ): Promise<void> {
    let terminal = false;
    try {
      for await (const event of events) {
        if (terminal && event.terminal) continue;
        await this.#publish(event);
        if (!event.terminal) continue;
        terminal = true;
        const status = typeof event.payload.status === "string"
          ? event.payload.status
          : "completed";
        const state = status === "cancelled" || status === "canceled"
          ? "cancelled"
          : status === "failed" || status === "error"
          ? "failed"
          : status === "timed_out"
          ? "timed_out"
          : "completed";
        await this.#driver.finish(runId, state);
      }
      if (!terminal) {
        await this.#publish({
          type: -1,
          payload: { error: "event stream closed without terminal result" },
          terminal: true,
        });
        await this.#driver.finish(runId, "failed");
      }
    } catch (error) {
      await this.#publish({
        type: -1,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
        terminal: true,
      });
      await this.#driver.finish(runId, "failed");
    } finally {
      this.#running.delete(runId);
      release();
    }
  }
}
