//
// `ArtifactCollector` owns the generated artifacts registered during one
// Runtime run. It is created by SessionRuntime before Agent construction so
// `publish_artifact` participates in the frozen, canonical tool registry. The
// Runtime-bound `beginArtifactCollection` method lives on SessionRuntime; this
// module owns the collector, the `publish_artifact` tool, and artifact
// classification.
//
// Deviations: `sync.Mutex` is dropped (Deno is single-threaded); `[]byte`/
// `io.ReadCloser` map to `Uint8Array`/`ReadableStream`; `context.Context` maps
// to an `AbortSignal`; `filepath` maps to `@std/path` plus `Deno.realPathSync`.

import * as path from "@std/path";
import type { AttachmentKind, SessionAttachment } from "./attachment.ts";
import {
  ATTACHMENT_AUDIO,
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
} from "./attachment.ts";
import type { AttachmentService } from "./input.ts";
import { detectAttachmentMediaType } from "./media_type.ts";
import {
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";

/**
 * The Runtime state the collector reads: identity, work directory, attachment
 * store, and registry. A SessionRuntime satisfies it structurally.
 */
export interface ArtifactRuntime {
  readonly id: string;
  readonly workDir: string;
  readonly artifactEnabled: boolean;
  readonly attachments: AttachmentService | null;
  readonly registry: Registry | null;
  ensureOpen(): void;
}

/** Owns the generated artifacts registered during one Runtime run. */
export class ArtifactCollector {
  readonly runtime: ArtifactRuntime;
  readonly runId: string;
  private items: SessionAttachment[] = [];
  private closed = false;
  private observer: ((record: SessionAttachment) => void) | null = null;

  constructor(runtime: ArtifactRuntime, runId: string) {
    this.runtime = runtime;
    this.runId = runId;
  }

  /**
   * Installs an optional adapter projection hook. Called with each artifact
   * record after it has been successfully copied and persisted. A null observer
   * removes any previously installed hook.
   */
  setObserver(observer: ((record: SessionAttachment) => void) | null): void {
    this.observer = observer;
  }

  /** Projects one persisted artifact through the optional observer. */
  private notifyObserver(record: SessionAttachment): void {
    const observer = this.observer;
    if (observer === null) return;
    try {
      observer(record);
    } catch {
      // Deliberately recovered: the durable registration already succeeded and
      // must stay authoritative.
    }
  }

  /** Returns a stable copy of every generated artifact of this run. */
  artifacts(): SessionAttachment[] {
    return [...this.items];
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * Removes this run's dynamic tool. Identity comparison still prevents an old
   * collector from removing a newer run's tool if a caller closes late.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const registry = this.runtime.registry;
    if (registry === null) return;
    const current = registry.get("publish_artifact");
    if (
      current !== undefined &&
      current instanceof PublishArtifactTool &&
      current.collector === this
    ) {
      registry.remove("publish_artifact");
    }
  }

  /**
   * Copies a regular file from the Runtime work directory to private attachment
   * storage. It refuses symlink escapes and persists only the copied content's
   * generated attachment ID, never the source path.
   */
  async register(
    sourcePath: string,
    filename: string,
    requestedKind: string,
    signal?: AbortSignal,
  ): Promise<SessionAttachment> {
    if (this.closed) {
      throw new Error("artifact collector is closed");
    }
    sourcePath = (sourcePath ?? "").trim();
    if (sourcePath === "") {
      throw new Error("artifact path is required");
    }
    const service = this.runtime.attachments;
    const sessionID = this.runtime.id;
    const workDir = this.runtime.workDir;
    if (service === null || sessionID === "" || workDir === "") {
      throw new Error("artifact runtime is not bound to a session");
    }
    let resolvedWorkDir: string;
    try {
      resolvedWorkDir = Deno.realPathSync(workDir);
    } catch (err) {
      throw new Error(
        `resolve artifact work directory: ${errorMessage(err)}`,
      );
    }
    if (!path.isAbsolute(sourcePath)) {
      sourcePath = path.join(resolvedWorkDir, sourcePath);
    }
    let resolvedSource: string;
    try {
      resolvedSource = Deno.realPathSync(sourcePath);
    } catch (err) {
      throw new Error(`resolve artifact path: ${errorMessage(err)}`);
    }
    const rel = path.relative(resolvedWorkDir, resolvedSource);
    if (rel === ".." || rel.startsWith(`..${path.SEPARATOR}`)) {
      throw new Error(
        "artifact path must stay within the Runtime work directory",
      );
    }
    const info = Deno.statSync(resolvedSource);
    if (!info.isFile) {
      throw new Error("artifact path must be a regular file");
    }

    const { kind, mediaType } = await classifyArtifact(
      resolvedSource,
      requestedKind,
    );
    if ((filename ?? "").trim() === "") {
      filename = path.basename(resolvedSource);
    }
    const record = await service.acceptArtifact(
      sessionID,
      this.runId,
      {
        origin: "tool:publish_artifact",
        reference: "runtime-artifact",
        kind,
        filename,
        mediaType,
        sizeHint: info.size,
        open: () => {
          const file = Deno.openSync(resolvedSource, { read: true });
          return {
            stream: file.readable,
            filename,
            mediaType,
            contentSize: info.size,
          };
        },
      },
      signal,
    );
    service.setStatus(sessionID, record.id, "generated");
    record.status = "generated";
    if (this.closed) {
      throw new Error("artifact collector closed while registering artifact");
    }
    this.items.push(record);
    this.notifyObserver(record);
    return record;
  }
}

/** Classifies one artifact path into a kind and detected media type. */
export async function classifyArtifact(
  filePath: string,
  requestedKind: string,
): Promise<{ kind: AttachmentKind; mediaType: string }> {
  requestedKind = (requestedKind ?? "").trim().toLowerCase();
  const mediaType = await detectAttachmentMediaType(filePath);
  const lowerMedia = mediaType.toLowerCase();
  const isImage = lowerMedia.startsWith("image/");
  switch (requestedKind) {
    case "":
    case "auto":
      return {
        kind: isImage ? ATTACHMENT_IMAGE : ATTACHMENT_FILE,
        mediaType,
      };
    case ATTACHMENT_IMAGE:
      if (!isImage) {
        throw new Error(
          `artifact requested as image but detected ${
            JSON.stringify(mediaType)
          }`,
        );
      }
      return { kind: ATTACHMENT_IMAGE, mediaType };
    case ATTACHMENT_FILE:
      return { kind: ATTACHMENT_FILE, mediaType };
    case ATTACHMENT_AUDIO:
      if (!lowerMedia.startsWith("audio/")) {
        throw new Error(
          `artifact requested as audio but detected ${
            JSON.stringify(mediaType)
          }`,
        );
      }
      return { kind: ATTACHMENT_AUDIO, mediaType };
    case ATTACHMENT_VIDEO:
      if (!lowerMedia.startsWith("video/")) {
        throw new Error(
          `artifact requested as video but detected ${
            JSON.stringify(mediaType)
          }`,
        );
      }
      return { kind: ATTACHMENT_VIDEO, mediaType };
    default:
      throw new Error(
        `unsupported artifact kind ${JSON.stringify(requestedKind)}`,
      );
  }
}

/**
 * The only Agent-facing way to declare a local file as a delivery artifact. It
 * copies the file before reporting success, so later Agent writes cannot
 * silently mutate a file that is about to be delivered.
 */
export class PublishArtifactTool implements Tool {
  readonly collector: ArtifactCollector;

  constructor(collector: ArtifactCollector) {
    this.collector = collector;
  }

  name(): string {
    return "publish_artifact";
  }

  description(): string {
    return "Publish a regular file that you created in the current working directory as a generated attachment. Use this only after the file is complete. The file is copied to Runtime-managed storage and may be delivered by the active front end.";
  }

  promptSnippet(): string {
    return "Publish a completed work-directory file as a generated artifact";
  }

  promptGuidelines(): string[] {
    return [
      "When you create a file intended for the user, call publish_artifact with its work-directory-relative path. Do not claim a file is deliverable merely because you mentioned its path.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to a completed regular file, relative to the current working directory",
        },
        filename: {
          type: "string",
          description: "Optional user-facing attachment filename",
        },
        kind: {
          type: "string",
          enum: ["auto", "image", "file", "audio", "video"],
          description:
            "Optional attachment kind; auto detects an image from its bytes",
        },
      },
      required: ["path"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const p = typeof params["path"] === "string" ? params["path"] : "";
    const filename = typeof params["filename"] === "string"
      ? params["filename"]
      : "";
    const kind = typeof params["kind"] === "string" ? params["kind"] : "";
    const record = await this.collector.register(
      p,
      filename,
      kind,
      ctx.signal,
    );
    return createTextToolResult(
      `Published generated ${record.kind} ${
        JSON.stringify(record.filename)
      } as attachment ${record.id}.`,
    );
  }
}

/** Creates the Runtime-owned `publish_artifact` tool for one collector. */
export function createPublishArtifactTool(
  collector: ArtifactCollector,
): PublishArtifactTool {
  return new PublishArtifactTool(collector);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
