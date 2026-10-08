//
// Reclaims Runtime-private artifact directories that no durable attachment row
// references any more and that are already past retention plus a grace window.
// It fails closed against an unreadable or missing sessions database.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; `time.Time`
// maps to `Date`; `sync/atomic` maps to plain module state (Deno is
// single-threaded); `os.ReadDir`/`Lstat`/`RemoveAll` map to Deno APIs. The
// `(s *AttachmentService) ReconcileStorage` method maps to the standalone
// `reconcileAttachmentStorage` function because TS classes cannot be split
// across modules.

import * as path from "@opensac/path";
import { AttachmentDAO } from "../dao/mod.ts";
import { queryRootDatabase, rootDatabasePath } from "../session/database.ts";
import type { AttachmentPolicy } from "./attachment.ts";
import type { AttachmentService } from "./input.ts";

/**
 * Added on top of the attachment retention window before an unreferenced
 * artifact directory may be reclaimed, so the sweep cannot race an intake that
 * has created its directory but not yet committed the durable row.
 */
export const RECONCILE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The Runtime-private subtree `acceptArtifact` writes into. It is spelled once
 * here and matched against the durable storage keys, so the reconciliation and
 * the intake can never disagree about where attachment content lives.
 */
const artifactDirectoryName = "artifacts";

/**
 * Throttles the opportunistic sweep to at most one pass per interval per
 * process. Reclamation is storage pressure relief, not a per-request duty.
 */
const artifactReconcileIntervalMs = 60 * 60 * 1000;

let lastArtifactReconcileNanos = 0;

/**
 * Test seam exposing the module-scope throttle stamp (Go kept this as an
 * unexported `atomic.Int64` reachable from the same package). Production code
 * never reads or writes it.
 */
export const artifactReconcileThrottle = {
  get lastNanos(): number {
    return lastArtifactReconcileNanos;
  },
  set lastNanos(value: number) {
    lastArtifactReconcileNanos = value;
  },
};

/** Reports one private-store reconciliation pass. */
export interface ArtifactReconciliation {
  /** Entries found directly under the artifact store. */
  scanned: number;
  /** Directories reclaimed in this pass. */
  removed: number;
  /** Total size of the reclaimed content. */
  freed: number;
  /** Directories a durable row still claims. */
  skippedReferenced: number;
  /** Unreferenced directories still inside the retention plus grace floor. */
  skippedYoung: number;
  /** Entries that are not artifact storage this function may interpret. */
  skippedUnrecognized: number;
  /** The modification time a directory must be older than to be reclaimable. */
  ageFloor: Date;
}

function emptyReconciliation(): ArtifactReconciliation {
  return {
    scanned: 0,
    removed: 0,
    freed: 0,
    skippedReferenced: 0,
    skippedYoung: 0,
    skippedUnrecognized: 0,
    ageFloor: new Date(0),
  };
}

/** Returns the session-directory subtree that holds private attachment content. */
export function artifactStorageDirectoryName(): string {
  return artifactDirectoryName;
}

/**
 * Returns the modification time an unreferenced artifact directory must predate
 * before `reconcileArtifactStorage` may reclaim it.
 */
export function artifactReclaimFloor(
  policy: AttachmentPolicy,
  now: Date,
): Date {
  if (policy.retention <= 0) return new Date(now.getTime());
  return new Date(
    now.getTime() - (policy.retention + RECONCILE_GRACE_MS),
  );
}

/**
 * Reclaims artifact directories that no durable attachment row references any
 * more and that are already past retention plus the grace window. It fails
 * closed: an unreadable or missing sessions database returns an error and
 * deletes nothing. Only plain directories named like a generated attachment ID,
 * containing only regular files, are ever considered.
 */
