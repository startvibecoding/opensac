//
// Package doctor owns the machine-readable installation and runtime checks.
// CLI and ACP deliberately render this same result instead of maintaining
// separate diagnostic implementations.
//
// Deliberate deviations from Go: `runtime.Version()` (the Go toolchain version)
// has no TypeScript equivalent, so the "Deno version" check reports
// `Deno.version.deno`; `exec.LookPath` maps to `platform.lookPathSync`;
// `os.Stat`/`os.IsNotExist` map to `Deno.statSync` plus `Deno.errors.NotFound`;
// `error` results map to thrown `Error`s at the few failure boundaries; and the
// config helpers are the free functions ported in `src/config`.

import path from "node:path";
import {
  configDir,
  defaultProviderConfig,
  getGlobalSkillsDir,
  getProviderConfig,
  getSessionDir,
  globalMCPPath,
  globalSettingsPath,
  loadSettingsFor,
  projectPathFor,
  type ProviderConfig,
  resolveKey,
  resolveProviderConfig,
  type Settings,
} from "../config/mod.ts";
import * as mcp from "../mcp/mod.ts";
import * as platform from "../platform/platform.ts";
import * as providerfactory from "../provider/factory/mod.ts";
import * as skills from "../skills/mod.ts";
import * as appversion from "../version/version.ts";

export const STATUS_OK = "ok";
export const STATUS_WARN = "warn";
export const STATUS_ERROR = "error";
export const STATUS_SKIP = "skip";

export interface Check {
  id: string;
  status: string;
  title: string;
  detail?: string;
  fix?: string;
}

export interface Response {
  ok: boolean;
  version: string;
  summary: string;
  checks: Check[];
}

/** Performs all doctor checks for cwd. An empty cwd means the process cwd. */
export function run(cwd: string, version: string): Response {
  if (version.trim() === "") version = appversion.current();
  if (cwd === "") cwd = Deno.cwd();
  try {
    cwd = path.resolve(cwd);
  } catch {
    // keep the original path when it cannot be resolved
  }

  const checks: Check[] = [];
  checks.push({
    id: "cli",
    status: STATUS_OK,
    title: "opensac CLI",
    detail: version,
  });
  checks.push(...checkEnvironment(cwd));

  let settings: Settings | undefined;
  let settingsErr: Error | undefined;
  try {
    settings = loadSettingsFor(cwd);
  } catch (err) {
    settingsErr = err as Error;
  }

  checks.push(checkSettingsFiles(cwd, settingsErr));
  checks.push(...checkConfigFiles(cwd, settingsErr));
  if (settingsErr !== undefined) {
    checks.push({
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: "settings unavailable",
      fix: "Fix settings.json syntax",
    });
  } else {
    checks.push(...checkProvider(settings!));
    checks.push(...checkConfiguredProviders(settings!));
    checks.push(...checkEnvironmentOverrides());
  }
  // The shell check needs settings, so it runs after they load. It reports the
  // shell that will actually execute commands, not just the platform default.
  checks.push(...checkShell(settings));
  checks.push(...checkSandbox(settings));
  checks.push(...checkMCP(cwd));
  checks.push(checkSessions(settings));
  checks.push(...checkSkills(cwd, settings));
  checks.push(...checkContext(cwd, settings));

  const result: Response = { ok: true, version, summary: "", checks };
  for (const check of checks) {
    if (check.status === STATUS_ERROR) {
      result.ok = false;
      if (result.summary === "") result.summary = summaryFor(check);
    }
  }
  if (result.summary === "") {
    for (const check of checks) {
      if (check.status === STATUS_WARN) {
        result.summary = summaryFor(check);
        break;
      }
    }
  }
  if (result.summary === "") result.summary = "All checks passed";
  return result;
}

