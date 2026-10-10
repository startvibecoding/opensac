// (the ACP prompt/input conversion layer).
//
// The ACP protocol delivers prompt content blocks; every resource must be
// normalized into the Runtime-owned input contract (`InputIngress`) rather than
// becoming prompt text. `promptToText`/`promptToRunInput` are retained for
// text-only protocol/unit callers; the live ACP prompt path uses
// `promptToIngresses`.
//
// Deviations: Go's `(value, error)` returns throw typed errors; `[]byte` maps
// to `Uint8Array`; `io.ReadCloser` maps to a byte buffer; `context.Context`
// maps to the optional `AbortSignal` threaded by `InputIngress.open`.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import type { FileInfo } from "../platform/runtime.ts";
import { createHash } from "node:crypto";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "../compat/path.ts";
import { decodeBase64 } from "../compat/encoding.ts";
import {
  ATTACHMENT_AUDIO,
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
  type AttachmentKind,
} from "../agentruntime/attachment.ts";
import {
  type InputIngress,
  type InputSubmission,
  type RunInput,
} from "../agentruntime/input_materializer.ts";
import type { SessionRuntime } from "../agentruntime/session_runtime.ts";
import { type ContentBlock } from "./protocol.ts";

/** Raised when a prompt content type cannot be normalized by the Runtime. */
export class ACPPromptContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ACPPromptContentError";
  }
}

/**
 * Projects text-only prompt blocks. Every block must be `text`; any resource or
 * media block must go through `promptToIngresses` so the Runtime owns
 * normalization.
 */
export function promptToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      throw new ACPPromptContentError(
        `prompt content type ${JSON.stringify(block.type)} must be ` +
          `normalized through Runtime`,
      );
    }
    if (block.text !== undefined && block.text !== "") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Text-only projection retained for protocol/unit callers. The live ACP prompt
 * path uses `promptToIngresses` so every resource is normalized by
 * `SessionRuntime` rather than becoming prompt text.
 */
export function promptToRunInput(blocks: ContentBlock[]): RunInput {
  return {
    text: promptToText(blocks),
    resources: [],
    knowledgeBaseReferences: [],
    knowledgeCapsules: [],
    idempotencyKey: "",
  };
}

/**
 * Normalizes every declared ACP prompt content block into the Runtime input
 * contract. Text is returned separately; local and encoded resources become
 * `InputIngress` values for the Runtime materializer.
 */
export function promptToIngresses(
  blocks: ContentBlock[],
  workspaceCwd: string,
  additional: string[],
  eventPrefix: string,
): { text: string; ingresses: InputIngress[] } {
  const textParts: string[] = [];
  const ingresses: InputIngress[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    switch (block.type) {
      case "text":
        if (block.text !== undefined && block.text !== "") {
          textParts.push(block.text);
        }
        break;
      case "resource_link": {
        if (
          (block.name ?? "").trim() === "" ||
          (block.uri ?? "").trim() === ""
        ) {
          throw new ACPPromptContentError(
            "resource_link requires name and uri",
          );
        }
        const path = resolveACPResourcePath(
          block.uri ?? "",
          workspaceCwd,
          additional,
        );
        ingresses.push(
          localACPIngress(
            path,
            block.name ?? "",
            block.mimeType ?? "",
            block.size,
            eventPrefix,
            index,
            block.uri ?? "",
          ),
        );
        break;
      }
      case "resource": {
        if (
          (block.data ?? "").trim() === "" &&
          (block.uri ?? "").trim() !== ""
        ) {
          const path = resolveACPResourcePath(
            block.uri ?? "",
            workspaceCwd,
            additional,
          );
          ingresses.push(
            localACPIngress(
              path,
              block.name ?? "",
              block.mimeType ?? "",
              block.size,
              eventPrefix,
              index,
              block.uri ?? "",
            ),
          );
          break;
        }
        ingresses.push(encodedACPIngress(block, eventPrefix, index));
        break;
      }
      case "image":
      case "audio":
        ingresses.push(encodedACPIngress(block, eventPrefix, index));
        break;
      default:
        throw new ACPPromptContentError(
          `unsupported prompt content type: ${block.type}`,
        );
    }
  }
  return { text: textParts.join("\n"), ingresses };
}

