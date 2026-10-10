// (shared CLI flag/options surface).
//
// This module owns the options carried by the root command and shared
// subcommands. It deliberately stays free of CLI-parser types so focused tests can
// validate flag/env mapping without a full parse. Deviations: Go's
// `time.Duration` strings map to milliseconds via `parseGoDuration`; Go's
// pflag booleans map to plain `boolean` options; and the ACP timeout flags
// keep the same flag-wins-over-env resolution as the Go command.

/** Options used to start an ACP stdio process (acp.RunOptions). */
import { runtime } from "../platform/runtime.ts";
export interface CLIOptions {
  // root / shared execution
  continueSession: boolean;
  resume: string;
  session: string;
  expert: string;
  print: boolean;
  json: boolean;
  sandbox: boolean;
  verbose: boolean;
  debug: boolean;
  multiAgent: boolean;
  delegate: boolean;
  workflows: boolean;
  webSearch: boolean;
  browser: boolean;
  artifact: boolean;
  // shared provider
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  // scheduled task management
  cron: boolean;
  // ACP decision deadlines (raw Go duration strings)
  acpPermissionTimeout: string;
  acpQuestionTimeout: string;
  // ACP isolated private Core
  acpStandalone: boolean;
}

export function defaultCLIOptions(): CLIOptions {
  return {
    continueSession: false,
    resume: "",
    session: "",
    expert: "",
    print: false,
    json: false,
    sandbox: false,
    verbose: false,
    debug: false,
    multiAgent: false,
    delegate: false,
    workflows: false,
    webSearch: false,
    browser: false,
    artifact: false,
    provider: "",
    model: "",
    mode: "",
    thinking: "",
    cron: false,
    acpPermissionTimeout: "",
    acpQuestionTimeout: "",
    acpStandalone: false,
  };
}

/**
 * Parses the subset of Go duration strings the CLI timeout flags accept and
 * returns milliseconds. Invalid, zero, or negative values return 0 so the
 * caller falls back to documented defaults, matching `resolveACPTimeout`.
 */
export function parseGoDurationMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(value.trim());
  if (match === null) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  switch (match[2]) {
    case "ns":
      return amount / 1e6;
    case "us":
    case "µs":
      return amount / 1e3;
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return 0;
  }
}

/**
 * Resolves one ACP decision timeout. The explicit flag wins over the
 * environment variable; invalid or non-positive values are ignored.
 */
export function resolveACPTimeout(
  flagValue: string,
  envKey: string,
  env: Record<string, string | undefined> = runtime.env.toObject(),
): number {
  for (const candidate of [flagValue, env[envKey] ?? ""]) {
    const ms = parseGoDurationMs(candidate);
    if (ms > 0) return ms;
  }
  return 0;
}