function checkEnvironment(cwd: string): Check[] {
  const checks: Check[] = [
    {
      id: "environment.os",
      status: STATUS_OK,
      title: "OS / Arch",
      detail: `${platform.os()}/${platform.arch()}`,
    },
    {
      id: "environment.deno",
      status: STATUS_OK,
      title: "Deno version",
      detail: Deno.version.deno,
    },
  ];
  const home = platform.homeDir();
  if (statExists(home) === undefined) {
    checks.push({
      id: "environment.home",
      status: STATUS_ERROR,
      title: "Home directory",
      detail: home + " (not accessible)",
    });
  } else {
    checks.push({
      id: "environment.home",
      status: STATUS_OK,
      title: "Home directory",
      detail: home,
    });
  }
  return [...checks, checkCWD(cwd)];
}

function checkCWD(cwd: string): Check {
  const stat = statResult(cwd);
  if (stat.info === undefined || !stat.info.isDirectory) {
    let detail = "working directory is unavailable";
    if (stat.error !== undefined) detail = stat.error.message;
    return {
      id: "cwd",
      status: STATUS_ERROR,
      title: "Working directory",
      detail,
      fix: "Start opensac from an existing directory",
    };
  }
  return {
    id: "cwd",
    status: STATUS_OK,
    title: "Working directory",
    detail: cwd,
  };
}

function checkSettingsFiles(
  cwd: string,
  settingsErr: Error | undefined,
): Check {
  const p = globalSettingsPath();
  const stat = statResult(p);
  if (stat.info !== undefined) {
    if (stat.info.isDirectory) {
      return {
        id: "config",
        status: STATUS_ERROR,
        title: "settings",
        detail: p + " is a directory",
        fix: "Replace settings.json with a file",
      };
    }
    if (settingsErr !== undefined) {
      return {
        id: "config",
        status: STATUS_ERROR,
        title: "settings",
        detail: p + ": " + settingsErr.message,
        fix: "Fix settings.json syntax",
      };
    }
    return { id: "config", status: STATUS_OK, title: "settings", detail: p };
  } else if (!stat.notExist && stat.error !== undefined) {
    return {
      id: "config",
      status: STATUS_ERROR,
      title: "settings",
      detail: stat.error.message,
    };
  }
  const projectPath = projectPathFor(cwd, "settings.json");
  if (statExists(projectPath) !== undefined && settingsErr === undefined) {
    return {
      id: "config",
      status: STATUS_OK,
      title: "settings",
      detail: projectPath,
    };
  }
  if (settingsErr !== undefined) {
    return {
      id: "config",
      status: STATUS_ERROR,
      title: "settings",
      detail: settingsErr.message,
      fix: "Create or fix settings.json",
    };
  }
  return {
    id: "config",
    status: STATUS_SKIP,
    title: "settings",
    detail: p + " (not found; defaults in use)",
  };
}

function checkConfigFiles(
  cwd: string,
  settingsErr: Error | undefined,
): Check[] {
  const files: Array<{ id: string; title: string; path: string }> = [
    {
      id: "config.project",
      title: "Project settings",
      path: projectPathFor(cwd, "settings.json"),
    },
    { id: "mcp.global", title: "MCP config (global)", path: globalMCPPath() },
    {
      id: "mcp.project",
      title: "MCP config (project)",
      path: projectPathFor(cwd, "mcp.json"),
    },
  ];
  const checks: Check[] = [];
  for (const file of files) {
    const stat = statResult(file.path);
    if (stat.notExist) {
      checks.push({
        id: file.id,
        status: STATUS_SKIP,
        title: file.title,
        detail: file.path + " (not found)",
      });
      continue;
    }
    if (stat.error !== undefined) {
      checks.push({
        id: file.id,
        status: STATUS_ERROR,
        title: file.title,
        detail: stat.error.message,
      });
      continue;
    }
    if (stat.info!.isDirectory) {
      checks.push({
        id: file.id,
        status: STATUS_ERROR,
        title: file.title,
        detail: file.path + " is a directory",
      });
      continue;
    }
    checks.push({
      id: file.id,
      status: STATUS_OK,
      title: file.title,
      detail: file.path,
    });
  }
  const parseStatus = settingsErr !== undefined ? STATUS_ERROR : STATUS_OK;
  const parseDetail = settingsErr !== undefined
    ? "failed to parse settings"
    : "loaded successfully";
  checks.push({
    id: "config.parse",
    status: parseStatus,
    title: "Settings parse",
    detail: parseDetail,
  });
  return checks;
}

