//
// Tracks workflow runs that can be canceled in this process. `sync.RWMutex` is
// dropped (Node is single-threaded); `context.CancelFunc` maps to `() => void`.

/**
 * Tracks workflow runs that can be canceled in this process. `register` throws
 * when either the run id or cancel function is missing, mirroring the Go error
 * returns.
 */
export class ActiveRegistry {
  #cancels = new Map<string, () => void>();

  /** Registers an active run's cancel function. Throws on empty inputs. */
  register(id: string, cancel: () => void): void {
    id = id.trim();
    if (id === "") {
      throw new Error("workflow run id is required");
    }
    if (cancel === null || cancel === undefined) {
      throw new Error("workflow cancel function is required");
    }
    this.#cancels.set(id, cancel);
  }

  /** Cancels the run if active. Returns whether a run was canceled. */
  cancel(id: string): boolean {
    id = id.trim();
    if (id === "") return false;
    const cancel = this.#cancels.get(id);
    if (cancel === undefined) return false;
    cancel();
    return true;
  }

  /** Removes a run from the active set. */
  unregister(id: string): void {
    id = id.trim();
    if (id === "") return;
    this.#cancels.delete(id);
  }

  /** Reports whether the run is active. */
  isActive(id: string): boolean {
    id = id.trim();
    if (id === "") return false;
    return this.#cancels.has(id);
  }
}

const defaultActiveRegistryInstance = new ActiveRegistry();

/** Creates a fresh active registry. */
export function createActiveRegistry(): ActiveRegistry {
  return new ActiveRegistry();
}

/** Returns the process-wide default active registry. */
export function defaultActiveRegistry(): ActiveRegistry {
  return defaultActiveRegistryInstance;
}
