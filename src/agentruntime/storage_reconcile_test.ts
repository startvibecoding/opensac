import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  defaultAttachmentPolicy,
  type SessionAttachment,
} from "./attachment.ts";
import { AttachmentService } from "./input.ts";
import {
  artifactReclaimFloor,
  artifactReconcileThrottle,
  artifactStorageDirectoryName,
  reconcileArtifactStorage,
  reconcileArtifactStorageOpportunistic,
} from "./storage_reconcile.ts";
import { createManager } from "../session/manager.ts";
import { closeDatabases, rootDBPath } from "../session/root_db.ts";

const artifactReconcileGraceMs = 24 * 60 * 60 * 1000;

function inputTestSession(): {
  root: string;
  workDir: string;
  sessionId: string;
} {
  const root = Deno.makeTempDirSync({ prefix: "opensac-reconcile-" });
  const workDir = Deno.makeTempDirSync({ prefix: "opensac-reconcile-work-" });
  const manager = createManager(workDir, root);
  manager.init();
  return { root, workDir, sessionId: manager.getHeader()!.id };
}

async function publishTestArtifact(
  service: AttachmentService,
  sessionId: string,
  runId: string,
  filename: string,
  content: string,
): Promise<SessionAttachment> {
  const bytes = new TextEncoder().encode(content);
  const record = await service.acceptArtifact(sessionId, runId, {
    origin: "test",
    reference: "runtime-artifact",
    kind: "file",
    filename,
    mediaType: "text/plain",
    sizeHint: bytes.length,
    open: () => ({ bytes, filename, mediaType: "text/plain" }),
  });
  service.setStatus(sessionId, record.id, "generated");
  return record;
}

/** Creates a committed-looking attachment directory aged below now. */
function writeArtifactDirectory(
  sessionDir: string,
  id: string,
  ageMs: number,
  content: string,
): string {
  const dir = path.join(sessionDir, artifactStorageDirectoryName(), id);
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "content");
  Deno.writeTextFileSync(file, content);
  const stamp = new Date(Date.now() - ageMs);
  Deno.utimeSync(file, stamp, stamp);
  Deno.utimeSync(dir, stamp, stamp);
  return file;
}

function exists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

Deno.test("ReconcileArtifactStorageReclaimsOnlyAgedUnreferenced", async () => {
  const { root, sessionId } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    const live = await publishTestArtifact(
      service,
      sessionId,
      "run-1",
      "keep.txt",
      "keep me",
    );

    const policy = defaultAttachmentPolicy();
    const now = new Date();
    const old = policy.retention + artifactReconcileGraceMs + 60 * 60 * 1000;
    const stale = writeArtifactDirectory(root, "0123456789abcdef", old, "gone");
    const young = writeArtifactDirectory(
      root,
      "1123456789abcdef",
      60_000,
      "in flight",
    );
    const foreign = writeArtifactDirectory(
      root,
      "someone-elses",
      old,
      "not mine",
    );
    const nested = path.join(
      root,
      artifactStorageDirectoryName(),
      "2123456789abcdef",
    );
    Deno.mkdirSync(path.join(nested, "subdir"), { recursive: true });

    const report = await reconcileArtifactStorage(root, policy, now);
    assertEquals(report.removed, 1);
    assertEquals(report.freed, "gone".length);
    assertEquals(report.skippedReferenced, 1);
    assertEquals(report.skippedYoung, 1);
    // `someone-elses` (bad name) and the nested layout are both unrecognized.
    assertEquals(report.skippedUnrecognized, 2);
    assert(exists(path.join(root, artifactStorageDirectoryName(), live.id)));
    assertEquals(exists(stale), false);
    for (const kept of [young, foreign, nested]) assert(exists(kept));
  } finally {
    closeDatabases();
  }
});

Deno.test("ReconcileArtifactStorageFailsClosedWithoutKnownReferences", async () => {
  const policy = defaultAttachmentPolicy();
  const now = new Date();

  const missingDB = Deno.makeTempDirSync({ prefix: "opensac-nodb-" });
  const orphan = writeArtifactDirectory(
    missingDB,
    "0123456789abcdef",
    policy.retention + artifactReconcileGraceMs + 60 * 60 * 1000,
    "bytes",
  );
  let threw = false;
  try {
    await reconcileArtifactStorage(missingDB, policy, now);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assert(exists(orphan));

  const corruptDB = Deno.makeTempDirSync({ prefix: "opensac-corruptdb-" });
  const orphan2 = writeArtifactDirectory(
    corruptDB,
    "0123456789abcdef",
    policy.retention + artifactReconcileGraceMs + 60 * 60 * 1000,
    "bytes",
  );
  Deno.writeTextFileSync(rootDBPath(corruptDB), "not a sqlite database");
  threw = false;
  try {
    await reconcileArtifactStorage(corruptDB, policy, now);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assert(exists(orphan2));
  closeDatabases();
});

Deno.test("ReconcileArtifactStorageNeverFollowsSymlinks", async () => {
  const { root, sessionId } = inputTestSession();
  void sessionId;
  try {
    const policy = defaultAttachmentPolicy();
    const victimDir = Deno.makeTempDirSync({ prefix: "opensac-victim-" });
    const victimFile = path.join(victimDir, "precious");
    Deno.writeTextFileSync(victimFile, "do not delete");
    Deno.mkdirSync(path.join(root, artifactStorageDirectoryName()), {
      recursive: true,
    });
    const link = path.join(
      root,
      artifactStorageDirectoryName(),
      "3123456789abcdef",
    );
    try {
      Deno.symlinkSync(victimDir, link, { type: "dir" });
    } catch {
      return; // platform cannot create a directory symlink
    }
    const stamp = new Date(Date.now() - 48 * 60 * 60 * 1000);
    Deno.utimeSync(victimFile, stamp, stamp);

    const report = await reconcileArtifactStorage(root, policy, new Date());
    assertEquals(report.removed, 0);
    assert(exists(victimFile));
  } finally {
    closeDatabases();
  }
});

Deno.test("ReconcileArtifactStorageOpportunisticRunsOncePerInterval", async () => {
  const { root, sessionId } = inputTestSession();
  void sessionId;
  try {
    const policy = defaultAttachmentPolicy();
    const old = policy.retention + artifactReconcileGraceMs + 60 * 60 * 1000;

    artifactReconcileThrottle.lastNanos = 0;
    const first = writeArtifactDirectory(root, "4123456789abcdef", old, "one");
    reconcileArtifactStorageOpportunistic(root, policy);
    await waitFor(() => !exists(first));
    assertEquals(exists(first), false);

    const second = writeArtifactDirectory(root, "5123456789abcdef", old, "two");
    reconcileArtifactStorageOpportunistic(root, policy);
    // The throttle window suppresses the second immediate pass.
    assertEquals(exists(second), true);

    artifactReconcileThrottle.lastNanos = (Date.now() - 2 * 60 * 60 * 1000) *
      1e6;
    reconcileArtifactStorageOpportunistic(root, policy);
    await waitFor(() => !exists(second));
    assertEquals(exists(second), false);
  } finally {
    artifactReconcileThrottle.lastNanos = 0;
    closeDatabases();
  }
});

Deno.test("ArtifactReclaimFloorIsRetentionPlusGrace", () => {
  const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  const floor = artifactReclaimFloor(defaultAttachmentPolicy(), now);
  const want = now.getTime() -
    (7 * 24 * 60 * 60 * 1000 + artifactReconcileGraceMs);
  assertEquals(floor.getTime(), want);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
