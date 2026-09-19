// Shared test helpers for the DAO tests.

import { closeAll, type DB, open } from "../db/mod.ts";
import { ensureCurrentSchema } from "../session/schema.ts";

/** Opens a fresh managed session database with the canonical schema. */
export function openTestDb(name = "sessions"): DB {
  const dir = Deno.makeTempDirSync({ prefix: "mothx-dao-test-" });
  return open(`${dir}/${name}.db`, ensureCurrentSchema);
}

/** Opens a fresh managed database without schema migration. */
export function openBareDb(name = "bare"): DB {
  const dir = Deno.makeTempDirSync({ prefix: "mothx-dao-bare-" });
  return open(`${dir}/${name}.db`);
}

/** Closes every process-owned connection opened by the tests. */
export function closeTestDbs(): void {
  closeAll();
}
