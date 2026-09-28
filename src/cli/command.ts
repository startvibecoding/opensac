// (`createRootCommand`, `createACPCommand`,
// `registerRootFlags`, `registerACPFlags`, and the root action dispatch).
//
// The Cliffy command tree is thin: it maps flags into `CLIOptions` and calls
// the shared runtime/doctor/Core/MCP entry points. The entry modes are ACP
// (`opensac acp`), the shared Core host (`opensac core`), the interactive TUI
// (the root action), and CLI print mode (`-P`); serve, channel, and A2A modes
// are not part of this product.
//
// Cliffy 1.3 invokes an option `action` with a single parsed-options argument
// (`{ camelCaseFlag: value }`), so every action below reads from that object
// rather than treating the value as a positional parameter.

import { Command } from "@cliffy/command";
import {
  type CLIOptions,
  defaultCLIOptions,
  resolveACPTimeout,
} from "./options.ts";
import { runACPCore, type RunOptions } from "../acp/run.ts";
import { isStartupError } from "../acp/support.ts";
import { executeDoctorCommand } from "./doctor.ts";
import {
  type CorePairOutcome,
  type CoreRestartOutcome,
  type CoreStartOutcome,
  type CoreStatusOutcome,
  type CoreStopOutcome,
  launchCoreCommand,
  pairCoreCommand,
  restartCoreCommand,
  runCoreCommand,
  statusCoreCommand,
  stopCoreCommand,
} from "./core.ts";
import { executeKnowledgeMCPCommand } from "./knowledge_mcp.ts";
import {
  defaultStatsOptions,
  executeStatsCommand,
  type StatsCommandOptions,
} from "./stats.ts";
import { executeSpeedtestCommand } from "./speedtest.ts";
import { current as currentVersion } from "../version/version.ts";

type ParsedFlags = Record<string, unknown>;

type OptionAction = (flags: ParsedFlags) => void | Promise<void>;

/** Stores a string flag value into `target[key]` when present. */
function stringSetter(
  target: Record<string, unknown>,
  key: string,
  flagName: string,
): OptionAction {
  return (flags) => {
    const value = flags[flagName];
    if (typeof value === "string") target[key] = value;
  };
}

/** Sets a boolean target when the parsed flag is true. */
function boolSetter(
  target: Record<string, unknown>,
  key: string,
  flagName = key,
): OptionAction {
  return (flags) => {
    if (flags[flagName] === true) target[key] = true;
  };
}

/** Maps resolved CLI flags into the ACP RunOptions contract. */
export function acpRunOptions(
  flags: CLIOptions,
  version: string,
): RunOptions {
  return {
    version,
    provider: flags.provider,
    model: flags.model,
    mode: flags.mode,
    thinking: flags.thinking,
    sandbox: flags.sandbox,
    verbose: flags.verbose,
    debug: flags.debug,
    multiAgent: flags.multiAgent,
    delegate: flags.delegate,
    workflows: flags.workflows,
    webSearch: flags.webSearch,
    browser: flags.browser,
    artifact: flags.artifact,
    standalone: flags.acpStandalone,
    permissionTimeoutMs: resolveACPTimeout(
      flags.acpPermissionTimeout,
      "OPENSAC_ACP_PERMISSION_TIMEOUT",
    ),
    questionTimeoutMs: resolveACPTimeout(
      flags.acpQuestionTimeout,
      "OPENSAC_ACP_QUESTION_TIMEOUT",
    ),
  };
}

/** Adds the shared provider flags to a Cliffy command. */
// deno-lint-ignore no-explicit-any
function sharedProviderFlags(cmd: any, flags: CLIOptions): any {
  return cmd
    .option("-p, --provider <name>", "Provider name", {
      action: stringSetter(
        flags as unknown as Record<string, unknown>,
        "provider",
        "provider",
      ),
    })
    .option("-m, --model <id>", "Model ID", {
      action: stringSetter(
        flags as unknown as Record<string, unknown>,
        "model",
        "model",
      ),
    })
    .option("-M, --mode <mode>", "Mode (plan, agent, yolo, os)", {
      action: stringSetter(
        flags as unknown as Record<string, unknown>,
        "mode",
        "mode",
      ),
    })
    .option(
      "-t, --thinking <level>",
      "Thinking level (off, minimal, low, medium, high, xhigh, max)",
      {
        action: stringSetter(
          flags as unknown as Record<string, unknown>,
          "thinking",
          "thinking",
        ),
      },
    );
}

