import * as path from "../compat/path.ts";
import { CorePaths } from "./paths.ts";

/** Discovery data for the currently running shared Core process. */
export interface CoreRegistration {
  id: string;
  version: string;
  protocolVersion: number;
  pid: number;
  /** The host used to bind the listener. */
  host: string;
  /** Optional explicit host advertised to clients, when known. */
  connectHost?: string;
  port: number;
  startedAt: number;
}

const REGISTRY_MUTATION_LOCK = ".core-registry-mutation.lock";
const REGISTRY_MUTATION_META = "owner.json";
const REGISTRY_TRANSITION_LOCK = ".core-registry-transition.lock";
const REGISTRY_TRANSITION_INTENT = ".core-registry-transition.intent";
const REGISTRY_RECLAIM_DIR = "reclaim";

interface RegistryMutationOwner {
  token: string;
  pid: number;
  hostname: string;
  timestamp: number;
}

/** Raised when a registry mutation cannot safely obtain its filesystem guard. */
export class CoreRegistryBusyError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, options?: ErrorOptions) {
    super("Core registry mutation is busy", options);
    this.name = "CoreRegistryBusyError";
    this.lockPath = lockPath;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Core registration ${key} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(
  object: JsonObject,
  key: string,
  minimum: number,
): number {
  const value = object[key];
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new TypeError(
      `Core registration ${key} must be an integer >= ${minimum}`,
    );
  }
  return value as number;
}

function requiredPort(object: JsonObject): number {
  const value = object.port;
  if (
    !Number.isInteger(value) || (value as number) < 0 ||
    (value as number) > 65535
  ) {
    throw new TypeError(
      "Core registration port must be an integer from 0 to 65535",
    );
  }
  return value as number;
}

