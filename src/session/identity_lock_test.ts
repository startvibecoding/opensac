// Tests for src/session/identity_lock.ts (no dedicated Go test file; this pins
// serialization and eviction for one channel identity).

import { assertEquals } from "@opensac/assert";
import { createIdentityLocks } from "./identity_lock.ts";

Deno.test("IdentityLocksSerializesOneIdentity", async () => {
  const locks = createIdentityLocks();
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    const release = await locks.lock("wechat", "id-1");
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise((r) => setTimeout(r, 10));
    active--;
    release();
  };
  await Promise.all([task(), task(), task()]);
  assertEquals(maxActive, 1);
  assertEquals(active, 0);
});

Deno.test("IdentityLocksAllowDistinctIdentitiesConcurrently", async () => {
  const locks = createIdentityLocks();
  let active = 0;
  let maxActive = 0;
  const task = async (id: string) => {
    const release = await locks.lock("wechat", id);
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise((r) => setTimeout(r, 10));
    active--;
    release();
  };
  await Promise.all([task("a"), task("b"), task("c")]);
  assertEquals(maxActive, 3);
});