/** Adds the shared execution capability flags. */
function sharedExecutionFlags(
  // deno-lint-ignore no-explicit-any
  cmd: any,
  flags: CLIOptions,
  webSearchDescription: string,
  // deno-lint-ignore no-explicit-any
): any {
  const target = flags as unknown as Record<string, unknown>;
  return cmd
    .option("--sandbox", "Enable sandbox for tool execution", {
      action: boolSetter(target, "sandbox"),
    })
    .option("-v, --verbose", "Verbose output", {
      action: boolSetter(target, "verbose"),
    })
    .option("--debug", "Enable debug mode", {
      action: boolSetter(target, "debug"),
    })
    .option("--multi-agent", "Enable multi-agent capability", {
      action: boolSetter(target, "multiAgent", "multiAgent"),
    })
    .option("--delegate", "Enable task delegation (multi-agent)", {
      action: boolSetter(target, "delegate"),
    })
    .option("--workflows", "Enable workflow execution", {
      action: boolSetter(target, "workflows"),
    })
    .option("--web-search", webSearchDescription, {
      action: boolSetter(target, "webSearch", "webSearch"),
    })
    .option("--browser", "Enable browser automation tools", {
      action: boolSetter(target, "browser"),
    })
    .option("--artifact", "Enable artifact creation/publishing", {
      action: boolSetter(target, "artifact"),
    });
}

/** Builds the `acp` subcommand. */
export function createACPCommand(version: string): Command {
  const flags = defaultCLIOptions();
  const cmd = sharedProviderFlags(new Command(), flags);
  sharedExecutionFlags(
    cmd,
    flags,
    "Enable configured web search provider for this ACP run",
  );
  cmd.description("Run the Agent Client Protocol stdio server")
    .noExit()
    .option(
      "--permission-timeout <duration>",
      "Approval decision timeout (Go duration, e.g. 30m; default 5m)",
      {
        action: stringSetter(
          flags as unknown as Record<string, unknown>,
          "acpPermissionTimeout",
          "permissionTimeout",
        ),
      },
    )
    .option(
      "--question-timeout <duration>",
      "Question decision timeout (Go duration, e.g. 30m; default 5m)",
      {
        action: stringSetter(
          flags as unknown as Record<string, unknown>,
          "acpQuestionTimeout",
          "questionTimeout",
        ),
      },
    )
    .option(
      "--standalone",
      "Run against an isolated private Core instead of the shared Core",
      {
        action: boolSetter(
          flags as unknown as Record<string, unknown>,
          "acpStandalone",
          "standalone",
        ),
      },
    )
    .action(async () => {
      try {
        await runACPCore(acpRunOptions(flags, version));
      } catch (error) {
        if (isStartupError(error)) Deno.exit(1);
        throw error;
      }
    });
  return cmd;
}

/** Flags forwarded from the `core pair` action to its runner. */
export interface CorePairRunOptions {
  /** Candidate client password verified against the running Core. */
  password?: string;
}

/** Injectable Core lifecycle entry points, mainly for dispatch tests. */
export interface CoreCommandRunners {
  /** Runs the long-lived Core host and returns its lifecycle exit code. */
  start?: (version: string) => Promise<number>;
  /** Stops a running Core and reports the outcome. */
  stop?: (version: string) => Promise<CoreStopOutcome>;
  /** Reports the registered Core state without starting anything. */
  status?: (version: string) => Promise<CoreStatusOutcome>;
  /** Starts (or reuses) the shared Core as a background process. */
  launch?: (version: string) => Promise<CoreStartOutcome>;
  /** Stops the running Core and starts a replacement. */
  restart?: (version: string) => Promise<CoreRestartOutcome>;
  /** Verifies that a client can pair with the running Core. */
  pair?: (
    version: string,
    options: CorePairRunOptions,
  ) => Promise<CorePairOutcome>;
}

