//
// This is the internal agent package's provider contract. It duplicates the
// protocol-neutral `src/provider` interfaces (the Go source does too) and is
// retained for 1:1 fidelity. New code should prefer `src/provider`.

import {
  type Message,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "../provider/types.ts";

/** Provider is the interface that all LLM providers must implement. */
export interface Provider {
  /** Sends a chat request and returns a stream of events. */
  chat(params: ChatParams): AsyncIterable<StreamEvent>;

  /** Returns the provider's name (e.g. "openai", "anthropic"). */
  name(): string;

  /** Returns the list of available models. */
  models(): AgentModel[];

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): AgentModel | undefined;
}

// Renamed from the Go `agent.Model` to avoid colliding with the protocol-neutral
// `provider.Model` that the rest of the port uses.
export type AgentModel = Model;

/** Holds parameters for a chat request. */
export interface ChatParams {
  messages: Message[];
  tools: ToolDefinition[];
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  maxTokens: number;
  modelId: string;
  abort?: AbortSignal;
}

/** Represents an event from the LLM stream. */
export interface StreamEvent {
  type: StreamEventType;
  textDelta: string;
  thinkDelta: string;
  toolCall?: ToolCallBlock;
  usage?: Usage;
  stopReason: string;
  error?: Error;
}

/** StreamEventType identifies the type of stream event. */
export type StreamEventType = number;

export const STREAM_START: StreamEventType = 0;
export const STREAM_TEXT_DELTA: StreamEventType = 1;
export const STREAM_THINK_DELTA: StreamEventType = 2;
export const STREAM_TOOL_CALL: StreamEventType = 3;
export const STREAM_USAGE: StreamEventType = 4;
export const STREAM_DONE: StreamEventType = 5;
export const STREAM_ERROR: StreamEventType = 6;

/** ThinkingLevel represents the thinking/reasoning level. */
export type ThinkingLevel = string;

export const THINKING_OFF: ThinkingLevel = "off";
export const THINKING_MINIMAL: ThinkingLevel = "minimal";
export const THINKING_LOW: ThinkingLevel = "low";
export const THINKING_MEDIUM: ThinkingLevel = "medium";
export const THINKING_HIGH: ThinkingLevel = "high";
export const THINKING_X_HIGH: ThinkingLevel = "xhigh";
export const THINKING_MAX: ThinkingLevel = "max";

/** Represents a model configuration. */
export interface Model {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  cost: ModelPricing;
  contextWindow: number;
  maxTokens: number;
}

/** Represents the pricing for a model. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Provides common functionality for provider implementations. */
export class BaseProvider {
  private nameValue: string;
  private modelsValue: AgentModel[];

  constructor(name: string, models: AgentModel[]) {
    this.nameValue = name;
    this.modelsValue = models;
  }

  /** Returns the provider's name. */
  name(): string {
    return this.nameValue;
  }

  /** Returns the list of available models. */
  models(): AgentModel[] {
    return this.modelsValue;
  }

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): AgentModel | undefined {
    for (const m of this.modelsValue) {
      if (m.id === id) return m;
    }
    return undefined;
  }
}

/** Creates a new BaseProvider. */
export function createBaseProvider(
  name: string,
  models: AgentModel[],
): BaseProvider {
  return new BaseProvider(name, models);
}
