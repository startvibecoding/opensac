// Ported from internal/serve/openaiapi/handler_provider_tools.go. The Go
// methods bind to *Server; the Deno projection takes the Server as its first
// argument (unused today, kept for the handler signature convention).
import type { Server } from "./server.ts";
import type { Settings } from "../../config/settings.ts";
import { discoverModels, resolveSecretRef } from "../../provider/discover.ts";
import { create } from "../../provider/factory/factory.ts";
import {
  type Message,
  streamDone,
  streamError,
  thinkingOff,
} from "../../provider/types.ts";
import { writeError, writeJSON } from "./auth.ts";

/**
 * providerProbeRequest is deliberately separate from the settings provider
 * config so WebUI drafts are never persisted as a side effect of probing them.
 */
export interface ProviderProbeRequest {
  api: string;
  baseUrl: string;
  apiKey: string;
  httpProxy: string;
  forceHTTP11: boolean;
  headers: Record<string, string>;
  model: string;
}

const probeBodyLimitBytes = 1 << 20;

export async function handleProviderModels(
  _server: Server,
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return writeError(405, "method not allowed", "invalid_request_error");
  }
  let probe: ProviderProbeRequest;
  try {
    probe = await awaitProbeRequest(req);
  } catch (err) {
    return writeError(
      400,
      err instanceof Error ? err.message : String(err),
      "invalid_request_error",
    );
  }
  // Model discovery is a provider concern shared with ACP's management
  // projection. The WebUI only decodes its draft HTTP payload and renders the
  // returned drafts; it must not own a second endpoint/client/auth sequence.
  try {
    const models = await discoverModels(req.signal, {
      api: probe.api,
      baseUrl: probe.baseUrl,
      apiKey: probe.apiKey,
      httpProxy: probe.httpProxy,
      forceHTTP11: probe.forceHTTP11,
      headers: probe.headers,
    });
    return writeJSON(200, { object: "list", data: models });
  } catch (err) {
    return writeError(
      502,
      err instanceof Error ? err.message : String(err),
      "upstream_error",
    );
  }
}

export async function handleProviderModelTest(
  _server: Server,
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return writeError(405, "method not allowed", "invalid_request_error");
  }
  let probe: ProviderProbeRequest;
  try {
    probe = await awaitProbeRequest(req);
  } catch (err) {
    return writeError(
      400,
      err instanceof Error ? err.message : String(err),
      "invalid_request_error",
    );
  }
  if (probe.model.trim() === "") {
    return writeError(400, "model is required", "invalid_request_error");
  }
  const providerID = "webui-probe";
  const settings: Settings = {
    defaultProvider: providerID,
    providers: {
      [providerID]: {
        api: probe.api,
        baseUrl: probe.baseUrl,
        apiKey: resolveSecretRef(probe.apiKey),
        httpProxy: probe.httpProxy,
        forceHTTP11: probe.forceHTTP11,
        headers: probe.headers,
        models: [{ id: probe.model, name: probe.model, input: ["text"] }],
      },
    },
  } as unknown as Settings;
  let p;
  try {
    ({ provider: p } = create(settings, providerID, probe.model));
  } catch (err) {
    return writeError(
      400,
      `create provider: ${err instanceof Error ? err.message : String(err)}`,
      "invalid_request_error",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  req.signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  const ping: Message = {
    role: "user",
    content: "ping",
    timestamp: new Date(),
  };
  try {
    for await (
      const event of p.chat({
        modelId: probe.model,
        systemPrompt: "",
        thinkingLevel: thinkingOff,
        maxTokens: 1,
        messages: [ping],
      })
    ) {
      if (event.type === streamError) {
        let message = "model request failed";
        if (event.error) message = event.error.message;
        return writeJSON(502, { ok: false, error: message });
      }
      if (event.type === streamDone) {
        return writeJSON(200, { ok: true, model: probe.model });
      }
    }
    return writeJSON(502, {
      ok: false,
      error: "model request ended without a completion",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function awaitProbeRequest(req: Request): Promise<ProviderProbeRequest> {
  // Go wraps the body in io.LimitReader(1<<20); the port reads the body and
  // rejects oversized payloads after the fact (deviation: an oversized body is
  // fully read before the limit is enforced).
  const text = await req.text();
  if (new TextEncoder().encode(text).length > probeBodyLimitBytes) {
    throw new Error("invalid JSON: request body too large");
  }
  let parsed: Partial<ProviderProbeRequest>;
  try {
    parsed = JSON.parse(text) as Partial<ProviderProbeRequest>;
  } catch (err) {
    throw new Error(
      `invalid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  const probe: ProviderProbeRequest = {
    api: (parsed.api ?? "").trim(),
    baseUrl: (parsed.baseUrl ?? "").trim(),
    apiKey: parsed.apiKey ?? "",
    httpProxy: parsed.httpProxy ?? "",
    forceHTTP11: parsed.forceHTTP11 ?? false,
    headers: parsed.headers ?? {},
    model: parsed.model ?? "",
  };
  if (probe.api === "" || probe.baseUrl === "") {
    throw new Error("api and baseUrl are required");
  }
  return probe;
}
