// Ported from internal/provider/attachments.go

import type { Attachment } from "./types.ts";

/**
 * AttachmentContent is an optional provider-specific download result. It is
 * deliberately not part of Provider so vendors without file retrieval remain
 * unaffected.
 */
export interface AttachmentContent {
  data: Uint8Array;
  mediaType: string;
  filename: string;
}

/**
 * Implemented only by providers that can resolve an archived provider
 * reference into bytes. Callers must authorize the ref against the session
 * archive before invoking it.
 */
export interface AttachmentResolver {
  resolveAttachment(
    signal: AbortSignal | undefined,
    ref: string,
  ): Promise<AttachmentContent>;
}

/**
 * An optional refinement for providers whose file reference needs lifecycle
 * context, such as a Code Interpreter container ID. Callers authorize the full
 * archived Attachment first.
 */
export interface AttachmentMetadataResolver {
  resolveAttachmentWithMetadata(
    signal: AbortSignal | undefined,
    attachment: Attachment,
  ): Promise<AttachmentContent>;
}

/**
 * Validates an opaque provider ref before it is interpolated into a
 * provider-owned path.
 */
export function validateAttachmentReferenceForResolver(ref: string): void {
  if (ref === "" || ref.length > 128) {
    throw new Error("invalid attachment reference");
  }
  for (const char of ref) {
    const code = char.codePointAt(0) as number;
    if (
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x30 && code <= 0x39) || // 0-9
      char === "_" || char === "-"
    ) {
      continue;
    }
    throw new Error("invalid attachment reference");
  }
}