function requiredFiniteNumber(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Core registration ${key} must be a finite number`);
  }
  return value;
}

/**
 * Validates and copies a registration. Unknown fields are ignored on read, but
 * password-bearing objects are rejected so a caller cannot accidentally write
 * authentication material into the discovery file.
 */
export function parseCoreRegistration(input: unknown): CoreRegistration {
  if (!isObject(input)) {
    throw new TypeError("Core registration must be an object");
  }
  if (hasOwn(input, "passwords")) {
    throw new TypeError("Core registration must not contain passwords");
  }

  const id = requiredString(input, "id");
  const version = requiredString(input, "version");
  const protocolVersion = requiredInteger(input, "protocolVersion", 0);
  const pid = requiredInteger(input, "pid", 1);
  const host = requiredString(input, "host");
  const connectHost = input.connectHost === undefined
    ? undefined
    : requiredString(input, "connectHost");
  const port = requiredPort(input);
  const startedAt = requiredFiniteNumber(input, "startedAt");

  return {
    id,
    version,
    protocolVersion,
    pid,
    host,
    ...(connectHost === undefined ? {} : { connectHost }),
    port,
    startedAt,
  };
}

function sameRegistration(
  left: CoreRegistration,
  right: CoreRegistration,
): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.protocolVersion === right.protocolVersion &&
    left.pid === right.pid &&
    left.host === right.host &&
    left.connectHost === right.connectHost &&
    left.port === right.port &&
    left.startedAt === right.startedAt;
}

/** Reads and writes the Core discovery registration for one state root. */
export class CoreRegistry {
  readonly paths: CorePaths;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(paths: CorePaths) {
    if (!(paths instanceof CorePaths)) {
      throw new TypeError("CoreRegistry requires CorePaths");
    }
    this.paths = paths;
  }

  /** Reads the current registration, or undefined when it is absent. */
  async read(): Promise<CoreRegistration | undefined> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.paths.registrationFile);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `read Core registration ${this.paths.registrationFile}: invalid JSON`,
        { cause: error },
      );
    }
    return parseCoreRegistration(value);
  }

  /** Atomically replaces the registration with a complete JSON value. */
  write(
    registration: CoreRegistration,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#enqueue(async () => {
      throwIfAborted(signal);
      const value = parseCoreRegistration(registration);
      await withRegistryMutationLock(this.paths, async () => {
        throwIfAborted(signal);
        await Deno.mkdir(this.paths.stateDir, {
          recursive: true,
          mode: 0o700,
        });

        const temporary = await Deno.makeTempFile({
          dir: this.paths.stateDir,
          prefix: ".core-registration-",
          suffix: ".tmp",
        });
        try {
          const data = `${JSON.stringify(value, null, 2)}\n`;
          await Deno.writeTextFile(temporary, data);
          await Deno.chmod(temporary, 0o600);
          await Deno.rename(temporary, this.paths.registrationFile);
          throwIfAborted(signal);
        } catch (error) {
          await removeIfPresent(temporary);
          throw error;
        }
      });
    });
  }

  /** Removes the registration only when it still belongs to `id`. */
  remove(id: string, signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      throwIfAborted(signal);
      if (typeof id !== "string" || id.trim() === "") {
        throw new TypeError("Core registration id is required");
      }
      const current = await this.read();
      if (current === undefined || current.id !== id) return;

      await withRegistryMutationLock(this.paths, async () => {
        throwIfAborted(signal);
        // Re-read after taking the cross-instance mutation guard. A different
        // registry/process may have replaced the file since the first check.
        const latest = await this.read();
        if (latest === undefined || latest.id !== id) return;
        await removeRegistrationAtomically(this.paths.registrationFile, id);
      });
    });
  }

  /** Reports whether the complete supplied registration is still current. */
  async isCurrent(registration: CoreRegistration): Promise<boolean> {
    const expected = parseCoreRegistration(registration);
    const current = await this.read();
    return current !== undefined && sameRegistration(expected, current);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function withRegistryMutationLock<T>(
  paths: CorePaths,
  operation: () => Promise<T>,
): Promise<T> {
  await Deno.mkdir(paths.stateDir, {
    recursive: true,
    mode: 0o700,
  });
  const lockDir = path.join(paths.stateDir, REGISTRY_MUTATION_LOCK);
  const owner = await withRegistryTransitionLock(
    paths,
    () => acquireRegistryMutationLock(lockDir),
  );
  try {
    return await operation();
  } finally {
    await withRegistryTransitionLock(
      paths,
      () => releaseRegistryMutationLock(lockDir, owner.token),
    );
  }
}

async function acquireRegistryMutationLock(
  lockDir: string,
): Promise<RegistryMutationOwner> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner: RegistryMutationOwner = {
      token: createMutationToken(),
      pid: Deno.pid,
      hostname: Deno.hostname(),
      timestamp: Date.now(),
    };
    try {
      await Deno.mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      let existing: RegistryMutationOwner | undefined;
      try {
        existing = await readRegistryMutationOwner(lockDir);
      } catch (readError) {
        throw new CoreRegistryBusyError(lockDir, { cause: readError });
      }
      if (
        existing === undefined ||
        existing.hostname !== Deno.hostname() ||
        mutationProcessLiveness(existing.pid) !== "dead"
      ) {
        throw new CoreRegistryBusyError(lockDir, { cause: error });
      }

      // The transition lock is held by the caller, so no other registry
      // operation can replace this guard or its reclaim marker while the
      // stale owner is being recovered.
      await recoverStaleRegistryReclaim(lockDir);
      const current = await readRegistryMutationOwner(lockDir);
      if (
        current === undefined ||
        current.token !== existing.token ||
        current.hostname !== Deno.hostname() ||
        mutationProcessLiveness(current.pid) !== "dead"
      ) {
        throw new CoreRegistryBusyError(lockDir, { cause: error });
      }
      const quarantine = uniqueMutationSibling(lockDir, "stale");
      try {
        await Deno.rename(lockDir, quarantine);
      } catch (renameError) {
        if (renameError instanceof Deno.errors.NotFound) continue;
        throw new CoreRegistryBusyError(lockDir, { cause: renameError });
      }
      const claimed = await readRegistryMutationOwner(quarantine);
      if (claimed === undefined || claimed.token !== existing.token) {
        throw new CoreRegistryBusyError(lockDir, { cause: error });
      }
      await removeDirectoryBestEffort(quarantine);
      continue;
    }

    try {
      const metadataPath = path.join(lockDir, REGISTRY_MUTATION_META);
      await Deno.writeTextFile(
        metadataPath,
        `${JSON.stringify(owner, null, 2)}\n`,
      );
      await Deno.chmod(metadataPath, 0o600);
      return owner;
    } catch (error) {
      await removeDirectoryBestEffort(lockDir);
      throw error;
    }
  }
  throw new CoreRegistryBusyError(lockDir);
}

async function recoverStaleRegistryReclaim(
  lockDir: string,
): Promise<void> {
  const claimDir = path.join(lockDir, REGISTRY_RECLAIM_DIR);
  try {
    await Deno.lstat(claimDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw new CoreRegistryBusyError(lockDir, { cause: error });
  }

  let existing: RegistryMutationOwner | undefined;
  try {
    existing = await readRegistryMutationOwner(claimDir);
  } catch (error) {
    throw new CoreRegistryBusyError(lockDir, { cause: error });
  }
  if (
    existing === undefined ||
    existing.hostname !== Deno.hostname() ||
    mutationProcessLiveness(existing.pid) !== "dead"
  ) {
    throw new CoreRegistryBusyError(lockDir);
  }

  // The transition lock held by the caller excludes every other registry
  // operation, so this stale claim can be moved without displacing a new one.
  const quarantine = uniqueMutationSibling(claimDir, "stale-claim");
  try {
    await Deno.rename(claimDir, quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw new CoreRegistryBusyError(lockDir, { cause: error });
  }
  const claimed = await readRegistryMutationOwner(quarantine);
  if (claimed === undefined || claimed.token !== existing.token) {
    throw new CoreRegistryBusyError(lockDir);
  }
  await removeDirectoryBestEffort(quarantine);
}

/**
 * Serializes every guard ownership transition. The intent record is published
 * before the transition directory, so a crash in the mkdir→owner.json window
 * still leaves a token/PID identity that can be rechecked and quarantined.
 * Missing or indeterminate identities continue to fail closed.
 */
async function withRegistryTransitionLock<T>(
  paths: CorePaths,
  operation: () => Promise<T>,
): Promise<T> {
  const transitionDir = path.join(paths.stateDir, REGISTRY_TRANSITION_LOCK);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await pathExists(transitionDir)) {
      if (!(await recoverExistingRegistryTransition(paths, transitionDir))) {
        throw new CoreRegistryBusyError(transitionDir);
      }
      continue;
    }

    const owner: RegistryMutationOwner = {
      token: createMutationToken(),
      pid: Deno.pid,
      hostname: Deno.hostname(),
      timestamp: Date.now(),
    };
    if (!(await acquireRegistryTransitionIntent(paths, owner))) continue;

    let published = false;
    try {
      try {
        await Deno.mkdir(transitionDir, { mode: 0o700 });
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) continue;
        throw error;
      }

      const metadataPath = path.join(transitionDir, REGISTRY_MUTATION_META);
      try {
        await Deno.writeTextFile(
          metadataPath,
          `${JSON.stringify(owner, null, 2)}\n`,
        );
        await Deno.chmod(metadataPath, 0o600);
      } catch (error) {
        await removeDirectoryBestEffort(transitionDir);
        throw error;
      }
      published = true;
      try {
        await releaseRegistryTransitionIntent(paths, owner.token);
        return await operation();
      } finally {
        await releaseRegistryTransitionLock(transitionDir, owner.token);
      }
    } finally {
      if (!published) {
        await releaseRegistryTransitionIntent(paths, owner.token);
      }
    }
  }
  throw new CoreRegistryBusyError(transitionDir);
}

async function recoverExistingRegistryTransition(
  paths: CorePaths,
  transitionDir: string,
): Promise<boolean> {
  let existing: RegistryMutationOwner | undefined;
  try {
    existing = await readRegistryMutationOwner(transitionDir);
  } catch {
    return false;
  }

  if (existing !== undefined) {
    if (
      existing.hostname !== Deno.hostname() ||
      mutationProcessLiveness(existing.pid) !== "dead"
    ) {
      return false;
    }
    const recovered = await recoverStaleRegistryTransition(
      transitionDir,
      existing,
    );
    if (recovered) {
      await releaseRegistryTransitionIntent(paths, existing.token);
    }
    return recovered;
  }

  let intent: RegistryMutationOwner | undefined;
  try {
    intent = await readRegistryTransitionIntent(paths);
  } catch {
    return false;
  }
  if (
    intent === undefined ||
    intent.hostname !== Deno.hostname() ||
    mutationProcessLiveness(intent.pid) !== "dead"
  ) {
    return false;
  }

  const recovered = await recoverIncompleteRegistryTransition(
    paths,
    transitionDir,
    intent,
  );
  if (recovered) {
    await releaseRegistryTransitionIntent(paths, intent.token);
  }
  return recovered;
}

async function acquireRegistryTransitionIntent(
  paths: CorePaths,
  owner: RegistryMutationOwner,
): Promise<boolean> {
  const intentPath = path.join(paths.stateDir, REGISTRY_TRANSITION_INTENT);
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = await Deno.makeTempFile({
      dir: paths.stateDir,
      prefix: ".core-registry-transition-intent-",
      suffix: ".tmp",
    });
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify(owner, null, 2)}\n`,
      );
      await Deno.chmod(temporary, 0o600);
      try {
        // Linking is a no-replace publication primitive. Unlike rename, it
        // cannot overwrite a live owner's intent during a race.
        await Deno.link(temporary, intentPath);
        return true;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    } finally {
      await removeIfPresent(temporary);
    }

    let existing: RegistryMutationOwner | undefined;
    try {
      existing = await readRegistryTransitionIntent(paths);
    } catch {
      return false;
    }
    if (
      existing === undefined ||
      existing.hostname !== Deno.hostname() ||
      mutationProcessLiveness(existing.pid) !== "dead"
    ) {
      return false;
    }

    const quarantine = uniqueMutationSibling(intentPath, "stale-intent");
    try {
      await Deno.rename(intentPath, quarantine);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      return false;
    }
    const claimed = await readRegistryOwnerFile(
      quarantine,
      "Core registry transition intent",
    );
    if (claimed === undefined || claimed.token !== existing.token) {
      await restoreQuarantinedFile(quarantine, intentPath);
      return false;
    }
    await removeIfPresent(quarantine);
  }
  return false;
}

