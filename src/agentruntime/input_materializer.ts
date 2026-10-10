//
// `InputMaterializer` owns project-relative input files and their
// session-backed records. Artifact bytes deliberately use a different private
// store (`AttachmentService`). The `SessionRuntime`-bound methods
// (`AcceptInput`/`PrepareInput`/`AttachPreparedInput`/`DiscardInput`/
// `CleanupInputResources`/`BuildUserMessage`) land with the `SessionRuntime`
// slice; this module ports the materializer and its persistence contract.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; `[]byte`
// maps to `Uint8Array`; `io.ReadCloser` maps to a byte stream; `time.Time` maps
// to `Date`; SHA-256/HMAC use `node:crypto`.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import type { FsFile } from "../platform/runtime.ts";
import { createHash, createHmac, randomBytes } from "node:crypto";
import * as path from "../compat/path.ts";
import {
  type Database,
  InputResourceDAO,
  type InputResourceRecord,
} from "../dao/mod.ts";
import type { DB } from "../db/mod.ts";
import { generateID } from "../session/entry.ts";
import { queryRootDatabase, writeRootDatabase } from "../session/database.ts";
import { appendInputResourceEventTx } from "../session/input_resources.ts";
import {
  ATTACHMENT_AUDIO,
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  ATTACHMENT_VIDEO,
  type AttachmentKind,
  sanitizeAttachmentFilename,
  validatePathComponent,
} from "./attachment.ts";
import { detectContentType } from "./media_type.ts";
import {
  type KnowledgeBaseReference,
  type KnowledgeCapsule,
} from "./knowledge_context.ts";

const VALID_INPUT_KINDS: ReadonlySet<string> = new Set([
  ATTACHMENT_IMAGE,
  ATTACHMENT_FILE,
  ATTACHMENT_AUDIO,
  ATTACHMENT_VIDEO,
]);

/**
 * The ephemeral adapter-to-Runtime handoff for one input resource. Reference
 * and transport credentials are never persisted.
 */
export interface InputIngress {
  origin: string;
  eventId: string;
  itemIndex: number;
  reference: string;
  kind: AttachmentKind;
  filenameHint: string;
  mediaTypeHint: string;
  sizeHint: number;
  open: (signal: AbortSignal | undefined) => InputStream | Promise<InputStream>;
}

/** The authenticated one-shot stream supplied by an adapter. */
export interface InputStream {
  bytes?: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
  filename?: string;
  mediaType?: string;
  contentSize?: number;
}

/**
 * The opaque resource reference carried by an input submission after Runtime
 * has materialized and persisted it.
 */
export interface PreparedInput {
  resourceId: string;
  kind: AttachmentKind;
  relativePath: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

/**
 * The only user-input contract consumed by `SessionRuntime`. Resource item
 * idempotency is enforced here; durable submission reservation and existing-Run
 * reuse are handled by the Runtime admission layer.
 */
export interface InputSubmission {
  text: string;
  resources: PreparedInput[];
  knowledgeBaseReferences: KnowledgeBaseReference[];
  knowledgeCapsules: KnowledgeCapsule[];
  idempotencyKey: string;
}

/**
 * Returns the canonical Runtime resource IDs in submission order. The slice is
 * copied so callers cannot mutate the submission's ownership facts.
 */
export function resourceIds(submission: InputSubmission): string[] {
  const ids: string[] = [];
  for (const resource of submission.resources) {
    if (resource.resourceId !== "") ids.push(resource.resourceId);
  }
  return ids;
}

/**
 * Remains a source-compatible name while adapters migrate to the canonical
 * `InputSubmission` name. It is an alias, not a second input model.
 */
export type RunInput = InputSubmission;

/** The canonical persisted input file record. */
export interface InputResource {
  id: string;
  sessionId: string;
  runId: string;
  origin: string;
  eventId: string;
  itemIndex: number;
  itemKey: string;
  kind: AttachmentKind;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  relativePath: string;
  status: string;
  createdAt: Date;
}

/** Projects a persisted record to the opaque submission reference. */
export function preparedInput(record: InputResource): PreparedInput {
  return {
    resourceId: record.id,
    kind: record.kind,
    relativePath: record.relativePath,
    filename: record.filename,
    mediaType: record.mediaType,
    bytes: record.bytes,
  };
}

/**
 * Reliability limits applied before an input file enters the project workspace.
 * It does not select file value or parse documents. `draftMaxAge` is in
 * milliseconds.
 */
export interface InputPolicy {
  maxImageBytes: number;
  maxFileBytes: number;
  maxImagePixels: number;
  draftMaxAge: number;
}

export function defaultInputPolicy(): InputPolicy {
  return {
    maxImageBytes: 20 << 20,
    maxFileBytes: 50 << 20,
    maxImagePixels: 40_000_000,
    draftMaxAge: 24 * 60 * 60 * 1000,
  };
}

/**
 * Owns project-relative input files and their session-backed records. Artifact
 * bytes deliberately use a different private store.
 */
export class InputMaterializer {
  readonly sessionDir: string;
  readonly workDir: string;
  readonly policy: InputPolicy;
  #itemKeyKey: Uint8Array | null = null;

