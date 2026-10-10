import { runtime } from "../platform/runtime.ts";
import type { FileInfo } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import { CorePaths } from "./paths.ts";
import { CoreRegistry } from "./registry.ts";

/** Identity recorded in the lock directory while a Core owns it. */
export interface CoreLockMetadata {
  token: string;
  pid: number;
  hostname: string;
  timestamp: number;
}

const META_FILE = "meta.json";
const RECLAIM_DIR = "reclaim";
const RECLAIM_META_FILE = "owner.json";

/**
 * A lock directory whose owner metadata is absent is only treated as a crashed
 * half-acquisition after this grace window. A healthy acquirer completes its
 * metadata write in microseconds, so an empty lock directory older than this
 * cannot be a live acquirer racing our own read.
 */
const ORPHAN_RECLAIM_GRACE_MS = 5_000;

/** Why a `CoreLockBusyError` was raised, for actionable caller messaging. */
export type CoreLockBusyDetail =
  | "held"
  | "missing-metadata"
  | "unreadable-metadata"
  | "unknown-owner"
  | "reclaim-race";

/** Raised when a lock cannot be acquired without risking a second owner. */
export class CoreLockBusyError extends Error {
  readonly lockPath: string;
  readonly metadata?: CoreLockMetadata;
  readonly detail: CoreLockBusyDetail;

  constructor(
    lockPath: string,
    metadata?: CoreLockMetadata,
    options?: ErrorOptions,
    detail?: CoreLockBusyDetail,
  ) {
    const resolved: CoreLockBusyDetail =
      detail ?? (metadata === undefined ? "unknown-owner" : "held");
    super(coreLockBusyMessage(lockPath, metadata, resolved), options);
    this.name = "CoreLockBusyError";
    this.lockPath = lockPath;
    this.metadata = metadata;
    this.detail = resolved;
  }
}

function coreLockBusyMessage(
  lockPath: string,
  metadata: CoreLockMetadata | undefined,
  detail: CoreLockBusyDetail,
): string {
  switch (detail) {
    case "held":
      return metadata === undefined
        ? "Core lock is held by an unknown owner"
        : `Core lock is held by pid ${metadata.pid} on ${metadata.hostname}`;
    case "missing-metadata":
      return (
        "Core lock is a stale directory left by a Core that crashed before " +
        `writing owner metadata (no owner is identifiable). Run ` +
        "`opensac core restart` to repair it, or remove " +
        `"${lockPath}" manually.`
      );
    case "unreadable-metadata":
      return (
        `Core lock owner metadata in "${lockPath}" is unreadable, so its ` +
        "owner cannot be identified. Remove that lock directory only after " +
        "confirming no Core is running."
      );
    case "reclaim-race":
      return "Core lock was claimed by a competing acquirer during recovery";
    case "unknown-owner":
    default:
      return "Core lock is held by an unknown owner";
  }
}

/** A held Core lock. Releasing the same handle more than once is harmless. */
export class CoreLockHandle {
  readonly paths: CorePaths;
  readonly token: string;
  #releasePromise: Promise<void> | undefined;

  constructor(paths: CorePaths, token: string) {
    this.paths = paths;
    this.token = token;
  }

  /** Releases the lock only while the recorded owner token still matches. */
  release(): Promise<void> {
    this.#releasePromise ??= releaseOwnedLock(this.paths, this.token);
    return this.#releasePromise;
  }

  /** Checks the owner token without removing or replacing the lock. */
  isCurrent(): Promise<boolean> {
    return isCurrentLock(this.paths, this.token);
  }
}

/** Provides the process-level, fail-closed Core lock. */
export class CoreLock {
  private constructor() {}

