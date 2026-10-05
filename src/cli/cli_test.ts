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
import {
  acpRunOptions,
  type CoreCommandRunners,
  createACPCommand,
  createCoreCommand,
  createRootCommand,
  formatCoreList,
  formatCorePair,
  formatCoreRestart,
  formatCoreStart,
  formatCoreStatus,
} from "./command.ts";
import {
  type CorePairOutcome,
  type CoreStartOutcome,
  type CoreStatusOutcome,
} from "./core.ts";
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
    OPENSAC_ACP_PERMISSION_TIMEOUT: "10m",
    OPENSAC_ACP_QUESTION_TIMEOUT: "2m",
  };
  assertEquals(
    resolveACPTimeout("", "OPENSAC_ACP_PERMISSION_TIMEOUT", env),
    600_000,
  );
  assertEquals(
    resolveACPTimeout("30s", "OPENSAC_ACP_PERMISSION_TIMEOUT", env),
    30_000,
  );
  // Invalid flag falls through to env.
  assertEquals(
    resolveACPTimeout("bogus", "OPENSAC_ACP_QUESTION_TIMEOUT", env),
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
  flags.acpStandalone = true;
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
  assertEquals(opts.standalone, true);
  assertEquals(opts.version, "9.9.9");
  assertEquals(opts.permissionTimeoutMs, 420_000);
  // Question timeout reads env when the flag is empty.
  const previous = Deno.env.get("OPENSAC_ACP_QUESTION_TIMEOUT");
  Deno.env.set("OPENSAC_ACP_QUESTION_TIMEOUT", "3m");
  try {
    assertEquals(
      acpRunOptions(defaultCLIOptions(), "").questionTimeoutMs,
      180_000,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_ACP_QUESTION_TIMEOUT");
    else Deno.env.set("OPENSAC_ACP_QUESTION_TIMEOUT", previous);
  }
});

Deno.test("acp exposes --standalone and core exposes the stop lifecycle command", async () => {
  const acpHelp = await createACPCommand("test-version").getHelp();
  assert(acpHelp.includes("--standalone"), "acp help must list --standalone");
  const coreHelp = await createCoreCommand("test-version").getHelp();
  assert(coreHelp.includes("stop"), "core help must list stop");
});

Deno.test("core dispatches bare start and the stop subcommand to their own runners", async () => {
  const calls: string[] = [];
  const runners = {
    start: (version: string) => {
      calls.push(`start:${version}`);
      return Promise.resolve(0);
    },
    stop: (version: string) => {
      calls.push(`stop:${version}`);
      return Promise.resolve({
        status: "absent" as const,
        exited: true,
        signalled: false,
      });
    },
  };
  // Regression: Cliffy resolves subcommands only when the parent action is
  // registered before the subcommands. With the wrong order, `core stop`
  // started a Core and bare `core` printed help.
  await createCoreCommand("test-version", runners).parse([]);
  assertEquals(calls, ["start:test-version"]);
  calls.length = 0;
  await createCoreCommand("test-version", runners).parse(["stop"]);
  assertEquals(calls, ["stop:test-version"]);
});

Deno.test("doctor command projects JSON and human output", () => {
  const configDir = Deno.makeTempDirSync();
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", configDir);
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
    assert(human.includes("  OpenSAC Doctor"));
    assert(human.some((line: string) => line.includes("Result:")));
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
  }
});

Deno.test("root command registers acp doctor and knowledge-mcp", async () => {
  const root = createRootCommand("test-version");
  const help = await root.getHelp();
  const names: string[] = [
    "acp",
    "core",
    "doctor",
    "knowledge-mcp",
    "stats",
  ];
  for (const name of names) {
    assert(help.includes(name), `help must list ${name}`);
  }
});

Deno.test("every supported subcommand is wired (no pending placeholders)", async () => {
  const root = createRootCommand("test-version");
  const help = await root.getHelp();
  for (
    const name of [
      "acp",
      "core",
      "doctor",
      "knowledge-mcp",
      "stats",
      "speedtest",
    ]
  ) {
    assert(help.includes(name), `help must list ${name}`);
  }
  // The removed serve/A2A modes must not come back as subcommands. Read the
  // command tree instead of parsing colored help text (the `acp` description
  // contains the substring "server").
  // deno-lint-ignore no-explicit-any
  const listed = (root as any).getCommands().map((cmd: any) => cmd.getName());
  for (const removed of ["serve", "a2a", "cron"]) {
    assertEquals(
      listed.includes(removed),
      false,
      `help must not list ${removed}`,
    );
  }
});

Deno.test("knowledge-mcp serve requires at least one knowledge base", async () => {
  const root = createRootCommand("test-version");
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
  const root = createRootCommand("test-version");
  const help = await root.getHelp();
  assert(help.includes("prompt..."), help);
  assert(help.includes("--print"), help);
});

Deno.test("core exposes status, start, stop, restart, pair, and list subcommands", () => {
  // deno-lint-ignore no-explicit-any
  const command = createCoreCommand("test-version") as any;
  const names = command
    .getCommands()
    .map((sub: { getName(): string }) => sub.getName());
  assertEquals([...names].sort(), [
    "list",
    "pair",
    "restart",
    "start",
    "status",
    "stop",
  ]);
});

