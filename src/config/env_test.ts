// (the Go package ships no env test, so these
// cover the ported behaviour directly).

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  applyEnvPatch,
  clearEnv,
  type EnvConfig,
  envList,
  globalEnvPath,
  loadEnv,
  saveEnv,
  setEnv,
  unsetEnv,
  validateEnvName,
} from "./mod.ts";

function withConfigDir(fn: (tmp: string) => void): void {
  const tmp = Deno.makeTempDirSync({ prefix: "env-" });
  const prevDir = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", path.join(tmp, "config"));
  try {
    fn(tmp);
  } finally {
    if (prevDir === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", prevDir);
  }
}

Deno.test("validateEnvName", () => {
  validateEnvName("GOOD_NAME");
  assertThrows(() => validateEnvName(""));
  assertThrows(() => validateEnvName("A=B"));
  assertThrows(() => validateEnvName("A\nB"));
});

Deno.test("env set/unset/list round trip", () => {
  withConfigDir(() => {
    const c: EnvConfig = { vars: {} };
    setEnv(c, "FOO", "bar");
    assertEquals(envList(c), { FOO: "bar" });
    const loaded = loadEnv();
    assertEquals(loaded.vars, { FOO: "bar" });

    setEnv(loaded, "EMPTY", "");
    assertEquals(loadEnv().vars.EMPTY, "");

    unsetEnv(loaded, "FOO");
    assertEquals(loadEnv().vars, { EMPTY: "" });

    clearEnv(c);
    assertEquals(loadEnv().vars, {});
  });
});

Deno.test("env applyPatch validates and applies atomically", () => {
  withConfigDir(() => {
    const c: EnvConfig = { vars: {} };
    applyEnvPatch(c, { A: "1", B: "2" }, ["OLD"]);
    assertEquals(loadEnv().vars, { A: "1", B: "2" });

    assertThrows(() => applyEnvPatch(c, { X: "1" }, ["X"]));
    assertThrows(() => applyEnvPatch(c, { BAD: "1", "=bad": "2" }, []));
  });
});

Deno.test("env save orders keys", () => {
  withConfigDir(() => {
    const c: EnvConfig = { vars: {} };
    saveEnv(c);
    applyEnvPatch(c, { Z: "1", A: "2" }, []);
    const text = Deno.readTextFileSync(globalEnvPath());
    assert(text.indexOf('"A"') < text.indexOf('"Z"'));
    assertEquals(Deno.statSync(globalEnvPath()).mode! & 0o777, 0o600);
  });
});