  constructor(sessionDir: string, workDir: string, policy: InputPolicy) {
    if (sessionDir.trim() === "") {
      throw new Error("input session directory is required");
    }
    if (workDir.trim() === "") {
      throw new Error("input work directory is required");
    }
    if (
      policy.maxImageBytes <= 0 ||
      policy.maxFileBytes <= 0 ||
      policy.maxImagePixels <= 0
    ) {
      throw new Error("input resource limits must be positive");
    }
    this.sessionDir = path.normalize(sessionDir);
    this.workDir = path.normalize(workDir);
    this.policy =
      policy.draftMaxAge > 0
        ? policy
        : { ...policy, draftMaxAge: 24 * 60 * 60 * 1000 };
  }

  /** The configured local resource limits. */
  Policy(): InputPolicy {
    return this.policy;
  }

  /**
   * Streams one resource into `.opensac/tmp/inputs` and persists its canonical
   * metadata. Stable platform items are idempotent across retries and
   * concurrent deliveries.
   */
  async Prepare(
    sessionId: string,
    _runId: string,
    ingress: InputIngress,
    signal?: AbortSignal,
  ): Promise<InputResource> {
    validatePathComponent(sessionId);
    if (ingress.open === undefined || ingress.open === null) {
      throw new Error("input source is not readable");
    }
    if (!VALID_INPUT_KINDS.has(ingress.kind)) {
      throw new Error(`unsupported input kind "${ingress.kind}"`);
    }
    const itemKey = this.itemKey(ingress);
    if (itemKey !== "") {
      const existing = this.findByItemKey(sessionId, itemKey);
      if (existing !== undefined) return existing;
    }

    const maxBytes =
      ingress.kind === ATTACHMENT_IMAGE
        ? this.policy.maxImageBytes
        : this.policy.maxFileBytes;
    if (ingress.sizeHint > maxBytes) {
      throw new Error(`input exceeds ${maxBytes} bytes`);
    }

    const root = await this.inputRoot();
    const resourceId = generateID();
    validatePathComponent(resourceId);
    const dir = path.join(root, resourceId);
    await nodeRuntime.mkdir(dir, { mode: 0o700 });
    const removeResource = () => {
      try {
        nodeRuntime.removeSync(dir, { recursive: true });
      } catch {
        // already gone
      }
    };
    let tmpName: string;
    try {
      tmpName = await nodeRuntime.makeTempFile({ dir, prefix: ".incoming-" });
    } catch (err) {
      removeResource();
      throw new Error(`create input temporary file: ${err}`);
    }
    const cleanup = () => {
      try {
        nodeRuntime.removeSync(tmpName);
      } catch {
        // already gone
      }
      removeResource();
    };

    let stream: InputStream;
    try {
      stream = await ingress.open(signal);
    } catch (err) {
      cleanup();
      throw new Error(`open ${ingress.origin} input: ${err}`);
    }
    if (stream.bytes === undefined && stream.stream === undefined) {
      cleanup();
      throw new Error(`open ${ingress.origin} input: empty reader`);
    }

    let written: number;
    let digest: string;
    try {
      const result = await copyInputStream(tmpName, stream, maxBytes);
      written = result.written;
      digest = result.digest;
    } catch (err) {
      cleanup();
      throw new Error(`read input: ${err}`);
    }
    if (written > maxBytes) {
      cleanup();
      throw new Error(`input exceeds ${maxBytes} bytes`);
    }

    let detectedType: string;
    try {
      detectedType = await detectInputMediaType(tmpName);
    } catch (err) {
      removeResource();
      throw new Error(`detect input media type: ${err}`);
    }
    let mediaType = detectedType;
    if (ingress.kind === ATTACHMENT_IMAGE) {
      if (!detectedType.toLowerCase().startsWith("image/")) {
        removeResource();
        throw new Error(
          `image input has detected media type "${detectedType}"`,
        );
      }
      try {
        await this.inspectImage(tmpName);
      } catch (err) {
        removeResource();
        throw err;
      }
      mediaType = detectedType;
    } else if (
      detectedType === "application/octet-stream" &&
      ingress.mediaTypeHint.trim() !== ""
    ) {
      // Preserve a trusted transport hint only when content sniffing cannot
      // identify the format (for example an AMR voice payload).
      mediaType = ingress.mediaTypeHint.trim();
    }

    let filename = ingress.filenameHint.trim();
    if (filename === "") filename = (stream.filename ?? "").trim();
    filename = canonicalInputFilename(filename, mediaType);
    const finalPath = path.join(dir, filename);
    try {
      await nodeRuntime.rename(tmpName, finalPath);
    } catch (err) {
      removeResource();
      throw new Error(`commit input: ${err}`);
    }
    let relativePath: string;
    try {
      relativePath = inputRelativePath(this.workDir, finalPath);
    } catch (err) {
      removeResource();
      throw err;
    }
    const now = new Date();
    // The resource row is intentionally staged first. Durable admission binds
    // it to a Run in the same transaction as the intent, Run row, turn
    // boundary, and started event; a failed admission therefore cannot leave an
    // attached resource pointing at a nonexistent Run.
    const record: InputResource = {
      id: resourceId,
      sessionId,
      runId: "",
      origin: ingress.origin.trim(),
      eventId: ingress.eventId.trim(),
      itemIndex: ingress.itemIndex,
      itemKey,
      kind: ingress.kind,
      filename,
      mediaType,
      bytes: written,
      sha256: digest,
      relativePath: relativePath.split(path.SEPARATOR).join("/"),
      status: "prepared",
      createdAt: now,
    };
    try {
      writeRootDatabase(this.sessionDir, (tx) => {
        new InputResourceDAO(null).insert(tx, {
          id: record.id,
          sessionId: record.sessionId,
          runId: record.runId,
          origin: record.origin,
          eventId: record.eventId,
          itemIndex: record.itemIndex,
          itemKey: record.itemKey,
          kind: record.kind,
          filename: record.filename,
          mediaType: record.mediaType,
          bytes: record.bytes,
          sha256: record.sha256,
          relativePath: record.relativePath,
          status: record.status,
          createdAt: record.createdAt.toISOString(),
          metadata: "{}",
        });
        appendInputResourceEventTx(tx, {
          id: `input-resource-${record.id}-prepared`,
          sessionId: record.sessionId,
          resourceId: record.id,
          runId: "",
          eventType: "input_resource_prepared",
          status: record.status,
          timestamp: record.createdAt,
          data: {
            kind: record.kind,
            filename: record.filename,
            mediaType: record.mediaType,
            bytes: record.bytes,
            sha256: record.sha256,
            relativePath: record.relativePath,
          },
        });
      });
    } catch (err) {
      removeResource();
      if (itemKey !== "") {
        const existing = this.findByItemKey(sessionId, itemKey);
        if (existing !== undefined) return existing;
      }
      throw new Error(`persist input resource: ${err}`);
    }
    return record;
  }

