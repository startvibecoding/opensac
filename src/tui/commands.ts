// Interactive TUI slash-command dispatch.
//
// The dispatcher owns command syntax and user-facing status/error lines only.
// Every mutation goes through a {@link CommandHost} — the session assembly in
// `tui_session.ts` — which in turn uses the shared Runtime/config/session APIs,
// keeping the TUI a thin projection that never owns sessions, agents, tools, or
// persistence.

import { splitFields } from "./command_specs.ts";
import { commandSpecs } from "./command_specs.ts";
import type { Translator } from "./i18n.ts";

/** Outcome of one command. */
export interface CommandResult {
  /** Rendered status/error lines (may be multi-line). */
  message?: string;
  /** True when the lines should be shown as an error. */
  error?: boolean;
  /** Requests that the shell close the interactive session. */
  quit?: boolean;
}

/** One command, dispatched by name. */
export type CommandHandler = (
  cmd: string,
  parts: string[],
) => CommandResult | Promise<CommandResult>;

/**
 * The mutation surface the command dispatcher may call. Implemented by the TUI
 * session over the shared Runtime. Kept narrow so a missing capability degrades
 * to a clear message instead of a crash.
 */
export interface CommandHost {
  readonly workDir: string;
  readonly translator: Translator;
  readonly mode: string;
  readonly modelID: string;
  readonly providerName: string;
  /** True while a foreground run is active. */
  readonly running: boolean;

  setMode(mode: string): void;
  setModel(modelID: string): Promise<CommandResult>;
  clearConversation(): void;
  compact(): Promise<CommandResult>;
  listSkills(): Promise<string>;
  activateSkill(name: string): Promise<string>;
  listMCPServers(): string;
  initMCPConfig(scope: string, full: boolean, force: boolean): CommandResult;
  listExperts(): Promise<string>;
  /** Shows one expert bundle's full details (/expert show <id>). */
  showExpert(id: string): Promise<string>;
  bindExpert(id: string): Promise<CommandResult>;
  forkSwitchExpert(id: string): Promise<CommandResult>;
  listSessions(): Promise<string>;
  /** Forks the current session, preserving its history (/sessions fork). */
  forkSession(): Promise<CommandResult>;
  switchSession(id: string): Promise<CommandResult>;
  clearSession(): Promise<CommandResult>;
  deleteSession(id: string): Promise<CommandResult>;
  listWorkflows(): Promise<CommandResult>;
  showWorkflow(id: string): Promise<CommandResult>;
  /** Cancels an active workflow run by ID (/workflows cancel <id>). */
  cancelWorkflow(id: string): Promise<CommandResult>;
  handleESM(cmd: string): Promise<CommandResult>;
  handleBTW(cmd: string): Promise<CommandResult>;
  listEnv(): Promise<string>;
  setEnv(key: string, value: string): Promise<CommandResult>;
  unsetEnv(key: string): Promise<CommandResult>;
  clearEnv(): Promise<CommandResult>;
  allowEditPath(parts: string[]): CommandResult;
  allowAutoEdit(parts: string[]): CommandResult;
  delegateMode(arg: string): Promise<CommandResult>;
  browserMode(arg: string): Promise<CommandResult>;
  statusLine(parts: string[]): Promise<CommandResult>;
  handleRule(parts: string[]): Promise<CommandResult>;
  handleSkillHub(parts: string[]): Promise<CommandResult>;
  listStats(parts: string[]): Promise<CommandResult>;
  listAgents(): Promise<string>;
  /** Switches the focused agent (/agent switch <id>). */
  switchAgent(id: string): Promise<CommandResult>;
  /** Destroys a sub-agent (/agent destroy <id>). */
  destroyAgent(id: string): Promise<CommandResult>;
  multiAgentEnabled(): boolean;
  handleReload(): Promise<CommandResult>;
  /** Lists configured providers and their credential state (/auth, /settings). */
  showProviders(): Promise<string>;
  /** Sets the default provider/model in global or project settings. */
  setDefaultModel(parts: string[]): Promise<CommandResult>;
  /** Reports or updates the TUI language. */
  tuiLang(parts: string[]): Promise<CommandResult>;
  /** Manages scheduled tasks. */
  cron(parts: string[]): CommandResult;
  /** Runs the /systeminit prompt through the agent. */
  systemInit(cmd: string): Promise<CommandResult>;
  /** Attaches the clipboard image to the draft. */
  pasteImage(): Promise<CommandResult>;
  /** Opens the interactive model switcher. */
  openModelDialog(): Promise<CommandResult>;
  /** Opens the interactive provider/auth editor. */
  openAuthDialog(): Promise<CommandResult>;
  /** Opens the interactive settings browser (/settings [provider]). */
  openSettingsDialog(providerID?: string): Promise<CommandResult>;
  /** Opens the interactive environment-variable editor. */
  openEnvDialog(): Promise<CommandResult>;
  /** Opens the interactive session browser. */
  openSessionsDialog(): Promise<CommandResult>;
  /** Opens the interactive TUI-language picker. */
  openTuiLangDialog(): Promise<CommandResult>;
}

