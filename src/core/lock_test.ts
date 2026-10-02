import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";
import { CoreLock, CoreLockBusyError } from "./lock.ts";

async function withStateDir(
  test: (paths: CorePaths, registry: CoreRegistry) => Promise<void>,
): Promise<void> {
  const stateDir = await Deno.makeTempDir({ prefix: "opensac-core-lock-" });
  try {
    const paths = CorePaths.fromStateDir(stateDir);
    await test(paths, new CoreRegistry(paths));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

function registration(
  id: string,
  overrides: Partial<CoreRegistration> = {},
): CoreRegistration {
  return {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    pid: Deno.pid,
    host: "127.0.0.1",
    port: 4096,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function seedLock(
  paths: CorePaths,
  metadata: {
    token: string;
    pid: number;
    hostname: string;
    timestamp: number;
  },
): Promise<void> {
  await Deno.mkdir(paths.lockFile, { mode: 0o700 });
  await Deno.writeTextFile(
    path.join(paths.lockFile, "meta.json"),
    JSON.stringify(metadata),
  );
}

Deno.test("CoreLock uses a private lock directory and releases it", async () => {
  await withStateDir(async (paths) => {
    const handle = await CoreLock.acquire(paths);
    try {
      const info = await Deno.stat(paths.lockFile);
      assert(info.isDirectory);
      const metadata = JSON.parse(
        await Deno.readTextFile(path.join(paths.lockFile, "meta.json")),
      );
      assertEquals(metadata.pid, Deno.pid);
      assertEquals(metadata.hostname, Deno.hostname());
      assertEquals(typeof metadata.token, "string");
      assert(metadata.token.length > 0);
      assertEquals(typeof metadata.timestamp, "number");
    } finally {
      await handle.release();
    }
    assertEquals(await exists(paths.lockFile), false);
  });
});

Deno.test("concurrent CoreLock acquisitions have one owner", async () => {
  await withStateDir(async (paths) => {
    const attempts = await Promise.allSettled([
      CoreLock.acquire(paths),
      CoreLock.acquire(paths),
    ]);
    const fulfilled = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof CoreLock.acquire>>
      > => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    assertEquals(fulfilled.length, 1);
    assertEquals(rejected.length, 1);
    assert(rejected[0].reason instanceof CoreLockBusyError);
    await fulfilled[0].value.release();
  });
});

Deno.test("two CoreLock acquisitions cannot succeed until release", async () => {
  await withStateDir(async (paths) => {
    const first = await CoreLock.acquire(paths);
    try {
      await assertRejects(
        () => CoreLock.acquire(paths),
        CoreLockBusyError,
      );
    } finally {
      await first.release();
    }

    const second = await CoreLock.acquire(paths);
    await second.release();
  });
});

Deno.test("CoreLock release is token protected and idempotent", async () => {
  await withStateDir(async (paths) => {
    const handle = await CoreLock.acquire(paths);
    const metadataPath = path.join(paths.lockFile, "meta.json");
    const original = JSON.parse(await Deno.readTextFile(metadataPath));
    await Deno.writeTextFile(
      metadataPath,
      JSON.stringify({ ...original, token: "another-owner" }),
    );

    await handle.release();
    assertEquals(await exists(paths.lockFile), true);
    await handle.release();
    assertEquals(await exists(paths.lockFile), true);
  });
});

Deno.test("CoreLock recovers a demonstrably dead owner with no healthy registration", async () => {
  await withStateDir(async (paths, registry) => {
    await seedLock(paths, {
      token: "stale-token",
      pid: 999_999_99,
      hostname: Deno.hostname(),
      timestamp: 1,
    });

    const handle = await CoreLock.acquire(paths);
    try {
      assertEquals(await registry.read(), undefined);
    } finally {
      await handle.release();
    }
  });
});

Deno.test("CoreLock recovers when the registered process is also dead", async () => {
  await withStateDir(async (paths, registry) => {
    await registry.write(registration("stale-core", { pid: 999_999_98 }));
    await seedLock(paths, {
      token: "stale-token",
      pid: 999_999_99,
      hostname: Deno.hostname(),
      timestamp: 1,
    });

    const handle = await CoreLock.acquire(paths);
    await handle.release();
  });
});

Deno.test("CoreLock refuses stale recovery while a registered process may be healthy", async () => {
  await withStateDir(async (paths, registry) => {
    await registry.write(registration("live-core"));
    await seedLock(paths, {
      token: "stale-token",
      pid: 999_999_99,
      hostname: Deno.hostname(),
      timestamp: 1,
    });

    await assertRejects(
      () => CoreLock.acquire(paths),
      CoreLockBusyError,
    );
    assertEquals(await exists(paths.lockFile), true);
  });
});

Deno.test("CoreLock does not reclaim an old timestamp for a live owner", async () => {
  await withStateDir(async (paths) => {
    await seedLock(paths, {
      token: "live-token",
      pid: Deno.pid,
      hostname: Deno.hostname(),
      timestamp: 1,
    });

    await assertRejects(
      () => CoreLock.acquire(paths),
      CoreLockBusyError,
    );
    assertEquals(await exists(paths.lockFile), true);
  });
});

Deno.test("CoreLock treats unreadable owner metadata as busy", async () => {
  await withStateDir(async (paths) => {
    await Deno.mkdir(paths.lockFile, { mode: 0o700 });
    await Deno.writeTextFile(
      path.join(paths.lockFile, "meta.json"),
      "{not-json",
    );

    await assertRejects(
      () => CoreLock.acquire(paths),
      CoreLockBusyError,
    );
    assertEquals(await exists(paths.lockFile), true);
  });
});

Deno.test("concurrent stale recovery never removes a re-acquired lock", async () => {
  await withStateDir(async (paths) => {
    await seedLock(paths, {
      token: "stale-token",
      pid: 999_999_99,
      hostname: Deno.hostname(),
      timestamp: 1,
    });

    const originalRemove = Deno.remove;
    const originalRename = Deno.rename;
    let releaseCleanup!: () => void;
    let signalCleanup!: (kind: "remove" | "rename") => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupStarted = new Promise<"remove" | "rename">((resolve) => {
      signalCleanup = resolve;
    });
    let hooked = false;

    Deno.remove =
      (async (target: string, options?: { recursive?: boolean }) => {
        if (!hooked && target === paths.lockFile && options?.recursive) {
          hooked = true;
          signalCleanup("remove");
          await cleanupGate;
        }
        return originalRemove(target, options);
      }) as typeof Deno.remove;
    Deno.rename = (async (oldPath: string, newPath: string) => {
      if (!hooked && oldPath === paths.lockFile) {
        const result = await originalRename(oldPath, newPath);
        hooked = true;
        signalCleanup("rename");
        await cleanupGate;
        return result;
      }
      return originalRename(oldPath, newPath);
    }) as typeof Deno.rename;

    let first:
      | Promise<Awaited<ReturnType<typeof CoreLock.acquire>>>
      | undefined;
    let second:
      | Promise<Awaited<ReturnType<typeof CoreLock.acquire>>>
      | undefined;
    try {
      first = CoreLock.acquire(paths);
      const cleanupKind = await cleanupStarted;
      if (cleanupKind === "remove") {
        // Let the second contender acquire while the old implementation is
        // paused before its recursive unlink.
        await originalRemove(paths.lockFile, { recursive: true });
      }
      second = CoreLock.acquire(paths);
      await waitForFile(path.join(paths.lockFile, "meta.json"));
      releaseCleanup();

      const results = await Promise.allSettled([first, second]);
      const owners = results.filter(
        (result) => result.status === "fulfilled",
      );
      assertEquals(owners.length, 1);
      for (const owner of owners) await owner.value.release();
    } finally {
      releaseCleanup();
      Deno.remove = originalRemove;
      Deno.rename = originalRename;
    }
  });
});

Deno.test("CoreLock fails closed when owner liveness cannot be established", async () => {
  await withStateDir(async (paths) => {
    await seedLock(paths, {
      token: "unknown-token",
      pid: 999_999_99,
      hostname: "a-different-host",
      timestamp: 1,
    });

    await assertRejects(
      () => CoreLock.acquire(paths),
      CoreLockBusyError,
    );
    assertEquals(await exists(paths.lockFile), true);
  });
});

async function seedOrphanLock(
  paths: CorePaths,
  ageMs = 0,
): Promise<void> {
  await Deno.mkdir(paths.lockFile, { mode: 0o700 });
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    await Deno.utime(paths.lockFile, past, past);
  }
}

Deno.test("CoreLock.inspect classifies free, held, and orphan locks", async () => {
  await withStateDir(async (paths) => {
    assertEquals((await CoreLock.inspect(paths)).state, "free");

    const handle = await CoreLock.acquire(paths);
    assertEquals((await CoreLock.inspect(paths)).state, "held");
    await handle.release();

    await seedOrphanLock(paths);
    const orphan = await CoreLock.inspect(paths);
    if (orphan.state !== "orphan") {
      throw new Error(`expected orphan, got ${orphan.state}`);
    }
    assertEquals(orphan.reason, "missing-metadata");
    assertEquals(orphan.reclaimableByConsent, true);
    // A fresh orphan is inside the grace window, so headless recovery refuses.
    assertEquals(orphan.reclaimableAutomatically, false);
  });
});

Deno.test("CoreLock.acquire auto-heals a stale missing-metadata orphan", async () => {
  await withStateDir(async (paths) => {
    await seedOrphanLock(paths, 60_000);
    const handle = await CoreLock.acquire(paths);
    try {
      assertEquals((await CoreLock.inspect(paths)).state, "held");
    } finally {
      await handle.release();
    }
    assertEquals(await exists(paths.lockFile), false);
  });
});

Deno.test("CoreLock.acquire refuses a missing-metadata orphan inside the grace window", async () => {
  await withStateDir(async (paths) => {
    await seedOrphanLock(paths, 0);
    await assertRejects(() => CoreLock.acquire(paths), CoreLockBusyError);
    assertEquals(await exists(paths.lockFile), true);
  });
});

Deno.test("CoreLock.acquire will not auto-heal malformed metadata or a live registration", async () => {
  await withStateDir(async (paths, registry) => {
    // Malformed metadata is never auto-healed, even past the grace window: it
    // is an unreadable-ownership signal that requires explicit human consent.
    await Deno.mkdir(paths.lockFile, { mode: 0o700 });
    const metaPath = path.join(paths.lockFile, "meta.json");
    await Deno.writeTextFile(metaPath, "{not-json");
    const past = new Date(Date.now() - 60_000);
    await Deno.utime(metaPath, past, past);
    await Deno.utime(paths.lockFile, past, past);
    await assertRejects(() => CoreLock.acquire(paths), CoreLockBusyError);
    assertEquals(await exists(paths.lockFile), true);
    await handleMalformedLock(paths);

    // A live registration blocks recovery of a clear missing-metadata orphan.
    await registry.write(registration("live-core"));
    await seedOrphanLock(paths, 60_000);
    await assertRejects(() => CoreLock.acquire(paths), CoreLockBusyError);
    assertEquals(await exists(paths.lockFile), true);
  });
});

async function handleMalformedLock(paths: CorePaths): Promise<void> {
  const removed = await CoreLock.reclaimOrphan(paths);
  assertEquals(removed, true);
  assertEquals(await exists(paths.lockFile), false);
}

Deno.test("CoreLock.reclaimOrphan removes a consented orphan even inside the grace window", async () => {
  await withStateDir(async (paths) => {
    await seedOrphanLock(paths, 0);
    assertEquals(await CoreLock.reclaimOrphan(paths), true);
    assertEquals(await exists(paths.lockFile), false);
    // It then acquires cleanly.
    const handle = await CoreLock.acquire(paths);
    await handle.release();
  });
});

Deno.test("CoreLock.reclaimOrphan refuses consent removal while a live Core is registered", async () => {
  await withStateDir(async (paths, registry) => {
    await registry.write(registration("live-core"));
    await seedOrphanLock(paths, 0);
    assertEquals(await CoreLock.reclaimOrphan(paths), false);
    assertEquals(await exists(paths.lockFile), true);
  });
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      await Deno.lstat(filePath);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await Deno.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