  /**
   * Removes an unbound draft resource from the project input area while
   * retaining a durable deleted record and canonical lifecycle event.
   */
  Discard(sessionId: string, resourceId: string): void {
    this.deleteResource(sessionId, resourceId, false);
  }

  /**
   * Explicitly removes a resource, including one already attached to a Run. The
   * record remains as an audit/replay tombstone.
   */
  delete(sessionId: string, resourceId: string): void {
    this.deleteResource(sessionId, resourceId, true);
  }

  private deleteResource(
    sessionId: string,
    resourceId: string,
    allowAttached: boolean,
  ): void {
    validatePathComponent(sessionId);
    validatePathComponent(resourceId);
    let relativePath = "";
    writeRootDatabase(this.sessionDir, (tx) => {
      const record = new InputResourceDAO(null).find(tx, sessionId, resourceId);
      if (record === undefined) {
        throw new Error(`input resource ${resourceId} not found`);
      }
      relativePath = record.relativePath;
      const runId = record.runId;
      const status = record.status;
      if (status === "deleted") return;
      if (runId !== "" && !allowAttached) {
        throw new Error(
          `input resource ${resourceId} is attached to Run ${runId}`,
        );
      }
      new InputResourceDAO(null).updateStatus(
        tx,
        sessionId,
        resourceId,
        "deleted",
      );
      appendInputResourceEventTx(tx, {
        id: `input-resource-${resourceId}-deleted`,
        sessionId,
        resourceId,
        runId,
        eventType: "input_resource_deleted",
        status: "deleted",
        timestamp: new Date(),
        data: { reason: "runtime_discard" },
      });
    });
    if (relativePath !== "") {
      const resourcePath = this.resourcePath(relativePath);
      try {
        nodeRuntime.removeSync(path.dirname(resourcePath), { recursive: true });
      } catch (err) {
        if (!(err instanceof nodeRuntime.errors.NotFound)) throw err;
      }
    }
  }