  /**
   * Acquires the Core lock using directory creation as the atomic operation.
   * Existing locks are reclaimed only after both their owner and any
   * registered Core process are demonstrably gone.
   */
  static async acquire(
    paths: CorePaths,
    signal?: AbortSignal,
  ): Promise<CoreLockHandle> {
    throwIfAborted(signal);
    if (!(paths instanceof CorePaths)) {
      throw new TypeError("CoreLock.acquire requires CorePaths");
    }

    const lockDir = paths.lockFile;
    throwIfAborted(signal);
    await runtime.mkdir(path.dirname(lockDir), {
      recursive: true,
      mode: 0o700,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = createOwnerToken();
      const metadata: CoreLockMetadata = {
        token,
        pid: runtime.pid,
        hostname: runtime.hostname(),
        timestamp: Date.now(),
      };

      try {
        // This deliberately does not use a file-existence check: mkdir is the
        // cross-process atomic acquisition primitive.
        await runtime.mkdir(lockDir, { mode: 0o700 });
        try {
          throwIfAborted(signal);
          await writeMetadata(lockDir, metadata);
          throwIfAborted(signal);
        } catch (error) {
          // We just created this directory and have not returned its handle,
          // so it is safe to remove our incomplete acquisition.
          await removeDirectoryBestEffort(lockDir);
          throw error;
        }
        return new CoreLockHandle(paths, token);
      } catch (error) {
        if (!(error instanceof runtime.errors.AlreadyExists)) throw error;

        let existing: CoreLockMetadata | undefined;
        try {
          existing = await readMetadata(lockDir);
        } catch (metadataError) {
          throw new CoreLockBusyError(
            lockDir,
            undefined,
            { cause: metadataError },
            "unreadable-metadata",
          );
        }
        if (existing === undefined) {
          // The directory exists but carries no owner metadata: the only way
          // to reach this is a Core that was hard-killed between the atomic
          // mkdir and its metadata write. Reclaim it only when no live Core is
          // registered and the directory is old enough that it cannot be a
          // healthy acquirer mid-write; otherwise keep failing closed.
          if (await reclaimOrphanLock(paths, lockDir, true)) {
            continue;
          }
          throw new CoreLockBusyError(
            lockDir,
            undefined,
            { cause: error },
            "missing-metadata",
          );
        }

        const stale = await canReclaim(paths, existing);
        if (!stale) {
          throw new CoreLockBusyError(lockDir, existing, { cause: error });
        }

        let claimed: boolean;
        try {
          claimed = await claimStaleLock(paths, lockDir, existing);
        } catch (claimError) {
          throw new CoreLockBusyError(lockDir, existing, {
            cause: claimError,
          });
        }
        if (!claimed) {
          throw new CoreLockBusyError(lockDir, existing, { cause: error });
        }
        // Retry the same atomic mkdir after the stale directory is gone.
      }
    }

    // A competing acquirer won the race after our stale removal. Do not loop
    // indefinitely or inspect/remove that owner's directory.
    throw new CoreLockBusyError(lockDir, undefined, undefined, "reclaim-race");
  }

  /**
   * Classifies the current lock state without acquiring or removing anything,
   * so an interactive caller can decide whether to offer a repair. A lock
   * directory with no readable owner metadata is reported as an `orphan` only
   * when no live Core is registered; a registered live Core makes it `held`,
   * even if the metadata file itself was lost.
   */
  static async inspect(
    paths: CorePaths,
    signal?: AbortSignal,
  ): Promise<CoreLockInspection> {
    throwIfAborted(signal);
    if (!(paths instanceof CorePaths)) {
      throw new TypeError("CoreLock.inspect requires CorePaths");
    }
    const lockDir = paths.lockFile;
    let info: FileInfo;
    try {
      info = await runtime.lstat(lockDir);
    } catch (error) {
      if (error instanceof runtime.errors.NotFound) return { state: "free" };
      throw error;
    }
    if (!info.isDirectory) {
      return {
        state: "orphan",
        reason: "not-a-directory",
        reclaimableByConsent: false,
        reclaimableAutomatically: false,
      };
    }
    let classification: MetadataClassification;
    try {
      classification = await classifyMetadata(lockDir);
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
    if (classification.status === "ok") {
      return {
        state: "held",
        owner: classification.metadata,
        reclaimableByConsent: false,
        reclaimableAutomatically: false,
      };
    }
    const reclaimableByConsent = await noLiveRegistration(paths);
    let ageMs: number | undefined;
    if (classification.status === "missing" && info.mtime !== null) {
      ageMs = Math.max(0, Date.now() - info.mtime.getTime());
    }
    return {
      state: "orphan",
      reason:
        classification.status === "missing"
          ? "missing-metadata"
          : "unreadable-metadata",
      ...(ageMs === undefined ? {} : { ageMs }),
      reclaimableByConsent,
      reclaimableAutomatically:
        classification.status === "missing" &&
        reclaimableByConsent &&
        (ageMs ?? 0) >= ORPHAN_RECLAIM_GRACE_MS,
    };
  }

  /**
   * Removes a demonstrably orphaned lock directory (no owner metadata, no
   * live registered Core) after explicit user consent. The removal re-verifies
   * the orphan condition and is serialized by the same reclaim claim used for
   * stale-owner recovery, so it never displaces a live or in-flight owner.
   */
  static async reclaimOrphan(
    paths: CorePaths,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    if (!(paths instanceof CorePaths)) {
      throw new TypeError("CoreLock.reclaimOrphan requires CorePaths");
    }
    return await reclaimOrphanLock(paths, paths.lockFile, false, signal);
  }
}

/** Result of `CoreLock.inspect`. */
export type CoreLockInspection =
  | { state: "free" }
  | {
      state: "held";
      owner: CoreLockMetadata;
      reclaimableByConsent: boolean;
      reclaimableAutomatically: boolean;
    }
  | {
      state: "orphan";
      reason: "missing-metadata" | "unreadable-metadata" | "not-a-directory";
      ageMs?: number;
      reclaimableByConsent: boolean;
      reclaimableAutomatically: boolean;
    };

type MetadataClassification =
  | { status: "ok"; metadata: CoreLockMetadata }
  | { status: "missing" }
  | { status: "unreadable" };

async function classifyMetadata(
  lockDir: string,
): Promise<MetadataClassification> {
  try {
    const metadata = await readMetadata(lockDir);
    return metadata === undefined
      ? { status: "missing" }
      : { status: "ok", metadata };
  } catch {
    // readMetadata throws only for unreadable/invalid metadata; a missing file
    // resolves to undefined above.
    return { status: "unreadable" };
  }
}

/**
 * True when the registry proves no live Core exists. A malformed or unreadable
 * registration fails closed (false) so an orphan is never removed while a
 * healthy Core may be relying on it.
 */
async function noLiveRegistration(paths: CorePaths): Promise<boolean> {
  let registration;
  try {
    registration = await new CoreRegistry(paths).read();
  } catch {
    return false;
  }
  if (registration === undefined) return true;
  return processLiveness(registration.pid) === "dead";
}

/**
 * Reclaims a lock directory whose owning Core is demonstrably gone.
 * `auto` is the safe headless form used by `acquire`: it only heals the clear
 * crashed half-acquisition (owner metadata absent), demands the grace window,
 * and re-verifies no live Core is registered. Explicit user consent
 * (`CoreLock.reclaimOrphan`) sets `auto` false, which additionally permits an
 * unreadable/malformed lock directory but still re-verifies no live registered
 * Core and never deletes a directory that gained valid owner metadata.
 */
async function reclaimOrphanLock(
  paths: CorePaths,
  lockDir: string,
  auto: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const first = await orphanDecision(lockDir);
  if (!first.isOrphan) return false;
  if (auto && first.status !== "missing") return false;
  if (!(await noLiveRegistration(paths))) return false;
  if (auto) {
    let info: FileInfo;
    try {
      info = await runtime.lstat(lockDir);
    } catch (error) {
      if (error instanceof runtime.errors.NotFound) return false;
      throw error;
    }
    if (
      info.mtime === null ||
      Date.now() - info.mtime.getTime() < ORPHAN_RECLAIM_GRACE_MS
    ) {
      return false;
    }
  }

  const claimDir = path.join(lockDir, RECLAIM_DIR);
  const claim = await acquireReclaimClaim(claimDir);
  if (claim === undefined) return false;

  let moved = false;
  try {
    throwIfAborted(signal);
    // Re-verify the orphan condition while the claim is held, exactly as stale
    // recovery does before any rename.
    const underClaim = await orphanDecision(lockDir);
    if (!underClaim.isOrphan) return false;
    if (auto && underClaim.status !== "missing") return false;
    if (!(await noLiveRegistration(paths))) return false;

    const quarantine = uniqueSibling(lockDir, "orphan");
    try {
      await runtime.rename(lockDir, quarantine);
      moved = true;
    } catch (error) {
      if (error instanceof runtime.errors.NotFound) return false;
      throw error;
    }
    // Only the uniquely named quarantine is removed. If it unexpectedly gained
    // valid owner metadata (a live acquirer), it is theirs, never ours to delete.
    const movedDecision = await orphanDecision(quarantine);
    if (movedDecision.status === "ok") {
      return false;
    }
    await removeDirectoryBestEffort(quarantine);
    return true;
  } finally {
    if (!moved) {
      await releaseReclaimClaim(claimDir, claim.token);
    }
  }
}

interface OrphanDecision {
  isOrphan: boolean;
  status: "missing" | "unreadable" | "ok" | "absent" | "not-a-directory";
}

/**
 * Classifies whether `lockDir` is an orphan: a directory whose owner metadata
 * is absent or unreadable. A metadata-bearing lock is never an orphan here (it
 * is handled by stale-owner recovery), and a non-directory path is never
 * auto-removed.
 */
async function orphanDecision(lockDir: string): Promise<OrphanDecision> {
  let info: FileInfo;
  try {
    info = await runtime.lstat(lockDir);
  } catch (error) {
    if (error instanceof runtime.errors.NotFound) {
      return { isOrphan: false, status: "absent" };
    }
    throw error;
  }
  if (!info.isDirectory) return { isOrphan: false, status: "not-a-directory" };
  const classification = await classifyMetadata(lockDir);
  return classification.status === "ok"
    ? { isOrphan: false, status: "ok" }
    : { isOrphan: true, status: classification.status };
}

async function claimStaleLock(
  paths: CorePaths,
  lockDir: string,
  expected: CoreLockMetadata,
): Promise<boolean> {
  const claimDir = path.join(lockDir, RECLAIM_DIR);
  const claim = await acquireReclaimClaim(claimDir);
  if (claim === undefined) return false;

  let moved = false;
  try {
    // The claim directory serializes stale recovery while the original lock
    // directory is still present. Re-check identity and liveness after the
    // claim is held before moving anything.
    const current = await readMetadata(lockDir);
    if (
      current === undefined ||
      current.token !== expected.token ||
      !(await canReclaim(paths, current))
    ) {
      return false;
    }

    const quarantine = uniqueSibling(lockDir, "stale");
    try {
      await runtime.rename(lockDir, quarantine);
      moved = true;
    } catch (error) {
      if (error instanceof runtime.errors.NotFound) return false;
      throw error;
    }

    // Only the uniquely named quarantine is removed. A new owner may already
    // have created the original lock path while this cleanup was pending.
    const claimed = await readMetadata(quarantine);
    if (claimed === undefined || claimed.token !== expected.token) {
      return false;
    }
    await removeDirectoryBestEffort(quarantine);
    return true;
  } finally {
    if (!moved) {
      await releaseReclaimClaim(claimDir, claim.token);
    }
  }
}

async function acquireReclaimClaim(
  claimDir: string,
): Promise<CoreLockMetadata | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const metadata: CoreLockMetadata = {
      token: createOwnerToken(),
      pid: runtime.pid,
      hostname: runtime.hostname(),
      timestamp: Date.now(),
    };
    try {
      await runtime.mkdir(claimDir, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof runtime.errors.AlreadyExists)) throw error;
      const existing = await readMetadataFile(
        path.join(claimDir, RECLAIM_META_FILE),
      );
      if (
        existing === undefined ||
        existing.hostname !== runtime.hostname() ||
        processLiveness(existing.pid) !== "dead"
      ) {
        return undefined;
      }
      const quarantine = uniqueSibling(claimDir, "stale-claim");
      try {
        await runtime.rename(claimDir, quarantine);
      } catch (renameError) {
        if (renameError instanceof runtime.errors.NotFound) continue;
        throw renameError;
      }
      await removeDirectoryBestEffort(quarantine);
      continue;
    }

