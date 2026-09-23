// internal/tui/commands.go (handleCommand).
//
// CommandSpec keeps slash-command syntax stable while localizing user-facing
// descriptions: syntax/usage is protocol text and must remain English. The
// dispatcher in Go switches on the command name; the TS projection keeps the
// same spec table so TUI help, suggestion, and dispatch stay aligned. i18n
// message IDs are carried as stable strings — the Ink renderer resolves them
// through the same bilingual maps used by the Go i18n bundle.

/** Stable i18n message identifier (mirrors internal/tui/i18n message IDs). */
export type MessageID = string;

/** One slash command: syntax is protocol text and must remain English. */
export interface CommandSpec {
  name: string;
  value: string;
  usage: string;
  description: MessageID;
}

export const commandSpecs: CommandSpec[] = [
  {
    name: "/auth",
    value: "/auth",
    usage: "/auth",
    description: "commands.auth.description",
  },
  {
    name: "/settings",
    value: "/settings",
    usage: "/settings",
    description: "commands.settings.description",
  },
  {
    name: "/tuilang",
    value: "/tuilang ",
    usage: "/tuilang [global|project] [auto|zh|en]",
    description: "commands.tuilang.description",
  },
  {
    name: "/mode",
    value: "/mode ",
    usage: "/mode [plan|agent|yolo|os]",
    description: "commands.mode.description",
  },
  {
    name: "/esm",
    value: "/esm ",
    usage: "/esm [objective|edit|pause|resume|clear|guide]",
    description: "commands.esm.description",
  },
  {
    name: "/model",
    value: "/model ",
    usage: "/model [model_id]",
    description: "commands.model.description",
  },
  {
    name: "/defaultModel",
    value: "/defaultModel ",
    usage: "/defaultModel [project|global]",
    description: "commands.default_model.description",
  },
  {
    name: "/env",
    value: "/env ",
    usage: "/env [list|set KEY VALUE|unset KEY|clear]",
    description: "commands.env.description",
  },
  {
    name: "/skillhub",
    value: "/skillhub",
    usage: "/skillhub [search <q>]",
    description: "commands.skillhub.description",
  },
  {
    name: "/skills",
    value: "/skills",
    usage: "/skills",
    description: "commands.skills.description",
  },
  {
    name: "/skill",
    value: "/skill ",
    usage: "/skill <name>",
    description: "commands.skill.description",
  },
  {
    name: "/paste-image",
    value: "/paste-image",
    usage: "/paste-image",
    description: "commands.paste_image.description",
  },
  {
    name: "/clear",
    value: "/clear",
    usage: "/clear",
    description: "commands.clear.description",
  },
  {
    name: "/compact",
    value: "/compact",
    usage: "/compact",
    description: "commands.compact.description",
  },
  {
    name: "/sessions",
    value: "/sessions",
    usage: "/sessions [ls|set <id>|clear|del <id>]",
    description: "commands.sessions.description",
  },
  {
    name: "/expert",
    value: "/expert ",
    usage: "/expert [list|show <id>|bind <id>|unbind|switch <id>]",
    description: "commands.expert.description",
  },
  {
    name: "/init_mcp",
    value: "/init_mcp ",
    usage: "/init_mcp [project|global] [basic|full] [--force]",
    description: "commands.init_mcp.description",
  },
  {
    name: "/mcps",
    value: "/mcps",
    usage: "/mcps",
    description: "commands.mcps.description",
  },
  {
    name: "/delegate",
    value: "/delegate ",
    usage: "/delegate [on|off|status]",
    description: "commands.delegate.description",
  },
  {
    name: "/browser",
    value: "/browser ",
    usage: "/browser [on|off|status]",
    description: "commands.browser.description",
  },
  {
    name: "/stats",
    value: "/stats ",
    usage: "/stats server|stop-server|tui",
    description: "commands.stats.description",
  },
  {
    name: "/statusline",
    value: "/statusline ",
    usage: "/statusline [status|on|off|command|refresh] ...",
    description: "commands.statusline.description",
  },
  {
    name: "/alloweditpath",
    value: "/alloweditpath ",
    usage: "/alloweditpath [add <glob>|remove <glob>|clear]",
    description: "commands.alloweditpath.description",
  },
  {
    name: "/allowautoedit",
    value: "/allowautoedit ",
    usage: "/allowautoedit [on|off] [global]",
    description: "commands.allowautoedit.description",
  },
  {
    name: "/btw",
    value: "/btw ",
    usage: "/btw <question>",
    description: "commands.btw.description",
  },
  {
    name: "/systeminit",
    value: "/systeminit ",
    usage: "/systeminit [guidance]",
    description: "commands.systeminit.description",
  },
  {
    name: "/rule",
    value: "/rule",
    usage: "/rule [force|--force]",
    description: "commands.rule.description",
  },
  {
    name: "/reload",
    value: "/reload",
    usage: "/reload",
    description: "commands.reload.description",
  },
  {
    name: "/workflows",
    value: "/workflows ",
    usage: "/workflows [list|show <id>|cancel <id>]",
    description: "commands.workflows.description",
  },
  {
    name: "/agent",
    value: "/agent ",
    usage: "/agent list|switch <id>|destroy <id>",
    description: "commands.agent.description",
  },
  {
    name: "/cron",
    value: "/cron ",
    usage: "/cron add|list|enable|disable|remove|run",
    description: "commands.cron.description",
  },
  {
    name: "/help",
    value: "/help",
    usage: "/help",
    description: "commands.help.description",
  },
  {
    name: "/quit",
    value: "/quit",
    usage: "/quit",
    description: "commands.quit.description",
  },
];

/** Returns the spec for a command name ("/model"), or undefined. */
export function findCommandSpec(name: string): CommandSpec | undefined {
  return commandSpecs.find((spec) => spec.name === name);
}

/**
 * Splits an input line into whitespace-separated fields (Go strings.Fields):
 * runs of whitespace collapse; leading/trailing whitespace is ignored.
 */
export function splitFields(input: string): string[] {
  return input.trim().length === 0 ? [] : input.trim().split(/\s+/);
}

/**
 * ParsedInput is the dispatch-level shape of one input line: either a slash
 * command (with `/skill:<name>` as its own form) or plain prompt text.
 */
export interface ParsedInput {
  kind: "command" | "skill" | "text";
  /** Command name including the leading slash ("/model"). */
  command: string;
  /** Remaining fields after the command name. */
  args: string[];
}

/**
 * Parses one input line for dispatch. Empty lines and non-slash text are
 * prompt text; "/skill:name" activates a skill ("/skill" alone lists skills).
 * Unknown commands still parse as commands — the App owns the error message.
 */
export function parseInputLine(line: string): ParsedInput {
  const parts = splitFields(line);
  if (parts.length === 0) {
    return { kind: "text", command: "", args: [] };
  }
  const first = parts[0];
  if (first.startsWith("/skill:")) {
    return {
      kind: "skill",
      command: first,
      args: parts.slice(1),
    };
  }
  if (first.startsWith("/")) {
    return { kind: "command", command: first, args: parts.slice(1) };
  }
  return { kind: "text", command: "", args: parts };
}

/** True when the command name is a registered spec. */
export function isKnownCommand(name: string): boolean {
  return findCommandSpec(name) !== undefined;
}