async function releaseRegistryTransitionIntent(
  paths: CorePaths,
  token: string,
): Promise<void> {
  const intentPath = path.join(paths.stateDir, REGISTRY_TRANSITION_INTENT);
  const current = await readRegistryTransitionIntent(paths);
  if (current === undefined || current.token !== token) return;
  const quarantine = uniqueMutationSibling(intentPath, "release-intent");
  try {
    await Deno.rename(intentPath, quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const claimed = await readRegistryOwnerFile(
    quarantine,
    "Core registry transition intent",
  );
  if (claimed?.token !== token) {
    await restoreQuarantinedFile(quarantine, intentPath);
    return;
  }
  await removeIfPresent(quarantine);
}

async function recoverIncompleteRegistryTransition(
  paths: CorePaths,
  transitionDir: string,
  expected: RegistryMutationOwner,
): Promise<boolean> {
  const claimDir = path.join(transitionDir, REGISTRY_RECLAIM_DIR);
  const claim = await acquireTransitionReclaimClaim(claimDir);
  if (claim === undefined) return false;

  let moved = false;
  try {
    const currentIntent = await readRegistryTransitionIntent(paths);
    if (
      currentIntent === undefined ||
      currentIntent.token !== expected.token ||
      currentIntent.hostname !== Deno.hostname() ||
      mutationProcessLiveness(currentIntent.pid) !== "dead"
    ) {
      return false;
    }

    const current = await readRegistryMutationOwner(transitionDir);
    if (current !== undefined) return false;

    const quarantine = uniqueMutationSibling(transitionDir, "stale-incomplete");
    try {
      await Deno.rename(transitionDir, quarantine);
      moved = true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      return false;
    }

    const claimed = await readRegistryMutationOwner(quarantine);
    if (claimed !== undefined) {
      // A legacy owner wrote metadata while the claim was being acquired. Do
      // not delete it; restore the directory when the original name is free.
      try {
        await Deno.rename(quarantine, transitionDir);
        moved = false;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) return false;
      }
      return false;
    }
    await removeDirectoryBestEffort(quarantine);
    return true;
  } finally {
    if (!moved) {
      await releaseTransitionReclaimClaim(claimDir, claim.token);
    }
  }
}

async function recoverStaleRegistryTransition(
  transitionDir: string,
  expected: RegistryMutationOwner,
): Promise<boolean> {
  const claimDir = path.join(transitionDir, REGISTRY_RECLAIM_DIR);
  const claim = await acquireTransitionReclaimClaim(claimDir);
  if (claim === undefined) return false;

  let moved = false;
  try {
    const current = await readRegistryMutationOwner(transitionDir);
    if (
      current === undefined ||
      current.token !== expected.token ||
      current.hostname !== Deno.hostname() ||
      mutationProcessLiveness(current.pid) !== "dead"
    ) {
      return false;
    }

    const quarantine = uniqueMutationSibling(transitionDir, "stale-transition");
    try {
      await Deno.rename(transitionDir, quarantine);
      moved = true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw new CoreRegistryBusyError(transitionDir, { cause: error });
    }

    const claimed = await readRegistryMutationOwner(quarantine);
    if (claimed === undefined || claimed.token !== expected.token) {
      return false;
    }
    await removeDirectoryBestEffort(quarantine);
    return true;
  } finally {
    if (!moved) {
      await releaseTransitionReclaimClaim(claimDir, claim.token);
    }
  }
}

async function acquireTransitionReclaimClaim(
  claimDir: string,
): Promise<RegistryMutationOwner | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner: RegistryMutationOwner = {
      token: createMutationToken(),
      pid: Deno.pid,
      hostname: Deno.hostname(),
      timestamp: Date.now(),
    };
    try {
      await Deno.mkdir(claimDir, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      let existing: RegistryMutationOwner | undefined;
      try {
        existing = await readRegistryMutationOwner(claimDir);
      } catch (readError) {
        throw new CoreRegistryBusyError(claimDir, { cause: readError });
      }
      if (
        existing === undefined ||
        existing.hostname !== Deno.hostname() ||
        mutationProcessLiveness(existing.pid) !== "dead"
      ) {
        return undefined;
      }
      const quarantine = uniqueMutationSibling(claimDir, "stale-claim");
      try {
        await Deno.rename(claimDir, quarantine);
      } catch (renameError) {
        if (renameError instanceof Deno.errors.NotFound) continue;
        throw new CoreRegistryBusyError(claimDir, { cause: renameError });
      }
      const claimed = await readRegistryMutationOwner(quarantine);
      if (claimed === undefined || claimed.token !== existing.token) {
        throw new CoreRegistryBusyError(claimDir);
      }
      await removeDirectoryBestEffort(quarantine);
      continue;
    }

    try {
      await Deno.writeTextFile(
        path.join(claimDir, REGISTRY_MUTATION_META),
        `${JSON.stringify(owner, null, 2)}\n`,
      );
      await Deno.chmod(
        path.join(claimDir, REGISTRY_MUTATION_META),
        0o600,
      );
      return owner;
    } catch (error) {
      await removeDirectoryBestEffort(claimDir);
      throw error;
    }
  }
  return undefined;
}

