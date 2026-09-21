// Ported from internal/serve/platform_supervisor.go
//
// PlatformSupervisor is the sole owner of live messaging platform instances.
// Callers receive snapshots and never retain the internal map or slice.

import type { Platform } from "../messaging/platform.ts";

export class PlatformSupervisor {
  #platforms = new Map<string, Platform>();

  get(name: string): Platform | undefined {
    return this.#platforms.get(name);
  }

  /** Replace installs platform and returns the previously registered one. */
  replace(name: string, platform: Platform | null): Platform | undefined {
    const old = this.#platforms.get(name);
    if (platform === null) {
      this.#platforms.delete(name);
    } else {
      this.#platforms.set(name, platform);
    }
    return old;
  }

  /**
   * ReplaceIf swaps an instance only when expected is still the owner. It is
   * used by asynchronous candidate startup so a late result cannot overwrite a
   * newer configuration update.
   */
  replaceIf(
    name: string,
    expected: Platform,
    platform: Platform | null,
  ): boolean {
    if (this.#platforms.get(name) !== expected) return false;
    if (platform === null) {
      this.#platforms.delete(name);
    } else {
      this.#platforms.set(name, platform);
    }
    return true;
  }

  /**
   * RemoveIf removes platform only when it is still the registered instance.
   * This prevents a late Start return from deleting a newer replacement.
   */
  removeIf(name: string, platform: Platform): boolean {
    if (platform === undefined || platform === null) return false;
    if (this.#platforms.get(name) !== platform) return false;
    this.#platforms.delete(name);
    return true;
  }

  snapshot(): Platform[] {
    return [...this.#platforms.values()];
  }

  /**
   * StopAll stops every registered platform sequentially, keeps the first
   * failure, and clears the registry even when a stop failed.
   */
  async stopAll(): Promise<void> {
    let firstError: unknown;
    for (const platform of this.snapshot()) {
      try {
        await platform.stop();
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
    this.#platforms = new Map();
    if (firstError !== undefined) throw firstError;
  }
}