/** Renders the help text (Go commandHelpText). */
export function helpText(tr: Translator): string {
  const lines: string[] = [tr.text("commands.title")];
  for (const spec of commandSpecs) {
    lines.push(
      `  ${spec.usage.padEnd(50, " ")} - ${tr.text(spec.description)}`,
    );
  }
  lines.push("", tr.text("keyboard.shortcuts.title"));
  const shortcut = (key: string, id: string) =>
    `  ${key.padEnd(18, " ")} - ${tr.text(id)}`;
  lines.push(
    shortcut("Enter", "keyboard.shortcut.submit"),
    shortcut("Alt+Enter/Ctrl+J", "keyboard.shortcut.newline"),
    shortcut("Tab", "keyboard.shortcut.cycle_mode"),
    shortcut("Esc", "keyboard.shortcut.abort"),
    shortcut("Ctrl+O", "keyboard.shortcut.tool_details"),
    shortcut("Ctrl+T", "keyboard.shortcut.plan_details"),
    shortcut("Ctrl+E", "keyboard.shortcut.esm_progress"),
    shortcut("Ctrl+R", "keyboard.shortcut.preview_image"),
    shortcut("Ctrl+G", "keyboard.shortcut.compact_tools"),
    shortcut("Up/Down", "keyboard.shortcut.move_history"),
    shortcut("Left/Right", "keyboard.shortcut.switch_detail_target"),
    shortcut("PgUp/PgDn", "keyboard.shortcut.page_panel"),
  );
  return lines.join("\n");
}