  /**
   * Removes expired unbound drafts, marks missing records, and leaves attached
   * resources untouched. Filesystem deletion happens after the durable status
   * transaction so a retry can safely finish interrupted cleanup.
   */
  Cleanup(sessionId: string, now?: Date): number {
    validatePathComponent(sessionId);
    const at = now ?? new Date();
    const remove: Array<{ relativePath: string }> = [];
    writeRootDatabase(this.sessionDir, (tx) => {
      const records = new InputResourceDAO(null).list(tx, sessionId);
      for (const record of records) {
        let missing = false;
        try {
          const resolved = this.resourcePath(record.relativePath);
          try {
            nodeRuntime.statSync(resolved);
          } catch (err) {
            if (err instanceof nodeRuntime.errors.NotFound) missing = true;
          }
        } catch {
          // invalid relative path: treated like a path error, not a missing file
        }
        if (
          missing &&
          record.status !== "deleted" &&
          record.status !== "missing"
        ) {
          new InputResourceDAO(null).updateStatus(
            tx,
            sessionId,
            record.id,
            "missing",
          );
          appendInputResourceEventTx(tx, {
            id: `input-resource-${record.id}-missing`,
            sessionId,
            resourceId: record.id,
            runId: record.runId,
            eventType: "input_resource_missing",
            status: "missing",
            timestamp: at,
            data: { reason: "file_missing" },
          });
        }
        if (record.status === "prepared" && record.runId === "") {
          const createdAt = new InputResourceDAO(null).createdAt(
            tx,
            sessionId,
            record.id,
          );
          const created = new Date(createdAt ?? "");
          if (
            !Number.isNaN(created.getTime()) &&
            at.getTime() - created.getTime() >= this.policy.draftMaxAge
          ) {
            new InputResourceDAO(null).deleteDraft(tx, sessionId, record.id);
            appendInputResourceEventTx(tx, {
              id: `input-resource-${record.id}-deleted`,
              sessionId,
              resourceId: record.id,
              runId: "",
              eventType: "input_resource_deleted",
              status: "deleted",
              timestamp: at,
              data: { reason: "draft_expired" },
            });
            remove.push({ relativePath: record.relativePath });
          }
        }
      }
    });
    for (const item of remove) {
      const resourcePath = this.resourcePath(item.relativePath);
      try {
        nodeRuntime.removeSync(path.dirname(resourcePath), { recursive: true });
      } catch (err) {
        if (!(err instanceof nodeRuntime.errors.NotFound)) throw err;
      }
    }
    return remove.length;
  }

