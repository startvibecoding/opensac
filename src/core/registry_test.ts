import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";

async function withStateDir(
  test: (paths: CorePaths, registry: CoreRegistry) => Promise<void>,
): Promise<void> {
  const stateDir = await Deno.makeTempDir({ prefix: "opensac-core-registry-" });
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

Deno.test("CorePaths.fromStateDir does not create state", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opensac-core-paths-" });
  try {
    const stateDir = path.join(parent, "state");
    const paths = CorePaths.fromStateDir(stateDir);

    assertEquals(paths.stateDir, stateDir);
    assertEquals(paths.registrationFile.endsWith("core.json"), true);
    assertEquals(paths.lockFile.endsWith("core.lock"), true);
    assertEquals(await exists(paths.stateDir), false);
    assertEquals(await exists(paths.registrationFile), false);
    assertEquals(await exists(paths.lockFile), false);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("CoreRegistry writes one complete atomic JSON registration", async () => {
  await withStateDir(async (paths, registry) => {
    const value = registration("core-a", { port: 4310 });
    await registry.write(value);

    assertEquals(await registry.read(), value);
    const raw = await Deno.readTextFile(paths.registrationFile);
    assertEquals(JSON.parse(raw), value);
    assertEquals(raw.includes("passwords"), false);

    const entries = [];
    for await (const entry of Deno.readDir(paths.stateDir)) {
      entries.push(entry.name);
    }
    assertEquals(entries.filter((name) => name !== "core.json"), []);
  });
});

Deno.test("CoreRegistry creates a missing state directory only on write", async () => {
  const parent = await Deno.makeTempDir({ prefix: "opensac-core-write-" });
  try {
    const paths = CorePaths.fromStateDir(path.join(parent, "nested", "state"));
    const registry = new CoreRegistry(paths);
    assertEquals(await registry.read(), undefined);
    assertEquals(await exists(paths.stateDir), false);

    await registry.write(registration("new-core"));
    assertEquals((await Deno.stat(paths.stateDir)).isDirectory, true);
    assertEquals((await registry.read())?.id, "new-core");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("CoreRegistry rejects malformed and secret-bearing registrations", async () => {
  await withStateDir(async (paths, registry) => {
    await assertRejects(() =>
      registry.write({ id: 1 } as unknown as CoreRegistration)
    );
    await assertRejects(() =>
      registry.write({
        ...registration("core-a"),
        passwords: ["do-not-write"],
      } as unknown as CoreRegistration)
    );
    await Deno.writeTextFile(paths.registrationFile, "{");
    await assertRejects(() => registry.read());
  });
});

Deno.test("CoreRegistry remove and isCurrent are identity-scoped", async () => {
  await withStateDir(async (_paths, registry) => {
    const old = registration("old-core");
    const newer = registration("new-core", { port: 4311 });
    await registry.write(old);
    assertEquals(await registry.isCurrent(old), true);

    await registry.write(newer);
    await registry.remove(old.id);
    assertEquals(await registry.read(), newer);
    assertEquals(await registry.isCurrent(old), false);
    assertEquals(await registry.isCurrent(newer), true);

    await registry.remove(newer.id);
    assertEquals(await registry.read(), undefined);
    assertEquals(await registry.isCurrent(newer), false);
  });
});

Deno.test("CoreRegistry remove rechecks identity across a replacement", async () => {
  await withStateDir(async (paths) => {
    const old = registration("old-core");
    const newer = registration("new-core", { port: 4311 });
    const writer = new CoreRegistry(paths);
    await writer.write(old);

    let releaseRead!: () => void;
    let signalRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    let paused = false;
    class PausingRegistry extends CoreRegistry {
      override async read(): Promise<CoreRegistration | undefined> {
        const value = await super.read();
        if (!paused) {
          paused = true;
          signalRead();
          await readGate;
        }
        return value;
      }
    }

    const remover = new PausingRegistry(paths);
    const removePromise = remover.remove(old.id);
    await readStarted;
    // Use a separate atomic writer to model another process replacing the
    // registration while remove is between its read and unlink.
    await replaceRegistrationAtomically(paths.registrationFile, newer);
    releaseRead();
    await removePromise;

    assertEquals(await writer.read(), newer);
  });
});

Deno.test("stale reclaim takeover cannot displace a replacement claim", async () => {
  await withStateDir(async (paths) => {
    const mutationLock = path.join(
      paths.stateDir,
      ".core-registry-mutation.lock",
    );
    const reclaimDir = path.join(mutationLock, "reclaim");
    await Deno.mkdir(reclaimDir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path.join(mutationLock, "owner.json"),
      JSON.stringify({
        token: "stale-guard",
        pid: 999_999_99,
        hostname: Deno.hostname(),
        timestamp: 1,
      }),
    );
    await Deno.writeTextFile(
      path.join(reclaimDir, "owner.json"),
      JSON.stringify({
        token: "stale-reclaim",
        pid: 999_999_98,
        hostname: Deno.hostname(),
        timestamp: 1,
      }),
    );

    const originalRename = Deno.rename;
    const originalWriteTextFile = Deno.writeTextFile;
    let releaseFirstClaim!: () => void;
    let signalFirstClaim!: () => void;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    const firstClaimSeen = new Promise<void>((resolve) => {
      signalFirstClaim = resolve;
    });
    let releaseMainRename!: () => void;
    let signalMainRename!: () => void;
    const mainRenameGate = new Promise<void>((resolve) => {
      releaseMainRename = resolve;
    });
    const mainRenameSeen = new Promise<void>((resolve) => {
      signalMainRename = resolve;
    });
    let releaseReplacement!: () => void;
    let signalReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacementSeen = new Promise<void>((resolve) => {
      signalReplacement = resolve;
    });
    let signalNewClaim!: () => void;
    const newClaimSeen = new Promise<void>((resolve) => {
      signalNewClaim = resolve;
    });
    const claimMetaPath = path.join(reclaimDir, "owner.json");
    let claimRenameCount = 0;
    let mainRenameCount = 0;
    let newClaimCreated = false;
    let replacementMoved = false;

    Deno.rename = (async (oldPath: string, newPath: string) => {
      if (oldPath === reclaimDir && claimRenameCount++ === 0) {
        signalFirstClaim();
        await firstClaimGate;
        const result = await originalRename(oldPath, newPath);
        if (newClaimCreated) {
          replacementMoved = true;
          signalReplacement();
          await replacementGate;
        }
        return result;
      }
      if (oldPath === mutationLock && mainRenameCount++ === 0) {
        signalMainRename();
        await mainRenameGate;
      }
      return originalRename(oldPath, newPath);
    }) as typeof Deno.rename;
    Deno.writeTextFile = (async (
      ...args: Parameters<typeof Deno.writeTextFile>
    ) => {
      const [target] = args;
      const result = await originalWriteTextFile(...args);
      if (target === claimMetaPath) {
        newClaimCreated = true;
        signalNewClaim();
      }
      return result;
    }) as typeof Deno.writeTextFile;

    const first = new CoreRegistry(paths).write(registration("first-core"));
    await firstClaimSeen;
    const second = new CoreRegistry(paths).write(
      registration("second-core", { port: 4310 }),
    );
    const secondSettled = second.then(
      () => "settled",
      () => "settled",
    );
    const outcome = await Promise.race([
      Promise.all([newClaimSeen, mainRenameSeen]).then(() => "replacement"),
      secondSettled,
    ]);

    try {
      if (outcome === "replacement") {
        releaseFirstClaim();
        await replacementSeen;
        assertEquals(replacementMoved, false);
        releaseReplacement();
        releaseMainRename();
      } else {
        releaseFirstClaim();
        releaseMainRename();
      }
      await Promise.allSettled([first, second]);
    } finally {
      releaseFirstClaim();
      releaseMainRename();
      releaseReplacement();
      Deno.rename = originalRename;
      Deno.writeTextFile = originalWriteTextFile;
    }
  });
});

Deno.test("concurrent stale mutation-guard recovery has one active owner", async () => {
  await withStateDir(async (paths) => {
    const mutationLock = path.join(
      paths.stateDir,
      ".core-registry-mutation.lock",
    );
    await Deno.mkdir(mutationLock, { mode: 0o700 });
    await Deno.writeTextFile(
      path.join(mutationLock, "owner.json"),
      JSON.stringify({
        token: "stale-guard",
        pid: 999_999_99,
        hostname: Deno.hostname(),
        timestamp: 1,
      }),
    );

    const originalRename = Deno.rename;
    const originalMakeTempFile = Deno.makeTempFile;
    let releaseFirstRename!: () => void;
    let signalFirstRename!: () => void;
    const firstRenameGate = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    const firstRenameSeen = new Promise<void>((resolve) => {
      signalFirstRename = resolve;
    });
    let releaseFirstMutation!: () => void;
    let signalFirstMutation!: () => void;
    let signalSecondMutation!: () => void;
    const firstMutationGate = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    const firstMutationSeen = new Promise<void>((resolve) => {
      signalFirstMutation = resolve;
    });
    const secondMutationSeen = new Promise<void>((resolve) => {
      signalSecondMutation = resolve;
    });
    let renameCount = 0;
    let mutationCount = 0;
    let activeMutations = 0;
    let maxActiveMutations = 0;
    let pauseFirstMutation = true;

    Deno.rename = (async (oldPath: string, newPath: string) => {
      if (oldPath === mutationLock && renameCount++ === 0) {
        signalFirstRename();
        await firstRenameGate;
      }
      return originalRename(oldPath, newPath);
    }) as typeof Deno.rename;
    Deno.makeTempFile = (async (
      options?: { dir?: string; prefix?: string; suffix?: string },
    ) => {
      const file = await originalMakeTempFile(options);
      if (
        options?.dir === paths.stateDir &&
        options.prefix === ".core-registration-"
      ) {
        mutationCount++;
        activeMutations++;
        maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
        if (mutationCount === 1) {
          signalFirstMutation();
          if (pauseFirstMutation) await firstMutationGate;
        }
        if (mutationCount === 2) signalSecondMutation();
        try {
          return file;
        } finally {
          activeMutations--;
        }
      }
      return file;
    }) as typeof Deno.makeTempFile;

    const first = new CoreRegistry(paths).write(registration("first-core"));
    await firstRenameSeen;
    const second = new CoreRegistry(paths).write(
      registration("second-core", { port: 4310 }),
    );
    const secondSettled = second.then(
      () => "settled",
      () => "settled",
    );
    const firstOutcome = await Promise.race([
      firstMutationSeen.then(() => "mutation"),
      secondSettled,
    ]);

    try {
      if (firstOutcome === "mutation") {
        // The first contender has the old implementation's stale observation;
        // let it continue after the second contender has entered the mutation.
        releaseFirstRename();
        await Promise.race([
          secondMutationSeen,
          first.then(() => "settled", () => "settled"),
        ]);
        releaseFirstMutation();
      } else {
        // A claim-aware implementation rejects the second contender while the
        // first still owns the recovery claim.
        pauseFirstMutation = false;
        releaseFirstRename();
      }
      await Promise.allSettled([first, second]);
      assertEquals(maxActiveMutations, 1);
    } finally {
      pauseFirstMutation = false;
      releaseFirstRename();
      releaseFirstMutation();
      Deno.rename = originalRename;
      Deno.makeTempFile = originalMakeTempFile;
    }
  });
});

Deno.test("CoreRegistry readers never observe partial replacement JSON", async () => {
  await withStateDir(async (_paths, registry) => {
    const initial = registration("initial-core");
    await registry.write(initial);
    let running = true;
    const reader = (async () => {
      while (running) {
        const value = await registry.read();
        assert(value !== undefined);
        assert(typeof value.id === "string");
        await Promise.resolve();
      }
    })();

    try {
      for (let i = 0; i < 40; i++) {
        await registry.write(registration(`replacement-${i}`, {
          version: "0.1.0",
          startedAt: 1_700_000_000_000 + i,
        }));
      }
    } finally {
      running = false;
    }
    await reader;
  });
});

Deno.test("CoreRegistry read returns undefined only for a missing file", async () => {
  await withStateDir(async (paths, registry) => {
    assertEquals(await registry.read(), undefined);
    await Deno.writeTextFile(
      paths.registrationFile,
      JSON.stringify({ id: "x" }),
    );
    await assertRejects(() => registry.read());
  });
});

async function replaceRegistrationAtomically(
  registrationFile: string,
  value: CoreRegistration,
): Promise<void> {
  const temporary = await Deno.makeTempFile({
    dir: path.dirname(registrationFile),
    prefix: ".test-registration-",
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(temporary, JSON.stringify(value));
    await Deno.rename(temporary, registrationFile);
  } finally {
    try {
      await Deno.remove(temporary);
    } catch {
      // Best-effort cleanup after the atomic replacement.
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
