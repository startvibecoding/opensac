import type { ChatParams, Model, StreamEvent } from "./types.ts";

/** Provider is the interface that all LLM providers must implement. */
export interface Provider {
  /** Sends a chat request and returns a stream of events. */
  chat(params: ChatParams): AsyncIterable<StreamEvent>;

  /** Returns the provider's name (e.g. "openai", "anthropic"). */
  name(): string;

  /** Returns the protocol/API type (e.g. "openai-chat", "anthropic-messages"). */
  api(): string;

  /** Returns the list of available models. */
  models(): Model[];

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): Model | undefined;
}