    try {
      await runtime.writeTextFile(
        path.join(claimDir, RECLAIM_META_FILE),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      await runtime.chmod(path.join(claimDir, RECLAIM_META_FILE), 0o600);
      return metadata;
    } catch (error) {
      await removeDirectoryBestEffort(claimDir);
      throw error;
    }
  }
  return undefined;
}

async function releaseReclaimClaim(
  claimDir: string,
  token: string,
): Promise<void> {
  const current = await readMetadataFile(
    path.join(claimDir, RECLAIM_META_FILE),
  );
  if (current === undefined || current.token !== token) return;
  await removeDirectoryBestEffort(claimDir);
}

function uniqueSibling(target: string, label: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${label}-${createOwnerToken()}`,
  );
}

async function writeMetadata(
  lockDir: string,
  metadata: CoreLockMetadata,
): Promise<void> {
  const temporary = await runtime.makeTempFile({
    dir: lockDir,
    prefix: ".core-lock-meta-",
    suffix: ".tmp",
  });
  try {
    await runtime.writeTextFile(
      temporary,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await runtime.chmod(temporary, 0o600);
    await runtime.rename(temporary, path.join(lockDir, META_FILE));
  } catch (error) {
    await removeFileBestEffort(temporary);
    throw error;
  }
}

async function readMetadata(
  lockDir: string,
): Promise<CoreLockMetadata | undefined> {
  return await readMetadataFile(path.join(lockDir, META_FILE));
}

async function readMetadataFile(
  metadataFile: string,
): Promise<CoreLockMetadata | undefined> {
  let text: string;
  try {
    text = await runtime.readTextFile(metadataFile);
  } catch (error) {
    if (error instanceof runtime.errors.NotFound) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Core lock metadata is not valid JSON`, { cause: error });
  }
  return parseMetadata(value);
}

