//
// Serializes operations for one external channel identity. It is shared by
// inbound dispatch and session lifecycle management. Entries are evicted once
// the last holder releases them so the map does not grow without bound in
// long-running processes.
//
// Deviation: `Lock` is async (returns a `Promise` for the release function)
// because the underlying mutex is queue-based; callers must `await` it before
// entering the critical section.

import { LockRegistry } from "./lock_registry.ts";

export class IdentityLocks {
  #registry: LockRegistry;

  constructor() {
    this.#registry = new LockRegistry();
  }

  /**
   * Acquires the mutex for one channel identity and returns a release
   * function. The returned function must be called exactly once.
   */
  async lock(channelType: string, channelID: string): Promise<() => void> {
    const key = channelType + "\x00" + channelID;
    const lock = this.#registry.acquire(key);
    await lock.lock();
    return () => {
      lock.unlock();
      this.#registry.drop(key, lock);
    };
  }
}

/** Creates a new identity-lock registry. */
export function createIdentityLocks(): IdentityLocks {
  return new IdentityLocks();
}
