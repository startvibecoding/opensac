import { assert, assertEquals } from "@std/assert";
import {
  asDueJobClaimer,
  createCronID,
  runningLeaseTimeoutMs,
} from "./cron.ts";
import type { CronJob, CronStore } from "./cron.ts";

Deno.test("running lease timeout is one day", () => {
  assertEquals(runningLeaseTimeoutMs, 24 * 60 * 60 * 1000);
});

Deno.test("createCronID produces unique hex identifiers", () => {
  const first = createCronID();
  const second = createCronID();
  assert(/^cron-[0-9a-f]{32}$/.test(first), `unexpected id ${first}`);
  assert(/^cron-[0-9a-f]{32}$/.test(second), `unexpected id ${second}`);
  assert(first !== second, "identifiers must not repeat");
});

Deno.test("asDueJobClaimer detects an atomic claimer", () => {
  const claimer = { claimDue: (_id: string, _now: Date) => true };
  const store: CronStore & { claimDue: (id: string, now: Date) => boolean } = {
    list: (): CronJob[] => [],
    get: (id: string): CronJob => ({ id }),
    create: (job: CronJob): CronJob => job,
    update: (_job: CronJob): void => {},
    delete: (_id: string): void => {},
    claimDue: claimer.claimDue,
  };

  const detected = asDueJobClaimer(store);
  assertEquals(detected, store, "a store exposing claimDue is a claimer");

  const plain: CronStore = {
    list: () => [],
    get: (id) => ({ id }),
    create: (job) => job,
    update: () => {},
    delete: () => {},
  };
  assertEquals(asDueJobClaimer(plain), null);
  assertEquals(asDueJobClaimer({} as CronStore), null);
});
