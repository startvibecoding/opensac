// Focused tests for the ported cmd/mothx surface: ACP timeout resolution,
// flag→RunOptions mapping, doctor projection, and the Cliffy command tree
// dispatch. Subprocess/stdio behavior is covered by the ACP process test
// (run_process_test.ts) which spawns `deno run src/main.ts acp`.

import { assert, assertEquals } from "@std/assert";
import {
  defaultCLIOptions,
  parseGoDurationMs,
  resolveACPTimeout,
} from "./options.ts";
import { acpRunOptions, newRootCommand } from "./command.ts";
import { executeDoctorCommand } from "./doctor.ts";

Deno.test("parseGoDurationMs covers Go duration units", () => {
  assertEquals(parseGoDurationMs("5m"), 300_000);
  assertEquals(parseGoDurationMs("30s"), 30_000);
  assertEquals(parseGoDurationMs("1h"), 3_600_000);
  assertEquals(parseGoDurationMs("500ms"), 500);
  assertEquals(parseGoDurationMs("1500000000ns"), 1_500);
  assertEquals(parseGoDurationMs("2500us"), 2.5);
  assertEquals(parseGoDurationMs("2500µs"), 2.5);
  assertEquals(parseGoDurationMs("1.5m"), 90_000);
});

Deno.test("parseGoDurationMs rejects invalid and non-positive values", () => {
  for (const value of ["", "abc", "5", "-1m", "0s", "5x"]) {
    assertEquals(parseGoDurationMs(value), 0, value);
  }
});

Deno.test("resolveACPTimeout flag wins over environment", () => {
  const env: Record<string, string | undefined> = {
    MOTHX_ACP_PERMISSION_TIMEOUT: "10m",
    MOTHX_ACP_QUESTION_TIMEOUT: "2m",
  };
  assertEquals(
    resolveACPTimeout("", "MOTHX_ACP_PERMISSION_TIMEOUT", env),
    600_000,
  );
  assertEquals(
    resolveACPTimeout("30s", "MOTHX_ACP_PERMISSION_TIMEOUT", env),
    30_000,
  );
  // Invalid flag falls through to env.
  assertEquals(
    resolveACPTimeout("bogus", "MOTHX_ACP_QUESTION_TIMEOUT", env),
    120_000,
  );
  // Both empty -> 0 (documented defaults).
  assertEquals(resolveACPTimeout("", "MISSING", env), 0);
});

Deno.test("acpRunOptions maps CLI flags and resolved timeouts", () => {
  const flags = defaultCLIOptions();
  flags.provider = "deepseek";
  flags.model = "v4";
  flags.mode = "yolo";
  flags.thinking = "high";
  flags.sandbox = true;
  flags.multiAgent = true;
  flags.workflows = true;
  flags.browser = true;
  flags.acpPermissionTimeout = "7m";
  const opts = acpRunOptions(flags, "9.9.9");
  assertEquals(opts.provider, "deepseek");
  assertEquals(opts.model, "v4");
  assertEquals(opts.mode, "yolo");
  assertEquals(opts.thinking, "high");
  assertEquals(opts.sandbox, true);
  assertEquals(opts.multiAgent, true);
  assertEquals(opts.workflows, true);
  assertEquals(opts.browser, true);
  assertEquals(opts.version, "9.9.9");
  assertEquals(opts.permissionTimeoutMs, 420_000);
  // Question timeout reads env when the flag is empty.
  const previous = Deno.env.get("MOTHX_ACP_QUESTION_TIMEOUT");
  Deno.env.set("MOTHX_ACP_QUESTION_TIMEOUT", "3m");
  try {
    assertEquals(
      acpRunOptions(defaultCLIOptions(), "").questionTimeoutMs,
      180_000,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("MOTHX_ACP_QUESTION_TIMEOUT");
    else Deno.env.set("MOTHX_ACP_QUESTION_TIMEOUT", previous);
  }
});

Deno.test("doctor command projects JSON and human output", () => {
  const configDir = Deno.makeTempDirSync();
  const previous = Deno.env.get("MOTHX_DIR");
  Deno.env.set("MOTHX_DIR", configDir);
  try {
    const lines: string[] = [];
    const result = executeDoctorCommand({
      json: true,
      version: "test",
      write: (line: string) => void lines.push(line),
    });
    assertEquals(result.exitCode, 0);
    assertEquals(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert(Array.isArray(parsed.checks));

    const human: string[] = [];
    executeDoctorCommand({
      json: false,
      version: "test",
      write: (line: string) => void human.push(line),
    });
    assert(human.includes("  MothX Doctor"));
    assert(human.some((line: string) => line.includes("Result:")));
  } finally {
    if (previous === undefined) Deno.env.delete("MOTHX_DIR");
    else Deno.env.set("MOTHX_DIR", previous);
  }
});

Deno.test("root command registers acp doctor and knowledge-mcp", async () => {
  const root = newRootCommand("test-version");
  const help = await root.getHelp();
  const names: string[] = ["acp", "doctor", "knowledge-mcp", "serve", "stats"];
  for (const name of names) {
    assert(help.includes(name), `help must list ${name}`);
  }
});

Deno.test("every Go subcommand is wired (no pending placeholders)", async () => {
  const root = newRootCommand("test-version");
  const help = await root.getHelp();
  for (
    const name of [
      "acp",
      "doctor",
      "knowledge-mcp",
      "serve",
      "a2a",
      "stats",
      "speedtest",
    ]
  ) {
    assert(help.includes(name), `help must list ${name}`);
  }
  // Go has no `mothx cron` subcommand (cron is the root --cron flag), so the
  // Commands section must not list one.
  const commandsSection = help.slice(help.indexOf("Commands:"));
  assertEquals(commandsSection.includes("cron"), false);
});

Deno.test("knowledge-mcp serve requires at least one knowledge base", async () => {
  const root = newRootCommand("test-version");
  let threw = false;
  try {
    // deno-lint-ignore no-explicit-any
    await (root as any).parse(["knowledge-mcp", "serve"]);
  } catch (error) {
    threw = true;
    const message = (error as Error).message;
    assert(
      message.includes("at least one --knowledge-base"),
      message,
    );
  }
  assert(threw);
});

Deno.test("root -P print action is wired (no longer a placeholder)", async () => {
  const root = newRootCommand("test-version");
  const help = await root.getHelp();
  assert(help.includes("prompt..."), help);
  assert(help.includes("--print"), help);
});
