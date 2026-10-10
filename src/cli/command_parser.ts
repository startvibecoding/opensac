// Project-owned command-line parser for the OpenSAC CLI.
//
// This replaces the external `@cliffy/command` dependency with a small, Node-free
// implementation of exactly the surface `command.ts` uses: chained
// `.name/.version/.description/.noExit/.option/.arguments/.command/.action`
// builders, per-option `action` callbacks that receive the parsed flags object,
// command-level actions invoked as `(flags, ...positionals)`, `parse(args)`,
// and `getHelp()`/`getCommands()`/`getName()` for the CLI tests.
//
// Behavior follows the Cliffy 1.3 subset in use:
//   * long flags camelCase a dashed name (`--max-tokens` -> `maxTokens`);
//   * value options accept `<name>` and `<n:integer>`/`<n:number>` placeholders
//     and both `--flag value` and `--flag=value`;
//   * `collect: true` accumulates repeats into an array;
//   * a subcommand is dispatched when the first positional matches its name;
//   * `.noExit()` means a usage error is thrown (carrying `exitCode`) rather
//     than exiting the process, matching `main.ts`.

type ParsedFlags = Record<string, unknown>;

/** Result of parsing one option specifier such as `-p, --provider <name>`. */
interface ParsedSpec {
  short?: string;
  long: string;
  key: string;
  takesValue: boolean;
  valueType: "string" | "integer" | "number";
}

type OptionAction = (flags: ParsedFlags) => void | Promise<void>;
type CommandAction = (
  flags: ParsedFlags,
  ...positionals: unknown[]
) => void | Promise<void>;

interface OptionDef {
  spec: string;
  description: string;
  parsed: ParsedSpec;
  collect: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  action?: OptionAction;
}

interface ArgumentsDef {
  name: string;
  variadic: boolean;
}

/** A usage error that carries the process exit code, like `@cliffy`. */
export class CommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

/** Converts a dashed flag name to the camelCase key Cliffy used. */
function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** Parses an option specifier into its flags and value shape. */
function parseSpec(spec: string): ParsedSpec {
  let short: string | undefined;
  let long = "";
  let takesValue = false;
  let valueType: ParsedSpec["valueType"] = "string";
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (part.startsWith("--")) {
      const match = /^--([^\s]+)(?:\s+<([^>]+)>)?$/.exec(part);
      if (match === null) {
        throw new CommandError(`Invalid option spec: ${spec}`);
      }
      long = match[1];
      const placeholder = match[2];
      if (placeholder !== undefined) {
        takesValue = true;
        const type = placeholder.split(":")[1];
        valueType = type === "integer" || type === "number" ? type : "string";
      }
    } else if (part.startsWith("-") && part.length > 1) {
      short = part.slice(1);
    }
  }
  if (long === "") throw new CommandError(`Invalid option spec: ${spec}`);
  return { short, long, key: camelCase(long), takesValue, valueType };
}

/** Parses an arguments specifier such as `[prompt...]`. */
function parseArgumentsSpec(spec: string): ArgumentsDef {
  const optional = spec.startsWith("[") && spec.endsWith("]");
  const inner = optional ? spec.slice(1, -1) : spec;
  const variadic = inner.endsWith("...");
  return { name: variadic ? inner.slice(0, -3) : inner, variadic };
}

/** Parses `getCommands()` capabilities used by the CLI tests. */
export class Command {
  #name = "";
  #registeredName = "";
  #version = "";
  #description = "";
  #options: OptionDef[] = [];
  #arguments?: ArgumentsDef;
  #action?: CommandAction;
  #commands: Command[] = [];

  name(value: string): this {
    this.#name = value;
    return this;
  }

  version(value: string): this {
    this.#version = value;
    return this;
  }

  description(value: string): this {
    this.#description = value;
    return this;
  }

  /** No-op: usage errors are thrown, never `exit()`-ed. */
  noExit(): this {
    return this;
  }