export async function reconcileArtifactStorage(
  sessionDir: string,
  policy: AttachmentPolicy,
  now: Date,
  signal?: AbortSignal,
): Promise<ArtifactReconciliation> {
  const report = emptyReconciliation();
  if (sessionDir.trim() === "") {
    throw new Error("attachment session directory is required");
  }
  if (policy.retention <= 0) {
    throw new Error("attachment retention must be positive");
  }
  if (now.getTime() === 0) now = new Date();
  report.ageFloor = artifactReclaimFloor(policy, now);

  const root = path.join(sessionDir, artifactDirectoryName);
  let rootInfo: Deno.FileInfo | null;
  try {
    rootInfo = await Deno.lstat(root);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return report;
    throw new Error(`inspect attachment storage: ${err}`);
  }
  if (!rootInfo.isDirectory) {
    throw new Error(`attachment storage path ${root} is not a directory`);
  }

  const referenced = await referencedArtifactDirectories(sessionDir);
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch (err) {
    throw new Error(`read attachment storage: ${err}`);
  }
  for (const entry of entries) {
    if (signal?.aborted) {
      throw new DOMException("reconcile aborted", "AbortError");
    }
    report.scanned++;
    const entryPath = path.join(root, entry.name);
    if (
      !entry.isDirectory || entry.isSymlink ||
      !isAttachmentDirectoryID(entry.name)
    ) {
      report.skippedUnrecognized++;
      continue;
    }
    if (referenced.has(entry.name)) {
      report.skippedReferenced++;
      continue;
    }
    const measured = await artifactDirectoryContents(entryPath);
    if (measured === null) {
      // Anything this pass cannot interpret is left alone: an unexpected
      // layout is not evidence that a directory is disposable.
      report.skippedUnrecognized++;
      continue;
    }
    if (measured.newest.getTime() >= report.ageFloor.getTime()) {
      report.skippedYoung++;
      continue;
    }
    try {
      await Deno.remove(entryPath, { recursive: true });
    } catch (err) {
      throw new Error(
        `reclaim unreferenced attachment storage ${entryPath}: ${err}`,
      );
    }
    report.removed++;
    report.freed += measured.size;
  }
  return report;
}

/**
 * Returns every artifact directory a durable row still claims, keyed by
 * directory name. Both the row ID and the storage key are consulted.
 */
async function referencedArtifactDirectories(
  sessionDir: string,
): Promise<Set<string>> {
  const dbPath = rootDatabasePath(sessionDir);
  try {
    await Deno.stat(dbPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `sessions database ${dbPath} does not exist; refusing to reconcile attachment storage against an unknown reference set`,
      );
    }
    throw new Error(`inspect sessions database: ${err}`);
  }
  const referenced = new Set<string>();
  queryRootDatabase(sessionDir, (db) => {
    const records = new AttachmentDAO(db.db).listStorageReferences(db.db!);
    for (const record of records) {
      const id = record.id.trim();
      if (id !== "") referenced.add(id);
      const key = record.storageKey.trim().split(path.SEPARATOR).join("/");
      const parts = key.split("/");
      if (parts.length >= 2 && parts[0] === artifactDirectoryName) {
        referenced.add(parts[1]);
      }
    }
  });
  return referenced;
}

/**
 * Measures one artifact directory without following symbolic links and rejects
 * any layout the Runtime does not write itself. Returns `null` for an
 * unrecognized layout rather than deleting it.
 */
async function artifactDirectoryContents(
  dir: string,
): Promise<{ newest: Date; size: number } | null> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch {
    return null;
  }
  let newest = 0;
  let size = 0;
  for (const entry of entries) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path.join(dir, entry.name));
    } catch {
      return null;
    }
    const acceptable = !entry.isDirectory && !info.isSymlink &&
      (entry.name === "content" || entry.name.startsWith(".incoming-"));
    if (!acceptable) return null;
    const mtime = info.mtime?.getTime() ?? 0;
    if (mtime > newest) newest = mtime;
    size += info.size;
  }
  if (newest === 0) {
    // An empty directory is a leftover of a failed intake, and its age is the
    // directory's own modification time.
    try {
      const info = await Deno.stat(dir);
      newest = info.mtime?.getTime() ?? 0;
    } catch {
      return null;
    }
  }
  return { newest: new Date(newest), size };
}

/**
 * Reports whether `name` is the shape `acceptArtifact` generates (a
 * 16-character lowercase hex identifier).
 */
function isAttachmentDirectoryID(name: string): boolean {
  if (name.length !== 16) return false;
  for (const ch of name) {
    if (!((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f"))) return false;
  }
  return true;
}

/**
 * Runs the private-store reconciliation for one service's own session directory
 * under its own policy. Adapters call it to report or reclaim; they never walk
 * the store themselves.
 */
export function reconcileAttachmentStorage(
  service: AttachmentService,
  now?: Date,
  signal?: AbortSignal,
): Promise<ArtifactReconciliation> {
  return reconcileArtifactStorage(
    service.sessionDir,
    service.policy,
    now ?? new Date(),
    signal,
  );
}

/**
 * Performs the sweep at most once per interval per process. It is reached from
 * the attachment intake path because reclamation is background maintenance
 * rather than part of accepting an attachment.
 */
export function reconcileArtifactStorageOpportunistic(
  sessionDir: string,
  policy: AttachmentPolicy,
): void {
  const nowMs = Date.now();
  const previous = lastArtifactReconcileNanos;
  lastArtifactReconcileNanos = nowMs * 1e6;
  if (
    previous !== 0 &&
    (nowMs * 1e6 - previous) / 1e6 < artifactReconcileIntervalMs
  ) {
    return;
  }
  void reconcileArtifactStorage(sessionDir, policy, new Date()).catch(() => {
    // best-effort
  });
}
