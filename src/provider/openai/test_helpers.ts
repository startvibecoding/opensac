// Shared helpers for the openai subprovider tests (ported from the Go
// provider_test.go helper section).

import type { HttpClient } from "../http_client.ts";
import type { ChatParams, Model, StreamEvent } from "../types.ts";
import { newProviderWithModels, type Provider } from "./provider.ts";

/** A no-op HTTP client for tests that never issue a request. */
export function dummyClient(): HttpClient {
  return {
    fetch() {
      return Promise.reject(new Error("unexpected request"));
    },
    close() {},
  };
}

export interface MockRequest {
  url: string;
  init: RequestInit | undefined;
  headers: Headers;
  body: string;
}

export interface MockProvider {
  provider: Provider;
  requests: MockRequest[];
}

/** Builds a client whose fetch returns the given SSE text. */
export function mockClient(
  respond: (req: MockRequest, attempt: number) => Response | Promise<Response>,
  onRequest?: (req: MockRequest, attempt: number) => void,
): HttpClient {
  let attempt = 0;
  return {
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      attempt++;
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers ?? {});
      let body = "";
      if (typeof init?.body === "string") body = init.body;
      const req: MockRequest = { url, init, headers, body };
      if (onRequest !== undefined) onRequest(req, attempt);
      return await respond(req, attempt);
    },
    close() {},
  };
}

/**
 * Creates a provider backed by a mock client that answers every request with the
 * given SSE body.
 */
export function newMockOpenAIProvider(
  models: Model[],
  sse: string,
  onRequest?: (req: MockRequest) => void,
): MockProvider {
  const p = newProviderWithModels("fake-key", "https://api.test/v1", models);
  const requests: MockRequest[] = [];
  p.client = mockClient(
    () => new Response(sse, { status: 200, headers: {} }),
    (req) => {
      requests.push(req);
      onRequest?.(req);
    },
  );
  return { provider: p, requests };
}

/** A streaming body that emits prefix bytes then errors on the next read. */
export function errorAfterStream(
  prefix: string,
  err: Error,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(prefix);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
    },
    pull(controller) {
      controller.error(err);
    },
  });
}

/** Collects all stream events from a provider chat call. */
export async function chatAndCollect(
  p: Provider,
  params: ChatParams,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of p.chat(params)) events.push(event);
  return events;
}

export function mustUsage(
  events: StreamEvent[],
): NonNullable<StreamEvent["usage"]> {
  for (const event of events) {
    if (event.type === 5 && event.usage !== undefined) return event.usage;
  }
  throw new Error("no STREAM_USAGE event received");
}

/** Captures the JSON request body from a mock request. */
export function decodeBody(req: MockRequest): Record<string, unknown> {
  return JSON.parse(req.body) as Record<string, unknown>;
}
