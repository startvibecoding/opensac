// (the `AttachmentService` half).
//
// The canonical Runtime-owned attachment store: intake, private-storage
// persistence, integrity-checked reads, and expiry cleanup. Platform adapters
// provide only an authenticated `open` function; this module owns every
// durable attachment row.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; `[]byte`
// maps to `Uint8Array`; `io.ReadCloser` maps to a `Deno.FsFile`; `time.Time`
// maps to `Date` (RFC3339 strings in the durable columns); SHA-256 uses
// `node:crypto`. `AcceptProviderAttachment` and the artifact collector remain
// with the `SessionRuntime` slice.

import { createHash } from "node:crypto";
import * as path from "../compat/path.ts";
import { AttachmentDAO, type AttachmentRecord } from "../dao/mod.ts";
import { generateID } from "../session/entry.ts";
import { queryRootDatabase, writeRootDatabase } from "../session/database.ts";
import {
  ATTACHMENT_AUDIO,
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
  type AttachmentKind,
  type AttachmentPolicy,
  parseAttachmentTimestamp,
  sanitizeAttachmentFilename,
  type SessionAttachment,
  validatePathComponent,
} from "./attachment.ts";
import { detectAttachmentMediaType } from "./media_type.ts";
import { reconcileArtifactStorageOpportunistic } from "./storage_reconcile.ts";

/** The private-store handoff used by `publish_artifact` and provider resolvers. */
export interface ArtifactIngress {
  origin: string;
  reference: string;
  kind: AttachmentKind;
  filename: string;
  mediaType: string;
  sizeHint: number;
  open: (
    signal: AbortSignal | undefined,
  ) => ArtifactStream | Promise<ArtifactStream>;
}

/** One readable artifact source, either a complete buffer or a byte stream. */
export interface ArtifactStream {
  bytes?: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
  filename?: string;
  mediaType?: string;
  contentSize?: number;
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  ATTACHMENT_IMAGE,
  ATTACHMENT_FILE,
  ATTACHMENT_AUDIO,
  ATTACHMENT_VIDEO,
]);

/**
 * Owns attachment storage and its session-backed records. Platform adapters
 * provide only the authenticated Open function.
 */
export class AttachmentService {
  readonly sessionDir: string;
  readonly policy: AttachmentPolicy;

  constructor(sessionDir: string, policy: AttachmentPolicy) {
    if (sessionDir.trim() === "") {
      throw new Error("attachment session directory is required");
    }
    if (policy.maxImageBytes <= 0 || policy.maxFileBytes <= 0) {
      throw new Error("attachment size limits must be positive");
    }
    if (policy.retention <= 0) {
      throw new Error("attachment retention must be positive");
    }
    this.sessionDir = path.normalize(sessionDir);
    this.policy = policy;
  }

  /** Returns the configured local resource limits. */
  Policy(): AttachmentPolicy {
    return this.policy;
  }

