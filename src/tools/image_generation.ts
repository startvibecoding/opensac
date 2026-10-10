//
// A local tool backed by either the OpenAI Images API or the Responses API
// native image_generation hosted tool. Go's `net/http` maps to `fetch`; the
// 2-minute client timeout maps to an `AbortSignal.timeout` combined with the
// invocation signal.

import {
  effectiveImageGeneration,
  type ImageGenerationSettings,
  isImageGenerationEnabled,
  resolveImageGenerationToken,
  type Settings,
} from "../config/settings.ts";
import { type ContentBlock } from "../provider/types.ts";
import {
  operationIDFromContext,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

interface ImageGenerationResult {
  b64JSON: string;
  url: string;
}

/** Generates an image from a text prompt using the configured provider. */
export class ImageGenerationTool implements Tool {
  #settings: Settings | undefined;

  constructor(settings: Settings | undefined) {
    this.#settings = settings;
  }

  name(): string {
    return "image_generation";
  }

  description(): string {
    return "Generate an image from a text prompt using the configured image generation provider.";
  }

  promptSnippet(): string {
    return "Generate images when the user requests an image";
  }

  promptGuidelines(): string[] {
    return [
      "Use image_generation for image creation requests and return the generated image to the user.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Image generation prompt",
        },
        size: {
          type: "string",
          description: "Image size, for example 1024x1024",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
        },
        n: { type: "integer", minimum: 1, maximum: 4 },
      },
      required: ["prompt"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (
      this.#settings === undefined ||
      !isImageGenerationEnabled(this.#settings)
    ) {
      throw new Error("image_generation is disabled");
    }
    const prompt =
      typeof params["prompt"] === "string" ? (params["prompt"] as string) : "";
    if (prompt.trim() === "") {
      throw new Error("image_generation requires a non-empty prompt");
    }
    const cfg = effectiveImageGeneration(this.#settings);
    let apiType = (cfg.apiType ?? "").trim().toLowerCase();
    if (apiType === "") apiType = "openai-images";
    switch (apiType) {
      case "openai-images":
      case "images":
      case "openai-image":
        return await this.#executeImages(ctx, cfg, prompt, params);
      case "openai-responses":
      case "responses":
        return await this.#executeResponses(ctx, cfg, prompt);
      default:
        throw new Error(
          `unsupported image_generation apiType ${JSON.stringify(cfg.apiType)}`,
        );
    }
  }

  async #executeImages(
    ctx: ToolContext,
    cfg: ImageGenerationSettings,
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const body: Record<string, unknown> = {
      model: cfg.model ?? "",
      prompt,
      n: intParam(params, "n", 1),
      response_format: "b64_json",
    };
    if (body["model"] === "") body["model"] = "gpt-image-1";
    const size = params["size"];
    if (typeof size === "string" && size.trim() !== "") body["size"] = size;
    const quality = params["quality"];
    if (typeof quality === "string" && quality.trim() !== "") {
      body["quality"] = quality;
    }
    const response = await this.#postJSON<{
      data?: Array<{ b64_json?: string; url?: string }>;
    }>(ctx, cfg, "/images/generations", body);
    const items: ImageGenerationResult[] = [];
    for (const item of response.data ?? []) {
      items.push({ b64JSON: item.b64_json ?? "", url: item.url ?? "" });
    }
    return await this.#imageResult(ctx, cfg, items);
  }

  async #executeResponses(
    ctx: ToolContext,
    cfg: ImageGenerationSettings,
    prompt: string,
  ): Promise<ToolResult> {
    const model = cfg.model && cfg.model !== "" ? cfg.model : "gpt-4.1";
    const body: Record<string, unknown> = {
      model,
      input: prompt,
      tools: [{ type: "image_generation" }],
    };
    const response = await this.#postJSON<{
      output?: Array<{ type?: string; result?: string }>;
    }>(ctx, cfg, "/responses", body);
    const items: ImageGenerationResult[] = [];
    for (const item of response.output ?? []) {
      if (item.type === "image_generation_call" && item.result) {
        items.push({ b64JSON: item.result, url: "" });
      }
    }
    return await this.#imageResult(ctx, cfg, items);
  }

  async #postJSON<T>(
    ctx: ToolContext,
    cfg: ImageGenerationSettings,
    p: string,
    payload: unknown,
  ): Promise<T> {
    let base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
    if (base === "") base = "https://api.openai.com/v1";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const op = operationIDFromContext(ctx);
    if (op !== undefined) headers["Idempotency-Key"] = op;
    const token = this.#settings
      ? resolveImageGenerationToken(this.#settings)
      : "";
    if (token !== "") headers["Authorization"] = "Bearer " + token;

    const response = await this.#fetch(ctx, base + p, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `image_generation request failed (${response.status}): ${bodyText.trim()}`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(`decode image_generation response: ${messageOf(err)}`);
    }
  }

  async #imageResult(
    ctx: ToolContext,
    cfg: ImageGenerationSettings,
    items: ImageGenerationResult[],
  ): Promise<ToolResult> {
    if (items.length === 0) {
      throw new Error("image_generation response contained no generated image");
    }
    const contents: ContentBlock[] = [];
    for (const item of items) {
      let data = item.b64JSON;
      const mime = "image/png";
      if (data === "" && item.url !== "") {
        const body = await this.#download(ctx, cfg, item.url);
        data = encodeBase64(body);
      }
      if (data === "") continue;
      contents.push({ type: "image", image: { data, mimeType: mime } });
    }
    if (contents.length === 0) {
      throw new Error("image_generation response contained no image data");
    }
    return {
      text: `Generated ${contents.length} image(s).`,
      contents,
    };
  }

  async #download(
    ctx: ToolContext,
    _cfg: ImageGenerationSettings,
    rawURL: string,
  ): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    const token = this.#settings
      ? resolveImageGenerationToken(this.#settings)
      : "";
    if (token !== "") headers["Authorization"] = "Bearer " + token;

    const response = await this.#fetch(ctx, rawURL, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`download generated image failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async #fetch(
    ctx: ToolContext,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      2 * 60 * 1000,
    );
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    try {
      return await fetch(url, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function intParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  if (typeof value === "number" && Math.trunc(value) > 0) {
    return Math.trunc(value);
  }
  return fallback;
}

function encodeBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
