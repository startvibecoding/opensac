// Ported from internal/tui/i18n: language resolution (language.go), the
// immutable Translator with fallback chain zh → en → message id (catalog.go),
// and the bilingual message catalogs (messages.go).
//
// The catalogs are populated per TUI component slice, mirroring the Go
// bundle's message IDs exactly; missing keys fall back to English and then to
// the raw ID, so partial tables are safe during migration.

/** The settings value: "auto" | "zh" | "en". */
export type ConfiguredLanguage = "auto" | "zh" | "en";
/** A render-time language: always "zh" or "en". */
export type Language = "zh" | "en";

/** Stable message identifier (mirrors the Go i18n MessageID constants). */
export type MessageID = string;

/** Parses a settings value; unknown values fall back to auto (valid=false). */
export function parseConfigured(
  value: string,
): { configured: ConfiguredLanguage; valid: boolean } {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "auto") {
    return { configured: "auto", valid: true };
  }
  if (normalized === "zh") return { configured: "zh", valid: true };
  if (normalized === "en") return { configured: "en", valid: true };
  return { configured: "auto", valid: false };
}

/**
 * Resolves a configured language using the current UTC offset: zh when the
 * zone is UTC+8, en otherwise (Go i18n.Resolve). A null timezone falls back
 * to en.
 */
export function resolveLanguage(
  configured: ConfiguredLanguage,
  now: Date,
  timeZone: string | null,
): Language {
  if (configured === "zh") return "zh";
  if (configured === "en") return "en";
  if (timeZone === null) return "en";
  return utcOffsetHours(now, timeZone) === 8 ? "zh" : "en";
}

/** Formats the zone offset as "UTC+08:00" / "UTC-05:30" ("unknown" if null). */
export function utcOffset(now: Date, timeZone: string | null): string {
  if (timeZone === null) return "unknown";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = formatter.formatToParts(now).find(
    (p) => p.type === "timeZoneName",
  )?.value ?? "";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part);
  if (m === null) return "unknown";
  return `UTC${m[1]}${m[2]}:${m[3]}`;
}

/**
 * The host's local IANA zone (Go time.Local); null when the runtime cannot
 * resolve one (Go falls back to UTC, which Resolve treats as non-UTC+8).
 */
export function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function utcOffsetHours(now: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = formatter.formatToParts(now).find(
    (p) => p.type === "timeZoneName",
  )?.value ?? "";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
  if (m === null) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) + Number(m[3] ?? "0") / 60);
}

/** Minimal Go fmt.Sprintf subset used by message catalogs: %s %d %v %% %0Nd. */
export function sprintf(format: string, args: unknown[] = []): string {
  let argIndex = 0;
  return format.replace(
    /%((\d+)[dv]|[sdv%])/g,
    (match: string, _outer: string, innerDigits: string | undefined) => {
      if (match === "%%") return "%";
      const arg = args[argIndex++];
      if (match.endsWith("d")) {
        const n = Math.trunc(Number(arg));
        if (innerDigits !== undefined) {
          const width = Number(innerDigits);
          const body = String(Math.abs(n)).padStart(width, "0");
          return n < 0 ? `-${body}` : body;
        }
        return String(n);
      }
      return String(arg);
    },
  );
}

/**
 * Bilingual catalogs. Message IDs and texts mirror the Go bundle exactly;
 * populate per component slice during migration.
 */
