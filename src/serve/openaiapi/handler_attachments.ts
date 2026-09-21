// Ported from internal/serve/openaiapi/handler_attachments.go. Go defines the
// handler as a *Server method; the Deno projection takes the Server as its
// first argument.
//
// Deviations: Go's io.LimitReader-style streaming is replaced by the standard
// Response body; the provider attachment resolvers are duck-typed (the TS
// Provider surface keeps them optional) and `http.DetectContentType` maps to
// the shared agentruntime media-type sniffer; the Go 500 branch of
// findSessionWorkDir collapses into not-found (see server.ts).
import type { Server } from "./server.ts";
import { getSessionDir } from "../../config/settings.ts";
import type { Attachment } from "../../provider/types.ts";
import {
  type AttachmentContent,
  type AttachmentMetadataResolver,
  type AttachmentResolver,
  validateAttachmentReferenceForResolver,
} from "../../provider/attachments.ts";
import { detectContentType } from "../../agentruntime/media_type.ts";
import { listSessionMessagesAfter } from "../../session/session_events.ts";
import { writeError } from "./auth.ts";

const attachmentPathPrefix = "/api/attachments/";
const attachmentResolveTimeoutMs = 30_000;

/**
 * handleAttachmentAPI serves an archived provider file reference through an
 * optional provider resolver. The session archive is the authorization list;
 * arbitrary provider IDs and URLs are never proxied.
 * GET /api/attachments/{providerRef}?session_id={sessionID}
 */
export async function handleAttachmentAPI(
  server: Server,
  req: Request,
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  const url = new URL(req.url);
  const raw = url.pathname.startsWith(attachmentPathPrefix)
    ? url.pathname.slice(attachmentPathPrefix.length)
    : url.pathname;
  let ref = "";
  try {
    ref = decodeURIComponent(raw);
  } catch {
    ref = "";
  }
  if (
    !url.pathname.startsWith(attachmentPathPrefix) || ref === ""
  ) {
    return writeError(
      400,
      "attachment reference required",
      "invalid_request_error",
    );
  }
  try {
    validateAttachmentReferenceForResolver(ref);
  } catch {
    return writeError(
      400,
      "invalid attachment reference",
      "invalid_request_error",
    );
  }
  const sessionId = (url.searchParams.get("session_id") ?? "").trim();
  if (sessionId === "" || server.settings === null) {
    return writeError(400, "session_id is required", "invalid_request_error");
  }
  const { found } = server.findSessionWorkDir(sessionId);
  if (!found) {
    return writeError(404, "session not found", "not_found");
  }
  const archived = archivedFileAttachment(server, sessionId, ref);
  if (!archived) {
    return writeError(
      404,
      "attachment is not archived for this session",
      "not_found",
    );
  }
  // Go reads s.provider under the read lock; Deno is single-threaded.
  const activeProvider = server.provider as
    | Partial<AttachmentMetadataResolver & AttachmentResolver>
    | undefined;
  const hasMetadataResolver =
    typeof activeProvider?.resolveAttachmentWithMetadata === "function";
  const hasResolver = typeof activeProvider?.resolveAttachment === "function";
  if (!hasMetadataResolver && !hasResolver) {
    return writeError(
      501,
      "the active provider cannot download attachments",
      "capability_error",
    );
  }
  const signal = AbortSignal.any([
    req.signal,
    AbortSignal.timeout(attachmentResolveTimeoutMs),
  ]);
  let content: AttachmentContent;
  try {
    content = hasMetadataResolver
      ? await (activeProvider as AttachmentMetadataResolver)
        .resolveAttachmentWithMetadata(signal, archived)
      : await (activeProvider as AttachmentResolver).resolveAttachment(
        signal,
        ref,
      );
  } catch (err) {
    return writeError(
      502,
      `download attachment: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "upstream_error",
    );
  }
  const mediaType = attachmentMediaType(content.mediaType, content.data);
  const filename = attachmentFilename(content.filename, ref);
  const headers = new Headers({
    "content-type": mediaType,
    "content-length": String(content.data.byteLength),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${filename}"`,
  });
  return new Response(content.data as unknown as BodyInit, {
    status: 200,
    headers,
  });
}

/** attachmentMediaType trusts a provider media type only when it is sane. */
export function attachmentMediaType(
  raw: string,
  data: Uint8Array,
): string {
  const mediaType = raw.split(";", 2)[0].trim();
  if (
    mediaType === "" || !mediaType.includes("/") ||
    /[\r\n]/.test(mediaType)
  ) {
    return detectContentType(data);
  }
  return mediaType;
}

/** attachmentFilename strips path/control characters from a download name. */
export function attachmentFilename(raw: string, fallback: string): string {
  let name = raw.trim();
  name = name.replace(/[\\/]/g, "_").replace(/[\r\n"]/g, "").replaceAll(
    "\x00",
    "",
  );
  if (name === "" || name === "." || name === "..") {
    name = fallback;
  }
  if (name.length > 180) {
    name = name.slice(0, 180);
  }
  return name;
}

/**
 * archivedFileAttachment walks the session transcript for the newest file
 * attachment whose provider ref matches. The archive is the authorization
 * list; unarchived refs are never handed to a provider.
 */
export function archivedFileAttachment(
  server: Server,
  sessionId: string,
  ref: string,
): Attachment | null {
  if (server.settings === null || sessionId === "" || ref === "") return null;
  let after = 0;
  for (;;) {
    let messages;
    try {
      messages = listSessionMessagesAfter(
        getSessionDir(server.settings),
        sessionId,
        after,
        500,
      );
    } catch {
      return null;
    }
    for (const item of messages) {
      for (const attachment of item.message.attachments ?? []) {
        if (attachment.kind === "file" && attachment.providerRef === ref) {
          return attachment;
        }
      }
      if (item.seq > after) after = item.seq;
    }
    if (messages.length < 500) return null;
  }
}
