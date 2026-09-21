// Ported from internal/serve/session_lifecycle.go
//
// SessionLifecycleService is the single coordinator for session persistence,
// API pool state and dispatcher cache state. Database helpers remain in the
// session package; this service owns the cross-runtime lock and ordering.
//
// Deviations from Go: `context.Context` maps to an optional `AbortSignal`
// (`ctx.Err()` maps to `signal.throwIfAborted()`); the `(value, error)` returns
// throw typed errors; `lifecycleConflict` becomes the `LifecycleConflict` Error
// subclass; the sessions pool is a narrow interface whose `deleteActiveSession`
// signals failure by throwing; `sync.RWMutex` collapses because Deno is
// single-threaded; the async `lockSessionData`/`IdentityLocks.lock` make every
// lifecycle method async.

import {
  type Binding,
  bindSession,
  findBinding,
  findBindingBySessionId,
  transferBinding,
  unbindSession,
} from "../session/bindings.ts";
import {
  type IdentityLocks,
  newIdentityLocks,
} from "../session/identity_lock.ts";
import { type Manager, rotateBoundSession } from "../session/manager.ts";
import {
  acquireMutation,
  acquireMutations,
  lockSessionData,
  RuntimeSessionNotFoundError,
} from "../session/runtime_lock.ts";
import { acquireSessionMutation } from "../agentruntime/execution_admission.ts";
import {
  ErrSessionRunBusy,
  RotateForceGraceMS,
} from "./channels/dispatcher.ts";
import type { Dispatcher } from "./channels/dispatcher.ts";
import { sessionKey } from "./channels/session_paths.ts";

/** lifecycleConflict marks an expected, operator-visible lifecycle refusal. */
export class LifecycleConflict extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The API pool half of the lifecycle contract: the Go `interface {
 * DeleteActiveSession(string) (bool, error) }` structural type. Errors throw.
 */
export interface SessionPool {
  /** May be async for durable deletion paths (Go's Server method is sync). */
  deleteActiveSession(sessionId: string): boolean | Promise<boolean>;
}

/** Event publisher receiving lifecycle change notifications. */
export type LifecycleEventPublisher = (
  eventType: string,
  data: unknown,
) => void;

