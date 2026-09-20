// Type slice of internal/agentruntime/input.go.
//
// The canonical Runtime attachment vocabulary shared by inbound input, provider
// output attachment resolution, and artifact delivery. The `AttachmentService`
// (storage intake, private store, DAO persistence) lands with the
// `SessionRuntime` slice because it needs the session database boundary and the
// runtime-owned `SessionRuntime`; these value types are ported now so the
// delivery planner and error/event projections can reference one definition.
//
// Deviation: `time.Time` maps to `Date`.

/**
 * Identifies the media classes supported by Runtime input and artifact
 * delivery. Provider attachments are normalized into this store only when they
 * become concrete files.
 */
export type AttachmentKind = "image" | "file" | "audio" | "video";

export const AttachmentImage: AttachmentKind = "image";
export const AttachmentFile: AttachmentKind = "file";
export const AttachmentAudio: AttachmentKind = "audio";
export const AttachmentVideo: AttachmentKind = "video";

/**
 * The canonical persisted attachment record. The content itself lives under
 * `storageKey` and is never embedded in a session entry.
 */
export interface SessionAttachment {
  id: string;
  sessionId: string;
  runId: string;
  origin: string;
  kind: AttachmentKind;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  storageKey: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Local resource limits for accepted media. These are reliability limits for a
 * self-hosted service, not a moderation or multi-tenant authorization policy.
 * `retention` is expressed in milliseconds.
 */
export interface AttachmentPolicy {
  maxImageBytes: number;
  maxFileBytes: number;
  retention: number;
}

export function defaultAttachmentPolicy(): AttachmentPolicy {
  return {
    maxImageBytes: 20 << 20,
    maxFileBytes: 50 << 20,
    retention: 7 * 24 * 60 * 60 * 1000,
  };
}

/**
 * Parses one of the timestamp layouts Go's `parseTimestamp` accepts:
 * RFC3339(Nano) and `2006-01-02 15:04:05`. Unknown values map to the zero
 * time (`new Date(0)`) exactly like Go's zero `time.Time`.
 */
export function parseAttachmentTimestamp(value: string): Date {
  const trimmed = value.trim();
  const normalized = trimmed.includes("T")
    ? trimmed
    : trimmed.replace(" ", "T") + "Z";
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Validates a single path component (session/attachment ID) exactly like Go's
 * `validatePathComponent`.
 */
export function validatePathComponent(value: string): void {
  if (
    value === "" || value === "." || value === ".." ||
    value.includes("/") || value.includes("\\")
  ) {
    throw new Error("invalid attachment path component");
  }
}

/**
 * Sanitizes an attachment filename, mirroring Go's `sanitizeAttachmentFilename`.
 */
export function sanitizeAttachmentFilename(value: string): string {
  const base = value.trim().split(/[/\\]/).pop() ?? "";
  if (base === "." || base === ".." || base === "") return "attachment";
  let out = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += "_";
      continue;
    }
    out += ch;
    if (out.length >= 255) break;
  }
  return out === "" ? "attachment" : out;
}