/**
 * Resolves a local resource URI against the negotiated workspace roots. Only
 * authenticated local (`file:` with no host, or `localhost`) regular files
 * inside `workspaceCwd` or an additional directory are accepted.
 */
export function resolveACPResourcePath(
  rawURI: string,
  workspaceCwd: string,
  additional: string[],
): string {
  const parsed = parseResourceURI(rawURI.trim());
  if (parsed.scheme !== "" && parsed.scheme.toLowerCase() !== "file") {
    throw new ACPPromptContentError(
      `resource URI scheme ${JSON.stringify(parsed.scheme)} is not an ` +
        `authenticated local source`,
    );
  }
  if (parsed.host !== "" && parsed.host.toLowerCase() !== "localhost") {
    throw new ACPPromptContentError("resource URI host is not allowed");
  }
  let resourcePath = parsed.path;
  if (resourcePath === "") {
    throw new ACPPromptContentError("resource URI path is empty");
  }
  if (!isAbsolute(resourcePath)) {
    resourcePath = join(workspaceCwd, resourcePath);
  }
  resourcePath = resolve(resourcePath);
  let resolved: string;
  try {
    resolved = nodeRuntime.realPathSync(resourcePath);
  } catch (error) {
    throw new ACPPromptContentError(
      `resolve resource path: ${errorMessage(error)}`,
    );
  }
  let info: FileInfo;
  try {
    info = nodeRuntime.statSync(resolved);
  } catch (error) {
    throw new ACPPromptContentError(
      `stat resource path: ${errorMessage(error)}`,
    );
  }
  if (!info.isFile) {
    throw new ACPPromptContentError("resource path is not a regular file");
  }
  const roots = [workspaceCwd, ...additional];
  for (const root of roots) {
    if (root.trim() === "") continue;
    let rootResolved = resolve(root);
    try {
      rootResolved = nodeRuntime.realPathSync(rootResolved);
    } catch {
      continue;
    }
    const rel = relative(rootResolved, resolved);
    if (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel)) {
      return resolved;
    }
  }
  throw new ACPPromptContentError(
    "resource path is outside the negotiated workspace",
  );
}

/**
 * Builds an authenticated local-file ingress. A stale protocol size hint is
 * deliberately ignored: the Runtime reads and validates the file itself.
 */
export function localACPIngress(
  path: string,
  filename: string,
  mediaType: string,
  size: number | undefined,
  eventPrefix: string,
  index: number,
  reference: string,
): InputIngress {
  let info: FileInfo;
  try {
    info = nodeRuntime.statSync(path);
  } catch (error) {
    throw new ACPPromptContentError(errorMessage(error));
  }
  if (size !== undefined && size >= 0 && size !== info.size) {
    // Runtime reads and validates the local file; a stale protocol hint is
    // deliberately ignored.
    size = undefined;
  }
  let resolvedName = filename;
  if (resolvedName.trim() === "") {
    resolvedName = basename(path);
  }
  const sizeHint = info.size;
  return {
    origin: "acp",
    eventId: `${eventPrefix}:${index}`,
    itemIndex: index,
    reference,
    kind: acpAttachmentKind("", mediaType),
    filenameHint: resolvedName,
    mediaTypeHint: mediaType,
    sizeHint,
    open: async () => {
      const bytes = await nodeRuntime.readFile(path);
      return {
        bytes,
        filename: resolvedName,
        mediaType,
        contentSize: sizeHint,
      };
    },
  };
}