/** Builds the shared Core lifecycle subcommand. */
export function createCoreCommand(
  version = currentVersion(),
  runners: CoreCommandRunners = {},
): Command {
  const start = runners.start ??
    ((v: string) => runCoreCommand({ version: v }));
  const stop = runners.stop ?? ((v: string) => stopCoreCommand({ version: v }));
  const status = runners.status ??
    ((v: string) => statusCoreCommand({ version: v }));
  const launch = runners.launch ??
    ((v: string) => launchCoreCommand({ version: v }));
  const restart = runners.restart ??
    ((v: string) => restartCoreCommand({ version: v }));
  const pair = runners.pair ??
    ((v: string, options: CorePairRunOptions) =>
      pairCoreCommand({
        version: v,
        ...(options.password === undefined
          ? {}
          : { password: options.password }),
      }));
  const command = new Command()
    .description(
      "Run the shared OpenSAC Core host in the foreground (manage it with status, start, restart, stop, pair)",
    )
    .noExit();
  // Cliffy 1.3.x resolves subcommands only when the action is registered
  // before the subcommands; registering `stop` first would run this action
  // for `opensac core stop` and show help for bare `opensac core`.
  command.action(async () => {
    const exitCode = await start(version);
    if (exitCode !== 0) Deno.exit(exitCode);
  });
  command.command("status", createCoreStatusCommand(status, version));
  command.command("start", createCoreStartCommand(launch, version));
  command.command("stop", createCoreStopCommand(stop, version));
  command.command("restart", createCoreRestartCommand(restart, version));
  command.command("pair", createCorePairCommand(pair, version));
  return command as unknown as Command;
}

/** Builds the `core status` lifecycle subcommand. */
function createCoreStatusCommand(
  status: (version: string) => Promise<CoreStatusOutcome>,
  version: string,
): Command {
  return new Command()
    .description("Show whether the shared OpenSAC Core is running")
    .noExit()
    .option("--json", "Print one machine-readable JSON status")
    .action((flags: ParsedFlags) =>
      runAndPrint(async () => {
        const outcome = await status(version);
        console.log(formatCoreStatus(outcome, flags.json === true));
        return outcome.running ? 0 : 1;
      }, "opensac core status")
    ) as unknown as Command;
}

/** Builds the `core start` lifecycle subcommand. */
function createCoreStartCommand(
  launch: (version: string) => Promise<CoreStartOutcome>,
  version: string,
): Command {
  return new Command()
    .description("Start the shared OpenSAC Core in the background")
    .noExit()
    .option("--json", "Print one machine-readable JSON result")
    .action((flags: ParsedFlags) =>
      runAndPrint(async () => {
        console.log(
          formatCoreStart(await launch(version), flags.json === true),
        );
        return 0;
      }, "opensac core start")
    ) as unknown as Command;
}

/** Builds the `core restart` lifecycle subcommand. */
function createCoreRestartCommand(
  restart: (version: string) => Promise<CoreRestartOutcome>,
  version: string,
): Command {
  return new Command()
    .description("Restart the shared OpenSAC Core")
    .noExit()
    .option("--json", "Print one machine-readable JSON result")
    .action((flags: ParsedFlags) =>
      runAndPrint(async () => {
        console.log(
          formatCoreRestart(await restart(version), flags.json === true),
        );
        return 0;
      }, "opensac core restart")
    ) as unknown as Command;
}

/** Builds the `core pair` lifecycle subcommand. */
function createCorePairCommand(
  pair: (
    version: string,
    options: CorePairRunOptions,
  ) => Promise<CorePairOutcome>,
  version: string,
): Command {
  return new Command()
    .description(
      "Verify and print the connection details a client needs to pair with the shared OpenSAC Core",
    )
    .noExit()
    .option(
      "--password <password>",
      "Candidate client password verified against the running Core (stored passwords are never printed)",
    )
    .option("--json", "Print one machine-readable JSON result")
    .action((flags: ParsedFlags) =>
      runAndPrint(async () => {
        const password = typeof flags.password === "string"
          ? flags.password
          : undefined;
        const outcome = await pair(version, {
          ...(password === undefined ? {} : { password }),
        });
        console.log(formatCorePair(outcome, flags.json === true));
        return 0;
      }, "opensac core pair")
    ) as unknown as Command;
}

