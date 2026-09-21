// Translated from internal/serve/session_lifecycle_test.go

import { assert, assertEquals, assertRejects } from "@std/assert";
import { findBinding } from "../session/bindings.ts";
import { createBound, newManager, openByIDExact } from "../session/manager.ts";
import { lockRuntime } from "../session/runtime_lock.ts";
import { newIdentityLocks } from "../session/identity_lock.ts";
import { Dispatcher } from "../serve/channels/dispatcher.ts";
import {
  LifecycleConflict,
  SessionLifecycleService,
  type SessionPool,
} from "./session_lifecycle.ts";

class LifecycleTestSessions implements SessionPool {
  deletedID = "";
  deleted = false;
  err: Error | null = null;

  deleteActiveSession(id: string): boolean {
    this.deletedID = id;
    if (this.err !== null) throw this.err;
    return this.deleted;
  }
}

Deno.test("session lifecycle delete rejects bound session", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const mgr = createBound(
      await Deno.makeTempDir(),
      sessionDir,
      "wechat",
      "identity-1",
    );
    const fake = new LifecycleTestSessions();
    fake.deleted = true;
    const service = new SessionLifecycleService(fake, null, sessionDir, null);
    const err = await service.delete(undefined, mgr.getHeader()!.id).then(
      () => null,
      (e: unknown) => e,
    );
    assert(err instanceof LifecycleConflict, `error = ${err}`);
    assertEquals((err as LifecycleConflict).code, "session_bound");
    assertEquals(fake.deletedID, "");
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("session lifecycle delete rejects runtime locked session", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const mgr = newManager(await Deno.makeTempDir(), sessionDir);
    mgr.initWithID("locked-session");
    const release = await lockRuntime(sessionDir, "locked-session");
    const fake = new LifecycleTestSessions();
    fake.deleted = true;
    const service = new SessionLifecycleService(fake, null, sessionDir, null);
    const err = await service.delete(undefined, "locked-session").then(
      () => null,
      (e: unknown) => e,
    );
    assert(err instanceof LifecycleConflict, `error = ${err}`);
    assertEquals((err as LifecycleConflict).code, "session_running");
    assertEquals(fake.deletedID, "");
    release();
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("session lifecycle delete preserves state when pool delete fails", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const mgr = newManager(await Deno.makeTempDir(), sessionDir);
    mgr.initWithID("delete-failure");
    const fake = new LifecycleTestSessions();
    fake.err = new Error("pool delete failed");
    const service = new SessionLifecycleService(fake, null, sessionDir, null);
    await assertRejects(
      () => service.delete(undefined, "delete-failure"),
      Error,
      "pool delete failed",
    );
    // The session must survive the pool failure.
    openByIDExact(sessionDir, "delete-failure");
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("session lifecycle rotate uses shared binding boundary", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const old = createBound(
      await Deno.makeTempDir(),
      sessionDir,
      "wechat",
      "rotate-identity",
    );
    const dispatcher = new Dispatcher({});
    const service = new SessionLifecycleService(
      null,
      dispatcher,
      sessionDir,
      newIdentityLocks(),
    );
    let eventType = "";
    let eventData: Record<string, unknown> | null = null;
    service.setEventPublisher((kind, data) => {
      eventType = kind;
      eventData = data as Record<string, unknown>;
    });
    await service.rotate(undefined, "wechat", "rotate-identity", false);
    const binding = findBinding(sessionDir, "wechat", "rotate-identity");
    assert(binding !== null, "binding disappeared");
    assert(
      binding.sessionId !== old.getHeader()!.id,
      "rotate must create a new session",
    );
    assertEquals(eventType, "binding_changed");
    assertEquals(eventData!["fromSessionId"], old.getHeader()!.id);
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("session lifecycle rotate force past busy run", async () => {
  const sessionDir = await Deno.makeTempDir();
  try {
    const old = createBound(
      await Deno.makeTempDir(),
      sessionDir,
      "wechat",
      "force-rotate",
    );
    const dispatcher = new Dispatcher({});
    const service = new SessionLifecycleService(
      null,
      dispatcher,
      sessionDir,
      newIdentityLocks(),
    );

    const release = await lockRuntime(sessionDir, old.getHeader()!.id);

    // Without force, a busy runtime lock is a conflict.
    const err = await service.rotate(undefined, "wechat", "force-rotate", false)
      .then(() => null, (e: unknown) => e);
    assert(err instanceof LifecycleConflict, `error = ${err}`);
    assertEquals((err as LifecycleConflict).code, "session_running");
    const binding = findBinding(sessionDir, "wechat", "force-rotate");
    assert(binding !== null);
    assertEquals(
      binding.sessionId,
      old.getHeader()!.id,
      "non-forced rotate must not touch a busy binding",
    );

    // With force, the rotation waits for the lock and then proceeds.
    setTimeout(() => release(), 300);
    await service.rotate(undefined, "wechat", "force-rotate", true);
    const after = findBinding(sessionDir, "wechat", "force-rotate");
    assert(after !== null);
    assert(
      after.sessionId !== old.getHeader()!.id,
      "forced rotate did not rebind the identity",
    );
  } finally {
    await Deno.remove(sessionDir, { recursive: true }).catch(() => {});
  }
});