function checkProvider(settings: Settings): Check[] {
  return validateProvider(
    settings,
    settings.defaultProvider ?? "",
    settings.defaultModel ?? "",
  );
}

/**
 * Applies the same provider/model checks to an explicit ACP selection as the
 * default-provider doctor check.
 */
export function validateProvider(
  settings: Settings | undefined,
  providerName: string,
  modelID: string,
): Check[] {
  if (settings === undefined) {
    return [{
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: "settings unavailable",
      fix: "Fix settings.json syntax",
    }];
  }
  const name = providerName.trim();
  const model = modelID.trim();
  if (name === "") {
    return [{
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: "no default provider configured",
      fix: "Set defaultProvider in settings.json",
    }];
  }
  if (
    getProviderConfig(settings, name) === undefined &&
    defaultProviderConfig(name) === undefined
  ) {
    return [{
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: name + ": unknown provider",
      fix: "Add the provider to settings.json",
    }];
  }
  const pc = resolveProviderConfig(name, settings);
  if (pc === undefined || (pc.baseUrl ?? "").trim() === "") {
    return [{
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: name + ": missing base URL",
      fix: "Set " + name + ".baseUrl",
    }];
  }
  const apiKey = resolveKey(settings, name).trim();
  if (apiKey === "" || apiKey.startsWith("${") || apiKey.startsWith("!")) {
    return [{
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: name + ": missing API key",
      fix: "Set " + name + ".apiKey or " + apiKeyEnv(name, pc),
    }];
  }

  try {
    providerfactory.create(settings, name, model, {
      requireModel: true,
    });
  } catch (err) {
    const message = ((err as Error).message ?? "").toLowerCase();
    if (message.includes("model") && message.includes("available")) {
      let detail = name + ": no usable model";
      if (model !== "") {
        detail = name + "/" + model + ": model is not available";
      }
      return [
        {
          id: "provider.default",
          status: STATUS_OK,
          title: "Default provider",
          detail: name,
        },
        {
          id: "model.default",
          status: STATUS_ERROR,
          title: "Default model",
          detail,
          fix: "Choose a model listed for this provider",
        },
      ];
    }
    return [{
      id: "provider.default",
      status: STATUS_ERROR,
      title: "Default provider",
      detail: name + ": configuration is unusable",
      fix: "Check the provider base URL and configuration",
    }];
  }

  const checks: Check[] = [{
    id: "provider.default",
    status: STATUS_OK,
    title: "Default provider",
    detail: name,
  }];
  if (model !== "") {
    checks.push({
      id: "model.default",
      status: STATUS_OK,
      title: "Default model",
      detail: model,
    });
  }
  return checks;
}

function checkConfiguredProviders(settings: Settings): Check[] {
  const names = Object.keys(settings.providers ?? {});
  names.sort();
  const checks: Check[] = [];
  let configured = 0;
  for (const name of names) {
    if (name.toLowerCase() === (settings.defaultProvider ?? "").toLowerCase()) {
      continue;
    }
    const pc = settings.providers?.[name];
    if (pc === undefined) continue;
    const key = resolveKey(settings, name).trim();
    if (key === "" || key.startsWith("${") || key.startsWith("!")) continue;
    configured++;
    checks.push({
      id: "provider." + stableID(name),
      status: STATUS_OK,
      title: "Provider",
      detail: name,
    });
  }
  if (configured === 0 && names.length === 0) {
    checks.push({
      id: "providers",
      status: STATUS_WARN,
      title: "Providers",
      detail: "no providers configured",
    });
  }
  return checks;
}

function checkEnvironmentOverrides(): Check[] {
  const overrides: Array<{ env: string; name: string }> = [
    { env: "VIBECODING_PROVIDER", name: "defaultProvider" },
    { env: "VIBECODING_MODEL", name: "defaultModel" },
    { env: "VIBECODING_MODE", name: "defaultMode" },
    { env: "VIBECODING_THINKING", name: "defaultThinkingLevel" },
  ];
  const checks: Check[] = [];
  for (const override of overrides) {
    if ((Deno.env.get(override.env) ?? "") !== "") {
      checks.push({
        id: "environment." + stableID(override.env),
        status: STATUS_WARN,
        title: "Environment override",
        detail: override.env + " overrides " + override.name,
      });
    }
  }
  return checks;
}

