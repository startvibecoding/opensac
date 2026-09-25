import * as path from "@std/path";
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

/** Raised when a lock cannot be acquired without risking a second owner. */
export class CoreLockBusyError extends Error {
  readonly lockPath: string;
  readonly metadata?: CoreLockMetadata;

  constructor(
    lockPath: string,
    metadata?: CoreLockMetadata,
    options?: ErrorOptions,
  ) {
    const owner = metadata === undefined
      ? "an unknown owner"
      : `pid ${metadata.pid} on ${metadata.hostname}`;
    super(`Core lock is held by ${owner}`, options);
    this.name = "CoreLockBusyError";
    this.lockPath = lockPath;
    this.metadata = metadata;
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
    await Deno.mkdir(path.dirname(lockDir), {
      recursive: true,
      mode: 0o700,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = createOwnerToken();
      const metadata: CoreLockMetadata = {
        token,
        pid: Deno.pid,
        hostname: Deno.hostname(),
        timestamp: Date.now(),
      };

      try {
        // This deliberately does not use a file-existence check: mkdir is the
        // cross-process atomic acquisition primitive.
        await Deno.mkdir(lockDir, { mode: 0o700 });
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
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;

        let existing: CoreLockMetadata | undefined;
        try {
          existing = await readMetadata(lockDir);
        } catch (metadataError) {
          throw new CoreLockBusyError(lockDir, undefined, {
            cause: metadataError,
          });
        }
        if (existing === undefined) {
          throw new CoreLockBusyError(lockDir, undefined, { cause: error });
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
    throw new CoreLockBusyError(lockDir);
  }
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
      await Deno.rename(lockDir, quarantine);
      moved = true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
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
      pid: Deno.pid,
      hostname: Deno.hostname(),
      timestamp: Date.now(),
    };
    try {
      await Deno.mkdir(claimDir, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const existing = await readMetadataFile(
        path.join(claimDir, RECLAIM_META_FILE),
      );
      if (
        existing === undefined ||
        existing.hostname !== Deno.hostname() ||
        processLiveness(existing.pid) !== "dead"
      ) {
        return undefined;
      }
      const quarantine = uniqueSibling(claimDir, "stale-claim");
      try {
        await Deno.rename(claimDir, quarantine);
      } catch (renameError) {
        if (renameError instanceof Deno.errors.NotFound) continue;
        throw renameError;
      }
      await removeDirectoryBestEffort(quarantine);
      continue;
    }

    try {
      await Deno.writeTextFile(
        path.join(claimDir, RECLAIM_META_FILE),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      await Deno.chmod(
        path.join(claimDir, RECLAIM_META_FILE),
        0o600,
      );
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
  const temporary = await Deno.makeTempFile({
    dir: lockDir,
    prefix: ".core-lock-meta-",
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(
      temporary,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, path.join(lockDir, META_FILE));
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
    text = await Deno.readTextFile(metadataFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
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
    typeof token !== "string" || token.trim() === "" ||
    typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 ||
    typeof hostname !== "string" || hostname.trim() === "" ||
    typeof timestamp !== "number" || !Number.isFinite(timestamp) ||
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
  if (metadata.hostname !== Deno.hostname()) return false;
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
    Deno.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "dead";
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
    await Deno.rename(lockDir, quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
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
    await Deno.remove(directory, { recursive: true });
  } catch {
    // Preserve the metadata write error; the empty lock is safer than
    // pretending acquisition completed.
  }
}

async function removeFileBestEffort(filePath: string): Promise<void> {
  try {
    await Deno.remove(filePath);
  } catch {
    // Best-effort cleanup for a failed atomic write.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Core lock acquisition aborted", "AbortError");
  }
}
