// (the Go package ships no env test, so these
// cover the ported behaviour directly).

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
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
import { test } from "#testing";

function withConfigDir(fn: (tmp: string) => void): void {
  const tmp = runtime.makeTempDirSync({ prefix: "env-" });
  const prevDir = runtime.env.get("OPENSAC_DIR");
  runtime.env.set("OPENSAC_DIR", path.join(tmp, "config"));
  try {
    fn(tmp);
  } finally {
    if (prevDir === undefined) runtime.env.delete("OPENSAC_DIR");
    else runtime.env.set("OPENSAC_DIR", prevDir);
  }
}

test("validateEnvName", () => {
  validateEnvName("GOOD_NAME");
  assertThrows(() => validateEnvName(""));
  assertThrows(() => validateEnvName("A=B"));
  assertThrows(() => validateEnvName("A\nB"));
});

test("env set/unset/list round trip", () => {
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

test("env applyPatch validates and applies atomically", () => {
  withConfigDir(() => {
    const c: EnvConfig = { vars: {} };
    applyEnvPatch(c, { A: "1", B: "2" }, ["OLD"]);
    assertEquals(loadEnv().vars, { A: "1", B: "2" });

    assertThrows(() => applyEnvPatch(c, { X: "1" }, ["X"]));
    assertThrows(() => applyEnvPatch(c, { BAD: "1", "=bad": "2" }, []));
  });
});

test("env save orders keys", () => {
  withConfigDir(() => {
    const c: EnvConfig = { vars: {} };
    saveEnv(c);
    applyEnvPatch(c, { Z: "1", A: "2" }, []);
    const text = runtime.readTextFileSync(globalEnvPath());
    assert(text.indexOf('"A"') < text.indexOf('"Z"'));
    assertEquals(runtime.statSync(globalEnvPath()).mode! & 0o777, 0o600);
  });
});