function checkSandbox(settings: Settings | undefined): Check[] {
  const bwrap = platform.lookPathSync("bwrap");
  if (bwrap !== null && bwrap !== "") {
    return appendSandboxConfig([{
      id: "sandbox",
      status: STATUS_OK,
      title: "Sandbox",
      detail: bwrap,
    }], settings);
  }
  return appendSandboxConfig([{
    id: "sandbox",
    status: STATUS_WARN,
    title: "Sandbox",
    detail: "bwrap not found",
  }], settings);
}

function appendSandboxConfig(
  checks: Check[],
  settings: Settings | undefined,
): Check[] {
  if (settings === undefined) return checks;
  const enabled = settings.sandbox?.enabled ?? false;
  const level = valueOr(settings.sandbox?.level ?? "", "none");
  return [...checks, {
    id: "sandbox.config",
    status: STATUS_OK,
    title: "Sandbox config",
    detail: `enabled=${enabled}, level=${level}`,
  }];
}

function checkShell(settings: Settings | undefined): Check[] {
  const configured = settings?.shellPath ?? "";
  const shell = platform.resolveBashShell(configured);
  // A configured shell that cannot be resolved is silently ignored by the
  // resolver, so surface it here instead of letting every command quietly run
  // in a different shell than the user asked for.
  if (configured !== "" && configured !== shell) {
    return [{
      id: "environment.shell",
      status: STATUS_WARN,
      title: "Shell",
      detail: `configured ${configured} (not found)`,
      fix: "Set settings.shellPath to an existing shell, or clear it",
    }];
  }
  if (statExists(shell) === undefined) {
    return [{
      id: "environment.shell",
      status: STATUS_WARN,
      title: "Shell",
      detail: shell + " (not found)",
    }];
  }
  return [{
    id: "environment.shell",
    status: STATUS_OK,
    title: "Shell",
    detail: shell,
  }];
}

function checkMCP(cwd: string): Check[] {
  let servers: Array<{ name?: string }>;
  try {
    servers = mcp.loadConfiguredServers(cwd);
  } catch {
    return [{
      id: "mcp",
      status: STATUS_ERROR,
      title: "MCP",
      detail: "MCP configuration could not be loaded",
      fix: "Fix mcp.json syntax",
    }];
  }
  if (servers.length === 0) {
    return [{
      id: "mcp",
      status: STATUS_SKIP,
      title: "MCP",
      detail: "none configured",
    }];
  }
  const checks: Check[] = [];
  for (const server of servers) {
    checks.push({
      id: "mcp." + stableID(server.name ?? ""),
      status: STATUS_OK,
      title: "MCP server",
      detail: server.name ?? "",
    });
  }
  return checks;
}

function checkSessions(settings: Settings | undefined): Check {
  if (settings === undefined) {
    return {
      id: "sessions",
      status: STATUS_SKIP,
      title: "Sessions",
      detail: "settings unavailable",
    };
  }
  const p = getSessionDir(settings);
  const stat = statResult(p);
  if (stat.notExist) {
    return {
      id: "sessions",
      status: STATUS_SKIP,
      title: "Sessions",
      detail: p + " (not created yet)",
    };
  }
  if (stat.error !== undefined) {
    return {
      id: "sessions",
      status: STATUS_ERROR,
      title: "Sessions",
      detail: stat.error.message,
    };
  }
  if (!stat.info!.isDirectory) {
    return {
      id: "sessions",
      status: STATUS_ERROR,
      title: "Sessions",
      detail: p + " is not a directory",
    };
  }
  return { id: "sessions", status: STATUS_OK, title: "Sessions", detail: p };
}