  /** Returns one persisted input resource belonging to `sessionId`. */
  get(sessionId: string, resourceId: string): InputResource {
    validatePathComponent(sessionId);
    validatePathComponent(resourceId);
    let record: InputResource | null = null;
    queryRootDatabase(this.sessionDir, (db) => {
      const conn = requireConn(db);
      const stored = new InputResourceDAO(null).find(
        conn,
        sessionId,
        resourceId,
      );
      if (stored !== undefined) record = mapInputResource(stored);
    });
    if (record === null) throw new Error("input resource not found");
    return record;
  }

  private findByItemKey(
    sessionId: string,
    itemKey: string,
  ): InputResource | undefined {
    let record: InputResource | null = null;
    queryRootDatabase(this.sessionDir, (db) => {
      const conn = requireConn(db);
      const stored = new InputResourceDAO(conn).findByItemKey(
        sessionId,
        itemKey,
      );
      if (stored !== undefined) record = mapInputResource(stored);
    });
    return record ?? undefined;
  }

  private async inputRoot(): Promise<string> {
    const workDir = await nodeRuntime.realPath(this.workDir);
    const root = path.join(workDir, ".opensac", "tmp", "inputs");
    await nodeRuntime.mkdir(root, { recursive: true, mode: 0o700 });
    const resolvedRoot = await nodeRuntime.realPath(root);
    const rel = path.relative(workDir, resolvedRoot);
    if (isEscaping(rel)) {
      throw new Error("input root escaped Runtime work directory");
    }
    return resolvedRoot;
  }

  resourcePath(relativePath: string): string {
    if (relativePath.trim() === "" || path.isAbsolute(relativePath)) {
      throw new Error("invalid input relative path");
    }
    const joined = path.join(this.workDir, ...relativePath.split("/"));
    const rel = path.relative(this.workDir, joined);
    if (isEscaping(rel) || path.isAbsolute(rel)) {
      throw new Error("invalid input relative path");
    }
    return joined;
  }

  private async inspectImage(filePath: string): Promise<void> {
    let config: ImageConfig | null;
    try {
      config = await decodeImageConfig(filePath);
    } catch (err) {
      throw new Error(`inspect image input: ${err}`);
    }
    if (config === null) {
      throw new Error("inspect image input: unknown image format");
    }
    if (config.width <= 0 || config.height <= 0) {
      throw new Error(
        `inspect image input: invalid dimensions ${config.width}x${config.height}`,
      );
    }
    const pixels = config.width * config.height;
    if (pixels > this.policy.maxImagePixels) {
      throw new Error(
        `image input has ${pixels} pixels (max ${this.policy.maxImagePixels})`,
      );
    }
  }

  private itemKey(ingress: InputIngress): string {
    let identity = ingress.eventId.trim();
    if (identity === "") identity = ingress.reference.trim();
    if (identity === "") return "";
    const key = this.installationKey();
    const mac = createHmac("sha256", key);
    mac.update(ingress.origin.trim());
    mac.update("\x00");
    mac.update(identity);
    mac.update("\x00");
    mac.update(String(ingress.itemIndex));
    return mac.digest("hex");
  }

