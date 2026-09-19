// Ported from internal/agent/provider.go.
//
// This is the internal agent package's provider contract. It duplicates the
// protocol-neutral `src/provider` interfaces (the Go source does too) and is
// retained for 1:1 fidelity. New code should prefer `src/provider`.

import type {
  Message,
  ToolCallBlock,
  ToolDefinition,
  Usage,
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

export const StreamStart: StreamEventType = 0;
export const StreamTextDelta: StreamEventType = 1;
export const StreamThinkDelta: StreamEventType = 2;
export const StreamToolCall: StreamEventType = 3;
export const StreamUsage: StreamEventType = 4;
export const StreamDone: StreamEventType = 5;
export const StreamError: StreamEventType = 6;

/** ThinkingLevel represents the thinking/reasoning level. */
export type ThinkingLevel = string;

export const ThinkingOff: ThinkingLevel = "off";
export const ThinkingMinimal: ThinkingLevel = "minimal";
export const ThinkingLow: ThinkingLevel = "low";
export const ThinkingMedium: ThinkingLevel = "medium";
export const ThinkingHigh: ThinkingLevel = "high";
export const ThinkingXHigh: ThinkingLevel = "xhigh";
export const ThinkingMax: ThinkingLevel = "max";

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
export function newBaseProvider(
  name: string,
  models: AgentModel[],
): BaseProvider {
  return new BaseProvider(name, models);
}
