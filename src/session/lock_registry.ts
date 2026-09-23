//
// Process-local map of per-key mutexes whose entries are evicted once no
// caller references them anymore. Long-running processes otherwise
// accumulate one mutex per historical session or identity key forever.
//
// Deviation: Go's `sync.Mutex` is a blocking OS-level primitive; here
// `CountedMutex` is an async queue-based mutex so a single-threaded Deno
// process can still hold a key across `await` points. Mutual exclusion across
// an eviction boundary still holds because a key's entry is only removed after
// every holder unlocked it and dropped its reference.

/** A mutex tracked by reference count so its registry entry can be removed
 * after the last holder releases it. */
export class CountedMutex {
  refs = 0;
  #locked = false;
  #waiters: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  /**
   * Non-blocking acquire. Reports whether the mutex was taken immediately,
   * mirroring Go's `sync.Mutex.TryLock`. Never queues a waiter.
   */
  tryLock(): boolean {
    if (this.#locked) return false;
    this.#locked = true;
    return true;
  }

  unlock(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      this.#locked = false;
    }
  }
}

export class LockRegistry {
  #locks = new Map<string, CountedMutex>();

  /**
   * Returns the mutex for `key` with its reference count incremented. Every
   * acquire must be paired with exactly one `drop`, whether or not the caller
   * managed to lock the mutex.
   */
  acquire(key: string): CountedMutex {
    let lock = this.#locks.get(key);
    if (lock === undefined) {
      lock = new CountedMutex();
      this.#locks.set(key, lock);
    }
    lock.refs++;
    return lock;
  }

  /**
   * Decrements the reference count for `key` and forgets the entry once no
   * reference remains. Call it only after releasing the mutex.
   */
  drop(key: string, lock: CountedMutex): void {
    lock.refs--;
    if (lock.refs <= 0) {
      this.#locks.delete(key);
    }
  }

  /** Reports whether `key` currently has a registry entry. */
  has(key: string): boolean {
    return this.#locks.has(key);
  }
}

/** Creates an empty lock registry. */
export function newLockRegistry(): LockRegistry {
  return new LockRegistry();
}