  private installationKey(): Uint8Array {
    if (this.#itemKeyKey !== null) return new Uint8Array(this.#itemKeyKey);
    const keyPath = path.join(this.sessionDir, ".runtime-input-key");
    nodeRuntime.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    let file: FsFile | null = null;
    try {
      file = nodeRuntime.openSync(keyPath, {
        write: true,
        createNew: true,
        mode: 0o600,
      });
    } catch (err) {
      if (!(err instanceof nodeRuntime.errors.AlreadyExists)) {
        throw new Error(`open Runtime input key: ${err}`);
      }
      file = null;
    }
    if (file !== null) {
      const key = randomBytes(32);
      try {
        file.writeSync(key);
        file.syncSync();
      } finally {
        file.close();
      }
      this.#itemKeyKey = key;
      return new Uint8Array(key);
    }
    const key = nodeRuntime.readFileSync(keyPath);
    if (key.length !== 32) {
      throw new Error(`Runtime input key has invalid length ${key.length}`);
    }
    this.#itemKeyKey = key;
    return new Uint8Array(key);
  }

  /**
   * Emits only text plus a deterministic project-path manifest. It never reads
   * input bytes or constructs provider image/file blocks.
   */
  buildManifest(records: InputResource[]): string {
    const parts: string[] = [];
    parts.push("[Runtime-managed input files for this request]");
    for (const record of records) {
      let status = "available";
      try {
        const resolved = this.resourcePath(record.relativePath);
        const info = nodeRuntime.statSync(resolved);
        if (!info.isFile) status = "missing";
      } catch {
        status = "missing";
      }
      parts.push(
        `- path: ${record.relativePath}\n` +
          `  name: ${record.filename}\n` +
          `  mediaType: ${record.mediaType}\n` +
          `  bytes: ${record.bytes}\n` +
          `  status: ${status}`,
      );
    }
    parts.push("");
    parts.push(
      "Decide whether a file needs inspection. Use read for files you choose " +
        "to read,",
    );
    parts.push(
      "or use an appropriate available Skill/tool when specialized parsing is " +
        "useful.",
    );
    parts.push("Do not claim to have examined a file that you did not read.");
    return parts.join("\n");
  }
}

function requireConn(db: Database): DB {
  const conn = db.db;
  if (conn === null) throw new Error("input resource database is not open");
  return conn;
}

function mapInputResource(stored: InputResourceRecord): InputResource {
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    runId: stored.runId,
    origin: stored.origin,
    eventId: stored.eventId,
    itemIndex: stored.itemIndex,
    itemKey: stored.itemKey,
    kind: stored.kind as AttachmentKind,
    filename: stored.filename,
    mediaType: stored.mediaType,
    bytes: stored.bytes,
    sha256: stored.sha256,
    relativePath: stored.relativePath,
    status: stored.status,
    createdAt: parseTimestamp(stored.createdAt),
  };
}

function parseTimestamp(value: string): Date {
  const normalized = value.includes("T")
    ? value
    : value.replace(" ", "T") + "Z";
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function isEscaping(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.SEPARATOR}`);
}

function inputRelativePath(workDir: string, finalPath: string): string {
  const rel = path.relative(workDir, finalPath);
  if (isEscaping(rel) || path.isAbsolute(rel)) {
    throw new Error("input path escaped Runtime work directory");
  }
  return rel;
}

/**
 * Copies `stream` to `targetPath` up to `maxBytes + 1` bytes (so the caller can
 * detect an over-limit source) while hashing the content.
 */
async function copyInputStream(
  targetPath: string,
  stream: InputStream,
  maxBytes: number,
): Promise<{ written: number; digest: string }> {
  const file = await nodeRuntime.open(targetPath, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let written = 0;
  const limit = maxBytes + 1;
  try {
    let remaining = limit;
    const source =
      stream.bytes !== undefined ? singleChunk(stream.bytes) : stream.stream;
    if (source === undefined) throw new Error("input source is empty");
    for await (const chunk of source) {
      if (remaining <= 0) break;
      const take =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      let offset = 0;
      while (offset < take.length) {
        const n = await file.write(take.subarray(offset));
        if (n <= 0) throw new Error("input write made no progress");
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

/** Commits an input filename, canonicalizing an image extension. */
export function canonicalInputFilename(
  filename: string,
  mediaType: string,
): string {
  const sanitized = sanitizeAttachmentFilename(filename);
  const extension = canonicalImageExtension(mediaType);
  if (extension === "") return sanitized;
  const current = path.extname(sanitized).toLowerCase();
  if (current === extension || (extension === ".jpg" && current === ".jpeg")) {
    return sanitized;
  }
  const currentExt = path.extname(sanitized);
  let base = sanitized.slice(0, sanitized.length - currentExt.length);
  if (base === "" || base === ".") base = "image";
  return base + extension;
}

function canonicalImageExtension(mediaType: string): string {
  switch (mediaType.split(";")[0].toLowerCase().trim()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

interface ImageConfig {
  width: number;
  height: number;
  format: "jpeg" | "png" | "gif" | "webp";
}

/**
 * Sniffs an input file's media type, mirroring Go's `detectInputMediaType`: MIME
 * sniffing first, then an image-header fallback for formats the sniffer cannot
 * identify (an extensionless WebP over an opaque transport).
 */
export async function detectInputMediaType(filePath: string): Promise<string> {
  const file = await nodeRuntime.open(filePath, { read: true });
  let head: Uint8Array;
  try {
    const buf = new Uint8Array(512);
    const n = await file.read(buf);
    head = buf.subarray(0, n ?? 0);
  } finally {
    file.close();
  }
  const detected = detectContentType(head);
  if (
    detected !== "application/octet-stream" &&
    detected !== "application/zip"
  ) {
    return detected;
  }
  const config = await decodeImageConfig(filePath);
  if (config !== null) {
    switch (config.format) {
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
    }
  }
  return detected;
}

/** Reads up to 64 KiB of an image and parses its dimensions. */
async function decodeImageConfig(
  filePath: string,
): Promise<ImageConfig | null> {
  const file = await nodeRuntime.open(filePath, { read: true });
  let data: Uint8Array;
  try {
    const buf = new Uint8Array(64 * 1024);
    const n = await file.read(buf);
    data = buf.subarray(0, n ?? 0);
  } finally {
    file.close();
  }
  return parseImageConfig(data);
}

function parseImageConfig(data: Uint8Array): ImageConfig | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= 24 && png.every((b, i) => data[i] === b)) {
    return {
      width: readUint32BE(data, 16),
      height: readUint32BE(data, 20),
      format: "png",
    };
  }
  if (
    data.length >= 10 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) &&
    data[5] === 0x61
  ) {
    return {
      width: readUint16LE(data, 6),
      height: readUint16LE(data, 8),
      format: "gif",
    };
  }
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8) {
    const dims = parseJPEGDimensions(data);
    if (dims !== null) return { ...dims, format: "jpeg" };
    return null;
  }
  if (
    data.length >= 30 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (fourcc === "VP8 ") {
      return {
        width: readUint16LE(data, 26) & 0x3fff,
        height: readUint16LE(data, 28) & 0x3fff,
        format: "webp",
      };
    }
    if (fourcc === "VP8L") {
      const b0 = data[21],
        b1 = data[22],
        b2 = data[23],
        b3 = data[24];
      return {
        width: (b0 | ((b1 & 0x3f) << 8)) + 1,
        height: (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) + 1,
        format: "webp",
      };
    }
    if (fourcc === "VP8X") {
      return {
        width: (data[24] | (data[25] << 8) | (data[26] << 16)) + 1,
        height: (data[27] | (data[28] << 8) | (data[29] << 16)) + 1,
        format: "webp",
      };
    }
  }
  return null;
}

function parseJPEGDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = data[i + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = (data[i + 2] << 8) | data[i + 3];
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = (data[i + 5] << 8) | data[i + 6];
      const width = (data[i + 7] << 8) | data[i + 8];
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) >>> 0) +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  );
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}
