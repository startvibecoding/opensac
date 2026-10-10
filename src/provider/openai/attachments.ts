import { type AttachmentContent } from "../attachments.ts";
import { validateAttachmentReferenceForResolver } from "../attachments.ts";
import { type Attachment } from "../types.ts";

export const maxResolvedAttachmentBytes = 32 << 20;

/** Structural view of the openai Provider used by the attachment resolver. */
export interface OpenAIAttachmentHost {
  apiKey: string;
  baseURL: string;
  headers?: Record<string, string>;
  client: { fetch(input: string | URL, init?: RequestInit): Promise<Response> };
}

/**
 * Downloads a file reference through the configured OpenAI API endpoint. It is
 * intentionally optional and never turns arbitrary URLs into a proxy; the Serve
 * layer authorizes the reference against the archive.
 */
export function resolveAttachment(
  p: OpenAIAttachmentHost,
  signal: AbortSignal | undefined,
  ref: string,
): Promise<AttachmentContent> {
  return resolveAttachmentWithContainer(p, signal, ref, "");
}

/**
 * Uses the Code Interpreter container file endpoint when archived provenance
 * contains both container and file identity. Ordinary refs continue through the
 * Files API.
 */
export function resolveAttachmentWithMetadata(
  p: OpenAIAttachmentHost,
  signal: AbortSignal | undefined,
  attachment: Attachment,
): Promise<AttachmentContent> {
  const containerID =
    typeof attachment.metadata?.["containerId"] === "string"
      ? (attachment.metadata!["containerId"] as string)
      : "";
  return resolveAttachmentWithContainer(
    p,
    signal,
    attachment.providerRef ?? "",
    containerID,
  );
}

async function resolveAttachmentWithContainer(
  p: OpenAIAttachmentHost,
  signal: AbortSignal | undefined,
  ref: string,
  containerID: string,
): Promise<AttachmentContent> {
  if (p === undefined || p === null || p.client == null || p.apiKey === "") {
    throw new Error("OpenAI attachment resolver is unavailable");
  }
  validateAttachmentReferenceForResolver(ref);
  let endpoint = `${p.baseURL.replace(/\/+$/, "")}/files/${encodeURIComponent(
    ref,
  )}/content`;
  if (containerID !== "") {
    try {
      validateAttachmentReferenceForResolver(containerID);
      endpoint = `${p.baseURL.replace(/\/+$/, "")}/containers/${encodeURIComponent(
        containerID,
      )}/files/${encodeURIComponent(ref)}/content`;
    } catch {
      // keep the Files API endpoint
    }
  }
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${p.apiKey}`);
  for (const [key, value] of Object.entries(p.headers ?? {})) {
    headers.set(key, value);
  }
  const resp = await p.client.fetch(endpoint, {
    method: "GET",
    headers,
    signal,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`attachment download failed with HTTP ${resp.status}`);
  }
  const contentLength = Number(resp.headers.get("Content-Length") ?? "0");
  if (contentLength > maxResolvedAttachmentBytes) {
    throw new Error(`attachment exceeds ${maxResolvedAttachmentBytes} bytes`);
  }
  const data = new Uint8Array(await resp.arrayBuffer());
  if (data.length > maxResolvedAttachmentBytes) {
    throw new Error(`attachment exceeds ${maxResolvedAttachmentBytes} bytes`);
  }
  let mediaType = (resp.headers.get("Content-Type") ?? "").trim();
  if (mediaType === "") mediaType = "application/octet-stream";
  return { data, mediaType, filename: ref };
}