Deno.test("core dispatches status, start, restart, pair, and list to their own runners", async () => {
  const startOutcome: CoreStartOutcome = {
    status: "started",
    url: "http://127.0.0.1:1",
    pid: 7,
    version: "test-version",
    protocolVersion: 1,
  };
  const calls: string[] = [];
  const runners: CoreCommandRunners = {
    start: (version) => {
      calls.push(`foreground:${version}`);
      return Promise.resolve(0);
    },
    status: (version) => {
      calls.push(`status:${version}`);
      return Promise.resolve({
        status: "ready",
        running: true,
        auth: false,
        url: "http://127.0.0.1:1",
        pid: 7,
        version: "test-version",
        protocolVersion: 1,
        startedAt: 0,
        uptimeMs: 0,
      });
    },
    launch: (version) => {
      calls.push(`start:${version}`);
      return Promise.resolve(startOutcome);
    },
    restart: (version) => {
      calls.push(`restart:${version}`);
      return Promise.resolve({
        stopped: { status: "stopped", exited: true, signalled: false },
        started: startOutcome,
      });
    },
    pair: (version, options) => {
      calls.push(`pair:${version}:${options.password ?? ""}`);
      return Promise.resolve({
        url: "http://127.0.0.1:1",
        pid: 7,
        version: "test-version",
        protocolVersion: 1,
        auth: false,
        verified: false,
      });
    },
    list: (version) => {
      calls.push(`list:${version}`);
      return Promise.resolve({
        url: "http://127.0.0.1:1",
        pid: 7,
        clients: [{
          clientId: "client-1",
          connectedAt: 1_700_000_000_000,
          subscriptions: [{ sessionId: "s1", runId: "r1" }],
        }],
      });
    },
  };

  await createCoreCommand("test-version", runners).parse(["status"]);
  assertEquals(calls, ["status:test-version"]);
  calls.length = 0;
  await createCoreCommand("test-version", runners).parse(["start"]);
  assertEquals(calls, ["start:test-version"]);
  calls.length = 0;
  await createCoreCommand("test-version", runners).parse(["restart"]);
  assertEquals(calls, ["restart:test-version"]);
  calls.length = 0;
  await createCoreCommand("test-version", runners).parse([
    "pair",
    "--password",
    "pw",
  ]);
  assertEquals(calls, ["pair:test-version:pw"]);
  calls.length = 0;
  await createCoreCommand("test-version", runners).parse(["list"]);
  assertEquals(calls, ["list:test-version"]);
  calls.length = 0;
  await createCoreCommand("test-version", runners).parse([]);
  assertEquals(calls, ["foreground:test-version"]);
});

Deno.test("core lifecycle formatters project human and JSON output", () => {
  const statusOutcome: CoreStatusOutcome = {
    status: "ready",
    running: true,
    auth: false,
    url: "http://127.0.0.1:1",
    pid: 7,
    version: "test-version",
    protocolVersion: 1,
    startedAt: 1_700_000_000_000,
    uptimeMs: 65_000,
  };
  assertEquals(
    formatCoreStatus(statusOutcome, true),
    JSON.stringify(statusOutcome),
  );
  const human = formatCoreStatus(statusOutcome, false);
  assert(
    human.includes("OpenSAC Core is running at http://127.0.0.1:1 (PID 7)."),
    human,
  );
  assert(human.includes("(up 1m 5s)"), human);
  assert(human.includes("Auth:     disabled"), human);

  const absent = formatCoreStatus(
    {
      status: "missing",
      running: false,
      auth: false,
      reason: "no registered Core",
    },
    false,
  );
  assert(absent.includes("OpenSAC Core is not running."), absent);
  assert(absent.includes("Reason:   no registered Core"), absent);

  const startOutcome: CoreStartOutcome = {
    status: "started",
    url: "http://127.0.0.1:1",
    pid: 7,
    version: "test-version",
    protocolVersion: 1,
  };
  assertEquals(
    formatCoreStart(startOutcome, false),
    "OpenSAC Core started at http://127.0.0.1:1 (PID 7).",
  );
  assertEquals(
    formatCoreStart({ ...startOutcome, status: "running" }, false),
    "OpenSAC Core is already running at http://127.0.0.1:1 (PID 7).",
  );

  assertEquals(
    formatCoreRestart(
      {
        stopped: { status: "stopped", exited: true, signalled: false },
        started: startOutcome,
      },
      false,
    ),
    "OpenSAC Core stopped.\nOpenSAC Core started at http://127.0.0.1:1 (PID 7).",
  );

  const listOutcome = {
    url: "http://127.0.0.1:1",
    pid: 7,
    clients: [{
      clientId: "client-1",
      remoteAddress: "127.0.0.1",
      connectedAt: 1_700_000_000_000,
      subscriptions: [{ sessionId: "s1", runId: "r1" }],
    }],
  };
  assertEquals(formatCoreList(listOutcome, true), JSON.stringify(listOutcome));
  const listed = formatCoreList(listOutcome, false);
  assert(
    listed.includes(
      "OpenSAC Core at http://127.0.0.1:1 (PID 7) has 1 connected client(s):",
    ),
    listed,
  );
  assert(listed.includes("client-1 from 127.0.0.1"), listed);
  assert(listed.includes("s1/r1"), listed);

  const pairOutcome: CorePairOutcome = {
    url: "http://127.0.0.1:1",
    pid: 7,
    version: "test-version",
    protocolVersion: 1,
    auth: false,
    verified: false,
  };
  const paired = formatCorePair(pairOutcome, false);
  assert(
    paired.includes(
      "Paired with the running OpenSAC Core at http://127.0.0.1:1 (PID 7).",
    ),
    paired,
  );
  assert(paired.includes("unauthenticated local clients"), paired);
  assert(
    formatCorePair({ ...pairOutcome, auth: true, verified: true }, false)
      .includes("candidate password accepted"),
  );
});