  option(
    spec: string,
    description: string,
    options: {
      action?: OptionAction;
      collect?: boolean;
      default?: unknown;
    } = {},
  ): this {
    this.#options.push({
      spec,
      description,
      parsed: parseSpec(spec),
      collect: options.collect === true,
      hasDefault: Object.prototype.hasOwnProperty.call(options, "default"),
      defaultValue: options.default,
      action: options.action,
    });
    return this;
  }

  arguments(spec: string): this {
    this.#arguments = parseArgumentsSpec(spec);
    return this;
  }

  action(handler: CommandAction): this {
    this.#action = handler;
    return this;
  }

  command(name: string, subcommand: Command): this {
    subcommand.#registeredName = name;
    this.#commands.push(subcommand);
    return this;
  }

  /** The command name: an explicit `.name()` or the registration name. */
  getName(): string {
    return this.#name !== "" ? this.#name : this.#registeredName;
  }

  /** The registered subcommands, in registration order. */
  getCommands(): Command[] {
    return [...this.#commands];
  }

  /** Renders the help text for this command. */
  getHelp(): Promise<string> {
    return Promise.resolve(this.#renderHelp());
  }

  #renderHelp(): string {
    const lines: string[] = [];
    if (this.#description !== "") lines.push(this.#description, "");
    const usage = [this.getName() || "command"];
    if (this.#options.length > 0) usage.push("[options]");
    if (this.#arguments !== undefined) {
      const arg = this.#arguments.variadic
        ? this.#arguments.name + "..."
        : this.#arguments.name;
      usage.push(`[${arg}]`);
    }
    lines.push(`Usage: ${usage.join(" ")}`, "");
    if (this.#options.length > 0) {
      lines.push("Options:");
      for (const option of this.#options) {
        lines.push(`  ${option.spec}  ${option.description}`);
      }
      lines.push("  -h, --help  Show this help");
      if (this.#version !== "") lines.push("  -V, --version  Show version");
      lines.push("");
    }
    if (this.#commands.length > 0) {
      lines.push("Commands:");
      for (const child of this.#commands) {
        lines.push(`  ${child.getName()}  ${child.#description}`);
      }
    }
    return lines.join("\n");
  }

  /** Parses `args` and runs the matching subcommand or this command. */
  async parse(args: string[]): Promise<void> {
    if (this.#commands.length > 0 && args.length > 0) {
      const first = args[0];
      if (typeof first === "string" && !first.startsWith("-")) {
        const child = this.#commands.find((c) => c.getName() === first);
        if (child !== undefined) {
          await child.parse(args.slice(1));
          return;
        }
      }
    }

    const { flags, positionals, help, version } = this.#parseArgs(args);
    if (help) {
      console.log(await this.getHelp());
      return;
    }
    if (version) {
      console.log(`${this.getName()} ${this.#version}`.trim());
      return;
    }
    for (const option of this.#options) {
      if (option.action !== undefined) await option.action(flags);
    }
    if (this.#action !== undefined) await this.#action(flags, ...positionals);
  }

  #parseArgs(args: string[]): {
    flags: ParsedFlags;
    positionals: string[];
    help: boolean;
    version: boolean;
  } {
    const flags: ParsedFlags = {};
    const positionals: string[] = [];
    const byLong = new Map<string, OptionDef>();
    const byShort = new Map<string, OptionDef>();
    for (const option of this.#options) {
      byLong.set(option.parsed.long, option);
      if (option.parsed.short !== undefined) {
        byShort.set(option.parsed.short, option);
      }
      if (option.hasDefault) flags[option.parsed.key] = option.defaultValue;
      if (option.collect) flags[option.parsed.key] = [];
    }

    let help = false;
    let version = false;
    let terminated = false;
    let index = 0;

    const assign = (option: OptionDef, raw: string | true): void => {
      const key = option.parsed.key;
      if (raw === true) {
        flags[key] = true;
        return;
      }
      let value: unknown = raw;
      if (option.parsed.valueType === "integer") {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isNaN(parsed)) {
          throw new CommandError(
            `Option --${option.parsed.long} expects an integer`,
          );
        }
        value = parsed;
      } else if (option.parsed.valueType === "number") {
        const parsed = Number(raw);
        if (Number.isNaN(parsed)) {
          throw new CommandError(
            `Option --${option.parsed.long} expects a number`,
          );
        }
        value = parsed;
      }
      if (option.collect) {
        (flags[key] as unknown[]).push(value);
      } else {
        flags[key] = value;
      }
    };

    while (index < args.length) {
      const token = args[index];
      if (!terminated && token === "--") {
        terminated = true;
        index++;
        continue;
      }
      if (!terminated && (token === "-h" || token === "--help")) {
        help = true;
        index++;
        continue;
      }
      if (!terminated && (token === "-V" || token === "--version")) {
        version = true;
        index++;
        continue;
      }
      if (!terminated && token.startsWith("--")) {
        let name = token.slice(2);
        let inline: string | undefined;
        const eq = name.indexOf("=");
        if (eq >= 0) {
          inline = name.slice(eq + 1);
          name = name.slice(0, eq);
        }
        const option = byLong.get(name);
        if (option === undefined) {
          throw new CommandError(`Unknown option: --${name}`);
        }
        if (option.parsed.takesValue) {
          const value = inline ?? args[++index];
          if (value === undefined) {
            throw new CommandError(`Missing value for --${name}`);
          }
          assign(option, value);
        } else {
          if (inline !== undefined) {
            throw new CommandError(`Option --${name} does not take a value`);
          }
          assign(option, true);
        }
        index++;
        continue;
      }
      if (!terminated && token.startsWith("-") && token.length > 1) {
        let name = token.slice(1);
        let inline: string | undefined;
        const eq = name.indexOf("=");
        if (eq >= 0) {
          inline = name.slice(eq + 1);
          name = name.slice(0, eq);
        }
        const option = byShort.get(name);
        if (option === undefined) {
          throw new CommandError(`Unknown option: -${name}`);
        }
        if (option.parsed.takesValue) {
          const value = inline ?? args[++index];
          if (value === undefined) {
            throw new CommandError(`Missing value for -${name}`);
          }
          assign(option, value);
        } else {
          assign(option, true);
        }
        index++;
        continue;
      }
      positionals.push(token);
      index++;
    }

    return { flags, positionals, help, version };
  }
}