/** Runs one lifecycle action, reporting failures without a stack trace. */
async function runAndPrint(
  operation: () => Promise<number>,
  label: string,
): Promise<void> {
  try {
    const exitCode = await operation();
    if (exitCode !== 0) Deno.exit(exitCode);
  } catch (error) {
    console.error(
      `${label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}

/** Formats `opensac core status` for humans or machines. */
export function formatCoreStatus(
  outcome: CoreStatusOutcome,
  json: boolean,
): string {
  if (json) return JSON.stringify(outcome);
  const lines = outcome.running
    ? [`OpenSAC Core is running at ${outcome.url} (PID ${outcome.pid ?? "?"}).`]
    : ["OpenSAC Core is not running."];
  if (outcome.version !== undefined && outcome.protocolVersion !== undefined) {
    lines.push(
      `  Version:  ${outcome.version} (protocol ${outcome.protocolVersion})`,
    );
  }
  if (outcome.running && outcome.startedAt !== undefined) {
    const uptime = outcome.uptimeMs === undefined
      ? ""
      : ` (up ${formatUptime(outcome.uptimeMs)})`;
    lines.push(
      `  Started:  ${new Date(outcome.startedAt).toISOString()}${uptime}`,
    );
  }
  lines.push(`  Auth:     ${outcome.auth ? "enabled" : "disabled"}`);
  if (outcome.reason !== undefined) {
    lines.push(`  Reason:   ${outcome.reason}`);
  }
  return lines.join("\n");
}

/** Formats `opensac core start` for humans or machines. */
export function formatCoreStart(
  outcome: CoreStartOutcome,
  json: boolean,
): string {
  if (json) return JSON.stringify(outcome);
  const verb = outcome.status === "started"
    ? "OpenSAC Core started"
    : "OpenSAC Core is already running";
  return `${verb} at ${outcome.url} (PID ${outcome.pid}).`;
}

/** Formats `opensac core restart` for humans or machines. */
export function formatCoreRestart(
  outcome: CoreRestartOutcome,
  json: boolean,
): string {
  if (json) return JSON.stringify(outcome);
  return [
    formatCoreStop(outcome.stopped),
    formatCoreStart(outcome.started, false),
  ].join("\n");
}

/** Formats `opensac core pair` for humans or machines. */
export function formatCorePair(
  outcome: CorePairOutcome,
  json: boolean,
): string {
  if (json) return JSON.stringify(outcome);
  const auth = !outcome.auth
    ? "disabled (unauthenticated local clients)"
    : outcome.verified
    ? "enabled (candidate password accepted)"
    : "enabled (configured client password accepted)";
  return [
    `Paired with the running OpenSAC Core at ${outcome.url} (PID ${outcome.pid}).`,
    `  Version:  ${outcome.version} (protocol ${outcome.protocolVersion})`,
    `  Auth:     ${auth}`,
  ].join("\n");
}

/** Formats the shared `core stop` result for humans. */
function formatCoreStop(outcome: CoreStopOutcome): string {
  if (outcome.status === "absent") return "No running OpenSAC Core.";
  if (!outcome.exited) {
    return "OpenSAC Core shutdown requested; it is still exiting.";
  }
  return outcome.signalled
    ? "OpenSAC Core stopped (SIGTERM fallback for an older Core build)."
    : "OpenSAC Core stopped.";
}

/** Renders an uptime like `2d 3h 4m 5s` from a millisecond duration. */
function formatUptime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Builds the `core stop` lifecycle subcommand. */
function createCoreStopCommand(
  stop: (version: string) => Promise<CoreStopOutcome>,
  version = currentVersion(),
): Command {
  return new Command()
    .description("Stop the running shared OpenSAC Core")
    .noExit()
    .action(async () => {
      await runAndPrint(async () => {
        console.log(formatCoreStop(await stop(version)));
        return 0;
      }, "opensac core stop");
    }) as unknown as Command;
}

/** Builds the `doctor` subcommand. */
// deno-lint-ignore no-explicit-any
function createDoctorCommand(version: string): any {
  return new Command()
    .description("Check environment, configuration, and provider status")
    .noExit()
    .option("--json", "Print one machine-readable JSON diagnosis")
    .action((options: Record<string, unknown>) => {
      executeDoctorCommand({
        json: options.json === true,
        version,
      });
    });
}

/** Builds the `knowledge-mcp` parent with its `serve` subcommand. */
// deno-lint-ignore no-explicit-any
function createKnowledgeMCPCommand(): any {
  const knowledgeBases: string[] = [];
  let sessionDir = "";
  const serve = new Command()
    .description("Serve configured knowledge bases over MCP stdio")
    .noExit()
    .option(
      "--knowledge-base <id:string>",
      "Knowledge base ID enabled for this MCP server (repeatable)",
      {
        collect: true,
        action: (flags: ParsedFlags) => {
          const value = flags["knowledgeBase"];
          if (typeof value === "string") knowledgeBases.push(value);
        },
      },
    )
    .option(
      "--session-dir <path>",
      "Session storage directory (defaults to settings.json)",
      {
        action: (flags: ParsedFlags) => {
          const value = flags["sessionDir"];
          if (typeof value === "string") sessionDir = value;
        },
      },
    )
    .action(async () => {
      await executeKnowledgeMCPCommand({ knowledgeBases, sessionDir });
    }) as unknown as Command;
  // deno-lint-ignore no-explicit-any
  return (new Command() as any)
    .description("Expose managed knowledge bases as MCP tools")
    .noExit()
    .command("serve", serve);
}

/** Builds the `stats` subcommand. */
// deno-lint-ignore no-explicit-any
function createStatsCommand(): any {
  const opts: StatsCommandOptions = defaultStatsOptions();
  return new Command()
    .description("Show usage statistics")
    .noExit()
    .option("--addr <addr>", "Listen address for the stats web server", {
      action: (flags: ParsedFlags) => {
        if (typeof flags["addr"] === "string") opts.addr = flags["addr"];
      },
    })
    .option("--db <path>", "Path to sessions.db", {
      action: (flags: ParsedFlags) => {
        if (typeof flags["db"] === "string") opts.dbPath = flags["db"];
      },
    })
    .option("--cli", "Print stats in the terminal instead of the web server", {
      action: (flags: ParsedFlags) => {
        if (flags["cli"] === true) opts.cli = true;
      },
    })
    .option(
      "--no-browser-open",
      "Do not open the stats dashboard in a browser",
      {
        action: (flags: ParsedFlags) => {
          if (flags["noBrowserOpen"] === true) opts.noBrowserOpen = true;
        },
      },
    )
    .action(async () => {
      await executeStatsCommand(opts);
    });
}

/** Builds the `speedtest` subcommand. */
// deno-lint-ignore no-explicit-any
function createSpeedtestCommand(): any {
  const flags = {
    provider: "",
    model: "",
    prompt: "",
    maxTokens: 256,
    timeoutMs: 0,
    concurrency: 1,
    runs: 3,
    thinking: "off",
  };
  const str = (key: string, flag: string): OptionAction => (f: ParsedFlags) => {
    if (typeof f[flag] === "string") {
      (flags as Record<string, unknown>)[key] = f[flag];
    }
  };
  const num = (key: string, flag: string): OptionAction => (f: ParsedFlags) => {
    if (typeof f[flag] === "number") {
      (flags as Record<string, unknown>)[key] = f[flag];
    }
  };
  return new Command()
    .description(
      "Benchmark configured providers and models (streaming tokens/s)",
    )
    .noExit()
    .option("-p, --provider <name>", "Only test models from one provider", {
      action: str("provider", "provider"),
    })
    .option("-m, --model <id>", "Only test one model ID", {
      action: str("model", "model"),
    })
    .option("--prompt <text>", "Text prompt used for every test", {
      action: str("prompt", "prompt"),
    })
    .option("--max-tokens <n:integer>", "Maximum output tokens per request", {
      action: num("maxTokens", "maxTokens"),
    })
    .option(
      "--timeout <duration>",
      "Per-model timeout (Go duration, e.g. 2m)",
      {
        action: (f: ParsedFlags) => {
          const value = f["timeout"];
          if (typeof value === "string") {
            flags.timeoutMs = parseSpeedtestDurationMs(value);
          }
        },
      },
    )
    .option(
      "--concurrency <n:integer>",
      "Number of models tested in parallel",
      { action: num("concurrency", "concurrency") },
    )
    .option("--runs <n:integer>", "Number of runs per model", {
      action: num("runs", "runs"),
    })
    .option(
      "-t, --thinking <level>",
      "Thinking level (off, minimal, low, medium, high, xhigh, max)",
      { action: str("thinking", "thinking") },
    )
    .action(async () => {
      await executeSpeedtestCommand(flags);
    });
}

/** Parses the Go duration subset accepted by --timeout into milliseconds. */
function parseSpeedtestDurationMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (match === null) return 0;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return 0;
  }
}

/** Builds the complete root command tree. */
export function createRootCommand(version = currentVersion()): Command {
  const flags = defaultCLIOptions();
  const root = new Command()
    .name("opensac")
    .version(version)
    .description("AI coding assistant")
    .noExit();

  const target = flags as unknown as Record<string, unknown>;
  // Root execution/session flags (TUI/print actions are #37).
  root
    .option("-c, --continue", "Continue most recent session", {
      action: boolSetter(target, "continueSession", "continue"),
    })
    .option("-r, --resume <id>", "Resume session by ID or path", {
      action: stringSetter(target, "resume", "resume"),
    })
    .option("--session <file>", "Use specific session file or ID", {
      action: stringSetter(target, "session", "session"),
    })
    .option("--expert <bundle>", "Bind an expert bundle to this session", {
      action: stringSetter(target, "expert", "expert"),
    })
    .option("-P, --print", "Print response and exit (non-interactive)", {
      action: boolSetter(target, "print", "print"),
    })
    .option("--json", "Stream print-mode output as NDJSON (requires -P)", {
      action: boolSetter(target, "json"),
    })
    .option("--cron", "Enable scheduled task management (cron tool)", {
      action: boolSetter(target, "cron"),
    });
  sharedProviderFlags(root, flags);
  sharedExecutionFlags(
    root,
    flags,
    "Enable configured web search provider for this run",
  );

  root
    .arguments("[prompt...]")
    .action(async (...args: unknown[]) => {
      // Cliffy passes (options, ...args) to action; the last positional here
      // is the flags object, preceding entries are the prompt words.
      const values = args.filter((a) => typeof a === "string") as string[];
      const prompt = values.join(" ");
      if (flags.print) {
        const { runPrintAction } = await import("./root_print.ts");
        const { loadSettings } = await import("../config/mod.ts");
        const result = await runPrintAction({
          prompt,
          provider: flags.provider,
          model: flags.model,
          mode: flags.mode,
          thinking: flags.thinking,
          workDir: Deno.cwd(),
          json: flags.json,
          multiAgent: flags.multiAgent,
          delegate: flags.delegate,
          workflows: flags.workflows,
        }, { settings: loadSettings() });
        Deno.exit(result.exitCode);
      }
      const { runInteractiveAction } = await import("./root_tui.ts");
      const { loadSettings } = await import("../config/mod.ts");
      try {
        await runInteractiveAction({
          provider: flags.provider,
          model: flags.model,
          mode: flags.mode,
          thinking: flags.thinking,
          workDir: Deno.cwd(),
          multiAgent: flags.multiAgent,
          delegate: flags.delegate,
          workflows: flags.workflows,
        }, loadSettings());
      } catch (error) {
        // Startup errors (provider/config/session) surface as a clean message,
        // not an unhandled rejection.
        console.error(`error: ${(error as Error).message}`);
        Deno.exit(1);
      }
    });

  // deno-lint-ignore no-explicit-any
  const anyRoot = root as any;
  anyRoot
    .command("acp", createACPCommand(version))
    .command("core", createCoreCommand(version))
    .command("doctor", createDoctorCommand(version))
    .command("knowledge-mcp", createKnowledgeMCPCommand())
    .command("stats", createStatsCommand())
    .command("speedtest", createSpeedtestCommand());

  return root;
}