function checkSignal(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export class SessionLifecycleService {
  sessions: SessionPool | null;
  dispatcher: Dispatcher | null;
  sessionDir: string;
  identityMux: IdentityLocks;
  publish: LifecycleEventPublisher | null = null;

  constructor(
    sessions: SessionPool | null,
    dispatcher: Dispatcher | null,
    sessionDir: string,
    identityMux: IdentityLocks | null,
  ) {
    this.sessions = sessions;
    this.dispatcher = dispatcher;
    this.sessionDir = sessionDir;
    this.identityMux = identityMux ?? newIdentityLocks();
  }

  setEventPublisher(publish: LifecycleEventPublisher | null): void {
    this.publish = publish;
  }

  #publishEvent(eventType: string, data: unknown): void {
    this.publish?.(eventType, data);
  }

  async delete(
    signal: AbortSignal | undefined,
    sessionId: string,
  ): Promise<boolean> {
    if (this.sessions === null || sessionId === "") {
      throw new Error("session lifecycle service unavailable");
    }
    checkSignal(signal);
    // Test doubles and legacy in-memory adapters may not have a configured
    // session root. Their manager owns deletion and there is no durable binding
    // or cross-process lease to inspect.
    if (this.sessionDir === "") {
      return await this.sessions.deleteActiveSession(sessionId);
    }
    let guard;
    try {
      guard = acquireMutation(this.sessionDir, sessionId);
    } catch (err) {
      if (err instanceof RuntimeSessionNotFoundError) {
        return await this.sessions.deleteActiveSession(sessionId);
      }
      throw new LifecycleConflict(
        "session_running",
        "session has an active run",
      );
    }
    try {
      const releaseData = await lockSessionData(this.sessionDir, sessionId);
      try {
        const binding = findBindingBySessionId(this.sessionDir, sessionId);
        if (binding !== null) {
          throw new LifecycleConflict(
            "session_bound",
            "unbind the channel identity before deleting this session",
          );
        }
        const deleted = await this.sessions.deleteActiveSession(sessionId);
        if (!deleted) return false;
        this.dispatcher?.refreshSessionTools(sessionId);
        this.#publishEvent("session_deleted", { sessionId });
        return true;
      } finally {
        releaseData();
      }
    } finally {
      guard.release();
    }
  }

  async bind(
    signal: AbortSignal | undefined,
    sessionId: string,
    channelType: string,
    channelId: string,
  ): Promise<void> {
    checkSignal(signal);
    let guard;
    try {
      guard = acquireMutation(this.sessionDir, sessionId);
    } catch {
      throw new LifecycleConflict(
        "session_running",
        "target session has an active run",
      );
    }
    try {
      const releaseIdentity = await this.identityMux.lock(
        channelType,
        channelId,
      );
      try {
        bindSession(this.sessionDir, sessionId, channelType, channelId);
        this.dispatcher?.refreshBinding(channelType, channelId);
        this.#publishEvent("binding_changed", {
          sessionId,
          channelType,
          channelId,
          toSessionId: sessionId,
        });
      } finally {
        releaseIdentity();
      }
    } finally {
      guard.release();
    }
  }

  async unbind(
    signal: AbortSignal | undefined,
    sessionId: string,
  ): Promise<Binding | null> {
    checkSignal(signal);
    let guard;
    try {
      guard = acquireMutation(this.sessionDir, sessionId);
    } catch {
      throw new LifecycleConflict(
        "session_running",
        "session has an active run",
      );
    }
    try {
      let binding = findBindingBySessionId(this.sessionDir, sessionId);
      if (binding !== null) {
        const releaseIdentity = await this.identityMux.lock(
          binding.channelType,
          binding.channelId,
        );
        try {
          binding = findBindingBySessionId(this.sessionDir, sessionId);
          if (binding === null) {
            throw new LifecycleConflict(
              "binding_changed",
              "session binding changed; retry",
            );
          }
          unbindSession(this.sessionDir, sessionId);
        } finally {
          releaseIdentity();
        }
      }
      if (binding !== null) {
        this.dispatcher?.refreshBinding(
          binding.channelType,
          binding.channelId,
        );
      }
      if (binding !== null) {
        this.#publishEvent("binding_changed", {
          sessionId: binding.sessionId,
          channelType: binding.channelType,
          channelId: binding.channelId,
          fromSessionId: binding.sessionId,
          toSessionId: "",
        });
      }
      return binding;
    } finally {
      guard.release();
    }
  }

  async transfer(
    signal: AbortSignal | undefined,
    channelType: string,
    channelId: string,
    fromSessionId: string,
    toSessionId: string,
  ): Promise<void> {
    checkSignal(signal);
    let group;
    try {
      group = acquireMutations(this.sessionDir, [fromSessionId, toSessionId]);
    } catch {
      throw new LifecycleConflict(
        "session_running",
        "source and target sessions must be idle",
      );
    }
    try {
      const releaseIdentity = await this.identityMux.lock(
        channelType,
        channelId,
      );
      try {
        transferBinding(
          this.sessionDir,
          channelType,
          channelId,
          fromSessionId,
          toSessionId,
        );
        this.dispatcher?.refreshBinding(channelType, channelId);
        this.#publishEvent("binding_changed", {
          channelType,
          channelId,
          fromSessionId,
          toSessionId,
        });
      } finally {
        releaseIdentity();
      }
    } finally {
      group.release();
    }
  }

  /**
   * Rotate creates a new bound session for a channel identity. It is used by
   * the channel /new and /clear commands so those commands share the same
   * runtime/identity lock ordering as HTTP binding mutations. A forced rotate
   * requests cancellation of the active run and waits a bounded grace period;
   * it never rotates without a durable mutation lease.
   */
  async rotate(
    signal: AbortSignal | undefined,
    platform: string,
    userId: string,
    force: boolean,
  ): Promise<void> {
    checkSignal(signal);
    if (platform !== "wechat" && platform !== "feishu") {
      this.dispatcher?.removeSession(sessionKey(platform, userId));
      return;
    }
    // Read the binding before taking the runtime lock, then re-read it while
    // holding the identity lock. A concurrent transfer may have changed the
    // session in between; retry with the new session instead of operating on an
    // unlocked target.
    for (;;) {
      checkSignal(signal);
      const binding = findBinding(this.sessionDir, platform, userId);
      if (binding === null) return;
      let releaseRuntime: (() => void) | null = null;
      try {
        if (this.dispatcher !== null) {
          releaseRuntime = await this.dispatcher.acquireRuntimeForRotate(
            signal,
            this.sessionDir,
            binding.sessionId,
            force,
          );
        } else {
          // Go: context.WithTimeout(ctx, channels.RotateForceGrace) when force.
          const leaseSignal = force && signal !== undefined
            ? AbortSignal.any([
              signal,
              AbortSignal.timeout(RotateForceGraceMS),
            ])
            : force
            ? AbortSignal.timeout(RotateForceGraceMS)
            : signal;
          const guard = await acquireSessionMutation(
            leaseSignal,
            this.sessionDir,
            binding.sessionId,
            { wait: force, pollIntervalMs: 200 },
          );
          releaseRuntime = () => guard.release();
        }
      } catch {
        throw new LifecycleConflict(
          "session_running",
          ErrSessionRunBusy.message,
        );
      }
      const releaseIdentity = await this.identityMux.lock(platform, userId);
      try {
        const current = findBinding(this.sessionDir, platform, userId);
        if (current === null) return;
        if (current.sessionId !== binding.sessionId) {
          releaseRuntime?.();
          releaseRuntime = null;
          continue;
        }
        const workDir = this.dispatcher !== null
          ? this.dispatcher.platformWorkDir(platform)
          : "";
        const rotated = rotateBoundSession(
          workDir,
          this.sessionDir,
          platform,
          userId,
          current.sessionId,
        );
        this.dispatcher?.refreshBinding(platform, userId);
        this.#publishEvent("binding_changed", {
          channelType: platform,
          channelId: userId,
          fromSessionId: current.sessionId,
          toSessionId: rotated.getHeader()?.id ?? "",
        });
        return;
      } finally {
        releaseIdentity();
        releaseRuntime?.();
      }
    }
  }
}

/** Re-exported for the run.go slice and tests. */
export type { Manager };
