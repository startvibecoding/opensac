// Shared-API implementations behind the TUI {@link CommandHost}. Each method is
// a thin translation of the Go handler to the Deno port's shared modules
// (config, session, skills, expert, workflow, skillhub, esm, stats). It never
// constructs an Agent, opens a database directly, or builds SQL.

import {
  addEditPath,
  type AllowConfig,
  clearEditPaths,
  editPathList,
  getAutoEdit,
  loadAllow,
  removeEditPath,
  saveProject,
  setGlobalAutoEdit,
  setProjectAutoEdit,
} from "../config/allow.ts";
import {
  clearEnv,
  envList,
  loadEnv,
  saveEnv,
  setEnv,
  unsetEnv,
} from "../config/env.ts";
import {
  defaultMCPConfig,
  fullMCPConfigTemplate,
  globalMCPPath,
  loadMCPConfig,
  type MCPServer,
  mcpServerEnabled,
  normalizeMCPConfig,
  projectMCPPath,
  saveMCPConfig,
} from "../config/mcp.ts";
import {
  getGlobalSkillsDir,
  isProjectDir,
  saveGlobalSettingsPatch,
  saveProjectSettingsPatch,
  type Settings,
} from "../config/settings.ts";
import { ensureRuleFile, ruleFilePath } from "../contextfiles/contextfiles.ts";
import { registerDelegateSubAgentTool } from "../agent/subagent.ts";
import { ConfigOptionBrowser } from "../agentruntime/session_options.ts";
import { ExpertSwitchRequiresForkError } from "../agentruntime/expert.ts";
import { forkWithExpert } from "../agentruntime/fork.ts";
import {
  createSession,
  deleteSession as deleteSessionRuntime,
  openSession,
} from "../agentruntime/session_lifecycle.ts";
import { listForDirDetailed, type SessionDetail } from "../session/manager.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import { newRunContext } from "../agent/run_context.ts";
import type { Agent } from "../agent/agent.ts";
import type { Event } from "../agent/events.ts";
import { Service as SkillHubService } from "../skillhub/service.ts";
import { projectSkillDirs } from "../skills/skills.ts";
import type { Market } from "../skillhub/types.ts";
import { clientsForSettings } from "../skillhub/factory.ts";
import { defaultStore as workflowStore } from "../workflow/tools.ts";
import { defaultActiveRegistry } from "../workflow/active.ts";
import { ErrNotFound, ESMStore, type Objective } from "../esm/mod.ts";
import { DB as StatsDB } from "../stats/stats.ts";
import { Server as StatsServer } from "../stats/server.ts";
import { formatDuration } from "./formatters.ts";
import { renderSessionList } from "./session_commands.ts";
import type { CommandResult } from "./commands.ts";
import type { TUISession } from "./tui_session.ts";

/** Default dashboard listen address (Go defaultStatsAddr). */
const DEFAULT_STATS_ADDR = "127.0.0.1:7878";

interface TUIHost {
  workDir: string;
  settings: Settings;
  translator: TUISession["translator"];
  runtime: TUISession["runtime"];
  manager: SessionManager;
  controller: TUISession["controller"];
  currentSessionID(): string;
  bindManager(manager: SessionManager): Promise<void>;
  setMode(mode: string): void;
}

export class TuiCommands {
  #host: TUIHost;
  #activeSkills = new Set<string>();
  #delegateMode = false;
  #agent: Agent | undefined;
  #reloadRequested = false;
  #statsServer: StatsServer | undefined;
  #statsServerURL = "";

  constructor(host: TUIHost) {
    this.#host = host;
  }

  /** Retains the built agent so /compact can drive a forced compaction. */
  setAgent(agent: Agent): void {
    this.#agent = agent;
  }