export const catalogs: Record<Language, Record<MessageID, string>> = {
  en: {
    "tool.modal.state.running": "running",
    "tool.modal.state.ready": "ready",
    "tool.modal.state.done": "done",
    "tool.modal.state.error": "error",
    "tool.modal.state.canceled": "canceled",
    "tool.modal.state.unknown": "unknown",
    "tool.modal.agent_tab": "[ %s %s ]",
    "tool.modal.main": "Main",
    "tool.modal.title": "Agent details",
    "tool.modal.position": "lines %d-%d/%d",
    "tool.modal.position_empty": "lines 0-0/0",
    "tool.modal.switch_target_hint": "Left/Right:switch target",
    "tool.modal.page_hint": "PgUp/PgDn:page",
    "tool.modal.scroll_hint": "Up/Down:scroll",
    "tool.modal.close_hint": "Esc:close",
    "activity.hosted_item": "hosted item",
    "activity.tool_started": "tool started: %s",
    "activity.tool_result": "tool result",
    "activity.done": "done",
    "activity.error": "error: %s",
    "activity.canceled": "canceled",
    "activity.no_activity": "no activity captured yet",
    "activity.latest_tool": "Latest tool:",
    "activity.thinking": "Thinking:",
    "activity.response": "Response:",
    "activity.latest_result": "Latest result:",
    "activity.timeline": "Activity timeline:",
    "activity.updated": "updated %s",
    "tool.result.lines": "%d lines",
    "tool.result.applied": "Applied",
    "activity.ago_seconds": "%ds ago",
    "activity.ago_minutes": "%dm ago",
    "esm.panel.load_failed": "Failed to load ESM progress: %v",
    "esm.panel.no_objective":
      "No Enable Supervisor Mode objective for this session.",
    "esm.panel.create_hint": "Create one with /esm <objective>.",
    "esm.panel.title": "Enable Supervisor Mode",
    "esm.panel.now": "Now: %s",
    "esm.panel.next": "Next: %s",
    "esm.panel.status": "Status: %s",
    "esm.panel.stage": "Stage: %s",
    "esm.panel.pipeline": "Pipeline: %s",
    "esm.panel.objective": "Objective",
    "esm.panel.latest_worker_progress": "Latest worker progress",
    "esm.panel.remaining_work": "Remaining work (%d):",
    "esm.panel.blocker": "Blocker",
    "esm.panel.repeated_blocker_audit": "Repeated blocker audit: %d/3",
    "esm.panel.latest_completion_review": "Latest completion review",
    "esm.panel.completion_rejections": "Consecutive completion rejections: %d",
    "esm.panel.automatic_recoveries": "Consecutive automatic recoveries: %d",
    "esm.panel.latest_recovery_reason": "Latest recovery reason",
    "esm.panel.completion_candidate": "Completion candidate",
    "esm.panel.live_details": "Live details:",
    "esm.panel.tokens": "Tokens: %d",
    "esm.panel.time": "Time: %s",
    "esm.panel.last_saved": "Last saved update: %s",
    "esm.panel.subagent_starting": "sub-agent is starting",
    "esm.panel.latest_tool": "latest tool: %s",
    "esm.panel.latest_result": "latest result: %s",
    "esm.panel.latest_response": "latest response: %s",
    "esm.panel.thinking": "Thinking: %s",
    "esm.panel.no_further_work": "No further ESM work is scheduled",
    "esm.panel.progress": "Progress: %d/3 pipeline stages completed",
    "esm.panel.work_remaining": "; %d work item(s) remaining",
    "esm.panel.activity_starting": "  %s [starting]",
    "esm.panel.activity_state": "  %s [%s]",
    "esm.panel.tool": "  Tool: %s",
    "esm.panel.latest": "  Latest: %s",
    "esm.panel.phase.critic_review": "Critic review",
    "esm.panel.phase.final_audit": "Final audit",
    "esm.panel.phase.complete": "Complete",
    "esm.panel.phase.worker_execution": "Worker execution",
    "esm.panel.activity.paused": "ESM is paused",
    "esm.panel.activity.blocked": "ESM is blocked",
    "esm.panel.activity.usage_limited":
      "ESM is waiting for the provider limit to clear",
    "esm.panel.activity.audit_passed": "The objective has passed final audit",
    "esm.panel.activity.critic_reviewing":
      "Critic is independently reviewing the worker evidence",
    "esm.panel.activity.auditing":
      "Audit is independently verifying completion",
    "esm.panel.activity.worker_investigating":
      "Worker is investigating and implementing the objective",
    "esm.panel.next.paused":
      "Review the outstanding work, then run /esm resume",
    "esm.panel.next.blocked": "Resolve the blocker, then run /esm resume",
    "esm.panel.next.usage_limited":
      "Resolve the provider usage limit, then run /esm resume",
    "esm.panel.next.complete": "No further ESM work is scheduled",
    "esm.panel.next.critic":
      "A passing critic review advances the candidate to final audit",
    "esm.panel.next.audit":
      "A passing audit marks the objective complete; a failure returns it to the worker",
    "esm.panel.next.worker":
      "Worker will record concrete progress and remaining work before the next run",
    "esm.panel.shortcut_hint":
      "Up/Down:scroll  PgUp/PgDn:page  Ctrl+E/Esc:close",
    "esm.panel.position": "lines %d-%d/%d",
    "esm.panel.position_empty": "lines 0-0/0",
    "input.placeholder": "Type a message...",
    "commands.title": "Commands:",
    "commands.mode.description":
      "Switch or show execution mode (plan/agent/yolo/os)",
    "commands.esm.description": "Enable or inspect Supervisor Mode",
    "commands.model.description": "Switch or show model",
    "commands.default_model.description": "Set the default provider/model",
    "commands.auth.description":
      "Configure provider token, base URL and models",
    "commands.settings.description":
      "Configure settings.json groups, including providers",
    "commands.tuilang.description": "Set the TUI language (global by default)",
    "commands.skills.description": "List available skills",
    "commands.skillhub.description":
      "Browse, search and install marketplace skills",
    "commands.env.description": "Manage extra environment variables",
    "commands.skill.description": "Activate a skill",
    "commands.paste_image.description":
      "Save a clipboard image and insert its local path",
    "commands.clear.description": "Clear conversation",
    "commands.compact.description": "Trigger context compaction",
    "commands.sessions.description": "List, switch, create or delete sessions",
    "commands.expert.description":
      "List, inspect, bind or fork-switch expert personas",
    "commands.init_mcp.description": "Initialize mcp.json",
    "commands.mcps.description": "List MCP servers",
    "commands.delegate.description": "Toggle delegation mode",
    "commands.browser.description": "Toggle browser automation",
    "commands.stats.description": "Manage or display usage statistics",
    "commands.statusline.description": "Inspect or toggle the TUI status line",
    "commands.alloweditpath.description": "Manage the auto-edit path whitelist",
    "commands.allowautoedit.description": "Toggle full auto-edit in agent mode",
    "commands.btw.description":
      "Ask a side question without touching the main task",
    "commands.systeminit.description": "Generate or refresh AGENTS.md",
    "commands.rule.description": "Create safe default project rules",
    "commands.reload.description":
      "Restart as a fresh process with a new session",
    "commands.workflows.description": "Inspect workflow runs",
    "commands.agent.description": "Manage multi-agent workers",
    "commands.cron.description": "Manage scheduled tasks",
    "commands.quit.description": "Exit",
    "commands.help.description": "Show this help",
  },
  zh: {
    "tool.modal.state.running": "运行中",
    "tool.modal.state.ready": "就绪",
    "tool.modal.state.done": "完成",
    "tool.modal.state.error": "错误",
    "tool.modal.state.canceled": "已取消",
    "tool.modal.state.unknown": "未知",
    "tool.modal.agent_tab": "[ %s %s ]",
    "tool.modal.main": "主界面",
    "tool.modal.title": "Agent 详情",
    "tool.modal.position": "第 %d-%d/%d 行",
    "tool.modal.position_empty": "第 0-0/0 行",
    "tool.modal.switch_target_hint": "←/→：切换目标",
    "tool.modal.page_hint": "PgUp/PgDn：翻页",
    "tool.modal.scroll_hint": "↑/↓：滚动",
    "tool.modal.close_hint": "Esc：关闭",
    "activity.hosted_item": "托管项目",
    "activity.tool_started": "工具已开始：%s",
    "activity.tool_result": "工具结果",
    "activity.done": "完成",
    "activity.error": "错误：%s",
    "activity.canceled": "已取消",
    "activity.no_activity": "暂无活动记录",
    "activity.latest_tool": "最新工具：",
    "activity.thinking": "思考：",
    "activity.response": "回复：",
    "activity.latest_result": "最新结果：",
    "activity.timeline": "活动时间线：",
    "activity.updated": "更新于 %s",
    "tool.result.lines": "%d 行",
    "tool.result.applied": "已应用",
    "activity.ago_seconds": "%d 秒前",
    "activity.ago_minutes": "%d 分钟前",
    "esm.panel.load_failed": "加载 ESM 进度失败：%v",
    "esm.panel.no_objective": "此会话没有 Enable Supervisor Mode 目标。",
    "esm.panel.create_hint": "使用 /esm <objective> 创建目标。",
    "esm.panel.title": "Enable Supervisor Mode",
    "esm.panel.now": "当前：%s",
    "esm.panel.next": "下一步：%s",
    "esm.panel.status": "状态：%s",
    "esm.panel.stage": "阶段：%s",
    "esm.panel.pipeline": "流水线：%s",
    "esm.panel.objective": "目标",
    "esm.panel.latest_worker_progress": "Worker 最新进度",
    "esm.panel.remaining_work": "剩余工作（%d）：",
    "esm.panel.blocker": "阻塞原因",
    "esm.panel.repeated_blocker_audit": "重复阻塞审计：%d/3",
    "esm.panel.latest_completion_review": "最新完成审查",
    "esm.panel.completion_rejections": "连续完成拒绝：%d",
    "esm.panel.automatic_recoveries": "连续自动恢复：%d",
    "esm.panel.latest_recovery_reason": "最新恢复原因",
    "esm.panel.completion_candidate": "完成候选",
    "esm.panel.live_details": "实时详情：",
    "esm.panel.tokens": "Token：%d",
    "esm.panel.time": "时间：%s",
    "esm.panel.last_saved": "最近保存更新：%s",
    "esm.panel.subagent_starting": "子 Agent 正在启动",
    "esm.panel.latest_tool": "最新工具：%s",
    "esm.panel.latest_result": "最新结果：%s",
    "esm.panel.latest_response": "最新回复：%s",
    "esm.panel.thinking": "思考：%s",
    "esm.panel.no_further_work": "没有安排更多 ESM 工作",
    "esm.panel.progress": "进度：已完成 %d/3 个流水线阶段",
    "esm.panel.work_remaining": "；剩余 %d 项工作",
    "esm.panel.activity_starting": "  %s [启动中]",
    "esm.panel.activity_state": "  %s [%s]",
    "esm.panel.tool": "  工具：%s",
    "esm.panel.latest": "  最新：%s",
    "esm.panel.phase.critic_review": "Critic 审查",
    "esm.panel.phase.final_audit": "最终审计",
    "esm.panel.phase.complete": "已完成",
    "esm.panel.phase.worker_execution": "Worker 执行",
    "esm.panel.activity.paused": "ESM 已暂停",
    "esm.panel.activity.blocked": "ESM 已阻塞",
    "esm.panel.activity.usage_limited": "ESM 正在等待 Provider 限制解除",
    "esm.panel.activity.audit_passed": "目标已通过最终审计",
    "esm.panel.activity.critic_reviewing": "Critic 正在独立审查 Worker 证据",
    "esm.panel.activity.auditing": "Audit 正在独立验证完成状态",
    "esm.panel.activity.worker_investigating": "Worker 正在调查并实现目标",
    "esm.panel.next.paused": "检查未完成工作后运行 /esm resume",
    "esm.panel.next.blocked": "解决阻塞原因后运行 /esm resume",
    "esm.panel.next.usage_limited": "解决 Provider 使用限制后运行 /esm resume",
    "esm.panel.next.complete": "没有安排更多 ESM 工作",
    "esm.panel.next.critic": "通过 Critic 审查后将进入最终审计",
    "esm.panel.next.audit": "通过审计后目标完成；失败则返回 Worker",
    "esm.panel.next.worker": "Worker 将在下次运行前记录具体进度和剩余工作",
    "esm.panel.shortcut_hint": "上/下：滚动  PgUp/PgDn：翻页  Ctrl+E/Esc：关闭",
    "esm.panel.position": "行 %d-%d/%d",
    "esm.panel.position_empty": "行 0-0/0",
    "input.placeholder": "输入消息...",
    "commands.title": "命令：",
    "commands.mode.description": "切换或显示执行模式（plan/agent/yolo/os）",
    "commands.esm.description": "启用或查看 Supervisor Mode",
    "commands.model.description": "切换或显示模型",
    "commands.default_model.description": "设置默认 Provider/模型",
    "commands.auth.description": "配置 Provider token、Base URL 和模型",
    "commands.settings.description": "配置 settings.json 设置组，包括 Provider",
    "commands.tuilang.description": "设置 TUI 语言（默认全局）",
    "commands.skills.description": "列出可用 Skill",
    "commands.skillhub.description": "浏览、搜索并安装市场 Skill",
    "commands.env.description": "管理额外环境变量",
    "commands.skill.description": "启用 Skill",
    "commands.paste_image.description": "保存剪贴板图片并插入本地路径",
    "commands.clear.description": "清空会话",
    "commands.compact.description": "触发上下文压缩",
    "commands.sessions.description": "列出、切换、新建或删除会话",
    "commands.expert.description": "列出、查看、绑定或通过分叉切换主角人设",
    "commands.init_mcp.description": "初始化 mcp.json",
    "commands.mcps.description": "列出 MCP 服务器",
    "commands.delegate.description": "切换委派模式",
    "commands.browser.description": "切换浏览器自动化工具",
    "commands.stats.description": "管理或显示用量统计",
    "commands.statusline.description": "查看或切换 TUI 状态栏",
    "commands.alloweditpath.description": "管理自动编辑路径白名单",
    "commands.allowautoedit.description": "切换 agent 模式完整自动编辑",
    "commands.btw.description": "提问旁支问题，不影响主任务",
    "commands.systeminit.description": "生成或刷新 AGENTS.md",
    "commands.rule.description": "创建安全的默认项目规则",
    "commands.reload.description": "以新会话重启进程",
    "commands.workflows.description": "查看 Workflow 运行",
    "commands.agent.description": "管理多 Agent 工作器",
    "commands.cron.description": "管理定时任务",
    "commands.quit.description": "退出",
    "commands.help.description": "显示此帮助",
  },
};

/** Immutable Translator, safe to share across TUI components. */
export class Translator {
  #language: Language;

  constructor(language: Language) {
    this.#language = language !== "zh" ? "en" : "zh";
  }

  /** Creates a Translator from the settings value, resolved once. */
  static fromConfig(
    value: string,
    now: () => Date = () => new Date(),
    timeZone: string | null = null,
  ): {
    translator: Translator;
    configured: ConfiguredLanguage;
    valid: boolean;
  } {
    const { configured, valid } = parseConfigured(value);
    return {
      translator: new Translator(resolveLanguage(configured, now(), timeZone)),
      configured,
      valid,
    };
  }

  get language(): Language {
    return this.#language;
  }

  /** Formats a message: zh → en → raw id fallback, then sprintf. */
  text(id: MessageID, ...args: unknown[]): string {
    let text = catalogs[this.#language][id];
    if (text === undefined || text === "") {
      text = catalogs.en[id];
    }
    if (text === undefined || text === "") {
      text = id;
    }
    if (args.length === 0) return text;
    return sprintf(text, args);
  }
}