function parseMetadata(value: unknown): CoreLockMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Core lock metadata must be an object");
  }
  const object = value as Record<string, unknown>;
  const token = object.token;
  const pid = object.pid;
  const hostname = object.hostname;
  const timestamp = object.timestamp;
  if (
    typeof token !== "string" ||
    token.trim() === "" ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid < 1 ||
    typeof hostname !== "string" ||
    hostname.trim() === "" ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    timestamp < 0
  ) {
    throw new TypeError("Core lock metadata has an invalid shape");
  }
  return { token, pid, hostname, timestamp };
}

async function canReclaim(
  paths: CorePaths,
  metadata: CoreLockMetadata,
): Promise<boolean> {
  // A hostname mismatch means the local process table says nothing about the
  // owner. Never guess based on age in that case.
  if (metadata.hostname !== runtime.hostname()) return false;
  if (processLiveness(metadata.pid) !== "dead") return false;

  let registration;
  try {
    registration = await new CoreRegistry(paths).read();
  } catch {
    // A malformed/unreadable registration is not proof that no healthy Core
    // exists. Fail closed and leave the lock in place.
    return false;
  }
  if (registration === undefined) return true;

  // A different live process may be the registered Core, or a replacement may
  // have reused the old PID. Either way, do not remove the lock.
  return processLiveness(registration.pid) === "dead";
}

function processLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    // Signal 0 performs the permission/existence check without delivering a
    // signal to the process.
    runtime.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof runtime.errors.NotFound) return "dead";
    return "unknown";
  }
}

function createOwnerToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
}

async function releaseOwnedLock(
  paths: CorePaths,
  token: string,
): Promise<void> {
  await removeOwnedLock(paths.lockFile, token);
}

async function isCurrentLock(
  paths: CorePaths,
  token: string,
): Promise<boolean> {
  const current = await readMetadata(paths.lockFile);
  return current !== undefined && current.token === token;
}

async function removeOwnedLock(
  lockDir: string,
  token: string,
): Promise<boolean> {
  const current = await readMetadata(lockDir);
  if (current === undefined || current.token !== token) return false;

  // Move the directory out of the acquisition namespace before deleting it.
  // A delayed recursive remove can therefore never target a newly-created
  // lock at the original path.
  const quarantine = uniqueSibling(lockDir, "release");
  try {
    await runtime.rename(lockDir, quarantine);
  } catch (error) {
    if (error instanceof runtime.errors.NotFound) return false;
    throw error;
  }

  const claimed = await readMetadata(quarantine);
  if (claimed === undefined || claimed.token !== token) {
    // Never delete a directory whose identity changed while it was being
    // claimed. The quarantine name is unique, so leaving it for manual
    // recovery is safer than deleting a possible new owner.
    return false;
  }
  await removeDirectoryBestEffort(quarantine);
  return true;
}

async function removeDirectoryBestEffort(directory: string): Promise<void> {
  try {
    await runtime.remove(directory, { recursive: true });
  } catch {
    // Preserve the metadata write error; the empty lock is safer than
    // pretending acquisition completed.
  }
}

async function removeFileBestEffort(filePath: string): Promise<void> {
  try {
    await runtime.remove(filePath);
  } catch {
    // Best-effort cleanup for a failed atomic write.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("Core lock acquisition aborted", "AbortError")
    );
  }
}
