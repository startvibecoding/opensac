//
// Periodically drives lease-first orphan convergence for one canonical Session
// database. Multiple processes may scan the same DB; the fenced recovery CAS
// elects exactly one worker per Session, so a lost or duplicated wake-up never
// affects correctness. Go's goroutine/ticker loop maps to an async
// tick-or-wake loop; `context.Context` maps to an `AbortSignal`.

import { runtimeDatabaseIdentityFor } from "../session/runtime_lock.ts";
import {
  type BeforeFail,
  defaultRecoveryAttemptTimeoutMs,
  recoverOrphanedRunsWithTrigger,
  type RunRecoveryPolicy,
  type RunRecoveryResult,
} from "./run_recovery.ts";

/** Default scan period for the periodic orphan sweep. */
export const defaultRecoveryScanIntervalMs = 5_000;

/**
 * Policy hooks owned by the shared Runtime host. Adapters may clean up their
 * protocol projections in `beforeFail`, but they do not decide whether a valid
 * lease can be displaced.
 */
export interface RecoveryCoordinatorOptions {
  scanIntervalMs?: number;
  attemptTimeoutMs?: number;
  policy?: RunRecoveryPolicy | null;
  beforeFail?: BeforeFail | null;
  onResult?: (result: RunRecoveryResult) => void;
  onError?: (err: Error) => void;
}

/**
 * Periodically drives lease-first orphan convergence for one canonical Session
 * database. `start` performs the mandatory startup scan synchronously, then
 * begins the periodic and wake-driven loop.
 */
export class RecoveryCoordinator {
  readonly sessionDir: string;
  readonly options: RecoveryCoordinatorOptions;

  #started = false;
  #running = false;
  #abort: AbortController | null = null;
  #scanLock: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wakeResolvers: Array<() => void> = [];
  #loopPromise: Promise<void> | null = null;

  constructor(sessionDir: string, options: RecoveryCoordinatorOptions = {}) {
    this.sessionDir = sessionDir;
    let scanIntervalMs = options.scanIntervalMs ??
      defaultRecoveryScanIntervalMs;
    if (scanIntervalMs <= 0 || scanIntervalMs > defaultRecoveryScanIntervalMs) {
      scanIntervalMs = defaultRecoveryScanIntervalMs;
    }
    let attemptTimeoutMs = options.attemptTimeoutMs ??
      defaultRecoveryAttemptTimeoutMs;
    if (
      attemptTimeoutMs <= 0 ||
      attemptTimeoutMs > defaultRecoveryAttemptTimeoutMs
    ) {
      attemptTimeoutMs = defaultRecoveryAttemptTimeoutMs;
    }
    this.options = { ...options, scanIntervalMs, attemptTimeoutMs };
  }

  /**
   * Performs the mandatory startup scan, then begins the periodic and
   * wake-driven loop. A startup error is returned for diagnostics, while the
   * coordinator remains active so transient failures can converge.
   */
  async start(parent?: AbortSignal): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#running = true;
    this.#abort = new AbortController();
    if (parent !== undefined) {
      if (parent.aborted) this.#abort.abort(parent.reason);
      else {
        parent.addEventListener("abort", () => this.#abort?.abort(), {
          once: true,
        });
      }
    }
    registerRecoveryCoordinator(this);
    const [, startupErr] = await this.#scan("startup");
    this.#loopPromise = this.#loop();
    if (startupErr !== undefined) throw startupErr;
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      await this.#waitTickOrWake();
      if (!this.#running) break;
      await this.#scan("periodic");
    }
    unregisterRecoveryCoordinator(this);
  }

  #waitTickOrWake(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.#timer !== null) {
          clearTimeout(this.#timer);
          this.#timer = null;
        }
        this.#wakeResolvers = this.#wakeResolvers.filter((r) => r !== finish);
        resolve();
      };
      this.#wakeResolvers.push(finish);
      this.#timer = setTimeout(
        finish,
        this.options.scanIntervalMs ?? defaultRecoveryScanIntervalMs,
      );
    });
  }

  async #scan(trigger: string): Promise<[RunRecoveryResult, Error?]> {
    return await this.#withScanLock(async () => {
      const signal = this.#abort?.signal;
      let result: RunRecoveryResult = { failed: [], kept: [], skipped: [] };
      try {
        result = await recoverOrphanedRunsWithTrigger(
          signal,
          this.sessionDir,
          trigger,
          this.options.attemptTimeoutMs ?? defaultRecoveryAttemptTimeoutMs,
          this.options.policy ?? null,
          this.options.beforeFail ?? null,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError?.(error);
        return [result, error] as [RunRecoveryResult, Error?];
      }
      this.options.onResult?.(result);
      return [result, undefined] as [RunRecoveryResult, Error?];
    });
  }

  async #withScanLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#scanLock;
    let release!: () => void;
    this.#scanLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Runs the same shared recovery path used by startup and the ticker. */
  async scanNow(): Promise<RunRecoveryResult> {
    const [result] = await this.#scan("periodic");
    return result;
  }

  /**
   * Coalesces notifications; SQLite remains the authority when the next scan
   * runs, so lost or duplicated wake-ups do not affect correctness.
   */
  wake(): void {
    for (const resolve of [...this.#wakeResolvers]) resolve();
  }

  /** Terminates the loop and waits for an in-progress scan to return. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#running = false;
    this.#abort?.abort();
    this.wake();
    await this.#loopPromise;
    await this.#withScanLock(async () => {});
    this.#started = false;
    this.#abort = null;
    this.#loopPromise = null;
  }
}

const recoveryCoordinators = new Map<string, Set<RecoveryCoordinator>>();

function registerRecoveryCoordinator(c: RecoveryCoordinator): void {
  const identity = recoveryDatabaseIdentity(c.sessionDir);
  let entries = recoveryCoordinators.get(identity);
  if (entries === undefined) {
    entries = new Set();
    recoveryCoordinators.set(identity, entries);
  }
  entries.add(c);
}

function unregisterRecoveryCoordinator(c: RecoveryCoordinator): void {
  const identity = recoveryDatabaseIdentity(c.sessionDir);
  const entries = recoveryCoordinators.get(identity);
  if (entries === undefined) return;
  entries.delete(c);
  if (entries.size === 0) recoveryCoordinators.delete(identity);
}

/** Wakes every coordinator registered for a canonical Session database. */
export function wakeRecoveryCoordinators(sessionDir: string): void {
  const identity = recoveryDatabaseIdentity(sessionDir);
  const entries = recoveryCoordinators.get(identity);
  if (entries === undefined) return;
  for (const coordinator of [...entries]) coordinator.wake();
}

function recoveryDatabaseIdentity(sessionDir: string): string {
  return runtimeDatabaseIdentityFor(sessionDir);
}