async function releaseTransitionReclaimClaim(
  claimDir: string,
  token: string,
): Promise<void> {
  const current = await readRegistryMutationOwner(claimDir);
  if (current === undefined || current.token !== token) return;
  await removeDirectoryBestEffort(claimDir);
}

async function releaseRegistryTransitionLock(
  transitionDir: string,
  token: string,
): Promise<void> {
  if (!(await registryOwnerMatches(transitionDir, token))) return;
  const quarantine = uniqueMutationSibling(transitionDir, "release");
  try {
    await Deno.rename(transitionDir, quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const claimed = await readRegistryMutationOwner(quarantine);
  if (claimed === undefined || claimed.token !== token) return;
  await removeDirectoryBestEffort(quarantine);
}

async function registryOwnerMatches(
  lockDir: string,
  token: string,
): Promise<boolean> {
  const current = await readRegistryMutationOwner(lockDir);
  return current !== undefined && current.token === token;
}

async function releaseRegistryMutationLock(
  lockDir: string,
  token: string,
): Promise<void> {
  const current = await readRegistryMutationOwner(lockDir);
  if (current === undefined || current.token !== token) return;
  const quarantine = uniqueMutationSibling(lockDir, "release");
  try {
    await Deno.rename(lockDir, quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const claimed = await readRegistryMutationOwner(quarantine);
  if (claimed === undefined || claimed.token !== token) return;
  await removeDirectoryBestEffort(quarantine);
}

async function readRegistryMutationOwner(
  lockDir: string,
): Promise<RegistryMutationOwner | undefined> {
  return await readRegistryOwnerFile(
    path.join(lockDir, REGISTRY_MUTATION_META),
    "Core registry mutation",
  );
}

async function readRegistryTransitionIntent(
  paths: CorePaths,
): Promise<RegistryMutationOwner | undefined> {
  return await readRegistryOwnerFile(
    path.join(paths.stateDir, REGISTRY_TRANSITION_INTENT),
    "Core registry transition intent",
  );
}

async function readRegistryOwnerFile(
  filePath: string,
  label: string,
): Promise<RegistryMutationOwner | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} metadata is not valid JSON`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} metadata must be an object`);
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
    throw new TypeError(`${label} metadata has an invalid shape`);
  }
  return { token, pid, hostname, timestamp };
}

