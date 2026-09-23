//
// A database that src/db had to back up and rebuild after a schema migration
// failure is announced over the same advisory UDP bus as runtime lease changes,
// so every other opensac process on this host that shares the session directory
// learns that the file it may still hold open was replaced. The notice carries
// no content: receivers only retire their cached connection, warn the user, and
// reopen the rebuilt file on the next access.

import * as path from "@std/path";
import {
  close as closeDatabase,
  type MigrationRecovery,
  setMigrationRecoveryNotifier,
} from "../db/mod.ts";
import type { DatabaseRecovery } from "./database.ts";
import {
  publishRuntimeLeaseNotification,
  runtimeLeaseBusDatabaseRebuilt,
  subscribeRuntimeLeaseNotifications,
} from "./runtime_lease_bus.ts";

let databaseRecoveryHookInstalled = false;

/**
 * Wires the recovery announcement into src/db. Every session database open runs
 * `ensureCurrentSchema`, so registering the hook there covers exactly the
 * processes that can perform a recovery without a module-level side effect.
 */
export function ensureDatabaseRecoveryHook(): void {
  if (databaseRecoveryHookInstalled) return;
  databaseRecoveryHookInstalled = true;
  setMigrationRecoveryNotifier(notifyDatabaseRebuilt);
}

/**
 * Announces one recovery over the advisory bus. It never carries the migration
 * error, the backup path, or any content: peers only need to know which
 * database file was replaced.
 */
export function notifyDatabaseRebuilt(recovery: MigrationRecovery): void {
  const dbPath = (recovery.path ?? "").trim();
  if (dbPath === "" || recovery.peer) return;
  publishRuntimeLeaseNotification({
    type: runtimeLeaseBusDatabaseRebuilt,
    path: path.normalize(dbPath),
    origin: "db",
  });
}

// Rebuilds other processes announced, so a front-end drains local and peer
// notices through one API and reports them exactly once.
const peerDatabaseRebuilds: DatabaseRecovery[] = [];

/**
 * Retires this process's cached connection when another process on this host
 * rebuilds a database after a failed migration. Without it, a long-running
 * process keeps reading and writing the replaced file through its open handle
 * (a deleted inode on Unix) until it restarts. The returned function
 * unsubscribes.
 */
export function watchDatabaseRebuilds(
  onNotice: ((recovery: DatabaseRecovery) => void) | null,
): () => void {
  return subscribeRuntimeLeaseNotifications((notification) => {
    if (notification.type !== runtimeLeaseBusDatabaseRebuilt) return;
    // Closing a connection checkpoints the database, so keep it off the bus
    // reader: a slow close must not delay lease wake-ups behind it.
    setTimeout(() => {
      handlePeerDatabaseRebuilt(notification.path ?? "", onNotice ?? null);
    }, 0);
  });
}

export function handlePeerDatabaseRebuilt(
  dbPath: string,
  onNotice: ((recovery: DatabaseRecovery) => void) | null,
): void {
  if (dbPath === "") return;
  const recovery: DatabaseRecovery = {
    path: dbPath,
    backupPath: "",
    err: null,
    peer: true,
    at: new Date(),
  };
  // Retire the cached handle first so the notice is only reported once the
  // connection is actually gone; a close failure is reported instead of
  // pretending the process converged.
  try {
    closeDatabase(dbPath);
  } catch (err) {
    console.error(
      `[db] another OpenSAC process rebuilt ${dbPath}; closing the cached connection: ${err}`,
    );
  }
  peerDatabaseRebuilds.push(recovery);
  if (onNotice !== null) {
    onNotice(recovery);
    return;
  }
  // No UI channel: log it, so headless entry points still report that their
  // connection was replaced.
  console.error(
    `[db] ${recovery.path}; reopening it on the next access`,
  );
}

/** Returns and clears the peer notices recorded since the last call. */
export function takePeerDatabaseRebuilds(): DatabaseRecovery[] {
  const entries = peerDatabaseRebuilds.slice();
  peerDatabaseRebuilds.length = 0;
  return entries;
}
