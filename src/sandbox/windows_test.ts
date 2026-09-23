// (the Go package ships no Windows test,
// so these cover the ported behaviour directly).

import { assert, assertEquals } from "@std/assert";
import { Level, newWinSandbox } from "./mod.ts";

Deno.test("win sandbox reports unavailable", () => {
  const sb = newWinSandbox(Deno.cwd(), Level.Standard);
  assertEquals(sb.name(), "windows-sandbox");
  assertEquals(sb.level(), Level.Standard);
  assert(!sb.isAvailable());
  assert(sb.availabilityError().message.includes("env-only isolation"));
});

Deno.test("win sandbox wrapCommand shell selection", () => {
  const sb = newWinSandbox(Deno.cwd(), Level.Standard);

  const cmd = sb.wrapCommand(undefined, "", "echo hello", {});
  assertEquals(cmd.program, "cmd.exe");
  assertEquals(cmd.args, ["/c", "echo hello"]);

  const busybox = sb.wrapCommand(undefined, "busybox.exe", "echo hello", {});
  assertEquals(busybox.args, ["sh", "-c", "echo hello"]);
});

Deno.test("win sandbox buildEnv filters and overlays", () => {
  const sb = newWinSandbox(Deno.cwd(), Level.Standard);
  Deno.env.set("OPENSAC_SANDBOX_LEAK", "1");
  try {
    const env = sb.buildEnv({});
    // Non-allow-listed parent variables are dropped.
    assert(!env.includes("OPENSAC_SANDBOX_LEAK=1"));
    assert(env.some((e) => e.startsWith("PATH=")) || env.length === 0);

    const withOpts = sb.buildEnv({ envVars: { FOO: "bar" } });
    assert(withOpts.includes("FOO=bar"));
  } finally {
    Deno.env.delete("OPENSAC_SANDBOX_LEAK");
  }
});