async function removeRegistrationAtomically(
  registrationFile: string,
  expectedId: string,
): Promise<void> {
  const quarantine = uniqueMutationSibling(registrationFile, "remove");
  try {
    await Deno.rename(registrationFile, quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }

  let claimed: CoreRegistration;
  try {
    const text = await Deno.readTextFile(quarantine);
    claimed = parseCoreRegistration(JSON.parse(text));
  } catch (error) {
    // A replacement that cannot be validated is never deleted. Restore it
    // when the original path is still absent; otherwise leave both values for
    // an operator to reconcile rather than risking data loss.
    await restoreQuarantinedRegistration(quarantine, registrationFile);
    throw error;
  }
  if (claimed.id !== expectedId) {
    await restoreQuarantinedRegistration(quarantine, registrationFile);
    return;
  }
  await removeIfPresent(quarantine);
}

async function restoreQuarantinedFile(
  quarantine: string,
  originalPath: string,
): Promise<void> {
  try {
    await Deno.link(quarantine, originalPath);
    await removeIfPresent(quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return;
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

async function restoreQuarantinedRegistration(
  quarantine: string,
  registrationFile: string,
): Promise<void> {
  try {
    // Linking is a no-replace operation. Unlike rename, it cannot overwrite a
    // newer registration that appeared while the quarantine was being checked.
    await Deno.link(quarantine, registrationFile);
    await removeIfPresent(quarantine);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return;
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

function mutationProcessLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    Deno.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "dead";
    return "unknown";
  }
}

function createMutationToken(): string {
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

function uniqueMutationSibling(target: string, label: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${label}-${createMutationToken()}`,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await Deno.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function removeDirectoryBestEffort(directory: string): Promise<void> {
  try {
    await Deno.remove(directory, { recursive: true });
  } catch {
    // A failed cleanup must not turn an already-claimed namespace into a
    // successful-looking mutation.
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await Deno.remove(filePath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Core registry operation aborted", "AbortError");
  }
}