  #tr() {
    return this.#host.translator;
  }

  // --- Skills ---------------------------------------------------------------

  listSkills(): string {
    const tr = this.#tr();
    const mgr = this.#host.runtime.skillsMgr;
    if (mgr === undefined) return tr.text("skills.unavailable");
    const skills = mgr.list();
    if (skills.length === 0) return tr.text("skills.empty");
    const lines = [tr.text("skill.available_title")];
    for (const skill of skills) {
      const marker = this.#activeSkills.has(skill.name) ? "*" : " ";
      lines.push(
        `  [${marker}] ${skill.name} (${skill.source}): ${skill.description}`,
      );
    }
    lines.push("", "Use /skill <name> or /skill:<name> to activate a skill.");
    return lines.join("\n");
  }

  activateSkill(name: string): string {
    const tr = this.#tr();
    const mgr = this.#host.runtime.skillsMgr;
    if (mgr === undefined) return tr.text("skills.unavailable");
    const skill = mgr.get(name);
    if (skill === undefined) return tr.text("skill.not_found", name);
    if (this.#activeSkills.has(name)) {
      return tr.text("skill.already_active", name);
    }
    this.#activeSkills.add(name);
    const ctx = mgr.buildSkillContext(name);
    this.#host.runtime.extraContext = this.#host.runtime.extraContext + ctx;
    return tr.text("skill.activated", name, skill.source, skill.description);
  }

  // --- MCP ------------------------------------------------------------------

  listMCPServers(): string {
    const tr = this.#tr();
    const servers = this.#loadMCPServers();
    if (servers.length === 0) return tr.text("mcps.empty");
    const lines = [tr.text("mcps.title", servers.length)];
    for (const srv of servers) {
      const enabled = mcpServerEnabled(srv)
        ? tr.text("mcps.enabled")
        : tr.text("mcps.disabled");
      lines.push(
        tr.text("mcps.entry", srv.name, srv.type ?? "stdio", enabled),
      );
    }
    return lines.join("\n");
  }

  #loadMCPServers(): MCPServer[] {
    const paths = [globalMCPPath(), projectMCPPath()];
    const servers: MCPServer[] = [];
    for (const p of paths) {
      try {
        const cfg = loadMCPConfig(p);
        normalizeMCPConfig(cfg);
        servers.push(...(cfg.mcpServers ?? []));
      } catch {
        // Missing config file: skip.
      }
    }
    return servers;
  }

  initMCPConfig(scope: string, full: boolean, force: boolean): CommandResult {
    const tr = this.#tr();
    const target = scope === "global" ? globalMCPPath() : projectMCPPath();
    if (!force) {
      try {
        Deno.statSync(target);
        return { message: tr.text("init_mcp.exists", scope) };
      } catch {
        // Not present: write it.
      }
    }
    try {
      const cfg = full ? fullMCPConfigTemplate() : defaultMCPConfig();
      saveMCPConfig(target, cfg);
      return { message: tr.text("init_mcp.created", target) };
    } catch (err) {
      return {
        message: tr.text("init_mcp.failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Experts --------------------------------------------------------------

  listExperts(): string {
    const tr = this.#tr();
    const experts = this.#host.runtime.listExperts();
    if (experts.length === 0) return tr.text("expert.empty");
    const lines = [tr.text("expert.list_title", experts.length)];
    for (const e of experts) {
      const name = tr.language === "zh" ? e.displayName.zh : e.displayName.en;
      lines.push(tr.text("expert.entry", e.name, e.source, name));
    }
    return lines.join("\n");
  }

  async bindExpert(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      await this.#host.runtime.setExpert(id);
    } catch (err) {
      if (err instanceof ExpertSwitchRequiresForkError) {
        return { message: err.message, error: true };
      }
      return { message: (err as Error).message, error: true };
    }
    return {
      message: id === ""
        ? tr.text("expert.unbound")
        : tr.text("expert.bound", id),
    };
  }

  async forkSwitchExpert(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionID = this.#host.currentSessionID();
    if (sessionID === "") {
      return { message: tr.text("sessions.no_match", id), error: true };
    }
    try {
      const result = forkWithExpert(
        this.#host.manager.getSessionDir(),
        {
          sourceSessionId: sessionID,
          requestId: `tui-fork-${crypto.randomUUID()}`,
          titleMode: "",
        },
        id,
      );
      const child = openSession(
        this.#host.manager.getSessionDir(),
        result.sessionId,
      );
      await this.#host.bindManager(child);
      this.#host.controller.store.resetTranscriptState();
      return {
        message: tr.text("expert.switched", result.sessionId, id),
      };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  // --- Sessions -------------------------------------------------------------

  listSessions(): string {
    const tr = this.#tr();
    const details = listForDirDetailed(
      this.#host.workDir,
      this.#host.manager.getSessionDir(),
    );
    return renderSessionList(
      details,
      this.#host.currentSessionID(),
      (n) => tr.text("sessions.list_title", n),
      tr.text("sessions.no_sessions"),
    );
  }

  #resolveSession(query: string): SessionDetail | undefined {
    const details = listForDirDetailed(
      this.#host.workDir,
      this.#host.manager.getSessionDir(),
    );
    const exact = details.find((d) => d.id === query);
    if (exact !== undefined) return exact;
    const matches = details.filter((d) => d.id.startsWith(query));
    if (matches.length === 1) return matches[0];
    return undefined;
  }

  async switchSession(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    if (this.#host.currentSessionID() === id) {
      return { message: tr.text("sessions.already_current") };
    }
    const detail = this.#resolveSession(id);
    if (detail === undefined) {
      return { message: tr.text("sessions.no_match", id), error: true };
    }
    try {
      const manager = openSession(
        this.#host.manager.getSessionDir(),
        detail.id,
      );
      await this.#host.bindManager(manager);
      this.#host.setMode(
        this.#host.manager.getHeader()?.cwd === "" ? "yolo" : "yolo",
      );
      this.#host.controller.store.resetTranscriptState();
      return {
        message: tr.text("sessions.switched", detail.id, detail.messageCount),
      };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  async clearSession(): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const manager = createSession({ workDir: this.#host.workDir });
      await this.#host.bindManager(manager);
      this.#host.controller.store.resetTranscriptState();
      return { message: tr.text("sessions.clear_hint") };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  async deleteSession(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    if (id === this.#host.currentSessionID()) {
      return {
        message: tr.text("sessions.cannot_delete_current"),
        error: true,
      };
    }
    const detail = this.#resolveSession(id);
    if (detail === undefined) {
      return { message: tr.text("sessions.no_match", id), error: true };
    }
    try {
      await deleteSessionRuntime(this.#host.manager.getSessionDir(), detail.id);
      return { message: tr.text("sessions.deleted", detail.id) };
    } catch (err) {
      return {
        message: tr.text("sessions.delete_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Workflows ------------------------------------------------------------

  async listWorkflows(): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const store = workflowStore();
      const runs = await store.list();
      if (runs.length === 0) return { message: tr.text("workflows.empty") };
      const lines = [tr.text("workflows.list_title", runs.length)];
      for (const run of runs) {
        lines.push(
          tr.text(
            "workflows.entry",
            run.status,
            run.id,
            run.name,
            run.updatedAt.toISOString(),
          ),
        );
      }
      return { message: lines.join("\n") };
    } catch (err) {
      return {
        message: tr.text("workflows.failed", (err as Error).message),
        error: true,
      };
    }
  }

  async showWorkflow(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const run = await workflowStore().load(id);
      if (run === null || run === undefined) {
        return {
          message: tr.text("workflows.show_failed", "not found"),
          error: true,
        };
      }
      const lines = [tr.text("workflows.show_title", run.id, run.status)];
      if (run.name !== "") lines.push(tr.text("workflows.name", run.name));
      for (const phase of run.phases ?? []) {
        lines.push(
          tr.text(
            "workflows.phase",
            phase.status,
            phase.name,
            phase.tasks?.length ?? 0,
          ),
        );
      }
      if (run.error !== undefined && run.error !== "") {
        lines.push(tr.text("workflows.error", run.error));
      }
      return { message: lines.join("\n") };
    } catch (err) {
      return {
        message: tr.text("workflows.show_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- ESM ------------------------------------------------------------------

  async handleESM(cmd: string): Promise<CommandResult> {
    await Promise.resolve();
    const tr = this.#tr();
    const sessionID = this.#host.currentSessionID();
    if (sessionID === "") return { message: tr.text("esm.panel.no_objective") };
    const store = new ESMStore(this.#host.manager.getSessionDir());
    const raw = cmd.trim().replace(/^\/esm/, "").trim();
    const [sub, ...restArr] = raw === "" ? ["status"] : raw.split(/\s+/);
    const rest = restArr.join(" ");
    try {
      switch (sub) {
        case "status":
          return { message: this.#formatESM(store.get(sessionID)) };
        case "edit":
          if (rest === "") {
            return {
              message: tr.text("commands.usage", "/esm edit <objective>"),
              error: true,
            };
          }
          store.edit(sessionID, rest);
          return { message: this.#formatESM(store.get(sessionID)) };
        case "pause":
          store.pause(sessionID);
          return { message: this.#formatESM(store.get(sessionID)) };
        case "resume":
          store.resume(sessionID);
          return { message: this.#formatESM(store.get(sessionID)) };
        case "guide":
          if (rest === "") {
            return {
              message: tr.text("commands.usage", "/esm guide <text>"),
              error: true,
            };
          }
          store.addGuidance(sessionID, rest);
          return { message: "Guidance queued for the next ESM role run." };
        case "clear":
          store.clear(sessionID);
          return { message: "Enable Supervisor Mode cleared." };
        default:
          store.create(sessionID, raw);
          return { message: this.#formatESM(store.get(sessionID)) };
      }
    } catch (err) {
      if (err === ErrNotFound) {
        return { message: tr.text("esm.panel.no_objective") };
      }
      return { message: (err as Error).message, error: true };
    }
  }

  #formatESM(obj: Objective | null): string {
    const tr = this.#tr();
    if (obj === null || obj.esmId === "") {
      return [
        tr.text("esm.panel.title"),
        "Status: none",
        "",
        tr.text("esm.panel.create_hint"),
      ].join("\n");
    }
    const lines = [
      tr.text("esm.panel.title"),
      `Status: ${obj.status}`,
      `Phase: ${obj.phase}`,
      `Objective: ${obj.objective}`,
      `Tokens: ${obj.tokensUsed}`,
    ];
    if (obj.timeUsedMs > 0) {
      lines.push(`Time: ${formatDuration(obj.timeUsedMs)}`);
    }
    if (obj.progressSummary !== "") {
      lines.push(`Latest progress: ${obj.progressSummary}`);
    }
    if (obj.remainingWork.length > 0) {
      lines.push(
        `Remaining work (${obj.remainingWork.length}): ${
          obj.remainingWork.join("; ")
        }`,
      );
    }
    return lines.join("\n");
  }

  // --- Environment ----------------------------------------------------------

  listEnv(): string {
    const tr = this.#tr();
    const vars = envList(loadEnv());
    const keys = Object.keys(vars).sort();
    if (keys.length === 0) return tr.text("env.empty");
    const lines = [tr.text("env.title", keys.length)];
    for (const key of keys) lines.push(tr.text("env.entry", key, vars[key]));
    return lines.join("\n");
  }

  setEnv(key: string, value: string): CommandResult {
    const tr = this.#tr();
    try {
      const cfg = loadEnv();
      setEnv(cfg, key, value);
      return { message: tr.text("env.set", key) };
    } catch (err) {
      return {
        message: tr.text("env.failed", (err as Error).message),
        error: true,
      };
    }
  }

  unsetEnv(key: string): CommandResult {
    const tr = this.#tr();
    try {
      const cfg = loadEnv();
      unsetEnv(cfg, key);
      return { message: tr.text("env.unset", key) };
    } catch (err) {
      return {
        message: tr.text("env.failed", (err as Error).message),
        error: true,
      };
    }
  }

  clearEnv(): CommandResult {
    const tr = this.#tr();
    try {
      clearEnv(loadEnv());
      return { message: tr.text("env.cleared") };
    } catch (err) {
      return {
        message: tr.text("env.failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Allow lists ----------------------------------------------------------

  allowEditPath(parts: string[]): CommandResult {
    const tr = this.#tr();
    const allow: AllowConfig = loadAllow();
    if (parts.length < 2) {
      const paths = editPathList(allow);
      if (paths.length === 0) {
        return {
          message: tr.text(
            "commands.usage",
            "/alloweditpath add|remove <glob>|clear",
          ),
        };
      }
      return {
        message: [tr.text("alloweditpath.title"), ...paths.map((p) => `  ${p}`)]
          .join("\n"),
      };
    }
    switch (parts[1]) {
      case "add": {
        if (parts.length < 3) {
          return {
            message: tr.text("commands.usage", "/alloweditpath add <glob>"),
            error: true,
          };
        }
        const glob = parts.slice(2).join(" ");
        if (!addEditPath(allow, glob)) {
          return { message: tr.text("alloweditpath.already", glob) };
        }
        saveProject(allow);
        return {
          message: tr.text(
            "alloweditpath.saved",
            tr.text("alloweditpath.added"),
            glob,
          ),
        };
      }
      case "remove":
      case "rm": {
        if (parts.length < 3) {
          return {
            message: tr.text("commands.usage", "/alloweditpath remove <glob>"),
            error: true,
          };
        }
        const glob = parts.slice(2).join(" ");
        if (!removeEditPath(allow, glob)) {
          return { message: tr.text("alloweditpath.not_found", glob) };
        }
        saveProject(allow);
        return {
          message: tr.text(
            "alloweditpath.saved",
            tr.text("alloweditpath.removed"),
            glob,
          ),
        };
      }
      case "clear":
        clearEditPaths(allow);
        saveProject(allow);
        return { message: tr.text("alloweditpath.cleared") };
      default:
        return {
          message: tr.text(
            "commands.usage",
            "/alloweditpath add|remove <glob>|clear",
          ),
          error: true,
        };
    }
  }

  allowAutoEdit(parts: string[]): CommandResult {
    const tr = this.#tr();
    const allow = loadAllow();
    if (parts.length < 2) {
      return {
        message: tr.text(
          "allowautoedit.status",
          getAutoEdit(allow) ? "ON" : "OFF",
        ),
      };
    }
    const globalScope = parts.slice(2).includes("global");
    let enable: boolean;
    if (parts[1] === "on") enable = true;
    else if (parts[1] === "off") enable = false;
    else {return {
        message: tr.text("commands.usage", "/allowautoedit [on|off] [global]"),
        error: true,
      };}
    try {
      if (globalScope) setGlobalAutoEdit(allow, enable);
      else {
        setProjectAutoEdit(allow, enable);
        saveProject(allow);
      }
    } catch (err) {
      return {
        message: tr.text("alloweditpath.save_failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: tr.text(
        "allowautoedit.saved",
        enable ? "ON" : "OFF",
        globalScope ? "global" : "project",
      ),
    };
  }

  // --- Modes ----------------------------------------------------------------

  delegateMode(arg: string): CommandResult {
    const tr = this.#tr();
    if (arg === "status") {
      return {
        message: tr.text("delegate.status", this.#delegateMode ? "ON" : "OFF"),
      };
    }
    if (this.#host.controller.isThinking) {
      return { message: tr.text("delegate.running"), error: true };
    }
    switch (arg) {
      case "on": {
        this.#delegateMode = true;
        return { message: tr.text("delegate.changed", "ON") };
      }
      case "off":
        this.#delegateMode = false;
        return { message: tr.text("delegate.changed", "OFF") };
      default:
        return {
          message: tr.text("commands.usage", "/delegate [on|off|status]"),
          error: true,
        };
    }
  }

  browserMode(arg: string): CommandResult {
    const tr = this.#tr();
    if (arg === "status") {
      const caps = this.#host.runtime.capabilitySnapshot();
      return {
        message: tr.text("browser.status", caps.browserEnabled ? "ON" : "OFF"),
      };
    }
    if (this.#host.controller.isThinking) {
      return { message: tr.text("browser.running"), error: true };
    }
    if (arg !== "on" && arg !== "off") {
      return {
        message: tr.text("commands.usage", "/browser [on|off|status]"),
        error: true,
      };
    }
    try {
      this.#host.runtime.setCapabilityOption(ConfigOptionBrowser, arg === "on");
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
    return { message: tr.text("browser.status", arg === "on" ? "ON" : "OFF") };
  }

  statusLine(parts: string[]): CommandResult {
    const tr = this.#tr();
    const current = this.#host.settings.statusLine ?? {};
    const sub = (parts[1] ?? "status").toLowerCase();
    if (sub === "status") {
      return {
        message: tr.text(
          "statusline.status",
          current.enabled === true ? "ON" : "OFF",
          current.refreshInterval
            ? `${current.refreshInterval}s`
            : "event-driven",
          (current.command ?? "").trim() || "(none)",
        ),
      };
    }
    if (sub !== "on" && sub !== "off") {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline [status|on|off|command|refresh] ...",
        ),
        error: true,
      };
    }
    const scope = (parts[2] ?? "project").toLowerCase();
    if (scope !== "project" && scope !== "global") {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline [status|on|off] [project|global]",
        ),
        error: true,
      };
    }
    const enabled = sub === "on";
    const next = {
      ...current,
      enabled,
      ...(enabled && !current.command
        ? {
          command: "ccstatusline",
          type: "command",
          timeoutMs: 800,
          fallback: "builtin",
        }
        : {}),
    };
    try {
      if (scope === "global") {
        saveGlobalSettingsPatch({ statusLine: next });
      } else {
        saveProjectSettingsPatch({ statusLine: next });
      }
      this.#host.settings.statusLine = next;
    } catch (err) {
      return {
        message: tr.text("statusline.failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: enabled
        ? tr.text("statusline.on", scope)
        : tr.text("statusline.off"),
    };
  }

  // --- Rule -----------------------------------------------------------------

  handleRule(parts: string[]): CommandResult {
    const tr = this.#tr();
    if (this.#host.controller.isThinking) {
      return { message: tr.text("rule.running"), error: true };
    }
    const overwrite = parts.length > 1 &&
      (parts[1] === "force" || parts[1] === "--force");
    if (parts.length > 2 || (parts.length === 2 && !overwrite)) {
      return {
        message: tr.text("commands.usage", "/rule [force|--force]"),
        error: true,
      };
    }
    try {
      const { path: filePath, content, written } = ensureRuleFile(
        this.#host.workDir,
        overwrite,
      );
      this.#host.runtime.ruleContent = content;
      if (written) {
        return {
          message: [
            tr.text(
              "rule.created",
              tr.text(overwrite ? "rule.overwrote" : "rule.created_verb"),
              filePath,
            ),
            tr.text("rule.loaded"),
          ].join("\n"),
        };
      }
      return {
        message: tr.text("rule.exists", ruleFilePath(this.#host.workDir)),
      };
    } catch (err) {
      return {
        message: tr.text("rule.write_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- SkillHub -------------------------------------------------------------

  #skillHub(): SkillHubService {
    const globalDir = this.#host.settings.skills === undefined ? "" : "";
    return new SkillHubService(
      globalDir,
      projectSkillDirs(this.#host.workDir),
      this.#host.settings.skillHub?.officialHandles ?? [],
      ...clientsForSettings(this.#host.settings.skillHub ?? {}),
    );
  }

  #skillHubScope(): string {
    return isProjectDir(this.#host.workDir) ? "project" : "global";
  }

  /** Parses a `<market>/<id>` reference (Go parseSkillHubID). */
  static #parseSkillHubID(value: string): { market: string; id: string } {
    const trimmed = value.trim();
    if (trimmed === "") throw new Error("skill reference is required");
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new Error(
        `invalid skill reference ${JSON.stringify(trimmed)}; use <market>/<id>`,
      );
    }
    return {
      market: trimmed.slice(0, slash),
      id: trimmed.slice(slash + 1),
    };
  }

  async handleSkillHub(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    const service = this.#skillHub();
    const sub = parts[1] ?? "list";
    try {
      switch (sub) {
        case "search": {
          if (parts.length < 3) {
            return {
              message: tr.text("commands.usage", "/skillhub search <query>"),
              error: true,
            };
          }
          const query = parts.slice(2).join(" ");
          const market = service.markets()[0]?.id ?? "skillhub";
          const page = await service.search(undefined, market, {
            query,
            limit: 20,
          });
          const lines = [`Skills (${page.items.length}):`];
          for (const item of page.items) {
            lines.push(`  ${item.id} — ${item.name}`);
          }
          return { message: lines.join("\n") };
        }
        case "detail": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub detail <market>/<id>",
              ),
              error: true,
            };
          }
          const { market, id } = TuiCommands.#parseSkillHubID(parts[2]);
          const detail = await service.detail(
            undefined,
            market as Market,
            id,
          );
          const lines = [
            `${detail.name} (${detail.id})`,
            detail.description ?? "",
            `version: ${detail.version ?? ""}`,
          ];
          return { message: lines.filter((l) => l !== "").join("\n") };
        }
        case "install": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub install <market>/<id>",
              ),
              error: true,
            };
          }
          const { market, id } = TuiCommands.#parseSkillHubID(parts[2]);
          const result = await service.install(undefined, {
            market: market as Market,
            id,
            scope: this.#skillHubScope(),
            targetDir: this.#skillHubTargetDir(),
            overwrite: parts.includes("--force"),
          });
          return { message: `✅ Installed ${result.name}` };
        }
        case "uninstall": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub uninstall <market>/<id>",
              ),
              error: true,
            };
          }
          const { market, id } = TuiCommands.#parseSkillHubID(parts[2]);
          service.uninstall(market as Market, id, this.#skillHubScope());
          return { message: `✅ Uninstalled ${id}` };
        }
        default: {
          // Default view: list installed skills (no network).
          const query = parts.slice(1).join(" ");
          const market = service.markets()[0]?.id ?? "skillhub";
          const page = await service.search(undefined, market, {
            query,
            limit: 20,
          });
          const lines = [`Skills (${page.items.length}):`];
          for (const item of page.items) {
            lines.push(`  ${item.id} — ${item.name}`);
          }
          return { message: lines.join("\n") };
        }
      }
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  #skillHubTargetDir(): string {
    if (this.#skillHubScope() === "project") {
      return projectSkillDirs(this.#host.workDir)[0];
    }
    return getGlobalSkillsDir(this.#host.settings);
  }

  // --- Stats ----------------------------------------------------------------

  async listStats(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    const sub = (parts[1] ?? "tui").toLowerCase();
    switch (sub) {
      case "server":
        return this.#startStatsServer();
      case "stop-server":
        return await this.#stopStatsServer();
      case "tui":
        break;
      default:
        return { message: tr.text("stats.usage"), error: true };
    }
    try {
      const db = StatsDB.openDefault();
      const summary = db.summary({});
      const lines = [
        tr.text("stats.title"),
        `Requests: ${summary.totalRequests}`,
        `Input tokens: ${summary.inputTokens}`,
        `Output tokens: ${summary.outputTokens}`,
        `Total tokens: ${summary.totalTokens}`,
      ];
      const byProvider = db.byProvider({});
      if (byProvider.length > 0) {
        lines.push("", tr.text("stats.by_provider"));
        for (const row of byProvider) {
          lines.push(`  ${row.label}: ${row.totalTokens}`);
        }
      }
      return { message: lines.join("\n") };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  /** Starts the in-process usage dashboard (Go startStatsServer). */
  #startStatsServer(): CommandResult {
    const tr = this.#tr();
    if (this.#statsServer !== undefined) {
      return {
        message: tr.text("stats.server.already_running", this.#statsServerURL),
      };
    }
    try {
      const db = StatsDB.openDefault();
      const server = new StatsServer(db, DEFAULT_STATS_ADDR);
      server.start();
      this.#statsServer = server;
      this.#statsServerURL = `http://${server.boundAddr()}`;
      return {
        message: `${tr.text("stats.starting")}\n${this.#statsServerURL}`,
      };
    } catch (err) {
      return {
        message: tr.text("stats.start_failed", (err as Error).message),
        error: true,
      };
    }
  }

  /** Stops the in-process usage dashboard. */
  async #stopStatsServer(): Promise<CommandResult> {
    const tr = this.#tr();
    const server = this.#statsServer;
    if (server === undefined) {
      return { message: tr.text("stats.server.not_running") };
    }
    try {
      await server.shutdown();
      this.#statsServer = undefined;
      this.#statsServerURL = "";
      return { message: tr.text("stats.server.stopped") };
    } catch (err) {
      return {
        message: tr.text("stats.server.stop_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Compaction -----------------------------------------------------------

  async compact(): Promise<CommandResult> {
    const tr = this.#tr();
    const agent = this.#agent;
    if (agent === undefined) {
      return { message: tr.text("compact.empty"), error: true };
    }
    if (!agent.canForceCompact()) {
      return { message: tr.text("compact.skipped"), error: true };
    }
    const sink = (ev: Event): boolean => {
      this.#host.controller.handleAgentEvent(ev);
      return true;
    };
    try {
      await agent.compact(newRunContext(), sink, true);
      return { message: tr.text("compact.done") };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  // --- Reload ---------------------------------------------------------------

  get reloadRequested(): boolean {
    return this.#reloadRequested;
  }

  requestReload(): CommandResult {
    this.#reloadRequested = true;
    return { message: this.#tr().text("reload.requested"), quit: true };
  }
}

export { defaultActiveRegistry, registerDelegateSubAgentTool, saveEnv };
