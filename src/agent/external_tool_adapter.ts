//
// Adapts a public agent.ExternalTool to the internal tools.Tool interface so
// host-provided tools can run inside the agent loop.

import type {
  ExternalTool,
  ExternalToolPromptInfo,
} from "../../sdk/agent/external_tool.ts";
import type { ContentBlock } from "../../sdk/agent/types.ts";
import type { ContentBlock as ProviderContentBlock } from "../provider/types.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/mod.ts";

/** Adapts a public ExternalTool to the internal tools.Tool interface. */
export class ExternalToolAdapter implements Tool {
  private inner: ExternalTool;

  constructor(inner: ExternalTool) {
    this.inner = inner;
  }

  name(): string {
    return this.inner.name();
  }

  description(): string {
    return this.inner.description();
  }

  promptSnippet(): string {
    const pi = this.inner as Partial<ExternalToolPromptInfo>;
    if (typeof pi.promptSnippet === "function") {
      const s = pi.promptSnippet();
      if (s !== "") return s;
    }
    return this.inner.description();
  }

  promptGuidelines(): string[] {
    const pi = this.inner as Partial<ExternalToolPromptInfo>;
    if (typeof pi.promptGuidelines === "function") {
      return pi.promptGuidelines();
    }
    return [];
  }

  parameters(): unknown {
    const raw = this.inner.parameters();
    if (raw == null || raw.length === 0) {
      return { type: "object", properties: {} };
    }
    return decodeParameters(raw);
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const res = await this.inner.execute(params, ctx.signal);
    if (res.isError) {
      // The agent loop signals tool errors via a thrown error.
      const msg = res.text === "" ? "tool reported an error" : res.text;
      throw new Error(msg);
    }

    const result: ToolResult = { text: res.text };
    if (res.contents != null && res.contents.length > 0) {
      result.contents = contentBlocksToProvider(res.contents);
    }
    return result;
  }
}

/** Wraps a public ExternalTool as an internal tools.Tool. */
export function newExternalToolAdapter(t: ExternalTool): Tool {
  return new ExternalToolAdapter(t);
}

/** Decodes raw JSON schema bytes, tolerating an already-decoded value. */
function decodeParameters(raw: Uint8Array | unknown): unknown {
  if (raw instanceof Uint8Array) {
    if (raw.length === 0) return { type: "object", properties: {} };
    const text = new TextDecoder().decode(raw);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return raw;
}

/** Maps public content blocks to internal provider blocks. */
export function contentBlocksToProvider(
  blocks: ContentBlock[],
): ProviderContentBlock[] {
  const out: ProviderContentBlock[] = [];
  for (const b of blocks) {
    const pb: ProviderContentBlock = {
      type: b.type,
      text: b.text,
      thinking: b.thinking,
      signature: b.signature,
    };
    if (b.image != null) {
      pb.image = {
        mimeType: b.image.mimeType ?? "",
        data: b.image.data ?? "",
        width: b.image.width,
        height: b.image.height,
        bytes: b.image.bytes,
        originalWidth: b.image.originalWidth,
        originalHeight: b.image.originalHeight,
        originalBytes: b.image.originalBytes,
        detail: b.image.detail,
        scale: b.image.scale,
        cropped: b.image.cropped,
        cropX: b.image.cropX,
        cropY: b.image.cropY,
        cropWidth: b.image.cropWidth,
        cropHeight: b.image.cropHeight,
      };
    }
    out.push(pb);
  }
  return out;
}