function checkSkills(cwd: string, settings: Settings | undefined): Check[] {
  if (settings === undefined) {
    return [{
      id: "skills",
      status: STATUS_SKIP,
      title: "Skills",
      detail: "settings unavailable",
    }];
  }
  const p = getGlobalSkillsDir(settings);
  const globalStat = statResult(p);
  if (globalStat.info !== undefined) {
    return [{ id: "skills", status: STATUS_OK, title: "Skills", detail: p }];
  }
  if (!globalStat.notExist && globalStat.error !== undefined) {
    return [{
      id: "skills",
      status: STATUS_ERROR,
      title: "Skills",
      detail: globalStat.error.message,
    }];
  }
  for (const projectPath of skills.projectSkillDirs(cwd)) {
    if (statExists(projectPath) !== undefined) {
      return [{
        id: "skills",
        status: STATUS_OK,
        title: "Skills",
        detail: projectPath,
      }];
    }
  }
  return [{
    id: "skills",
    status: STATUS_SKIP,
    title: "Skills",
    detail: p + " (not created)",
  }];
}

function checkContext(cwd: string, settings: Settings | undefined): Check[] {
  const checks: Check[] = [];
  if (settings !== undefined) {
    const enabled = settings.contextFiles?.enabled ?? false;
    checks.push({
      id: "context.files",
      status: enabled ? STATUS_OK : STATUS_SKIP,
      title: "Context files",
      detail: `enabled=${enabled}`,
    });
  }
  const known = [
    "AGENTS.md",
    "CLAUDE.md",
    "CURSOR.md",
    ".cursorrules",
    "CONVENTIONS.md",
  ];
  for (const name of known) {
    const info = statExists(path.join(cwd, name));
    if (info !== undefined && !info.isDirectory) {
      checks.push({
        id: "context.project",
        status: STATUS_OK,
        title: "Project context",
        detail: name,
      });
      break;
    }
  }
  if (
    checks.length === 0 || checks[checks.length - 1].id !== "context.project"
  ) {
    checks.push({
      id: "context.project",
      status: STATUS_SKIP,
      title: "Project context",
      detail: "none found",
    });
  }
  const globalFiles = ["AGENTS.md", "CLAUDE.md"];
  for (const name of globalFiles) {
    if (statExists(path.join(configDir(), name)) !== undefined) {
      checks.push({
        id: "context.global",
        status: STATUS_OK,
        title: "Global context",
        detail: name,
      });
      return checks;
    }
  }
  checks.push({
    id: "context.global",
    status: STATUS_SKIP,
    title: "Global context",
    detail: "none found",
  });
  return checks;
}

function apiKeyEnv(name: string, pc: ProviderConfig | undefined): string {
  if (pc !== undefined) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(
      (pc.apiKey ?? "").trim(),
    );
    if (match !== null) return match[1];
  }
  let out = "";
  for (const r of name.toUpperCase()) {
    if ((r >= "A" && r <= "Z") || (r >= "0" && r <= "9")) out += r;
    else out += "_";
  }
  return out.replace(/^_+|_+$/g, "") + "_API_KEY";
}

function summaryFor(check: Check): string {
  const detail = check.detail ?? "";
  if (check.id === "provider.default" && detail.includes("missing API key")) {
    const head = detail.split(":", 2)[0].trim().replace(/:$/, "");
    return "Default provider " + head + " has no API key";
  }
  if (detail !== "") return check.title + ": " + detail;
  return check.title + " check failed";
}

function stableID(value: string): string {
  const lower = value.trim().toLowerCase();
  let out = "";
  let lastDash = false;
  for (const r of lower) {
    if ((r >= "a" && r <= "z") || (r >= "0" && r <= "9")) {
      out += r;
      lastDash = false;
      continue;
    }
    if (!lastDash && out.length > 0) {
      out += "-";
      lastDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

function valueOr(value: string, fallback: string): string {
  return value === "" ? fallback : value;
}

interface StatResult {
  info?: Deno.FileInfo;
  notExist: boolean;
  error?: Error;
}

function statResult(p: string): StatResult {
  try {
    return { info: Deno.statSync(p), notExist: false };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { notExist: true };
    return { notExist: false, error: err as Error };
  }
}

function statExists(p: string): Deno.FileInfo | undefined {
  return statResult(p).info;
}
