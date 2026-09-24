//
// Faithful port except that `imageproc.prepareFile` is async, so `execute`
// awaits it. Go's `encoding/base64` maps to `@std/encoding`.

import { encodeBase64 } from "@std/encoding/base64";
import * as path from "@std/path";
import {
  type Crop,
  type Mode,
  normalizeMode,
  type Policy,
  prepareFile,
  type Result,
} from "../imageproc/mod.ts";
import { truncateString } from "../util/truncate.ts";
import {
  createImageToolResult,
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Maps file extensions to MIME types. */
const imageMimeType: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Reads file contents. */
export class ReadTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "read";
  }

  description(): string {
    return "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). For text files, output is truncated at 2000 lines or 50KB. Use offset/limit for large files. For images, use imageMode=detail when OCR, screenshots, diagrams, or small text require more visual detail.";
  }

  promptSnippet(): string {
    return "Read file contents (preferred for inspecting files)";
  }

  promptGuidelines(): string[] {
    return [
      "Use read to examine files instead of cat or sed.",
      'For image OCR, screenshots, diagrams, or small UI text, use read with imageMode="detail".',
      "For localized image questions, use the crop parameter in source image pixels before reading the full image at high detail.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" },
        offset: {
          type: "integer",
          description: "Line number to start reading from (1-indexed)",
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to read",
        },
        imageMode: {
          type: "string",
          enum: ["auto", "fast", "detail", "raw"],
          description:
            "Image processing mode for image files. auto balances quality and request size; fast uses lower resolution; detail preserves more detail; raw sends the original file after safety checks.",
        },
        maxLongEdge: {
          type: "integer",
          description:
            "Optional maximum long edge in pixels for image resizing",
        },
        crop: {
          type: "object",
          description:
            "Optional crop rectangle in source image pixels before resizing",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
          },
          required: ["x", "y", "width", "height"],
        },
      },
      required: ["path"],
    };
  }

  async execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pathParam = params["path"];
    if (typeof pathParam !== "string" || pathParam === "") {
      throw new Error("path is required");
    }
    let p = pathParam;
    try {
      p = this.#registry.resolvePath(p);
    } catch (err) {
      throw new Error(`invalid path: ${messageOf(err)}`);
    }

    const ext = path.extname(p).toLowerCase();
    const mimeType = imageMimeType[ext];
    if (mimeType !== undefined) {
      const policy = this.#imageReadPolicy(params);
      let info: Deno.FileInfo;
      try {
        info = Deno.statSync(p);
      } catch (err) {
        throw new Error(`cannot stat image file: ${messageOf(err)}`);
      }
      if (
        (policy.maxFileBytes ?? 0) > 0 &&
        info.size > (policy.maxFileBytes as number)
      ) {
        throw new Error(
          `image file too large: ${info.size} bytes (max ${policy.maxFileBytes})`,
        );
      }
      let result: Result;
      try {
        result = await prepareFile(p, policy);
      } catch (err) {
        throw new Error(`cannot read image file: ${messageOf(err)}`);
      }
      const meta = result.meta;
      const image = {
        data: encodeBase64(result.data),
        mimeType: result.mimeType,
        width: meta.width,
        height: meta.height,
        bytes: meta.bytes,
        originalWidth: meta.originalWidth,
        originalHeight: meta.originalHeight,
        originalBytes: meta.originalBytes,
        detail: meta.detail,
        scale: meta.scale,
        cropped: meta.cropped,
        cropX: meta.cropX,
        cropY: meta.cropY,
        cropWidth: meta.cropWidth,
        cropHeight: meta.cropHeight,
      };
      const desc = imageDescription(p, mimeType, result);
      return createImageToolResult(desc, image);
    }

    let data: Uint8Array;
    try {
      data = await Deno.readFile(p);
    } catch (err) {
      throw new Error(`cannot read file: ${messageOf(err)}`);
    }

    const content = new TextDecoder().decode(data);
    const lines = content.split("\n");

    let offset = 0;
    const offsetParam = params["offset"];
    if (typeof offsetParam === "number" && offsetParam > 0) {
      offset = Math.trunc(offsetParam) - 1;
    }

    let limit = lines.length;
    const limitParam = params["limit"];
    if (typeof limitParam === "number" && limitParam > 0) {
      limit = Math.trunc(limitParam);
    }

    if (offset >= lines.length) {
      return createTextToolResult("(end of file)");
    }
    let end = offset + limit;
    if (end > lines.length) end = lines.length;

    const selected = lines.slice(offset, end);
    const maxBytes = 50000;
    let sb = "";
    for (let i = 0; i < selected.length; i++) {
      const lineNum = offset + i + 1;
      sb += `${lineNum}\t${selected[i]}\n`;
      // Stop formatting early once the output is over the byte cap. The
      // truncation below only depends on the first maxBytes of the formatted
      // text, so huge windows do not build multi-megabyte strings first.
      if (sb.length > maxBytes) break;
    }

    if (new TextEncoder().encode(sb).length > maxBytes) {
      sb = truncateString(sb, maxBytes) +
        `\n... (truncated, total ${lines.length} lines)`;
    }

    return createTextToolResult(sb);
  }

  #imageReadPolicy(params: Record<string, unknown>): Policy {
    let mode: Mode = normalizeMode("");
    const modeParam = params["imageMode"];
    if (typeof modeParam === "string") {
      mode = normalizeMode(modeParam);
    }
    const policy = this.#registry.imagePolicy(mode);
    const longEdge = params["maxLongEdge"];
    if (typeof longEdge === "number" && longEdge > 0) {
      policy.maxLongEdge = Math.trunc(longEdge);
    }
    const crop = imageCropParam(params["crop"]);
    if (crop !== null) {
      policy.crop = crop;
    }
    return policy;
  }
}

function imageDescription(
  p: string,
  sourceMime: string,
  result: Result,
): string {
  const meta = result.meta;
  const original = `${meta.originalWidth}x${meta.originalHeight} ${
    formatBytes(meta.originalBytes)
  } ${sourceMime}`;
  const sent = `${meta.width}x${meta.height} ${
    formatBytes(meta.bytes)
  } ${result.mimeType}`;
  let crop = "";
  if (meta.cropped) {
    crop =
      `, crop: ${meta.cropWidth}x${meta.cropHeight}+${meta.cropX}+${meta.cropY}`;
  }
  if (
    meta.resized || meta.transcoded || meta.originalBytes !== meta.bytes ||
    sourceMime !== result.mimeType
  ) {
    return `[Image file: ${p}, original: ${original}${crop}, sent: ${sent}, mode: ${meta.detail}]`;
  }
  return `[Image file: ${p}, ${sent}${crop}, mode: ${meta.detail}]`;
}

function imageCropParam(value: unknown): Crop | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw new Error("crop must be an object");
  }
  const obj = value as Record<string, unknown>;
  return {
    x: intParamValue(obj["x"]),
    y: intParamValue(obj["y"]),
    width: intParamValue(obj["width"]),
    height: intParamValue(obj["height"]),
  };
}

function intParamValue(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : Math.trunc(n);
  }
  return 0;
}

function formatBytes(n: number): string {
  const unit = 1024;
  if (n < unit) return `${n}B`;
  const kb = n / unit;
  if (kb < unit) return `${kb.toFixed(1)}KB`;
  return `${(kb / unit).toFixed(1)}MB`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
