// Ported from internal/tools/file_lock.go.
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
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.#release(p);
        };
      }

      const currentOwner = current.owner;
      const acquiredAt = current.acquiredAt;
      await this.#wait(p, signal).catch((err) => {
        if (err instanceof AbortError) {
          throw new Error(
            `wait for file lock ${p} held by ${currentOwner} since ${
              new Date(acquiredAt).toISOString()
            }: ${err.message}`,
          );
        }
        throw err;
      });
    }
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

  #wait(p: string, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const queue = this.#waiters.get(p) ?? [];
      const onWake = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve();
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
export function newFileLockManager(): FileLockManager {
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