/** Dispatches one slash-command line against the host. */
export async function dispatchCommand(
  line: string,
  host: CommandHost,
): Promise<CommandResult> {
  const parts = splitFields(line);
  if (parts.length === 0) return {};
  const tr = host.translator;
  const command = parts[0];

  if (command.startsWith("/skill:")) {
    const name = command.slice("/skill:".length);
    return name === ""
      ? { message: await host.listSkills() }
      : { message: await host.activateSkill(name) };
  }

  switch (command) {
    case "/help":
      return { message: helpText(tr) };
    case "/quit":
      return { quit: true };
    case "/mode":
      return cmdMode(host, parts);
    case "/model":
      if (parts.length > 1) return await cmdModel(host, parts);
      if (host.running) {
        return {
          message: tr.text("commands.running_cannot_open", "/model"),
          error: true,
        };
      }
      return host.openModelDialog();
    case "/clear":
      host.clearConversation();
      return { message: tr.text("conversation.cleared") };
    case "/compact":
      if (host.running) {
        return { message: tr.text("compact.running"), error: true };
      }
      return await host.compact();
    case "/skills":
      return { message: await host.listSkills() };
    case "/skill":
      return {
        message: parts.length > 1
          ? await host.activateSkill(parts[1])
          : await host.listSkills(),
      };
    case "/mcps":
      return { message: host.listMCPServers() };
    case "/init_mcp":
      return cmdInitMCP(host, parts);
    case "/expert":
      return await cmdExpert(host, parts);
    case "/sessions":
      if (parts.length === 1) return host.openSessionsDialog();
      return await cmdSessions(host, parts);
    case "/workflows":
      return await cmdWorkflows(host, parts);
    case "/esm":
      return await host.handleESM(line);
    case "/btw":
      return await host.handleBTW(line);
    case "/env":
      if (parts.length === 1) return await host.openEnvDialog();
      return await cmdEnv(host, parts);
    case "/alloweditpath":
      return host.allowEditPath(parts);
    case "/allowautoedit":
      return host.allowAutoEdit(parts);
    case "/delegate":
      return host.delegateMode(parts[1] ?? "status");
    case "/browser":
      return host.browserMode(parts[1] ?? "status");
    case "/statusline":
      return host.statusLine(parts);
    case "/rule":
      return host.handleRule(parts);
    case "/skillhub":
      return await host.handleSkillHub(parts);
    case "/stats":
      return await host.listStats(parts);
    case "/agent":
      return await cmdAgent(host, parts);
    case "/reload":
      return await host.handleReload();
    case "/auth":
      if (host.running) {
        return {
          message: tr.text("commands.running_cannot_open", "/auth"),
          error: true,
        };
      }
      return host.openAuthDialog();
    case "/settings":
      if (host.running) {
        return {
          message: tr.text("settings.running"),
          error: true,
        };
      }
      return host.openSettingsDialog(parts[1]);
    case "/defaultModel":
      if (host.running) {
        return {
          message: tr.text("commands.running_cannot_open", "/defaultModel"),
          error: true,
        };
      }
      return await host.setDefaultModel(parts);
    case "/tuilang":
      if (parts.length === 1) return host.openTuiLangDialog();
      return host.tuiLang(parts);
    case "/cron":
      return host.cron(parts);
    case "/systeminit":
      return await host.systemInit(line);
    case "/paste-image":
      return await host.pasteImage();
    default:
      return { message: tr.text("commands.unknown", command), error: true };
  }
}

function cmdMode(host: CommandHost, parts: string[]): CommandResult {
  const tr = host.translator;
  if (parts.length > 1) {
    switch (parts[1]) {
      case "plan":
      case "agent":
      case "yolo":
      case "os":
        host.setMode(parts[1]);
        return { message: tr.text("commands.mode", parts[1].toUpperCase()) };
      default:
        return { message: tr.text("commands.invalid_mode"), error: true };
    }
  }
  const current = host.mode.toUpperCase();
  const permission = {
    PLAN: "commands.permissions.plan",
    AGENT: "commands.permissions.agent",
    YOLO: "commands.permissions.yolo",
    OS: "commands.permissions.os",
  }[current];
  const message = permission === undefined
    ? tr.text("commands.current_mode", current)
    : `${tr.text("commands.current_mode", current)}\n${tr.text(permission)}`;
  return { message };
}

async function cmdModel(
  host: CommandHost,
  parts: string[],
): Promise<CommandResult> {
  if (parts.length > 1) return await host.setModel(parts[1]);
  return {
    message: host.translator.text(
      "commands.model.current",
      host.modelID,
      host.providerName,
    ),
  };
}

function cmdInitMCP(host: CommandHost, parts: string[]): CommandResult {
  let scope = "project";
  let full = false;
  let force = false;
  for (const p of parts.slice(1)) {
    if (p === "global" || p === "project") scope = p;
    else if (p === "full") full = true;
    else if (p === "basic") full = false;
    else if (p === "--force") force = true;
  }
  return host.initMCPConfig(scope, full, force);
}

