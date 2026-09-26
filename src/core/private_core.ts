// An isolated private Core process with its own state directory.
//
// Standalone entry points (for example `opensac acp --standalone`) own this
// Core's complete lifecycle: it is started on demand inside a fresh private
// state directory, never registers into the shared global discovery, and is
// shut down and cleaned up when its owner exits. The private directory doubles
// as the Core's OPENSAC_DIR, so its registration, lock, sessions, and database
// stay isolated from the shared Core's state.

import { join } from "@std/path";
import {
  CoreClient,
  type CoreClientOptions,
  type CoreLauncher,
  waitForRegistrationExit,
} from "./client.ts";
import type { ResolvedCoreConfig } from "./config.ts";
import { CorePaths } from "./paths.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";

/** Lifecycle configuration for an isolated private Core. */
export interface PrivateCoreOptions {
  /** Product version recorded by the private Core and its clients. */
  version: string;
  /** Core application protocol version recorded by the private Core. */
  protocolVersion: number;
  /** Parent directory under which the private state directory is created. */
  parentDir: string;
  /** Bounded wait for the private Core to exit during close. */
  stopTimeoutMs?: number;
  /** Bounded readiness budget for starting the private Core. */
  startTimeoutMs?: number;
  /** Creates the private state directory. Defaults to a unique directory. */
  createStateDir?: (parentDir: string) => Promise<string>;
  /** Removes a stopped private Core's state directory. Defaults to remove. */
  removeStateDir?: (stateDir: string) => Promise<void>;
  /** Creates the process launcher for the private state directory. */
  createLauncher?: (stateDir: string) => CoreLauncher;
  /** Sleep seam used while waiting for exit. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Observable result of closing a private Core. */
export interface PrivateCoreCloseOutcome {
  /** True when the private Core was observed exiting within the wait budget. */
  exited: boolean;
  /** True when the private state directory was removed. */
  cleaned: boolean;
}

/** A running private Core and the client connected to it. */
export interface PrivateCoreHandle {
  /** A client bound to the private Core's isolated discovery directory. */
  readonly client: CoreClient;
  /** The private state directory (also the Core's OPENSAC_DIR). */
  readonly stateDir: string;
  /**
   * Requests graceful shutdown, waits for the process to exit, and removes
   * the private state directory when it did. Safe to call repeatedly and
   * never throws for cleanup trouble; `exited`/`cleaned` report the outcome.
   */
  close(): Promise<PrivateCoreCloseOutcome>;
}

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const FAILED_START_STOP_TIMEOUT_MS = 3_000;

/** The loopback-only, OS-assigned-port configuration of a private Core. */
export function privateCoreConfig(): ResolvedCoreConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    auth: false,
    passwords: [],
  };
}

/**
 * Starts an isolated private Core and returns its lifecycle handle.
 *
 * On any startup failure the partially created private state is cleaned up
 * before the error is rethrown, so a failed standalone run never leaks a
 * state directory or an unreachable Core process.
 */
export async function startPrivateCore(
  options: PrivateCoreOptions,
): Promise<PrivateCoreHandle> {
  const stateDir = await (options.createStateDir ?? createUniqueStateDir)(
    options.parentDir,
  );
  const config = privateCoreConfig();
  // The private directory is the child Core's OPENSAC_DIR: give it a settings
  // file that binds an OS-assigned loopback port so it can never collide with
  // the shared Core's fixed configured endpoint.
  await Deno.writeTextFile(
    join(stateDir, "settings.json"),
    `${JSON.stringify({ core: config }, null, 2)}\n`,
  );

  const clientOptions: CoreClientOptions = {
    stateDir,
    version: options.version,
    protocolVersion: options.protocolVersion,
    config,
  };
  if (options.startTimeoutMs !== undefined) {
    clientOptions.startTimeoutMs = options.startTimeoutMs;
  }
  const createLauncher = options.createLauncher;
  if (createLauncher !== undefined) {
    clientOptions.launcher = createLauncher(stateDir);
  }

  const client = new CoreClient(clientOptions);
  try {
    const discovery = await client.ensureStarted();
    if (discovery.status !== "ready") {
      throw new Error(`Private Core is not ready: ${discovery.status}`);
    }
    return privateCoreHandle(client, stateDir, options);
  } catch (error) {
    // A startup failure must still try to stop anything that was launched,
    // but it must not mask the original error or linger on a slow cleanup.
    await closePrivateCore(client, stateDir, {
      ...options,
      stopTimeoutMs: Math.min(
        options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        FAILED_START_STOP_TIMEOUT_MS,
      ),
    });
    throw error;
  }
}

function privateCoreHandle(
  client: CoreClient,
  stateDir: string,
  options: PrivateCoreOptions,
): PrivateCoreHandle {
  let closePromise: Promise<PrivateCoreCloseOutcome> | undefined;
  return {
    client,
    stateDir,
    close(): Promise<PrivateCoreCloseOutcome> {
      closePromise ??= closePrivateCore(client, stateDir, options);
      return closePromise;
    },
  };
}

async function closePrivateCore(
  client: CoreClient,
  stateDir: string,
  options: PrivateCoreOptions,
): Promise<PrivateCoreCloseOutcome> {
  const registry = new CoreRegistry(CorePaths.fromStateDir(stateDir));
  let registration: CoreRegistration | undefined;
  try {
    registration = await registry.read();
  } catch {
    registration = undefined;
  }
  try {
    await client.shutdown();
  } catch {
    // A private Core that is already gone produces the same outcome as a
    // successful shutdown request; `exited` below reports the truth either
    // way, and close() stays total so exit-time cleanup cannot throw.
  }
  const exited = registration === undefined || await waitForRegistrationExit(
    registry,
    registration,
    {
      timeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      sleep: options.sleep,
    },
  );
  await client.close();

  let cleaned = false;
  if (exited) {
    try {
      await (options.removeStateDir ?? removeStateDir)(stateDir);
      cleaned = true;
    } catch {
      // Removing the private directory is best-effort; a leftover directory
      // must never fail an otherwise clean shutdown.
    }
  }
  return { exited, cleaned };
}

async function createUniqueStateDir(parentDir: string): Promise<string> {
  const stateDir = join(parentDir, uniqueStateDirName());
  await Deno.mkdir(stateDir, { recursive: true });
  return stateDir;
}

function uniqueStateDirName(): string {
  let random: string;
  try {
    random = crypto.randomUUID();
  } catch {
    random = `${Date.now().toString(36)}-${
      Math.random().toString(36).slice(2)
    }`;
  }
  return `${Date.now().toString(36)}-${random}`;
}

function removeStateDir(stateDir: string): Promise<void> {
  return Deno.remove(stateDir, { recursive: true });
}
