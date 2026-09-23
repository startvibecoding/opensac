import type { Provider } from "./provider.ts";
import type { ChatParams, Model, StreamEvent } from "./types.ts";
import { streamError } from "./types.ts";

/** Converts an abort signal into the error surfaced by a cancelled stream. */
function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/** MockProvider is a mock implementation of Provider for testing. */
export class MockProvider implements Provider {
  private mockName: string;
  private mockApi: string;
  private readonly mockModels: Model[];
  private readonly responses: StreamEvent[];
  private callCountValue = 0;

  constructor(name: string, models: Model[], responses: StreamEvent[]) {
    this.mockName = name;
    this.mockApi = "mock";
    this.mockModels = models;
    this.responses = responses;
  }

  /** Sets the mock provider's API type. */
  setAPI(api: string): void {
    this.mockApi = api;
  }

  /** Sends a chat request and returns a stream of events. */
  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.callCountValue++;
    const responses = [...this.responses];

    if (params.abort?.aborted) {
      yield { type: streamError, error: abortError(params.abort) };
      return;
    }

    for (const event of responses) {
      if (params.abort?.aborted) {
        yield { type: streamError, error: abortError(params.abort) };
        return;
      }
      yield event;
    }
  }

  /** Returns the provider's name. */
  name(): string {
    return this.mockName;
  }

  /** Returns the protocol/API type. */
  api(): string {
    return this.mockApi;
  }

  /** Returns the list of available models. */
  models(): Model[] {
    return this.mockModels;
  }

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): Model | undefined {
    return this.mockModels.find((m) => m.id === id);
  }

  /** Returns the number of times Chat was called. */
  getCallCount(): number {
    return this.callCountValue;
  }
}

/** Creates a new MockProvider. */
export function newMockProvider(
  name: string,
  models: Model[],
  responses: StreamEvent[],
): MockProvider {
  return new MockProvider(name, models, responses);
}