  /**
   * Copies a published/generated object into Runtime-private storage. User
   * inputs must never call this path.
   */
  async acceptArtifact(
    sessionID: string,
    runID: string,
    ingress: ArtifactIngress,
    signal?: AbortSignal,
  ): Promise<SessionAttachment> {
    if (sessionID.trim() === "") {
      throw new Error("attachment session ID is required");
    }
    if (ingress.open === undefined || ingress.open === null) {
      throw new Error("attachment source is not readable");
    }
    if (!VALID_KINDS.has(ingress.kind)) {
      throw new Error(`unsupported attachment kind "${ingress.kind}"`);
    }
    // Best-effort expiry cleanup belongs to the single Runtime-owned store. A
    // cleanup hiccup must not make a trusted self-hosted user's new attachment
    // unusable; its durable write below remains the authoritative operation.
    try {
      await this.CleanupExpired(signal);
    } catch {
      // deliberately ignored
    }
    // Expiry only sees rows the database still has. The throttled directory
    // pass beside it reclaims storage whose rows are gone.
    reconcileArtifactStorageOpportunistic(this.sessionDir, this.policy);

    const maxBytes = ingress.kind === ATTACHMENT_IMAGE
      ? this.policy.maxImageBytes
      : this.policy.maxFileBytes;
    if (ingress.sizeHint > maxBytes) {
      throw new Error(`attachment exceeds ${maxBytes} bytes`);
    }

    const attachmentID = generateID();
    validatePathComponent(sessionID);
    validatePathComponent(attachmentID);
    const dir = path.join(this.sessionDir, "artifacts", attachmentID);
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpName = await Deno.makeTempFile({ dir, prefix: ".incoming-" });
    const removeTmp = () => {
      try {
        Deno.removeSync(tmpName);
      } catch {
        // already gone
      }
    };

    let stream: ArtifactStream;
    try {
      stream = await ingress.open(signal);
    } catch (err) {
      removeTmp();
      throw new Error(`open ${ingress.origin} attachment: ${err}`);
    }

    let written: number;
    let digest: string;
    try {
      const result = await copyLimited(tmpName, stream, maxBytes);
      written = result.written;
      digest = result.digest;
    } catch (err) {
      removeTmp();
      throw err;
    }
    if (written > maxBytes) {
      removeTmp();
      throw new Error(`attachment exceeds ${maxBytes} bytes`);
    }

    let filename = ingress.filename;
    if (filename.trim() === "") filename = stream.filename ?? "";
    filename = sanitizeAttachmentFilename(filename);
    let mediaType = ingress.mediaType.trim();
    if (mediaType === "") mediaType = (stream.mediaType ?? "").trim();
    let detectedType = "";
    let detectErr: unknown = null;
    try {
      detectedType = await detectAttachmentMediaType(tmpName);
    } catch (err) {
      detectErr = err;
    }
    if (ingress.kind === ATTACHMENT_IMAGE) {
      if (
        detectErr !== null || !detectedType.toLowerCase().startsWith("image/")
      ) {
        removeTmp();
        if (detectErr !== null) {
          throw new Error(`detect image attachment: ${detectErr}`);
        }
        throw new Error(
          `image attachment has detected media type "${detectedType}"`,
        );
      }
      // Use the bytes-derived type for image input instead of trusting an
      // event's filename or content-type hint.
      mediaType = detectedType;
    } else if (mediaType === "" && detectErr === null) {
      mediaType = detectedType;
    }

    const storageKey = path
      .join("artifacts", attachmentID, "content")
      .split(path.SEPARATOR)
      .join("/");
    const finalPath = path.join(dir, "content");
    try {
      await Deno.rename(tmpName, finalPath);
    } catch (err) {
      removeTmp();
      throw new Error(`commit attachment: ${err}`);
    }

    const now = new Date();
    const record: SessionAttachment = {
      id: attachmentID,
      sessionId: sessionID,
      runId: runID,
      origin: ingress.origin,
      kind: ingress.kind,
      filename,
      mediaType,
      bytes: written,
      sha256: digest,
      storageKey,
      status: "accepted",
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.policy.retention),
    };
    try {
      writeRootDatabase(this.sessionDir, (tx) => {
        new AttachmentDAO(null).insert(tx, {
          id: record.id,
          sessionId: record.sessionId,
          runId: record.runId,
          origin: record.origin,
          kind: record.kind,
          filename: record.filename,
          mediaType: record.mediaType,
          bytes: record.bytes,
          sha256: record.sha256,
          storageKey: record.storageKey,
          status: record.status,
          createdAt: record.createdAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
          metadata: "{}",
        });
      });
    } catch (err) {
      try {
        Deno.removeSync(finalPath);
      } catch {
        // already gone
      }
      throw new Error(`persist attachment: ${err}`);
    }
    return record;
  }

  /** Returns one attachment record belonging to `sessionID`. */
  get(sessionID: string, attachmentID: string): SessionAttachment {
    validatePathComponent(sessionID);
    validatePathComponent(attachmentID);
    let record: SessionAttachment | null = null;
    queryRootDatabase(this.sessionDir, (db) => {
      const stored = new AttachmentDAO(db.db).find(sessionID, attachmentID);
      if (stored !== undefined) record = recordFromDAO(stored);
    });
    if (record === null) {
      throw new Error(`attachment ${attachmentID} not found`);
    }
    return record;
  }

  /**
   * Returns the private content stream after checking session ownership and
   * expiry. Callers must close the returned file.
   */
  async Open(
    sessionID: string,
    attachmentID: string,
  ): Promise<{ record: SessionAttachment; file: Deno.FsFile }> {
    const record = this.get(sessionID, attachmentID);
    if (
      record.expiresAt.getTime() !== 0 &&
      Date.now() > record.expiresAt.getTime()
    ) {
      throw new Error(`attachment ${attachmentID} has expired`);
    }
    const filePath = this.storagePath(record.storageKey);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(filePath);
    } catch (err) {
      throw new Error(`open attachment: ${err}`);
    }
    if (!info.isFile) {
      throw new Error(`attachment ${attachmentID} is not a regular file`);
    }
    if (record.bytes !== info.size) {
      throw new Error(
        `attachment ${attachmentID} failed integrity check: size mismatch`,
      );
    }
    const file = await Deno.open(filePath, { read: true });
    const hash = createHash("sha256");
    const buf = new Uint8Array(64 * 1024);
    while (true) {
      const n = await file.read(buf);
      if (n === null) break;
      hash.update(buf.subarray(0, n));
    }
    if (hash.digest("hex") !== record.sha256.trim()) {
      file.close();
      throw new Error(
        `attachment ${attachmentID} failed integrity check: hash mismatch`,
      );
    }
    await file.seek(0, Deno.SeekMode.Start);
    return { record, file };
  }

  /**
   * Expires and removes private attachment content whose TTL has elapsed. It is
   * deliberately tolerant of an already-missing file.
   */
  async CleanupExpired(
    _signal?: AbortSignal,
  ): Promise<{ count: number }> {
    const now = new Date();
    const expired: Array<{ id: string; storageKey: string }> = [];
    writeRootDatabase(this.sessionDir, (tx) => {
      const records = new AttachmentDAO(null).expired(tx, now.toISOString());
      for (const record of records) {
        expired.push({ id: record.id, storageKey: record.storageKey });
      }
      new AttachmentDAO(null).markExpired(tx, now.toISOString());
    });
    for (const item of expired) {
      const filePath = this.storagePath(item.storageKey);
      try {
        await Deno.remove(filePath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          throw new Error(`remove expired attachment ${item.id}: ${err}`);
        }
      }
      // Ignore a non-empty/missing parent so a retry remains safe.
      try {
        await Deno.remove(path.dirname(filePath));
      } catch {
        // deliberately ignored
      }
    }
    return { count: expired.length };
  }

  storagePath(storageKey: string): string {
    if (storageKey.trim() === "") {
      throw new Error("invalid attachment storage key");
    }
    const joined = path.join(this.sessionDir, ...storageKey.split("/"));
    const rel = path.relative(this.sessionDir, joined);
    if (
      rel === ".." || rel.startsWith(`..${path.SEPARATOR}`) ||
      path.isAbsolute(rel)
    ) {
      throw new Error("invalid attachment storage key");
    }
    return joined;
  }

  /**
   * Updates the Runtime-owned lifecycle state of an attachment. Used for
   * accepted -> generated -> expired transitions; adapters do not write
   * attachment rows directly.
   */
  setStatus(sessionID: string, attachmentID: string, status: string): void {
    validatePathComponent(sessionID);
    validatePathComponent(attachmentID);
    if (
      status !== "accepted" && status !== "generated" && status !== "expired"
    ) {
      throw new Error(`invalid attachment status "${status}"`);
    }
    writeRootDatabase(this.sessionDir, (tx) => {
      const changed = new AttachmentDAO(null).setStatus(
        tx,
        sessionID,
        attachmentID,
        status,
      );
      if (changed !== 1) {
        throw new Error(`attachment ${attachmentID} not found for session`);
      }
    });
  }
}

