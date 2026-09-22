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
  saveGlobalAutoEditValue,
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
import type { AgentManager } from "../agent/manager.ts";
import { ConfigOptionBrowser } from "../agentruntime/session_options.ts";
import { ExpertSwitchRequiresForkError } from "../agentruntime/expert.ts";
import { fork, forkWithExpert } from "../agentruntime/fork.ts";
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
import { newLocalIndex } from "../skillhub/local.ts";
import type { Market } from "../skillhub/types.ts";
import { clientsForSettings } from "../skillhub/factory.ts";
import { defaultStore as workflowStore } from "../workflow/tools.ts";
import { defaultActiveRegistry } from "../workflow/active.ts";
import {
  EsmInvalidObjectiveError,
  EsmInvalidTransitionError,
  EsmObjectiveExistsError,
  EsmObjectiveNotFoundError,
  ESMStore,
  type Objective,
} from "../esm/mod.ts";
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
  ensureAgentManager(): import("../agent/manager.ts").AgentManager;
  startESMContinuationIfIdle(): void;
  abortESMWorker(): void;
}

export class TuiCommands {
  #host: TUIHost;
  #activeSkills = new Set<string>();
  /** The accumulated extra-context bytes appended by activateSkill. */
  #appendedSkillContext = "";
  #delegateMode = false;
  #activeAgent = "main";
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
    const ctx = mgr.buildSkillContext(name);
    this.#host.runtime.extraContext = this.#host.runtime.extraContext + ctx;
    this.#appendedSkillContext += ctx;
    this.#activeSkills.add(name);
    return tr.text("skill.activated", name, skill.source, skill.description);
  }

  /**
   * Clears skill activations and restores the pre-skill extra context (Go
   * /clear rebuilds activeSkills + extraContext).
   */
  clearActiveSkills(): void {
    if (this.#appendedSkillContext !== "") {
      const current = this.#host.runtime.extraContext ?? "";
      this.#host.runtime.extraContext = current.endsWith(
          this.#appendedSkillContext,
        )
        ? current.slice(0, -this.#appendedSkillContext.length)
        : current;
    }
    this.#appendedSkillContext = "";
    this.#activeSkills.clear();
  }

  // --- MCP ------------------------------------------------------------------

  listMCPServers(): string {
    const sources: Array<{ label: string; path: string }> = [
      { label: "Global", path: globalMCPPath() },
      { label: "Project", path: projectMCPPath() },
    ];
    const lines = ["MCP servers:"];
    let foundAny = false;
    for (const src of sources) {
      lines.push("", `${src.label} (${src.path}):`);
      let cfg;
      try {
        cfg = loadMCPConfig(src.path);
        normalizeMCPConfig(cfg);
      } catch (err) {
        if (
          (err as Error & { code?: string }).code === "ENOENT" ||
          (err as Error).message.includes("No such file")
        ) {
          lines.push("  (not configured)");
        } else {
          lines.push(`  (invalid: ${(err as Error).message})`);
        }
        continue;
      }
      const servers = cfg.mcpServers ?? [];
      if (servers.length === 0) {
        lines.push("  (empty)");
        continue;
      }
      for (const srv of servers) {
        foundAny = true;
        const target = srv.command ?? srv.url ?? "-";
        lines.push(`  - ${srv.name} [${srv.type ?? "stdio"}] ${target}`);
      }
    }
    if (!foundAny) lines.push("", "Use /init_mcp to create project mcp.json.");
    return lines.join("\n");
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
    const boundID = this.#host.runtime.expertState().binding?.id ?? "";
    const lines = ["Experts:", ""];
    for (const e of experts) {
      const marker = e.name === boundID ? "*" : " ";
      const name = tr.language === "zh" ? e.displayName.zh : e.displayName.en;
      let line =
        `  [${marker}] ${e.name}  ${name} (${e.expertType}, ${e.source})`;
      if (e.invalid) line += `: invalid — ${e.invalidReason ?? ""}`;
      lines.push(line);
    }
    lines.push(
      "",
      "Use /expert show <id> to inspect, or /expert bind <id> to bind this session.",
    );
    return lines.join("\n");
  }

  /** Shows one expert bundle's full details (Go formatExpertBundle). */
  showExpert(id: string): string {
    try {
      const bundle = this.#host.runtime.inspectExpert(id);
      return this.#formatExpertBundle(bundle);
    } catch (err) {
      return this.#tr().text(
        "expert.show_failed",
        (err as Error).message,
      );
    }
  }

  #formatExpertBundle(bundle: {
    name: string;
    manifest: {
      expertType: string;
      displayName: { zh: string; en: string };
      members?: Array<{
        id: string;
        name?: { zh: string; en: string };
        profession?: { zh: string; en: string };
        role?: string;
      }>;
    };
    invalid: boolean;
    invalidReason: string;
  }): string {
    const tr = this.#tr();
    const lines = [`Expert: ${bundle.name}`];
    const displayName = tr.language === "zh"
      ? bundle.manifest.displayName.zh
      : bundle.manifest.displayName.en;
    lines.push(`Name: ${displayName}`);
    lines.push(`Type: ${bundle.manifest.expertType}`);
    if (bundle.invalid) {
      lines.push(`Status: invalid — ${bundle.invalidReason}`);
      return lines.join("\n");
    }
    lines.push("Status: available");
    if (bundle.manifest.expertType === "team") {
      lines.push("Members:");
      for (const member of bundle.manifest.members ?? []) {
        let line = `  - ${member.id}`;
        const name = tr.language === "zh" ? member.name?.zh : member.name?.en;
        if (name !== undefined && name !== "" && name !== member.id) {
          line += ` (${name})`;
        }
        const profession = tr.language === "zh"
          ? member.profession?.zh
          : member.profession?.en;
        if (profession !== undefined && profession !== "") {
          line += `: ${profession}`;
        }
        if (member.role !== undefined && member.role !== "") {
          line += ` [${member.role}]`;
        }
        lines.push(line);
      }
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
      this.#host.controller.resetContextUsage();
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

  /** Forks the current session into a child branch (Go forkCurrentSession). */
  async forkSession(): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionID = this.#host.currentSessionID();
    if (sessionID === "") {
      return { message: tr.text("sessions.no_match", ""), error: true };
    }
    try {
      const result = fork(this.#host.manager.getSessionDir(), {
        sourceSessionId: sessionID,
        requestId: `tui-fork-${crypto.randomUUID()}`,
        titleMode: "",
      });
      const child = openSession(
        this.#host.manager.getSessionDir(),
        result.sessionId,
      );
      await this.#host.bindManager(child);
      this.#host.controller.store.resetTranscriptState();
      this.#host.controller.resetContextUsage();
      const detail = listForDirDetailed(
        this.#host.workDir,
        this.#host.manager.getSessionDir(),
      ).find((d) => d.id === result.sessionId);
      return {
        message: tr.text(
          "sessions.switched",
          result.sessionId,
          detail?.messageCount ?? 0,
        ),
      };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
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
      this.#host.controller.resetContextUsage();
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
      this.#host.controller.resetContextUsage();
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

  /** Cancels an active workflow run (Go handleWorkflowsCommand cancel). */
  cancelWorkflow(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    const target = id.trim();
    if (!defaultActiveRegistry().cancel(target)) {
      return Promise.resolve({
        message: tr.text("workflows.not_active", target),
        error: true,
      });
    }
    return Promise.resolve({
      message: tr.text("workflows.cancel_requested", target),
    });
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
    // Go: pause/resume/clear cannot mutate an active run; only objective
    // creation, edit, and guide may update while the agent is thinking.
    if (
      this.#host.controller.isThinking &&
      (sub === "pause" || sub === "resume" || sub === "clear")
    ) {
      return {
        message:
          "Only /esm <objective>, /esm edit, and /esm guide may update an active run. " +
          "Pause, resume, and clear require the current run to finish or be aborted.",
        error: true,
      };
    }
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
          if (rest !== "") {
            return {
              message: tr.text("commands.usage", "/esm pause"),
              error: true,
            };
          }
          store.pause(sessionID);
          return { message: this.#formatESM(store.get(sessionID)) };
        case "resume":
          if (rest !== "") {
            return {
              message: tr.text("commands.usage", "/esm resume"),
              error: true,
            };
          }
          store.resume(sessionID);
          this.#host.startESMContinuationIfIdle();
          return { message: this.#formatESM(store.get(sessionID)) };
        case "guide":
          if (rest === "") {
            return {
              message: tr.text("commands.usage", "/esm guide <text>"),
              error: true,
            };
          }
          store.addGuidance(sessionID, rest);
          this.#host.startESMContinuationIfIdle();
          return { message: "Guidance queued for the next ESM role run." };
        case "clear":
          if (rest !== "") {
            return {
              message: tr.text("commands.usage", "/esm clear"),
              error: true,
            };
          }
          store.clear(sessionID);
          this.#host.abortESMWorker();
          return { message: "Enable Supervisor Mode cleared." };
        default:
          store.create(sessionID, raw);
          this.#host.startESMContinuationIfIdle();
          return { message: this.#formatESM(store.get(sessionID)) };
      }
    } catch (err) {
      return { message: this.#formatESMError(err), error: true };
    }
  }

  /** Maps ESM store errors to the Go command messages. */
  #formatESMError(err: unknown): string {
    if (err instanceof EsmObjectiveNotFoundError) {
      return "No ESM objective. Create one with /esm <objective>.";
    }
    if (err instanceof EsmObjectiveExistsError) {
      return "An unfinished ESM objective already exists. Use /esm edit <objective> or /esm clear.";
    }
    if (err instanceof EsmInvalidObjectiveError) {
      return "ESM objective cannot be empty.";
    }
    if (err instanceof EsmInvalidTransitionError) {
      return "ESM status cannot be changed that way.";
    }
    return (err as Error).message;
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
        message: [
          tr.text(
            "allowautoedit.status",
            getAutoEdit(allow) ? "ON" : "OFF",
          ),
          tr.text("commands.usage", "/allowautoedit [on|off] [global]"),
        ].join("\n"),
      };
    }
    const globalScope = parts.slice(2).includes("global");
    let enable: boolean;
    if (parts[1] === "on") enable = true;
    else if (parts[1] === "off") enable = false;
    else {
      return {
        message: tr.text("commands.usage", "/allowautoedit [on|off] [global]"),
        error: true,
      };
    }
    try {
      let effective = enable;
      const scope = globalScope ? "global" : "project";
      if (globalScope) {
        effective = setGlobalAutoEdit(allow, enable);
        saveGlobalAutoEditValue(enable);
      } else {
        setProjectAutoEdit(allow, enable);
        saveProject(allow);
      }
      let msg = `Auto-edit (agent mode): ${enable ? "ON" : "OFF"} [${scope}]`;
      if (globalScope && effective !== enable) {
        msg += ` (effective here: ${
          effective ? "ON" : "OFF"
        } due to project override)`;
      }
      return { message: msg };
    } catch (err) {
      return {
        message: tr.text("alloweditpath.save_failed", (err as Error).message),
        error: true,
      };
    }
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
      case "on":
        return this.#enableDelegate();
      case "off":
        this.#host.runtime.registry?.remove("delegate_subagent");
        this.#delegateMode = false;
        return { message: tr.text("delegate.changed", "OFF") };
      default:
        return {
          message: tr.text("commands.usage", "/delegate [on|off|status]"),
          error: true,
        };
    }
  }

  /** Registers the blocking delegate tool on the shared AgentManager. */
  #enableDelegate(): CommandResult {
    const tr = this.#tr();
    const runtime = this.#host.runtime;
    if (runtime.registry === null) {
      return { message: tr.text("agent.manager_unavailable"), error: true };
    }
    try {
      registerDelegateSubAgentTool(
        runtime.registry,
        this.#host.ensureAgentManager(),
      );
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
    this.#delegateMode = true;
    return { message: tr.text("delegate.changed", "ON") };
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
    const sub = (parts[1] ?? "status").toLowerCase();
    switch (sub) {
      case "status":
        return this.#statusLineStatus();
      case "on":
      case "off":
        return this.#statusLineToggle(sub === "on", parts[2] ?? "project");
      case "command":
        return this.#statusLineCommand(parts);
      case "refresh":
        return this.#statusLineRefresh(parts);
      default:
        return {
          message: tr.text(
            "commands.usage",
            "/statusline [status|on|off|command|refresh] ...",
          ),
          error: true,
        };
    }
  }

  /** Renders the status-line configuration (Go showStatusLineStatus). */
  #statusLineStatus(): CommandResult {
    const cfg = this.#host.settings.statusLine ?? {};
    if (cfg.enabled !== true) {
      return { message: "Status line: OFF\nFooter: builtin" };
    }
    const lines = [
      "Status line: ON",
      `  Type: ${cfg.type ?? "command"}`,
      `  Command: ${(cfg.command ?? "").trim() || "ccstatusline"}`,
      `  Timeout: ${cfg.timeoutMs ?? 800}ms`,
      cfg.refreshInterval !== undefined && cfg.refreshInterval > 0
        ? `  Refresh: ${cfg.refreshInterval}s`
        : "  Refresh: event-driven",
    ];
    return { message: lines.join("\n") };
  }

  /** Toggles the status line on/off in a project/global scope. */
  #statusLineToggle(enabled: boolean, scopeRaw: string): CommandResult {
    const tr = this.#tr();
    const scope = scopeRaw.toLowerCase();
    if (scope !== "project" && scope !== "global") {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline [status|on|off] [project|global]",
        ),
        error: true,
      };
    }
    const current = this.#host.settings.statusLine ?? {};
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
      if (scope === "global") saveGlobalSettingsPatch({ statusLine: next });
      else saveProjectSettingsPatch({ statusLine: next });
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

  /** Sets the status-line command (Go setStatusLineCommand). */
  #statusLineCommand(parts: string[]): CommandResult {
    const tr = this.#tr();
    if (parts.length < 3) {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline command <cmd> [project|global]",
        ),
        error: true,
      };
    }
    let scope = "project";
    let end = parts.length;
    const last = parts[parts.length - 1].toLowerCase();
    if (last === "project" || last === "global") {
      scope = last;
      end--;
    }
    const cmd = parts.slice(2, end).join(" ").trim();
    if (cmd === "") {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline command <cmd> [project|global]",
        ),
        error: true,
      };
    }
    const current = this.#host.settings.statusLine ?? {};
    const next = {
      ...current,
      type: "command",
      command: cmd,
      timeoutMs: current.timeoutMs ?? 800,
      fallback: current.fallback ?? "builtin",
    };
    try {
      if (scope === "global") saveGlobalSettingsPatch({ statusLine: next });
      else saveProjectSettingsPatch({ statusLine: next });
      this.#host.settings.statusLine = next;
    } catch (err) {
      return {
        message: tr.text("statusline.failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: `Status line command updated (${scope} settings): ${cmd}`,
    };
  }

  /** Sets the status-line refresh interval in seconds (Go setStatusLineRefresh). */
  #statusLineRefresh(parts: string[]): CommandResult {
    const tr = this.#tr();
    if (parts.length < 3) {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline refresh <sec> [project|global]",
        ),
        error: true,
      };
    }
    let scope = "project";
    if (parts.length > 3) {
      const last = parts[parts.length - 1].toLowerCase();
      if (last === "project" || last === "global") scope = last;
    }
    const refresh = Number.parseInt(parts[2], 10);
    if (Number.isNaN(refresh) || refresh < 0 || refresh > 60) {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline refresh <0-60> [project|global]",
        ),
        error: true,
      };
    }
    const current = this.#host.settings.statusLine ?? {};
    const next = { ...current, refreshInterval: refresh };
    try {
      if (scope === "global") saveGlobalSettingsPatch({ statusLine: next });
      else saveProjectSettingsPatch({ statusLine: next });
      this.#host.settings.statusLine = next;
    } catch (err) {
      return {
        message: tr.text("statusline.failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: refresh === 0
        ? `Status line refresh updated (${scope} settings): event-driven`
        : `Status line refresh updated (${scope} settings): ${refresh}s`,
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
          return { message: `Installed ${result.name}` };
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
          return { message: `Uninstalled ${id}` };
        }
        case "skillset": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub skillset <market>/<id>... [--global|--project|--activate]",
              ),
              error: true,
            };
          }
          let scope = this.#skillHubScope();
          let activate = false;
          const requests: Array<{
            market: Market;
            id: string;
            scope: string;
            targetDir: string;
          }> = [];
          for (const value of parts.slice(2)) {
            if (value === "--global") {
              scope = "global";
              continue;
            }
            if (value === "--project") {
              scope = "project";
              continue;
            }
            if (value === "--activate") {
              activate = true;
              continue;
            }
            const { market, id } = TuiCommands.#parseSkillHubID(value);
            requests.push({
              market: market as Market,
              id,
              scope,
              targetDir: this.#skillHubTargetDir(),
            });
          }
          const results = await service.installSkillSet(undefined, requests);
          if (activate) {
            for (const result of results) {
              this.activateSkill(result.name);
            }
          }
          return {
            message: `Installed ${results.length} skills${
              activate ? " and activated them in the current session" : ""
            }.`,
          };
        }
        case "installed": {
          const index = newLocalIndex(
            this.#skillHubTargetDir(),
            projectSkillDirs(this.#host.workDir),
          );
          const states = index.list();
          if (states.length === 0) {
            return { message: "No marketplace skills installed." };
          }
          const lines = ["Installed marketplace skills:"];
          for (const state of states) {
            lines.push(
              `  ${state.dir} (${state.scope}, ${state.version})`,
            );
          }
          return { message: lines.join("\n") };
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
        for (const row of byProvider.slice(0, 5)) {
          const label = row.vendor === "" ? "-" : row.vendor;
          lines.push(
            `  ${label}  req:${row.requests}  in:${row.inputTokens}  out:${row.outputTokens}  total:${row.totalTokens}`,
          );
        }
      }
      const byModel = db.byModel({});
      if (byModel.length > 0) {
        lines.push("", tr.text("stats.by_model"));
        for (const row of byModel.slice(0, 5)) {
          const label = row.model !== "" ? row.model : (row.label || "-");
          lines.push(
            `  ${label}  req:${row.requests}  in:${row.inputTokens}  out:${row.outputTokens}  total:${row.totalTokens}`,
          );
        }
      }
      const recent = db.recent(1, 10);
      if (recent.items.length > 0) {
        lines.push("", tr.text("stats.recent"));
        for (const item of recent.items) {
          const t =
            item.timestamp?.toISOString().slice(0, 16).replace("T", " ") ??
              "-";
          lines.push(
            `  ${t}  ${item.vendor || "-"}  ${
              item.model || "-"
            }  in:${item.inputTokens} out:${item.outputTokens}  ${
              formatStatsDuration(item.durationMs)
            }`,
          );
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

  // --- Agents ---------------------------------------------------------------

  /**
   * Lists agents (Go listAgents). The TUI has no Runtime AgentManager wired
   * yet, so this mirrors Go's nil-manager path exactly.
   */
  listAgents(): string {
    const tr = this.#tr();
    const lines = [tr.text("agent.multi_status", "main")];
    let manager: AgentManager;
    try {
      manager = this.#host.ensureAgentManager();
    } catch {
      lines.push(`  ${tr.text("agent.manager_unavailable")}`);
      return lines.join("\n");
    }
    const ids = manager.list();
    if (ids.length === 0) {
      lines.push(`  ${tr.text("agent.no_agents")}`);
      return lines.join("\n");
    }
    for (const id of ids) {
      const [parentID, hasParent] = manager.parent(id);
      const childCount = manager.childrenOf(id).length;
      let info = `  ${id} [running]`;
      if (hasParent) info += ` parent=${parentID}`;
      if (childCount > 0) info += ` children=${childCount}`;
      lines.push(info);
    }
    return lines.join("\n");
  }

  /** Switches the focused agent (Go switchAgent). */
  async switchAgent(id: string): Promise<CommandResult> {
    await Promise.resolve();
    const tr = this.#tr();
    let manager: AgentManager;
    try {
      manager = this.#host.ensureAgentManager();
    } catch {
      return { message: tr.text("agent.manager_unavailable"), error: true };
    }
    const [, ok] = manager.get(id);
    if (!ok) return { message: tr.text("agent.not_found", id), error: true };
    this.#activeAgent = id;
    return { message: tr.text("agent.focused", id) };
  }

  /** Destroys a sub-agent (Go destroyAgent). */
  async destroyAgent(id: string): Promise<CommandResult> {
    await Promise.resolve();
    const tr = this.#tr();
    let manager: AgentManager;
    try {
      manager = this.#host.ensureAgentManager();
    } catch {
      return { message: tr.text("agent.manager_unavailable"), error: true };
    }
    try {
      manager.destroy(id);
    } catch {
      return { message: tr.text("agent.not_found", id), error: true };
    }
    return { message: tr.text("agent.destroyed", id) };
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

/** Formats a duration like the Go stats overlay (e.g. "350ms", "1.5s"). */
function formatStatsDuration(ms: number): string {
  if (ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export { defaultActiveRegistry, registerDelegateSubAgentTool, saveEnv };
