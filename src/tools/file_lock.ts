//
// Coordinates in-process writes to individual files. It deliberately supports
// acquiring only one file at a time. Go's `context.Context` maps to an
// `AbortSignal`; the `sync.Mutex` is dropped (Deno is single-threaded) and
// replaced with a promise-based per-path waiter queue.

interface HeldLock {
  owner: string;
  acquiredAt: number;
}

/** Coordinates in-process writes to individual files. */
export class FileLockManager {
  #held = new Map<string, HeldLock>();
  #waiters = new Map<string, Array<() => void>>();

  /**
   * Waits for exclusive access to `p` and resolves a release function. Waiting
   * is cancellable through `signal`.
   */
  async acquire(
    signal: AbortSignal | undefined,
    p: string,
    ownerIn: string,
  ): Promise<() => void> {
    if (p === "") {
      throw new Error("path is required");
    }
    const owner = ownerIn === "" ? "unknown" : ownerIn;

    for (;;) {
      if (signal?.aborted) {
        throw abortError(signal);
      }

      const current = this.#held.get(p);
      if (current === undefined) {
        this.#held.set(p, { owner, acquiredAt: Date.now() });
        return this.#makeRelease(p);
      }

      const currentOwner = current.owner;
      const acquiredAt = current.acquiredAt;
      let granted = false;
      try {
        granted = await this.#wait(p, signal);
      } catch (err) {
        if (err instanceof AbortError) {
          throw new Error(
            `wait for file lock ${p} held by ${currentOwner} since ${
              new Date(acquiredAt).toISOString()
            }: ${err.message}`,
          );
        }
        throw err;
      }
      if (granted) {
        // The releasing holder handed the lock directly to this waiter (the
        // placeholder entry written by #release is ours). Claim it instead of
        // re-checking the held map, which would wait for a release that can
        // never come and deadlock every queued caller.
        this.#held.set(p, { owner, acquiredAt: Date.now() });
        if (signal?.aborted) {
          this.#release(p);
          throw abortError(signal);
        }
        return this.#makeRelease(p);
      }
    }
  }

  #makeRelease(p: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release(p);
    };
  }

  #release(p: string): void {
    const waiters = this.#waiters.get(p);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift();
      if (waiters.length === 0) this.#waiters.delete(p);
      // Hand the lock directly to the next waiter.
      this.#held.set(p, { owner: "unknown", acquiredAt: Date.now() });
      next?.();
      return;
    }
    this.#held.delete(p);
  }

  /**
   * Waits until the lock is handed to this waiter. Resolves `true` when the
   * releasing holder granted ownership to us; the waiter must then claim the
   * placeholder entry instead of re-checking the held map.
   */
  #wait(p: string, signal: AbortSignal | undefined): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const queue = this.#waiters.get(p) ?? [];
      const onWake = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const idx = queue.indexOf(onWake);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new AbortError("aborted"));
      };
      queue.push(onWake);
      this.#waiters.set(p, queue);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

class AbortError extends Error {}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return new Error(
    reason instanceof Error ? reason.message : "operation aborted",
  );
}

/** Creates an empty in-memory file lock manager. */
export function createFileLockManager(): FileLockManager {
  return new FileLockManager();
}

const defaultManager = new FileLockManager();

/**
 * Returns the process-wide file lock manager used by default registries. It
 * coordinates parent and sub-agent registries in the same process.
 */
export function defaultFileLockManager(): FileLockManager {
  return defaultManager;
}