function recordFromDAO(stored: AttachmentRecord): SessionAttachment {
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    runId: stored.runId,
    origin: stored.origin,
    kind: stored.kind as AttachmentKind,
    filename: stored.filename,
    mediaType: stored.mediaType,
    bytes: stored.bytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    status: stored.status,
    createdAt: parseAttachmentTimestamp(stored.createdAt),
    expiresAt: parseAttachmentTimestamp(stored.expiresAt),
  };
}

/**
 * Copies `stream` to `targetPath` up to `maxBytes + 1` bytes (so the caller can
 * detect an over-limit source) while hashing the content.
 */
async function copyLimited(
  targetPath: string,
  stream: ArtifactStream,
  maxBytes: number,
): Promise<{ written: number; digest: string }> {
  const file = await Deno.open(targetPath, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let written = 0;
  const limit = maxBytes + 1;
  try {
    const source = stream.bytes !== undefined
      ? singleChunk(stream.bytes)
      : stream.stream;
    if (source === undefined) {
      throw new Error("attachment source is empty");
    }
    let remaining = limit;
    for await (const chunk of source) {
      if (remaining <= 0) break;
      const take = chunk.length > remaining
        ? chunk.subarray(0, remaining)
        : chunk;
      let offset = 0;
      while (offset < take.length) {
        const n = await file.write(take.subarray(offset));
        if (n <= 0) throw new Error("attachment write made no progress");
        offset += n;
      }
      hash.update(take);
      written += take.length;
      remaining -= take.length;
    }
    await file.sync();
  } finally {
    file.close();
  }
  return { written, digest: hash.digest("hex") };
}

async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