async function cmdExpert(
  host: CommandHost,
  parts: string[],
): Promise<CommandResult> {
  const tr = host.translator;
  const usage = "/expert [list|show <id>|bind <id>|unbind|switch <id>]";
  if (parts.length === 1 || parts[1] === "list") {
    return { message: await host.listExperts() };
  }
  switch (parts[1]) {
    case "show":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/expert show <id>"),
          error: true,
        };
      }
      return { message: await host.showExpert(parts[2]) };
    case "bind":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/expert bind <id>"),
          error: true,
        };
      }
      return await host.bindExpert(parts[2]);
    case "unbind":
      return await host.bindExpert("");
    case "switch":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/expert switch <id>"),
          error: true,
        };
      }
      return await host.forkSwitchExpert(parts[2]);
    default:
      return { message: tr.text("commands.usage", usage), error: true };
  }
}

async function cmdSessions(
  host: CommandHost,
  parts: string[],
): Promise<CommandResult> {
  const tr = host.translator;
  if (parts.length === 1) return { message: await host.listSessions() };
  switch (parts[1]) {
    case "ls":
    case "list":
      return { message: await host.listSessions() };
    case "set":
    case "switch":
    case "use":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/sessions set <id>"),
          error: true,
        };
      }
      return await host.switchSession(parts[2]);
    case "clear":
    case "new":
      return await host.clearSession();
    case "del":
    case "delete":
    case "rm":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/sessions del <id>"),
          error: true,
        };
      }
      return await host.deleteSession(parts[2]);
    case "fork":
    case "branch":
      return await host.forkSession();
    default:
      return {
        message: tr.text("sessions.unknown_subcommand", parts[1]),
        error: true,
      };
  }
}

async function cmdWorkflows(
  host: CommandHost,
  parts: string[],
): Promise<CommandResult> {
  const sub = (parts[1] ?? "list").toLowerCase();
  if (sub === "list" || sub === "ls") return await host.listWorkflows();
  if (sub === "show") {
    if (parts.length < 3) {
      return {
        message: host.translator.text("commands.usage", "/workflows show <id>"),
        error: true,
      };
    }
    return await host.showWorkflow(parts[2]);
  }
  if (sub === "cancel") {
    if (parts.length < 3) {
      return {
        message: host.translator.text(
          "commands.usage",
          "/workflows cancel <id>",
        ),
        error: true,
      };
    }
    return await host.cancelWorkflow(parts[2]);
  }
  return {
    message: host.translator.text(
      "commands.usage",
      "/workflows [list|show <id>|cancel <id>]",
    ),
    error: true,
  };
}

async function cmdEnv(
  host: CommandHost,
  parts: string[],
): Promise<CommandResult> {
  const tr = host.translator;
  const sub = (parts[1] ?? "list").toLowerCase();
  switch (sub) {
    case "list":
      return { message: await host.listEnv() };
    case "set":
      if (parts.length < 4) {
        return { message: tr.text("env.usage"), error: true };
      }
      return await host.setEnv(parts[2], parts.slice(3).join(" "));
    case "unset":
      if (parts.length < 3) {
        return { message: tr.text("env.usage"), error: true };
      }
      return await host.unsetEnv(parts[2]);
    case "clear":
      return await host.clearEnv();
    default:
      return { message: tr.text("env.usage"), error: true };
  }
}

async function cmdAgent(
  host: CommandHost,
  parts: string[],
): Promise<CommandResult> {
  const tr = host.translator;
  if (!host.multiAgentEnabled()) {
    return { message: tr.text("agent.disabled") };
  }
  if (parts.length < 2) {
    return {
      message: tr.text("commands.usage", "/agent list|switch|destroy"),
      error: true,
    };
  }
  switch (parts[1]) {
    case "list":
      return { message: await host.listAgents() };
    case "switch":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/agent switch <id>"),
          error: true,
        };
      }
      return await host.switchAgent(parts[2]);
    case "destroy":
      if (parts.length < 3) {
        return {
          message: tr.text("commands.usage", "/agent destroy <id>"),
          error: true,
        };
      }
      return await host.destroyAgent(parts[2]);
    default:
      return Promise.resolve({
        message: tr.text(
          "commands.usage",
          "/agent list|switch <id>|destroy <id>",
        ),
        error: true,
      });
  }
}