/** Builds an ingress for an inline base64 `image`/`audio`/`resource` block. */
export function encodedACPIngress(
  block: ContentBlock,
  eventPrefix: string,
  index: number,
): InputIngress {
  let data = (block.data ?? "").trim();
  if (data === "") {
    throw new ACPPromptContentError(
      `prompt content type ${JSON.stringify(block.type)} requires base64 data`,
    );
  }
  if (data.toLowerCase().startsWith("data:")) {
    const comma = data.indexOf(",");
    if (comma >= 0) data = data.slice(comma + 1);
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(data);
  } catch (error) {
    throw new ACPPromptContentError(
      `decode ${block.type} content: ${errorMessage(error)}`,
    );
  }
  if (decoded.length === 0) {
    throw new ACPPromptContentError(
      `prompt content type ${JSON.stringify(block.type)} is empty`,
    );
  }
  let mediaType = (block.mimeType ?? "").trim();
  if (mediaType === "" && block.type === "image") mediaType = "image/png";
  let filename = (block.name ?? "").trim();
  if (filename === "") filename = `acp-${index}`;
  const dataCopy = decoded.slice();
  const sizeHint = dataCopy.length;
  return {
    origin: "acp",
    eventId: `${eventPrefix}:${index}`,
    itemIndex: index,
    reference: "",
    kind: acpAttachmentKind(block.type, mediaType),
    filenameHint: filename,
    mediaTypeHint: mediaType,
    sizeHint,
    open: () => ({
      bytes: dataCopy.slice(),
      filename,
      mediaType,
      contentSize: sizeHint,
    }),
  };
}

/** Maps an ACP content type / media type onto the canonical attachment kind. */
export function acpAttachmentKind(
  contentType: string,
  mediaType: string,
): AttachmentKind {
  if (contentType.trim().toLowerCase() === "image") return ATTACHMENT_IMAGE;
  if (contentType.trim().toLowerCase() === "audio") return ATTACHMENT_AUDIO;
  const baseType = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (baseType.startsWith("image/")) return ATTACHMENT_IMAGE;
  if (baseType.startsWith("audio/")) return ATTACHMENT_AUDIO;
  if (baseType.startsWith("video/")) return ATTACHMENT_VIDEO;
  return ATTACHMENT_FILE;
}

/**
 * Produces the durable idempotency input without retaining raw prompt blocks.
 * Inline base64 media and local file URIs stay in the Runtime materializer
 * boundary rather than entering `session_execution_intents.request_json`.
 */
export function acpPromptRequestSnapshot(
  runtime: SessionRuntime | null | undefined,
  text: string,
  input: InputSubmission,
): string {
  const resources: Array<Record<string, unknown>> = [];
  const knowledge: Array<Record<string, unknown>> = [];
  const capsules = new Map<string, { snapshotId: string; text: string }>();
  for (const capsule of input.knowledgeCapsules) {
    capsules.set(capsule.knowledgeBaseId, {
      snapshotId: capsule.snapshotId,
      text: capsule.text,
    });
  }
  for (const reference of input.knowledgeBaseReferences) {
    const entry: Record<string, unknown> = {
      knowledgeBaseId: reference.knowledgeBaseId,
      snapshotId: "",
      required: reference.required ?? false,
      textSha256: "",
    };
    const capsule = capsules.get(reference.knowledgeBaseId);
    if (capsule !== undefined) {
      entry.snapshotId = capsule.snapshotId;
      entry.textSha256 = sha256Hex(capsule.text);
    }
    knowledge.push(entry);
  }
  if (runtime !== null && runtime !== undefined && runtime.inputs !== null) {
    for (const prepared of input.resources) {
      const record = runtime.inputs.get(runtime.id, prepared.resourceId);
      resources.push({
        id: record.id,
        kind: record.kind,
        filename: record.filename,
        mediaType: record.mediaType,
        bytes: record.bytes,
        relativePath: record.relativePath,
        sha256: record.sha256,
      });
    }
  } else if (input.resources.length > 0) {
    throw new ACPPromptContentError(
      "snapshot input materializer is unavailable",
    );
  }
  return JSON.stringify({ text, resources, knowledge });
}

function parseResourceURI(rawURI: string): {
  scheme: string;
  host: string;
  path: string;
} {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rawURI);
  if (schemeMatch === null) {
    return { scheme: "", host: "", path: decodePath(rawURI) };
  }
  const scheme = schemeMatch[1];
  let rest = rawURI.slice(schemeMatch[0].length);
  let host = "";
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      host = rest.slice(0, slash);
      rest = rest.slice(slash);
    } else {
      host = rest;
      rest = "";
    }
  }
  return { scheme, host, path: decodePath(rest) };
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new ACPPromptContentError(
      `decode resource URI: ${errorMessage(error)}`,
    );
  }
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
