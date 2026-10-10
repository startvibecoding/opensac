// Interactive TUI session state: the assembly of controller + input state +
// run lifecycle for the root interactive action, plus the CommandHost that the
// slash-command dispatcher mutates through.
//
// The session is the TUI's service projection. It owns no Agent construction,
// session persistence, provider construction, or tool registry: every command
// goes through the shared `TUIService` (Core-owned session/run semantics) plus
// UI-only config helpers (allow rules).

import { isProjectDir, loadAllow } from "../config/mod.ts";
import {
  EVENT_QUESTION_REQUEST,
  EVENT_RUN_FINISHED,
  EVENT_TOOL_APPROVAL_REQUEST,
} from "../agentruntime/events.ts";
import {
  type TUICoreConnectionState,
  type TUIDecisionAnswer,
  type TUIDecisionRequest,
  type TUIPreparedInput,
  type TUIService,
  type TUISessionView,
  type TUISettingsView,
  type TUITranscriptMessage} from "./service.ts";
import { SOURCE_TUI } from "../agentruntime/source.ts";
import {
  isDecisionNotFound,
  isSessionNotFound,
  isSessionNotResident,
} from "./service.ts";
import { coreEventToAgentEvent } from "./run_event_projection.ts";
import { type CoreRuntimeEvent } from "../core/runtime.ts";
import { AppController } from "./app_controller.ts";
import { TuiRun } from "./tui_run.ts";
import { localTimeZone, Translator } from "./i18n.ts";
import { InputState } from "./input_state.ts";
import { ToolModalState, type ToolModalTarget } from "./tool_modal.ts";
import {
  type ModalBlock,
  ModalContentCache,
  type ModalContentView,
} from "./modal_content.ts";
import { renderTaskPlanLines } from "./plan_view.ts";
import { type AgentActivity, renderAgentActivity } from "./activity.ts";
import { type TaskPlan } from "../tools/tool.ts";
import { expandedToolRow } from "./tool_row_format.ts";
import {
  esmObjectiveFromView,
  esmPanelLines,
  esmPanelWidth,
} from "./esm_panel.ts";
import {
  type CommandHost,
  type CommandResult,
  dispatchCommand,
} from "./commands.ts";
import { TuiCommands } from "./tui_commands.ts";
import {
  installedEntries,
  SkillHubPanel,
  type SkillHubPanelHost,
} from "./skillhub_panel.ts";
import { SkillMgrPanel, type SkillMgrPanelHost } from "./skillmgr_panel.ts";
import {
  clientsForSettings,
  Service as SkillHubService,
} from "../skillhub/mod.ts";
import {
  defaultSkillHubOfficialHandle,
  getGlobalSkillsDir,
  type Settings,
} from "../config/settings.ts";
import { projectSkillDirs } from "../skills/skills.ts";
import { TuiSessionCommands } from "./tui_session_commands.ts";
import {
  AuthDialog,
  DefaultModelDialog,
  type DialogHost,
  EnvDialog,
  ModelDialog,
  SessionsDialog,
  SettingsDialog,
  TuiLangDialog,
} from "./dialogs.ts";
import { clampWidth, Dialog, frame } from "./dialog.ts";
import { ACCENT, BOLD, DIM, RED, RESET } from "./theme.ts";
import { type AppProps } from "./app.tsx";
import { type Objective } from "../esm/state.ts";
import { type KeyEvent, splitInputChunk } from "./keys.ts";
import { displayWidth } from "./formatters.ts";

export interface TUISessionOptions {
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  workDir: string;
  version: string;
  multiAgent?: boolean;
  /** Configured TUI language (empty resolves to auto). */
  tuilang?: string;
  /**
   * How long a confirmed Core reconnect stays in the live view before it
   * clears itself. Defaults to three seconds.
   */
  coreReconnectNoticeMs?: number;
  /**
   * Continue the most recent persisted session of this working directory
   * (`-c`) instead of starting a fresh one.
   */
  continueLast?: boolean;
  /**
   * Resume one specific persisted session by id, session file, or directory
   * (`-r` / `--session`). Wins over `continueLast`.
   */
  resumeSession?: string;
}

/** How long a confirmed Core reconnect stays in the live view. */
const CORE_RECONNECT_NOTICE_MS = 3_000;

/**
 * Whether a `-r`/`--session` target names a directory rather than a session id.
 *
 * The flag documents both forms, so the entry has to tell them apart. A path
 * separator or a leading `.`/`~` is decisive; a bare token is treated as an id,
 * which is what `opensac -r abc123` means.
 */
export function isDirectoryTarget(target: string): boolean {
  const value = target.trim();
  if (value === "") return false;
  if (value === "." || value === "..") return true;
  if (value.startsWith("~/")) return true;
  // Backslash counts too: a Windows path is the common case for this flag.
  return value.includes("/") || value.includes("\\");
}

/** Resolves the session translator from settings (Go NewApp). */
export function tuiTranslatorFromSettings(settings: {
  tuilang?: string;
}): Translator {
  const { translator, valid } = Translator.fromConfig(
    settings.tuilang ?? "",
    () => new Date(),
    localTimeZone(),
  );
  if (!valid) {
    console.error(
      `Warning: invalid tuilang ${
        JSON.stringify(settings.tuilang)
      }; using auto`,
    );
  }
  return translator;
}

/** One interactive TUI session. */
export class TUISession implements CommandHost {
  readonly controller: AppController;
  readonly input: InputState;
  readonly header: NonNullable<AppProps["header"]>;
  readonly translator: Translator;
  #providerName: string;
  #modelID: string;
  #mode: string;
  #thinking: string;
  #workDir: string;
  #coreReconnectNoticeMs: number;
  /** Continue the most recent persisted session on startup (`-c`). */
  #continueLast = false;
  /** Explicit resume target from `-r` / `--session`. */
  #resumeSession = "";
  #busy = false;
  /** The front-end-neutral service owning session/run semantics. */
  readonly #service: TUIService;
  /** The Core-owned session view (set once the service session is bound). */
  #sessionView: TUISessionView | undefined;
  /** Cached secret-safe settings projection used for dialog rendering. */
  #settingsView: TUISettingsView | undefined;
  /** The run currently streaming through the service, if any. */
  #activeRunID = "";
  /** Unsubscribe hook for Core-requested human decisions. */
  #stopDecisions: (() => void) | undefined;
  /** Unsubscribe hook for shared Core connection transitions. */
  #stopConnectionState: (() => void) | undefined;
  /** Pending timer that clears the confirmed-reconnect notice. */
  #connectionNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a Core restart has actually been observed since the last recovery. */
  #coreWasReconnecting = false;
  #closed = false;
  /** Runtime-staged clipboard images awaiting the next submission. */
  #preparedInputs: TUIPreparedInput[] = [];
  #commands: TuiCommands;
  #sessionCommands: TuiSessionCommands;
  #dialog: Dialog | undefined;
  /** The framed /skillhub marketplace panel (mothx popup style). */
  #skillHubPanel: SkillHubPanel | undefined;
  /** The framed /skillmgr skill manager panel (mothx popup style). */
  #skillMgrPanel: SkillMgrPanel | undefined;
  /** Render hook installed by the shell for asynchronous state changes. */
  #renderScheduler: () => void = () => {};
  #toolModal: ToolModalState | undefined;
  #planModal: ToolModalState | undefined;
  #esmObjective: Objective | null = null;
  /**
   * The ESM role agent currently executing (Go esmActiveAgentID). Set by the
   * ESM supervisor once the TUI wires role continuation; the panel shows the
   * agent's live activity when present.
   */
  #esmActiveAgentId = "";
  #esmOpen = false;
  #esmScroll = 0;
  /** Simple event view (Ctrl+G): one-line tool rows, routine lifecycle rows
   * hidden until the full view is toggled back on (Go compactMode, default
   * on). */
  #compactMode = true;
  #multiAgent: boolean;
  #reloadRequested = false;
  /** The Core ESM continuation run currently consumed, if any. */
  #esmRunId = "";
  /** The running ESM event consumer, if any. */
  #esmConsumer: Promise<void> | undefined;
  /** Set when the user aborted the worker; consumed by the idle restart. */
  #esmCancelRequested = false;
  /** Terminal size for modal/panel layouts (set by the CLI shell). */
  #termWidth = 100;
  #termHeight = 40;
  /**
   * Incremental wrapped-content cache per modal tab (Ctrl+O/Ctrl+T).
   *
   * The framed panels are windows over a large, mostly immutable body: the
   * expanded transcript, one agent snapshot, or a plan. Re-wrapping the whole
   * body on every keystroke and every 120 ms spinner tick made each frame
   * O(conversation), which dominated TUI CPU. Each tab caches its wrapped
   * blocks and only rebuilds the blocks whose cheap signature changed, and the
   * frame materializes only the visible slice.
   */
  #modalCaches = new Map<string, ModalContentCache>();
  /** Width/generation the current modal caches were built for. */
  #modalCacheWidth = -1;
  #modalCacheGenerationSeen = -1;
  /** Memoized block list for the transcript tab (see #transcriptBlocks). */
  #transcriptBlocksScope = "";
  #transcriptBlocksCache: ModalBlock[] = [];
  /** The spinner frame used by the last modal content build. */
  #modalSpinner = "";
  /** Live (running) rows of the memoized transcript body, in body order. */
  #liveModalBlocks: LiveModalBlock[] = [];
  /** Identity of the body the last modal frame rendered (see #toolModalContent). */
  #lastModalFrameKey = "";
  /** Blocks the last modal frame actually re-formatted (0 on a cache hit). */
  #lastFrameRebuilt = 0;
  /** The content cache used by the most recent frame (test/profiling aid). */
  #lastModalCache: ModalContentCache | undefined;

  constructor(
    options: TUISessionOptions,
    service: TUIService,
  ) {
    this.#service = service;
    this.#workDir = options.workDir;
    this.#coreReconnectNoticeMs = options.coreReconnectNoticeMs ??
      CORE_RECONNECT_NOTICE_MS;
    this.#continueLast = options.continueLast ?? false;
    this.#resumeSession = (options.resumeSession ?? "").trim();
    this.#multiAgent = options.multiAgent ?? false;
    // Explicit CLI flags win; empty values resolve from the Core-owned
    // settings projection in start() (the Runtime re-resolves run policy).
    this.#providerName = options.provider;
    this.#modelID = options.model;
    this.#mode = options.mode;
    this.#thinking = options.thinking;
    this.translator = tuiTranslatorFromSettings({
      tuilang: options.tuilang ?? "",
    });
    this.controller = new AppController(this.translator, {
      onMessage: () => {},
      scheduleRender: () => this.requestRender(),
      deliverApproval: (approvalID, approved) => {
        this.#answerDecision({
          requestId: approvalID,
          kind: "approval",
          approved,
        });
      },
      deliverQuestion: (questionID, answer) => {
        this.#answerDecision({
          requestId: questionID,
          kind: "question",
          answer,
        });
      },
    });
    this.input = new InputState({
      width: 80,
      placeholder: "Type a message...",
      translator: this.translator,
    });
    // Assigned by start(); methods that need it run only after that.
    this.#commands = new TuiCommands(this);
    this.#sessionCommands = new TuiSessionCommands(this);
    this.header = {
      version: options.version,
      providerName: this.#providerName,
      modelName: this.#modelID,
      cwd: this.#workDir,
    };
  }

  /** Binds the Core-owned service session and resolves display defaults. */
  async start(): Promise<void> {
    const settingsView = await this.#service.settings();
    this.#settingsView = settingsView;
    // Display defaults come from the Core-owned effective settings projection;
    // explicit CLI flags already filled these fields.
    if (this.#providerName === "") {
      this.#providerName = settingsView.defaultProvider;
    }
    if (this.#modelID === "") this.#modelID = settingsView.defaultModel;
    if (this.#mode === "") {
      this.#mode = settingsView.defaultMode !== ""
        ? settingsView.defaultMode
        : "yolo";
    }
    if (this.#thinking === "") this.#thinking = settingsView.thinkingLevel;
    this.refreshHeader();
    await this.#openInitialSession();
    this.#stopDecisions = this.#service.onDecisionRequest((request) =>
      this.#handleDecisionRequest(request)
    );
    // A Core restart is invisible from here until the shared connection says
    // so, so tell the user instead of letting the next prompt look frozen.
    this.#stopConnectionState = this.#service.onConnectionState((state) =>
      this.#handleConnectionState(state)
    );
  }

  /**
   * Projects one shared Core connection transition into the live view.
   *
   * A restart is a transport condition, not conversation, so it never reaches
   * the transcript. The reconnect is confirmed briefly and then cleared, which
   * leaves the live view as it was before the restart happened.
   */
  #handleConnectionState(state: TUICoreConnectionState): void {
    if (state === "connected" && !this.#coreWasReconnecting) {
      // The subscription replays the current state, so a front end that was
      // already connected must not claim it reconnected.
      return;
    }
    this.#coreWasReconnecting = state === "reconnecting";
    this.#clearConnectionNotice();
    this.controller.setCoreConnection(
      state,
      this.translator.text(
        state === "connected" ? "core.reconnected" : "core.reconnecting",
      ),
    );
    if (state === "connected") {
      this.#scheduleConnectionNoticeClear();
    }
    this.requestRender();
  }

  /** Clears a settled connection notice after the confirmation window. */
  #scheduleConnectionNoticeClear(): void {
    this.#connectionNoticeTimer = setTimeout(() => {
      this.#connectionNoticeTimer = undefined;
      this.controller.clearCoreConnectionNotice();
      this.requestRender();
    }, this.#coreReconnectNoticeMs);
  }

  /**
   * Reports that the registered Core was unusable and has been replaced.
   *
   * A Core built from different code cannot answer a single request, so the
   * client replaces it rather than refusing to start. That is a transport
   * condition, not conversation: it shows in the live view through the same
   * notice slot as a reconnect and then clears itself, and it never becomes a
   * transcript entry.
   */
  notifyCoreReplaced(): void {
    this.#coreWasReconnecting = true;
    this.#clearConnectionNotice();
    this.controller.setCoreConnection(
      "connected",
      this.translator.text("core.replaced"),
    );
    this.#scheduleConnectionNoticeClear();
    this.requestRender();
  }

  #clearConnectionNotice(): void {
    if (this.#connectionNoticeTimer === undefined) return;
    clearTimeout(this.#connectionNoticeTimer);
    this.#connectionNoticeTimer = undefined;
  }

  get compactMode(): boolean {
    return this.#compactMode;
  }

  /** Records the terminal size used by modal and panel layouts. */
  setTerminalSize(width: number, height: number): void {
    this.#termWidth = width;
    this.#termHeight = height;
    // An open framed panel re-frames to the new size; its wrapped body is
    // rebuilt by the content cache because the wrap width changed.
    this.#toolModal?.setWidth(width).setHeight(height);
    this.#planModal?.setWidth(width).setHeight(height);
    if (width !== this.#modalCacheWidth) this.#transcriptBlocksScope = "";
  }

  get termWidth(): number {
    return this.#termWidth;
  }

  get termHeight(): number {
    return this.#termHeight;
  }

  /** The current ESM continuation consumer state (test/session introspection). */
  get esmWorkerRunning(): boolean {
    return this.#esmConsumer !== undefined;
  }

  /** The run ID currently streaming through the service (cancel/replay). */
  get activeRunID(): string {
    return this.#activeRunID;
  }

  /** The Core-owned session identity (empty before `start()`). */
  get serviceSessionID(): string {
    return this.#sessionView?.sessionId ?? "";
  }

  /**
   * Starts one Core-owned ESM continuation worker when idle (Go
   * startESMContinuationIfIdle). The Core loops supervisor continuations while
   * the objective can auto-run; the TUI consumes the canonical run events.
   * Resolves once the consumer is attached (never awaits the worker).
   */
  async startESMContinuationIfIdle(): Promise<void> {
    this.#esmCancelRequested = false;
    if (this.#esmConsumer !== undefined) return;
    if (this.#busy || this.controller.isThinking) return;
    const sessionId = this.currentSessionID();
    if (sessionId === "") return;
    let continuation;
    try {
      continuation = await this.#service.esmContinue({ sessionId });
    } catch {
      // The continuation is an idle background restart: degrade to idle.
      return;
    }
    if (continuation.runId === "") return;
    this.#esmRunId = continuation.runId;
    this.#esmConsumer = this.#consumeEsmEvents(sessionId, continuation.runId)
      .catch((error) => {
        this.controller.addMessage(errorMessage(error), "error");
      })
      .finally(() => {
        if (this.#esmRunId === continuation.runId) {
          this.#esmRunId = "";
          this.#esmConsumer = undefined;
        }
        this.requestRender();
      });
  }

  /** Aborts the Core-owned ESM continuation worker, if any. */
  async abortESMWorker(): Promise<void> {
    if (this.#esmConsumer === undefined && this.#esmRunId === "") return;
    // A user-requested abort must not be immediately undone by the idle
    // restart that follows the current interactive run.
    this.#esmCancelRequested = true;
    const sessionId = this.currentSessionID();
    if (sessionId === "") return;
    try {
      await this.#service.esmStop({ sessionId });
    } catch (error) {
      this.controller.addMessage(errorMessage(error), "error");
    }
  }

  /**
   * Consumes one Core ESM continuation run's canonical events: role activity
   * projects into the controller, supervisor messages become status rows.
   */
  async #consumeEsmEvents(sessionId: string, runId: string): Promise<void> {
    for await (
      const event of this.#service.subscribeRunEvents(sessionId, runId)
    ) {
      const payload = event.payload ?? {};
      switch (event.eventType) {
        case "esm_status": {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (text !== "") this.controller.addMessage(text, "status");
          break;
        }
        case "esm_finished": {
          const status = String(payload.status ?? "completed");
          const text = typeof payload.text === "string" ? payload.text : "";
          if (text !== "") {
            this.controller.addMessage(
              text,
              status === "failed" ? "error" : "plain",
            );
          }
          break;
        }
        default: {
          const agentEvent = coreEventToAgentEvent(event);
          if (agentEvent !== undefined) {
            const agentId = agentEvent.agentId ?? "";
            if (agentId !== "") {
              if (agentEvent.type === EVENT_RUN_FINISHED) {
                this.clearESMActiveAgent(agentId);
              } else {
                this.setESMActiveAgent(agentId);
              }
            }
            this.controller.handleAgentEvent(agentEvent);
          }
          break;
        }
      }
      if (event.terminal) break;
      this.requestRender();
    }
  }

  /**
   * Consumes one service run's canonical events into the controller. The
   * terminal event is returned unprojected so command callers can read its
   * status payload (compaction results) without synthesizing run state.
   */
  async consumeRunEvents(
    sessionId: string,
    runId: string,
  ): Promise<CoreRuntimeEvent | undefined> {
    let terminal: CoreRuntimeEvent | undefined;
    for await (
      const event of this.#service.subscribeRunEvents(sessionId, runId)
    ) {
      if (event.terminal) {
        terminal = event;
        break;
      }
      const agentEvent = coreEventToAgentEvent(event);
      if (agentEvent !== undefined) {
        this.controller.handleAgentEvent(agentEvent);
      }
    }
    return terminal;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get mode(): string {
    return this.#mode;
  }

  /**
   * Mirrors the current policy binding into the Core-owned session config so
   * service-run prompts use the same provider/model/mode/thinking values.
   */
  #syncSessionConfig(): void {
    const sessionId = this.#sessionView?.sessionId;
    if (sessionId === undefined) return;
    void this.#service
      .setSessionConfig({
        sessionId,
        providerName: this.#providerName,
        modelID: this.#modelID,
        mode: this.#mode,
        thinkingLevel: this.#thinking,
        capabilities: { multiAgent: this.#multiAgent },
      })
      .then((view) => {
        this.#sessionView = view;
      })
      .catch((error) => {
        this.controller.addMessage(errorMessage(error), "error");
      });
  }

  get reloadRequested(): boolean {
    return this.#reloadRequested;
  }

  // --- Input helpers ---------------------------------------------------------

  /** Splits one raw stdin chunk (exposed for the shell). */
  splitInput = splitInputChunk;

  setEditorWidth(width: number): void {
    this.input.setWidth(width);
  }

  /** Stages one prepared input (clipboard image) for the next submission. */
  addPreparedInput(prepared: TUIPreparedInput): void {
    this.#preparedInputs.push(prepared);
  }

  // --- CommandHost -----------------------------------------------------------

  get workDir(): string {
    return this.#workDir;
  }

  get modelID(): string {
    return this.#modelID;
  }

  get providerName(): string {
    return this.#providerName;
  }

  get running(): boolean {
    return this.#busy;
  }

  setMode(mode: string): void {
    this.#mode = mode;
    this.#syncSessionConfig();
  }

  async setModel(modelID: string): Promise<CommandResult> {
    // Model existence and the model list come from the secret-safe Core
    // settings projection; the dialog/bridge keeps no private provider catalog.
    const settings = await this.#service.settings();
    this.#settingsView = settings;
    const provider = settings.providers.find((entry) =>
      entry.name === this.#providerName
    );
    const model = provider?.models.find((entry) => entry.id === modelID);
    if (model === undefined) {
      return {
        message: this.translator.text(
          "commands.model.not_found",
          modelID,
          (provider?.models ?? []).map((m) => m.id).join(", "),
        ),
        error: true,
      };
    }
    this.#modelID = modelID;
    this.refreshHeader();
    this.#syncSessionConfig();
    return {
      message: this.translator.text(
        "commands.model.switched",
        model.name,
        model.id,
      ),
    };
  }

  clearConversation(): void {
    this.#commands.clearActiveSkills();
    this.controller.store.resetTranscriptState();
    this.controller.activities.clear();
    this.controller.resetContextUsage();
    this.input.paste.reset();
  }

  async compact(): Promise<CommandResult> {
    return await this.#commands.compact();
  }

  async openSkillMgrDialog(): Promise<CommandResult> {
    await Promise.resolve();
    this.openSkillMgrPanel();
    return {};
  }

  async activateSkill(name: string): Promise<string> {
    return await this.#commands.activateSkill(name);
  }

  listMCPServers(): string {
    return this.#commands.listMCPServers();
  }

  initMCPConfig(scope: string, full: boolean, force: boolean): CommandResult {
    return this.#commands.initMCPConfig(scope, full, force);
  }

  listExperts(): Promise<string> {
    return this.#commands.listExperts();
  }

  showExpert(id: string): Promise<string> {
    return this.#commands.showExpert(id);
  }

  async bindExpert(id: string): Promise<CommandResult> {
    return await this.#commands.bindExpert(id);
  }

  async forkSwitchExpert(id: string): Promise<CommandResult> {
    return await this.#commands.forkSwitchExpert(id);
  }

  async listSessions(): Promise<string> {
    return await this.#commands.listSessions();
  }

  async switchSession(id: string): Promise<CommandResult> {
    return await this.#commands.switchSession(id);
  }

  async clearSession(): Promise<CommandResult> {
    return await this.#commands.clearSession();
  }

  async deleteSession(id: string): Promise<CommandResult> {
    return await this.#commands.deleteSession(id);
  }

  async forkSession(): Promise<CommandResult> {
    return await this.#commands.forkSession();
  }

  async listWorkflows(): Promise<CommandResult> {
    return await this.#commands.listWorkflows();
  }

  async showWorkflow(id: string): Promise<CommandResult> {
    return await this.#commands.showWorkflow(id);
  }

  async cancelWorkflow(id: string): Promise<CommandResult> {
    return await this.#commands.cancelWorkflow(id);
  }

  async handleESM(cmd: string): Promise<CommandResult> {
    return await this.#commands.handleESM(cmd);
  }

  async handleBTW(cmd: string): Promise<CommandResult> {
    return await this.#sessionCommands.handleBTW(cmd);
  }

  listEnv(): Promise<string> {
    return this.#commands.listEnv();
  }

  setEnv(key: string, value: string): Promise<CommandResult> {
    return this.#commands.setEnv(key, value);
  }

  unsetEnv(key: string): Promise<CommandResult> {
    return this.#commands.unsetEnv(key);
  }

  clearEnv(): Promise<CommandResult> {
    return this.#commands.clearEnv();
  }

  allowEditPath(parts: string[]): CommandResult {
    return this.#commands.allowEditPath(parts);
  }

  allowAutoEdit(parts: string[]): CommandResult {
    return this.#commands.allowAutoEdit(parts);
  }

  delegateMode(arg: string): Promise<CommandResult> {
    return this.#commands.delegateMode(arg);
  }

  browserMode(arg: string): Promise<CommandResult> {
    return this.#commands.browserMode(arg);
  }

  statusLine(parts: string[]): Promise<CommandResult> {
    return this.#commands.statusLine(parts);
  }

  handleRule(parts: string[]): Promise<CommandResult> {
    return this.#commands.handleRule(parts);
  }

  async handleSkillHub(parts: string[]): Promise<CommandResult> {
    // Bare /skillhub opens the framed marketplace browser (mothx popup style);
    // subcommands keep the scripted text path for CLI/automation parity.
    if (parts.length <= 1) {
      this.openSkillHubPanel();
      return {};
    }
    return await this.#commands.handleSkillHub(parts);
  }

  // --- SkillHub marketplace panel --------------------------------------------

  get skillHubPanelOpen(): boolean {
    return this.#skillHubPanel !== undefined && !this.#skillHubPanel.closed;
  }

  /** Opens the framed /skillhub browser (mothx popup style). */
  openSkillHubPanel(): void {
    if (this.skillHubPanelOpen) return;
    this.closeDialog();
    this.closeSkillMgrPanel();
    this.closeToolModal();
    this.closePlanModal();
    this.input.editor.reset();
    this.#skillHubPanel = new SkillHubPanel(this.#skillHubPanelHost(), {
      close: () => {
        this.#skillHubPanel = undefined;
        this.requestRender();
      },
    });
    this.requestRender();
  }

  closeSkillHubPanel(): void {
    this.#skillHubPanel?.close();
    this.#skillHubPanel = undefined;
    this.requestRender();
  }

  /** Routes one key event to the open panel; true when it consumed it. */
  handleSkillHubKey(ev: KeyEvent): boolean {
    const panel = this.#skillHubPanel;
    if (panel === undefined || panel.closed) return false;
    // Escape and q always close the popup, whatever view is active.
    if (ev.type !== "text" && ev.name === "escape") {
      this.closeSkillHubPanel();
      return true;
    }
    if (ev.type === "text" && ev.text.toLowerCase() === "q") {
      this.closeSkillHubPanel();
      return true;
    }
    panel.handleKey(ev);
    if (panel.closed) this.#skillHubPanel = undefined;
    // The open panel owns the keyboard entirely: unconsumed keys are dropped
    // rather than leaking into the editor underneath.
    return true;
  }

  /** Renders the panel inside its rounded wire frame. */
  skillHubPanelView(): string {
    const panel = this.#skillHubPanel;
    if (panel === undefined) return "";
    const page = panel.page();
    const lines = [
      page.title,
      "",
      ...page.body ?? [],
    ];
    for (const item of page.items) {
      const idx = Number.parseInt(item.value, 10);
      const pointer = idx === panel.cursor
        ? `${ACCENT}${BOLD}› ${RESET}`
        : "  ";
      lines.push(`${pointer}${item.label}`);
      if (item.description !== undefined && item.description !== "") {
        lines.push(`    ${DIM}${item.description}${RESET}`);
      }
    }
    if (page.error !== undefined && page.error !== "") {
      lines.push("", `${RED}${page.error}${RESET}`);
    }
    lines.push("", `${DIM}${page.hint}${RESET}`);
    return frame(lines, clampWidth(this.#termWidth));
  }

  /** The panel host: shared SkillHub service calls plus session hooks. */
  #skillHubPanelHost(): SkillHubPanelHost {
    let cachedSettings: Settings | undefined;
    const settings = async (): Promise<Settings> => {
      cachedSettings ??= await this.#service.getSettings();
      return cachedSettings;
    };
    const service = async (): Promise<SkillHubService> => {
      const s = await settings();
      return new SkillHubService(
        getGlobalSkillsDir(s),
        projectSkillDirs(this.#workDir),
        s.skillHub?.officialHandles ?? [defaultSkillHubOfficialHandle],
        ...clientsForSettings(s.skillHub ?? {}),
      );
    };
    return {
      translator: this.translator,
      markets: () => service().then((s) => s.markets()),
      search: (market, query) =>
        service().then((s) => s.search(undefined, market, query)),
      official: (query) => service().then((s) => s.official(undefined, query)),
      categories: (market) =>
        service().then((s) => s.categories(undefined, market)),
      detail: (market, id) =>
        service().then((s) => s.detail(undefined, market, id)),
      install: (request) =>
        service().then((s) => s.install(undefined, request)),
      uninstall: async (market, id, scope) => {
        (await service()).uninstall(market, id, scope);
      },
      listInstalled: () =>
        installedEntries(
          getGlobalSkillsDir(cachedSettings ?? {}),
          projectSkillDirs(this.#workDir),
        ),
      activateSkill: (name) => this.activateSkill(name),
      defaultScope: () => isProjectDir(this.#workDir) ? "project" : "global",
      targetDir: (scope) =>
        scope === "project"
          ? projectSkillDirs(this.#workDir)[0]
          : getGlobalSkillsDir(cachedSettings ?? {}),
      settle: (message, error) =>
        this.controller.addMessage(message, error === true ? "error" : "plain"),
      requestRender: () => this.requestRender(),
    };
  }

  async listStats(parts: string[]): Promise<CommandResult> {
    return await this.#commands.listStats(parts);
  }

  // --- Skill manager panel -----------------------------------------------------

  get skillMgrPanelOpen(): boolean {
    return this.#skillMgrPanel !== undefined && !this.#skillMgrPanel.closed;
  }

  /** Opens the framed /skillmgr manager (mothx popup style). */
  openSkillMgrPanel(): void {
    if (this.skillMgrPanelOpen) return;
    this.closeDialog();
    this.closeSkillHubPanel();
    this.closeToolModal();
    this.closePlanModal();
    this.input.editor.reset();
    this.#skillMgrPanel = new SkillMgrPanel(this.#skillMgrPanelHost(), {
      close: () => {
        this.#skillMgrPanel = undefined;
        this.requestRender();
      },
    });
    this.requestRender();
  }

  closeSkillMgrPanel(): void {
    this.#skillMgrPanel?.close();
    this.#skillMgrPanel = undefined;
    this.requestRender();
  }

  /** Routes one key event to the open panel; true when it consumed it. */
  handleSkillMgrKey(ev: KeyEvent): boolean {
    const panel = this.#skillMgrPanel;
    if (panel === undefined || panel.closed) return false;
    // Escape and q always close the popup without applying pending toggles.
    if (ev.type !== "text" && ev.name === "escape") {
      this.closeSkillMgrPanel();
      return true;
    }
    if (ev.type === "text" && ev.text.toLowerCase() === "q") {
      this.closeSkillMgrPanel();
      return true;
    }
    panel.handleKey(ev);
    if (panel.closed) this.#skillMgrPanel = undefined;
    // The open panel owns the keyboard entirely: unconsumed keys are dropped
    // rather than leaking into the editor underneath.
    return true;
  }

  /** Renders the panel inside its rounded wire frame. */
  skillMgrPanelView(): string {
    return this.#skillMgrPanel?.view(this.#termWidth) ?? "";
  }

  /** The panel host: Runtime-owned skill reads/toggles plus session hooks. */
  #skillMgrPanelHost(): SkillMgrPanelHost {
    return {
      translator: this.translator,
      // No feature-forced builtin skills in the Deno port yet: workflow and
      // browser capabilities own tools, not skill activations. The locked
      // projection stays available for parity with the mothx panel.
      lockedNames: () => [],
      listSkills: () =>
        this.#service.listSkills({ sessionId: this.currentSessionID() }),
      setSkillActive: (name, active) =>
        this.#service
          .setSkillActive({
            sessionId: this.currentSessionID(),
            name,
            active,
          })
          .then(() => {}),
      settle: (message, error) =>
        this.controller.addMessage(message, error === true ? "error" : "plain"),
      requestRender: () => this.requestRender(),
    };
  }

  listAgents(): Promise<string> {
    return this.#commands.listAgents();
  }

  async switchAgent(id: string): Promise<CommandResult> {
    return await this.#commands.switchAgent(id);
  }

  async destroyAgent(id: string): Promise<CommandResult> {
    return await this.#commands.destroyAgent(id);
  }

  multiAgentEnabled(): boolean {
    return this.#multiAgent;
  }

  async handleReload(): Promise<CommandResult> {
    await Promise.resolve();
    this.#reloadRequested = true;
    this.#busy = false;
    return {
      message: this.translator.text("reload.requested"),
      quit: true,
    };
  }

  async showProviders(): Promise<string> {
    return await this.#sessionCommands.showProviders();
  }

  // --- Interactive dialogs ---------------------------------------------------

  /** The dialog host the concrete panels mutate through. */
  get dialogHost(): DialogHost {
    return {
      translator: this.translator,
      workDir: this.#workDir,
      providerName: this.#providerName,
      modelID: this.#modelID,
      allow: loadAllow(),
      currentSessionID: () => this.currentSessionID(),
      listModels: (providerName) =>
        this.#settingsView?.providers.find((entry) =>
          entry.name === providerName
        )?.models ?? [],
      applyModel: (providerName, modelID) =>
        this.applyModelBinding(providerName, modelID),
      loadSettings: (scope) => this.#service.getSettings({ scope }),
      saveSettings: (scope, updates) =>
        this.#service.updateSettings({ scope, updates }),
      validateProviderModel: (providerID, modelID) =>
        this.#service.validateProviderModel({ providerID, modelID }),
      listProviders: () => this.#service.listProviders(),
      loadEnv: () => this.#service.listEnv(),
      saveEnv: (vars) => this.#service.updateEnv({ vars }).then(() => {}),
      reloadSettings: () => this.reloadSettings(),
      requestRender: () => this.requestRender(),
      switchSession: async (detail) => {
        // The Core owns session identity: open it there, scoped to the
        // directory the listing found it in, and adopt the view.
        // A switched-to session is a continuation, so it reprints its stored
        // conversation exactly as `-c` does at startup; resumePersistedSession
        // owns the reset-then-reprint order and the persisted mode.
        await this.resumePersistedSession(detail.sessionId, detail.workDir);
      },
      newSession: async () => {
        // The Core mints the persisted identity; no client-side session row.
        await this.createFreshSession();
        this.controller.store.resetTranscriptState();
      },
      deleteSession: async (id) => {
        await this.#service.deleteSession({ sessionId: id });
      },
    };
  }

  get dialogOpen(): boolean {
    return this.#dialog !== undefined && !this.#dialog.closed;
  }

  /** Opens a dialog and clears the draft so the panel owns the keyboard. */
  #openDialog(dialog: Dialog): void {
    this.#dialog = dialog;
    this.input.editor.reset();
    this.input.updateSuggestions();
  }

  closeDialog(): void {
    this.#dialog = undefined;
  }

  dialogView(width: number): string {
    return this.#dialog?.view(width) ?? "";
  }

  /** Routes one key event to the open dialog; true when it consumed it. */
  handleDialogKey(ev: KeyEvent): boolean {
    const dialog = this.#dialog;
    if (dialog === undefined || dialog.closed) return false;
    dialog.handleKey(ev);
    this.#settleDialog();
    return true;
  }

  /**
   * Processes the outcome of a dialog closed by a synchronous key handler or
   * by an asynchronous service call (fire-and-forget persistence).
   */
  #settleDialog(): void {
    const dialog = this.#dialog;
    if (dialog === undefined || !dialog.closed) return;
    // Settle first: clear the dialog before publishing its outcome. The
    // message below schedules a render synchronously, and a render settles
    // dialogs again — publishing first would re-enter this method on the same
    // closed dialog and recurse until the stack blows.
    this.#dialog = undefined;
    const outcome = dialog.outcome;
    if (outcome.message !== undefined && outcome.message !== "") {
      this.controller.addMessage(
        outcome.message,
        outcome.error === true ? "error" : "plain",
      );
    }
    // Hand off to another panel (Go closeAuthDialog + openXDialog).
    if (outcome.handoff === "auth") void this.openAuthDialog();
    else if (outcome.handoff === "defaultModel") {
      void this.openDefaultModelDialog("global");
    } else if (outcome.handoff === "tuilang") void this.openTuiLangDialog();
  }

  /** Installs the shell's rerender hook for asynchronous state changes. */
  setRenderScheduler(scheduler: () => void): void {
    this.#renderScheduler = scheduler;
  }

  /** Renders after an asynchronous update and settles a closed dialog. */
  requestRender(): void {
    this.#settleDialog();
    this.#renderScheduler();
  }

  async openModelDialog(): Promise<CommandResult> {
    await Promise.resolve();
    this.#openDialog(
      new Dialog((d) => new ModelDialog(this.dialogHost, d)),
    );
    return {};
  }

  async openDefaultModelDialog(scope: string): Promise<CommandResult> {
    const [catalog, settings] = await Promise.all([
      this.#service.listProviders(),
      this.#service.getSettings(),
    ]);
    this.#openDialog(
      new Dialog((d) =>
        new DefaultModelDialog(this.dialogHost, d, scope, {
          catalog,
          defaultProvider: settings.defaultProvider ?? "",
          defaultModel: settings.defaultModel ?? "",
        })
      ),
    );
    return {};
  }

  async openEnvDialog(): Promise<CommandResult> {
    const vars = await this.#service.listEnv();
    this.#openDialog(
      new Dialog((d) => new EnvDialog(this.dialogHost, d, vars)),
    );
    return {};
  }

  async openSessionsDialog(): Promise<CommandResult> {
    const items = await this.#service.listPersistedSessions({
      workDir: this.#workDir,
    });
    this.#openDialog(
      new Dialog((d) => new SessionsDialog(this.dialogHost, d, items)),
    );
    return {};
  }

  async openAuthDialog(initialProvider?: string): Promise<CommandResult> {
    const settings = await this.#service.getSettings();
    this.#openDialog(
      new Dialog((d) =>
        new AuthDialog(this.dialogHost, d, settings, initialProvider)
      ),
    );
    return {};
  }

  async openSettingsDialog(providerID?: string): Promise<CommandResult> {
    // `/settings <provider>` deep-links into that provider's auth detail (Go
    // openSettingsDialog(args)).
    if (providerID !== undefined && providerID.trim() !== "") {
      return await this.openAuthDialog(providerID.trim());
    }
    const settings = await this.#service.getSettings();
    this.#openDialog(
      new Dialog((d) => new SettingsDialog(this.dialogHost, d, settings)),
    );
    return {};
  }

  async openTuiLangDialog(): Promise<CommandResult> {
    const scope = isProjectDir(this.#workDir) ? "project" : "global";
    const settings = await this.#service.getSettings();
    this.#openDialog(
      new Dialog((d) => new TuiLangDialog(this.dialogHost, d, scope, settings)),
    );
    return {};
  }

  setDefaultModel(parts: string[]): Promise<CommandResult> {
    return this.openDefaultModelDialog(parts[1] ?? "global");
  }

  tuiLang(parts: string[]): Promise<CommandResult> {
    return this.#sessionCommands.tuiLang(parts);
  }

  cron(parts: string[]): CommandResult {
    return this.#sessionCommands.cron(parts);
  }

  async systemInit(cmd: string): Promise<CommandResult> {
    return await this.#sessionCommands.systemInit(cmd);
  }

  async pasteImage(): Promise<CommandResult> {
    return await this.#sessionCommands.pasteImage();
  }

  // --- Slash commands --------------------------------------------------------

  /** Dispatches one submitted line: commands locally, else a prompt run. */
  async handleSubmit(text: string): Promise<void> {
    if (text.startsWith("/")) {
      try {
        const result = await dispatchCommand(text, this);
        if (result.message !== undefined && result.message !== "") {
          this.controller.addMessage(
            result.message,
            result.error === true ? "error" : "plain",
          );
        }
      } catch (err) {
        this.controller.addMessage(errorMessage(err), "error");
      }
      this.requestRender();
      return;
    }
    try {
      await this.submitPrompt(text);
    } catch (err) {
      // Mid-run rejections are already terminalized and reported through the
      // canonical EVENT_ERROR path; only failures before the run surfaces here.
      if (!this.controller.runTerminalHandled) {
        this.controller.addMessage(errorMessage(err), "error");
      }
    }
    this.requestRender();
  }

  /** Submits one user message as a durable conversation-turn run. */
  async submitPrompt(text: string): Promise<void> {
    if (this.#busy || text.trim() === "") return;
    this.#busy = true;
    this.controller.isThinking = true;
    // A fresh submission owns a fresh terminal slot; handleSubmit relies on it
    // to decide whether a rejection still needs a user-visible error row.
    this.controller.runTerminalHandled = false;
    try {
      await this.#runPromptTurn(text);
    } finally {
      this.#busy = false;
      this.controller.isThinking = false;
      // A finished interactive run hands the terminal back to an active ESM
      // objective (Go finishESMRun continuation), unless the user aborted the
      // worker during this run.
      if (this.#esmCancelRequested) {
        this.#esmCancelRequested = false;
      } else {
        await this.startESMContinuationIfIdle();
      }
    }
  }

  /**
   * One durable conversation-turn run over the service: prompt admission,
   * event consumption, and cancellation are Core-owned; the TUI only projects
   * the canonical run events into the controller.
   */
  async #runPromptTurn(text: string): Promise<void> {
    this.controller.addMessage(`> ${text}`, "plain");
    const sessionId = this.currentSessionID();
    if (this.#sessionView === undefined || sessionId === "") {
      throw new Error("session initialization failed; cannot start a run");
    }
    // Staged clipboard images (prepareInput) join the submission here; plain
    // text goes through the same prompt path with no staged resources.
    const preparedInputs = this.#preparedInputs;
    this.#preparedInputs = [];
    const accepted = await this.#service.prompt({
      sessionId,
      text,
      providerName: this.#providerName,
      modelID: this.#modelID,
      mode: this.#mode,
      thinkingLevel: this.#thinking,
      ...(preparedInputs.length > 0 ? { preparedInputs } : {}),
    });
    this.#activeRunID = accepted.runId;
    if (accepted.agentId !== undefined && accepted.agentId !== "") {
      this.controller.setLeadAgentId(accepted.agentId);
    }
    const run = new TuiRun({
      runId: accepted.runId,
      sessionId,
      mode: this.#mode,
      model: this.#modelID,
    });
    this.controller.attachRun(run);
    try {
      for await (
        const event of this.#service.subscribeRunEvents(
          sessionId,
          accepted.runId,
        )
      ) {
        const agentEvent = coreEventToAgentEvent(event);
        if (agentEvent !== undefined) {
          this.controller.handleAgentEvent(agentEvent);
        }
      }
    } finally {
      this.#activeRunID = "";
    }
  }

  /** Cancels the active run (ctrl+c while busy). */
  cancelRun(): void {
    const sessionId = this.currentSessionID();
    const runId = this.#activeRunID;
    if (this.#sessionView !== undefined && sessionId !== "" && runId !== "") {
      void this.#service.cancelRun({ sessionId, runId }).catch((error) => {
        this.controller.addMessage(errorMessage(error), "error");
      });
    }
    void this.abortESMWorker();
  }

  /** Closes the service session exactly once (Core-owned teardown). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopDecisions?.();
    this.#stopDecisions = undefined;
    this.#stopConnectionState?.();
    this.#stopConnectionState = undefined;
    this.#clearConnectionNotice();
    if (this.#sessionView !== undefined) {
      await this.#service.closeSession({
        sessionId: this.#sessionView.sessionId,
      });
    }
  }

  /**
   * Creates one fresh Core-owned session: the Core mints the persisted
   * identity and the TUI adopts the returned canonical view.
   */
  async createFreshSession(): Promise<TUISessionView> {
    const view = await this.#service.createSession({
      workDir: this.#workDir,
      // The entry declares its RuntimeSource once so run policy resolves from
      // the TUI identity instead of the shared Core's fallback.
      source: SOURCE_TUI,
      providerName: this.#providerName,
      modelID: this.#modelID,
      mode: this.#mode,
      thinkingLevel: this.#thinking,
      capabilities: { multiAgent: this.#multiAgent },
    });
    this.adoptSession(view);
    return view;
  }

  /** Adopts one Core-owned session view as the live session (switch/fork). */
  adoptSession(view: TUISessionView): void {
    this.#sessionView = view;
    this.#workDir = view.workDir !== "" ? view.workDir : this.#workDir;
    this.refreshHeader();
  }

  /**
   * Binds the session the TUI starts with: a resumed one when `-r`/`-c` asked
   * for it, otherwise a fresh Core-owned session.
   *
   * A resume also reprints the durable conversation. An empty transcript is not
   * a continuation: the Runtime replays the persisted branch into the Agent, so
   * the visible history must come from the same source or the user is asked to
   * trust a context they cannot see.
   */
  async #openInitialSession(): Promise<void> {
    const target = this.#resumeSession;
    if (target !== "") {
      const {
        sessionId,
        workDir,
        failure,
        view,
      } = await this.#resolveResumeTarget(target);
      if (sessionId !== "") {
        await this.resumePersistedSession(sessionId, workDir, view);
        return;
      }
      // One row naming the target and why it failed, then a usable session:
      // a bad `-r` must not leave the user with nothing.
      this.controller.addMessage(
        `${this.translator.text("session.resume_failed", target)}: ${failure}`,
        "error",
      );
      await this.createFreshSession();
      return;
    }
    if (this.#continueLast) {
      const latest = await this.#newestPersistedSession(this.#workDir);
      if (latest.sessionId !== "") {
        // The listing was scoped to this directory, so the open must be too.
        await this.resumePersistedSession(latest.sessionId, latest.workDir);
        return;
      }
      // Nothing to continue yet is the normal first run in a fresh directory,
      // so it starts a session rather than reporting a failure.
    }
    await this.createFreshSession();
  }

  /**
   * Opens one persisted session in the Core and reprints its history.
   *
   * The open is scoped to `workDir` rather than left to the Core's startup
   * directory: a shared Core may serve several front ends, so an unscoped open
   * resolves against a directory that is not necessarily this one and fails for
   * a session that does exist here. Resetting the live view first keeps a
   * repeated resume from reprinting the same turns twice, and the persisted mode
   * is applied exactly as the `/sessions` switch path applies it.
   */
  async resumePersistedSession(
    sessionId: string,
    workDir = this.#workDir,
    resolvedView?: TUISessionView,
  ): Promise<void> {
    // A caller that already opened the session to resolve the target passes the
    // view down rather than making the Core serve the same open twice.
    const view = resolvedView ??
      await this.#openScoped(sessionId, workDir);
    this.adoptSession(view);
    // A persisted session mode wins; an empty one falls back to the yolo
    // product default (the Runtime re-resolves source-forced modes).
    this.setMode(view.mode !== "" ? view.mode : "yolo");
    this.controller.store.resetTranscriptState();
    this.controller.resetContextUsage();
    await this.replayDurableTranscript();
  }

  /**
   * Reprints the resumed session's durable turns through the same transcript
   * rows a live turn produces, so scrollback, the Ctrl+O panel, and a later
   * `/clear` all treat history and new output identically.
   */
  async replayDurableTranscript(): Promise<void> {
    const sessionId = this.currentSessionID();
    if (sessionId === "") return;
    let messages: TUITranscriptMessage[];
    try {
      messages = await this.#service.getTranscript({ sessionId });
    } catch (error) {
      // The reprint is presentation; a failed read must not make the resumed
      // session unusable, so it says so and carries on with live turns.
      this.controller.addMessage(
        `${this.translator.text("session.history_unavailable")}: ${
          errorMessage(error)
        }`,
        "warning",
      );
      this.requestRender();
      return;
    }
    for (const message of messages) {
      if (message.role === "user") {
        this.controller.addMessage(`> ${message.text}`, "plain");
      } else {
        // The row keeps the raw Markdown source and the assistant kind, so a
        // reprinted history renders through the same Markdown projection as a
        // live turn instead of showing literal ** and ` markers.
        this.controller.addMessage(message.text, "assistant");
      }
    }
    if (messages.length > 0) {
      // One status row saying what was restored, so the reprint is never
      // mistaken for a fresh empty session.
      this.controller.addMessage(
        this.translator.text(
          "session.resumed",
          sessionId,
          messages.length,
        ),
        "status",
      );
    }
    this.requestRender();
  }

  /**
   * The newest persisted session of one working directory that actually has a
   * conversation, with the directory it was found in so the caller can open it
   * scoped to that same directory. Sessions with no messages are skipped: every
   * aborted or never-used startup persists an empty row, and "continue" means
   * the newest conversation, not the newest file.
   */
  async #newestPersistedSession(
    workDir: string,
  ): Promise<{ sessionId: string; workDir: string }> {
    const entries = await this.#service.listPersistedSessions({ workDir });
    let bestId = "";
    let bestTime = -1;
    for (const entry of entries) {
      const at = new Date(entry.modTime).getTime();
      if (entry.sessionId === "" || !Number.isFinite(at)) continue;
      if ((entry.messageCount ?? 0) <= 0) continue;
      if (at > bestTime) {
        bestTime = at;
        bestId = entry.sessionId;
      }
    }
    return { sessionId: bestId, workDir };
  }

  /**
   * Resolves `-r`/`--session`, which accepts a session id (optionally a prefix)
   * or a directory path. A directory selects the newest session recorded there;
   * anything else resolves as an id scoped to the starting working directory, so
   * a session that belongs elsewhere is never adopted under the wrong cwd.
   *
   * It reports why a target could not be resolved. Transport and Core failures
   * propagate instead of becoming "no such session": telling the user their id
   * is unknown while the Core is merely unreachable would send them to retry a
   * name that was fine.
   */
  async #resolveResumeTarget(
    target: string,
  ): Promise<{
    sessionId: string;
    workDir: string;
    failure: string;
    view?: TUISessionView;
  }> {
    if (isDirectoryTarget(target)) {
      const latest = await this.#newestPersistedSession(target);
      return latest.sessionId === ""
        ? {
          sessionId: "",
          workDir: target,
          failure: `no session recorded under ${target}`,
        }
        : { ...latest, failure: "" };
    }
    try {
      // Resolve by opening it with its own scoping, so a session of another
      // directory is rejected here rather than adopted later, and the view this
      // call already produced is reused instead of opened a second time.
      const view = await this.#openScoped(target, this.#workDir);
      return {
        sessionId: target,
        workDir: this.#workDir,
        failure: "",
        view,
      };
    } catch (error) {
      // Only a genuinely absent target is a user-correctable `-r`; a Core that
      // is merely unreachable must propagate rather than be reported as a bad id.
      if (!isSessionNotFound(error)) throw error;
      return { sessionId: "", workDir: "", failure: errorMessage(error) };
    }
  }

  /**
   * Opens one session scoped to `workDir`, replaying it once when the Core
   * answers "persisted but not resident here".
   *
   * The Core uses that answer for a session whose row exists but which the
   * serving process has not bound yet (typically because the shared Core
   * restarted). It replies before starting any work, so re-opening and sending
   * the same request again is safe and is exactly what the dedicated protocol
   * code asks the client to do. Treating it as a missing session instead would
   * tell the user a perfectly good id was unresumable every time the Core came
   * back up.
   */
  async #openScoped(
    sessionId: string,
    workDir: string,
  ): Promise<TUISessionView> {
    try {
      return await this.#service.openSession({ sessionId, workDir });
    } catch (error) {
      if (!isSessionNotResident(error)) throw error;
      // The answer arrives before any work starts, so re-opening and sending the
      // same request again is safe and is what the dedicated code asks for.
      return await this.#service.openSession({ sessionId, workDir });
    }
  }

  /** Surfaces one Core-requested decision through the standard panel path. */
  #handleDecisionRequest(request: TUIDecisionRequest): void {
    if (request.kind === "approval") {
      this.controller.handleAgentEvent({
        type: EVENT_TOOL_APPROVAL_REQUEST,
        approvalId: request.requestId,
        approvalTool: request.toolName ?? "",
        ...(request.args === undefined ? {} : { approvalArgs: request.args }),
      });
      return;
    }
    this.controller.handleAgentEvent({
      type: EVENT_QUESTION_REQUEST,
      questionId: request.requestId,
      questionText: request.question ?? "",
      ...(request.options === undefined
        ? {}
        : { questionOptions: request.options }),
      ...(request.context === undefined
        ? {}
        : { questionContext: request.context }),
    });
  }

  /**
   * Delivers one resolved decision back to the originating Core request.
   * Identity, first-response-wins, and the resolved DecisionRecord are
   * Core-owned; an already resolved or expired request is dropped silently.
   */
  #answerDecision(answer: TUIDecisionAnswer): void {
    void this.#service.answerDecision(answer).catch((error) => {
      if (isDecisionNotFound(error)) return;
      this.controller.addMessage(errorMessage(error), "error");
    });
  }

  /** Answers the shown approval through the Core decision request. */
  answerApproval(approved: boolean): void {
    const shown = this.controller.shownApproval;
    if (!shown) return;
    this.#answerDecision({
      requestId: shown.approvalID,
      kind: "approval",
      approved,
    });
    // Panel advancement (clear shown slot, surface the next queued request)
    // stays controller-owned.
    this.controller.resolveApproval(shown.approvalID, approved);
  }

  /** Answers the shown question with the chosen option. */
  answerQuestion(value: string): void {
    const shown = this.controller.shownQuestion;
    if (!shown) return;
    this.#answerDecision({
      requestId: shown.questionID,
      kind: "question",
      answer: value,
    });
    this.controller.resolveQuestion(shown.questionID);
    this.controller.addMessage(
      value === "" ? "Answered" : value,
      "plain",
    );
  }

  /** Escape: abort a pending request, else clear the draft (Go KeyEsc). */
  handleEscape(): void {
    if (
      this.#busy || this.controller.shownApproval ||
      this.controller.shownQuestion
    ) {
      this.cancelRun();
      return;
    }
    this.input.editor.reset();
    this.input.resetHistoryNavigation();
    this.input.updateSuggestions();
  }

  /** Cycles plan → agent → yolo → os (Go cycleMode). */
  cycleMode(): void {
    switch (this.#mode) {
      case "plan":
        this.#mode = "agent";
        break;
      case "agent":
        this.#mode = "yolo";
        break;
      case "yolo":
        this.#mode = "os";
        break;
      case "os":
        this.#mode = "plan";
        break;
      default:
        this.#mode = "yolo";
    }
    this.#syncSessionConfig();
    this.controller.addMessage(
      this.translator.text("commands.mode", this.#mode.toUpperCase()),
      "plain",
    );
  }

  /** Ctrl+G: toggles between the simple and full event display. */
  toggleCompactMode(): void {
    this.#compactMode = !this.#compactMode;
    this.controller.addMessage(
      this.translator.text(
        this.#compactMode ? "event_view.simple" : "event_view.full",
      ),
      "status",
    );
  }

  describeMultiAgent(): void {
    this.controller.addMessage(
      this.#multiAgent
        ? this.translator.text("agent.multi_on")
        : this.translator.text("agent.disabled"),
      "plain",
    );
  }

  /** Opens the most recently attached clipboard image (Ctrl+R). */
  previewLastPastedImage(): void {
    const result = this.#sessionCommands.previewPastedImage();
    if (result.message !== undefined && result.message !== "") {
      this.controller.addMessage(
        result.message,
        result.error === true ? "error" : "plain",
      );
    }
  }

  // --- Tool modal ------------------------------------------------------------

  get toolModalOpen(): boolean {
    return this.#toolModal !== undefined;
  }

  openToolModal(): void {
    const store = this.controller.store;
    const hasContent = store.messages.length > 0 ||
      store.toolResults.length > 0 ||
      this.controller.activities.order.length > 0;
    if (!hasContent) {
      this.controller.addMessage(
        this.translator.text("tool.modal.no_details"),
        "plain",
      );
      return;
    }
    this.closePlanModal();
    // Tabs mirror the Go toolModalTargets: main (the expanded transcript) plus
    // one tab per background or managed sub-agent — never one tab per tool
    // call. The lead agent is the "main" tab and must not repeat.
    const targets: ToolModalTarget[] = [
      {
        id: "main",
        label: this.translator.text("tool.modal.main"),
        kind: "main",
      },
    ];
    const lead = this.controller.leadAgentId;
    const seen = new Set<string>();
    for (const id of this.controller.activities.order) {
      if (id === "" || id === lead || seen.has(id)) continue;
      seen.add(id);
      const act = this.controller.activities.get(id);
      const state = act !== undefined && act.state !== ""
        ? ` ${act.state}`
        : "";
      targets.push({
        id: `agent:${id}`,
        label: `${id}${state}`,
        kind: act !== undefined && act.kind !== "" ? act.kind : "subagent",
      });
    }
    const modal = new ToolModalState(this.#termWidth, this.#termHeight);
    modal.setTargets(targets);
    this.#toolModal = modal;
    // Managed sub-agents live in the Core-owned registry; extend the tabs when
    // the projection arrives (the recorded activities above already cover
    // every agent that has produced events).
    void this.#service
      .listAgents({ sessionId: this.currentSessionID() })
      .then((agents) => {
        if (this.#toolModal !== modal) return;
        let changed = false;
        for (const agent of agents) {
          const id = agent.id;
          if (id === "" || id === lead || seen.has(id)) continue;
          seen.add(id);
          targets.push({ id: `agent:${id}`, label: id, kind: "subagent" });
          changed = true;
        }
        if (!changed) return;
        modal.setTargets(targets);
        this.requestRender();
      })
      .catch(() => {
        // The projection is best-effort; recorded activities stay authoritative.
      });
  }

  /**
   * Rows available to a modal/panel above the shell chrome. The editor frame
   * and rows plus the two footer lines are reserved so the managed region
   * never has to scroll (Ink repaints the whole region and flickers once the
   * frame is taller than the terminal).
   */
  #panelAvailableHeight(): number {
    const editorRows = Math.max(
      this.input.editor.view().split("\n").length,
      1,
    );
    return Math.max(this.#termHeight - 6 - editorRows, 6);
  }

  closeToolModal(): void {
    this.#toolModal = undefined;
    this.#releaseModalCaches();
  }

  // --- Plan modal (Ctrl+T) ----------------------------------------------------

  get planModalOpen(): boolean {
    return this.#planModal !== undefined;
  }

  /** Opens the current task plan in a framed modal like the tool modal. */
  openPlanModal(): void {
    const plan = this.controller.currentPlan;
    if (plan === undefined) {
      this.controller.addMessage(
        this.translator.text("plan.modal.no_plan"),
        "plain",
      );
      return;
    }
    this.closeToolModal();
    const modal = new ToolModalState(this.#termWidth, this.#termHeight);
    modal.setTargets([
      {
        id: "plan",
        label: this.translator.text("plan.modal.title"),
        kind: "plan",
      },
    ]);
    this.#planModal = modal;
  }

  closePlanModal(): void {
    this.#planModal = undefined;
    this.#releaseModalCaches();
  }

  /**
   * Releases the framed panels' held *text*. A panel is a transient view over a
   * transcript that already keeps every tool output alive in the store, so the
   * duplicated wrapped copy must not outlive the panel: closing drops it and the
   * character budget stops it growing while open.
   *
   * The cheap layout (per-block signature and wrapped line count, roughly half a
   * KB per transcript row — a fraction of the content the store itself holds)
   * stays warm, because the scroll clamp and bottom pin need every block's line
   * count: releasing it would turn a reopen into a full re-wrap of the whole
   * conversation (measured ~160 ms per 5 MB, and seconds on a long session).
   */
  #releaseModalCaches(): void {
    for (const cache of this.#modalCaches.values()) cache.dropText();
    this.#lastModalFrameKey = "";
    this.#lastFrameRebuilt = 0;
  }

  planModalPageSize(): number {
    return this.#planModal?.pageSizeFor(false, this.#panelAvailableHeight()) ??
      1;
  }

  scrollPlanModal(delta: number): void {
    const modal = this.#planModal;
    if (!modal) return;
    modal.scroll(
      delta,
      this.#planModalContent().lineCount,
      this.planModalPageSize(),
    );
  }

  planModalView(): string {
    const modal = this.#planModal;
    if (!modal) return "";
    return modal.render(this.#planModalContent(), this.translator, {
      availableHeight: this.#panelAvailableHeight(),
      title: this.translator.text("plan.modal.title"),
    });
  }

  /** Test access to the active plan modal state. */
  planModalForTest(): ToolModalState {
    if (this.#planModal === undefined) {
      throw new Error("plan modal not open");
    }
    return this.#planModal;
  }

  /** The cached plan body for the open plan modal (one block). */
  #planModalContent(): ModalContentView {
    const plan = this.controller.currentPlan;
    const width = ToolModalState.contentWidthFor(this.#termWidth);
    this.#syncModalCacheScope(width);
    const cache = this.#modalCacheFor("plan");
    const text = plan === undefined
      ? this.translator.text("plan.modal.no_plan")
      : renderTaskPlanLines(plan, this.translator).join("\n");
    const blocks: ModalBlock[] = [{
      key: "plan",
      sig: `${planSignature(plan)}@${width}`,
      build: () => text,
    }];
    return cache.refresh(blocks, width, this.#modalCacheGenerationSeen);
  }

  toolModalPageSize(): number {
    return this.#toolModal?.pageSizeFor(
      (this.#toolModal.targets.length ?? 0) > 1,
      this.#panelAvailableHeight(),
    ) ?? 1;
  }

  scrollToolModal(delta: number): void {
    const modal = this.#toolModal;
    if (!modal) return;
    const page = this.toolModalPageSize();
    modal.scroll(delta, this.#toolModalContent().lineCount, page);
  }

  switchToolModalTarget(delta: number): void {
    this.#toolModal?.switchTarget(delta);
  }

  /**
   * Renders the open tool modal. `spinner` is the current rotating-dots frame,
   * prefixed to running-state labels while a run is active.
   */
  toolModalView(spinner = ""): string {
    const modal = this.#toolModal;
    if (!modal) return "";
    return modal.render(this.#toolModalContent(spinner), this.translator, {
      availableHeight: this.#panelAvailableHeight(),
    });
  }

  /** Wrapped characters held by every open panel's content cache. */
  toolModalCachedCharsForTest(): number {
    let chars = 0;
    for (const cache of this.#modalCaches.values()) chars += cache.cachedChars;
    return chars;
  }

  /** Test access to the active modal state. */
  toolModalForTest(): ToolModalState {
    if (this.#toolModal === undefined) throw new Error("tool modal not open");
    return this.#toolModal;
  }

  /**
   * Content-cache state of the frame that was rendered last: how many blocks
   * it rebuilt, how many the body has, and its wrapped line count. The Ctrl+O
   * performance contract is that a repeat frame with an unchanged body (a
   * scroll, a key that only moves the window) rebuilds nothing.
   */
  toolModalCacheStatsForTest(): {
    rebuiltBlocks: number;
    blocks: number;
    lineCount: number;
  } {
    const cache = this.#lastModalCache;
    return {
      rebuiltBlocks: this.#lastFrameRebuilt,
      blocks: cache?.blockCount ?? 0,
      lineCount: cache?.lineCount ?? 0,
    };
  }

  /**
   * The cached, windowed body for the active tool-modal tab. Only blocks whose
   * cheap signature changed are rebuilt and re-wrapped; the frame render reads
   * the visible slice, so a scroll or spinner tick is O(page) not O(history).
   */
  #toolModalContent(spinner = this.#modalSpinner): ModalContentView {
    const modal = this.#toolModal;
    if (modal === undefined) return EMPTY_MODAL_CONTENT;
    const target = modal.targets[modal.active];
    if (target === undefined) return EMPTY_MODAL_CONTENT;
    const store = this.controller.store;
    const width = ToolModalState.contentWidthFor(this.#termWidth);
    // Block signatures derive only from the transcript revision/generation, the
    // wrap width, and the spinner frame, so that tuple fully identifies a body:
    // repeating the frame inside it costs nothing at all (a scroll only changes
    // the window the renderer asks the cache to slice).
    const frameKey =
      `${target.id}|${store.generation}|${store.revision}|${width}|${spinner}|${this.controller.activities.revision}`;
    if (
      frameKey === this.#lastModalFrameKey && this.#lastModalCache !== undefined
    ) {
      // The frame is served entirely from cache: nothing was rebuilt.
      this.#lastFrameRebuilt = 0;
      return this.#lastModalCache;
    }
    this.#syncModalCacheScope(width);
    const cache = this.#modalCacheFor(target.id);
    this.#lastModalCache = cache;
    this.#lastModalFrameKey = frameKey;
    const agentTab = target.id.startsWith("agent:");
    const blocks = agentTab
      ? this.#agentActivityBlock(target.id.slice("agent:".length), width)
      : this.#transcriptBlocks(width);
    if (!agentTab) this.#applyModalSpinner(spinner);
    const view = cache.refresh(blocks, width, this.#modalCacheGenerationSeen);
    this.#lastFrameRebuilt = cache.lastRebuiltBlocks;
    return view;
  }

  /**
   * Blocks for the expanded conversation (Go buildToolModalLines).
   *
   * Transcript rows are append-only and tool rows change only through store
   * mutators that bump `revision`, so an unchanged
   * (generation, revision, width) scope returns the memoized list. A running
   * row's signature is a getter over the current spinner frame, so the spinner
   * animation never rebuilds the block list or the stable rows — only the few
   * live rows re-format, and only when they are actually visible.
   */
  #transcriptBlocks(width: number): ModalBlock[] {
    const store = this.controller.store;
    const scope = `${store.generation}|${store.revision}|${width}`;
    if (scope === this.#transcriptBlocksScope) {
      return this.#transcriptBlocksCache;
    }
    const blocks: ModalBlock[] = [];
    const live: LiveModalBlock[] = [];
    for (let i = 0; i < store.messages.length; i++) {
      const block = this.#modalBlockForRow(i, width, live);
      if (block !== undefined) blocks.push(block);
    }
    if (blocks.length === 0) {
      const text = this.translator.text("tool.modal.no_conversation");
      blocks.push({ key: "empty", sig: `${text}@${width}`, build: () => text });
    }
    this.#transcriptBlocksScope = scope;
    this.#transcriptBlocksCache = blocks;
    this.#liveModalBlocks = live;
    return blocks;
  }

  /**
   * The cached block descriptor for transcript row `idx`, or undefined when the
   * row renders nothing (an untouched streaming placeholder). Signatures read
   * only lengths and state flags, never the row's content.
   */
  #modalBlockForRow(
    idx: number,
    width: number,
    live: LiveModalBlock[],
  ): ModalBlock | undefined {
    const store = this.controller.store;
    const tool = store.toolRowAt(idx);
    if (tool !== undefined) {
      const base = [
        "t",
        tool.toolName,
        tool.status,
        tool.fullContent.length,
        tool.summary.length,
        tool.toolError.length,
        tool.executionState,
        tool.diff === undefined
          ? "-"
          : `${tool.diff.added}/${tool.diff.deleted}/${
            tool.diff.unified?.length ?? 0
          }/${tool.diff.truncated === true}`,
        tool.plan === undefined ? "-" : planSignature(tool.plan),
        argsFingerprint(tool.toolArgs),
        width,
      ].join("|");
      if (tool.status !== "running") {
        return {
          key: `row-${idx}`,
          sig: base,
          build: () => this.#expandedMessageAt(idx),
        };
      }
      // A running row renders the spinner frame in its text. Register it so a
      // spinner tick rewrites just these few signatures instead of rebuilding
      // the memoized block list (and re-wrapping every stable row).
      const block: ModalBlock = {
        key: `row-${idx}`,
        sig: `${base}|${this.#modalSpinner}`,
        build: () => this.#expandedMessageAt(idx, this.#modalSpinner),
      };
      live.push({ block, base });
      return block;
    }
    // Streaming slots only ever grow, so the raw length is a sound signature.
    const assistant = store.assistantRaw(idx).length;
    if (assistant > 0) {
      return {
        key: `row-${idx}`,
        sig: `a|${assistant}|${width}`,
        build: () => this.#expandedMessageAt(idx),
      };
    }
    const think = store.thinkRaw(idx).length;
    if (think > 0) {
      return {
        key: `row-${idx}`,
        sig: `k|${think}|${width}`,
        build: () => this.#expandedMessageAt(idx),
      };
    }
    const message = store.messages[idx];
    if (message !== undefined && message.trim() !== "") {
      const text = message;
      return {
        key: `row-${idx}`,
        sig: `m|${text.length}|${text.charCodeAt(0)}|${width}`,
        build: () => text,
      };
    }
    return undefined;
  }

  /** Applies the current spinner frame to the live rows of the cached body. */
  #applyModalSpinner(spinner: string): void {
    if (spinner === this.#modalSpinner) return;
    this.#modalSpinner = spinner;
    for (const live of this.#liveModalBlocks) {
      live.block.sig = `${live.base}|${spinner}`;
    }
  }

  /** Blocks for one sub-agent tab: the full activity snapshot as one block. */
  #agentActivityBlock(
    agentId: string,
    width: number,
  ): ModalBlock[] {
    const act = this.controller.activities.get(agentId);
    const sig = `${agentActivitySignature(act)}@${width}`;
    return [{
      key: "activity",
      sig,
      build: () => renderAgentActivity(act, agentId, this.translator),
    }];
  }

  /**
   * Drops every cached modal body when the wrap width or the transcript
   * generation changed: cached lines were wrapped for the old layout and row
   * indices are reused by a cleared transcript.
   */
  #syncModalCacheScope(width: number): void {
    const generation = this.controller.store.generation;
    if (
      this.#modalCacheWidth === width &&
      this.#modalCacheGenerationSeen === generation
    ) return;
    this.#modalCaches.clear();
    this.#modalCacheWidth = width;
    this.#modalCacheGenerationSeen = generation;
    this.#transcriptBlocksScope = "";
    this.#liveModalBlocks = [];
    this.#lastModalFrameKey = "";
  }

  #modalCacheFor(key: string): ModalContentCache {
    let cache = this.#modalCaches.get(key);
    if (cache === undefined) {
      cache = new ModalContentCache();
      this.#modalCaches.set(key, cache);
    }
    return cache;
  }

  /** One transcript row expanded (Go renderExpandedMessageAt). */
  #expandedMessageAt(idx: number, spinner = ""): string {
    const store = this.controller.store;
    const tool = store.toolRowAt(idx);
    if (tool !== undefined) {
      return expandedToolRow(this.translator, {
        toolName: tool.toolName,
        toolArgs: tool.toolArgs,
        status: tool.status,
        summary: tool.summary,
        fullContent: tool.fullContent,
        diff: tool.diff,
        plan: tool.plan,
        spinner,
        toolError: tool.toolError,
        executionState: tool.executionState,
      });
    }
    const assistant = store.assistantRaw(idx);
    if (assistant !== "") {
      return `${
        this.translator.text("transcript.assistant_prefix")
      }\n${assistant}`;
    }
    const think = store.thinkRaw(idx);
    if (think !== "") {
      return `${this.translator.text("activity.thinking")}\n${think}`;
    }
    const message = store.messages[idx];
    if (message !== undefined && message !== "") return message;
    return "";
  }

  // --- ESM panel -------------------------------------------------------------

  get esmPanelOpen(): boolean {
    return this.#esmOpen;
  }

  openESMPanel(): void {
    this.#esmOpen = true;
    this.#esmScroll = 0;
    this.#refreshESMState();
  }

  /** Refreshes the Core-owned ESM objective snapshot for the panel. */
  #refreshESMState(): void {
    const sessionId = this.currentSessionID();
    if (sessionId === "") {
      this.#esmObjective = null;
      return;
    }
    void this.#service
      .esmState({ sessionId })
      .then((view) => {
        this.#esmObjective = view.objective === null
          ? null
          : esmObjectiveFromView(view.objective);
        if (view.activeAgentId !== "") {
          this.#esmActiveAgentId = view.activeAgentId;
        }
        this.requestRender();
      })
      .catch(() => {
        this.#esmObjective = null;
        this.requestRender();
      });
  }

  closeESMPanel(): void {
    this.#esmOpen = false;
  }

  scrollESMPanel(delta: number): void {
    const lines = this.#esmPanelLines();
    const page = this.#esmPanelPageSize();
    this.#esmScroll += delta;
    const max = Math.max(lines.length - page, 0);
    if (this.#esmScroll < 0) this.#esmScroll = 0;
    if (this.#esmScroll > max) this.#esmScroll = max;
  }

  esmPanelView(): string {
    const width = esmPanelWidth(this.#termWidth);
    const inner = Math.max(width - 2, 4);
    const lines = this.#esmPanelLines();
    const pageSize = this.#esmPanelPageSize();
    const visible = lines.slice(this.#esmScroll, this.#esmScroll + pageSize);
    // Closed rounded frame: `╭─…╮` and `│ … │` both span `width` columns.
    const body = visible.map((l) => {
      const pad = " ".repeat(Math.max(inner - 2 - displayWidth(l), 0));
      return `│ ${l}${pad} │`;
    });
    return [
      `╭${"─".repeat(inner)}╮`,
      ...body,
      `╰${"─".repeat(inner)}╯`,
    ].join("\n");
  }

  /** Visible rows for the ESM panel, adapted to the terminal height. */
  #esmPanelPageSize(): number {
    // Shell chrome below the panel: editor frame (3) + hint (1) + footer (1),
    // the panel frame (2), and a small margin.
    return Math.max(this.#termHeight - 12, 4);
  }

  #esmPanelLines(): string[] {
    const activeAgentId = this.esmActiveAgentId;
    return esmPanelLines(
      this.#esmObjective,
      esmPanelWidth(this.#termWidth),
      this.translator,
      {
        activeAgentId,
        activity: activeAgentId !== ""
          ? this.controller.activities.get(activeAgentId)
          : undefined,
      },
    );
  }

  /** The ESM objective currently bound to this session, if any. */
  get esmObjective(): Objective | null {
    return this.#esmObjective;
  }

  /** The ESM role agent currently executing, if any. */
  get esmActiveAgentId(): string {
    return this.#esmActiveAgentId;
  }

  /** Tracks the active ESM role agent (Go setActiveESMAgent). */
  setESMActiveAgent(id: string): void {
    this.#esmActiveAgentId = id;
  }

  /** Clears the tracking when `id` is still the active one. */
  clearESMActiveAgent(id: string): void {
    if (this.#esmActiveAgentId === id) this.#esmActiveAgentId = "";
  }

  // --- Service accessors used by the command layer ---------------------------

  /** The front-end-neutral service owning session/run semantics. */
  get service(): TUIService {
    return this.#service;
  }

  get thinkingLevel(): string {
    return this.#thinking;
  }

  get multiAgent(): boolean {
    return this.#multiAgent;
  }

  /** The canonical session ID (empty before initialization). */
  currentSessionID(): string {
    return this.#sessionView?.sessionId ?? "";
  }

  /** Binds a provider/model pair chosen in a dialog to the live session. */
  applyModelBinding(providerName: string, modelID: string): void {
    this.#providerName = providerName;
    this.#modelID = modelID;
    this.refreshHeader();
    this.#syncSessionConfig();
  }

  /** Re-reads the Core-owned settings projection after a settings edit. */
  reloadSettings(): void {
    void this.#service.settings().then((view) => {
      this.#settingsView = view;
    }).catch((error) => {
      this.controller.addMessage(errorMessage(error), "error");
    });
  }

  /** Updates the header shown by the shell after a model/provider change. */
  refreshHeader(): void {
    this.header.modelName = this.#modelID;
    this.header.providerName = this.#providerName;
  }
}

/** Formats a caught failure for one transcript error row. */
function errorMessage(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Re-exported for the shell/tests. */
export { dispatchCommand };
export type { KeyEvent };

/**
 * Cheap fingerprint of a tool row's arguments: key and value counts and string
 * lengths only, never their text. A 100 KB `write` payload must not be
 * re-serialized for every modal frame, and an argument change always arrives
 * with a status/content change, which the signature also carries.
 */
function argsFingerprint(
  args: Record<string, unknown> | undefined,
): string {
  if (args === undefined) return "-";
  const names: string[] = [];
  let lengths = 0;
  for (const [key, value] of Object.entries(args)) {
    names.push(key);
    lengths += typeof value === "string"
      ? value.length
      : value === undefined
      ? 0
      : 1;
  }
  return `${names.join(",")}:${lengths}`;
}

/** A running modal row and the signature base its spinner is appended to. */
interface LiveModalBlock {
  block: ModalBlock;
  base: string;
}

/**
 * A content view with no lines, returned when a framed panel has no open
 * state (the renderers treat it as an empty body).
 */
const EMPTY_MODAL_CONTENT: ModalContentView = {
  lineCount: 0,
  slice: () => [],
};

/**
 * Cheap change signature of a task plan: lengths plus a small weighted sum of
 * the step titles and statuses, never the rendered checklist itself.
 */
function planSignature(plan: TaskPlan | undefined): string {
  if (plan === undefined) return "-";
  let acc = 0;
  for (const step of plan.steps) {
    acc = (acc + step.title.length * 31 + step.status.length * 7 +
      charCodeSum(step.status)) >>> 0;
  }
  return `${plan.title.length}|${plan.note.length}|${plan.steps.length}|${acc}`;
}

/** Cheap change signature of one agent activity snapshot. */
function agentActivitySignature(act: AgentActivity | undefined): string {
  if (act === undefined) return "none";
  const updated = act.updatedAt?.getTime() ?? 0;
  // The snapshot header renders a relative age, so it re-renders at most once
  // per second even while the agent itself is idle.
  const ageBucket = updated > 0 ? Math.round((Date.now() - updated) / 1000) : 0;
  const lastEvent = act.events[act.events.length - 1];
  return [
    act.kind,
    act.state,
    act.lastTool.length,
    act.lastThink.length,
    act.lastText.length,
    act.lastResult.length,
    act.fullThink.length,
    act.fullText.length,
    act.fullResult.length,
    act.events.length,
    lastEvent === undefined
      ? "-"
      : `${lastEvent.text.length}:${lastEvent.time.getTime()}`,
    ageBucket,
  ].join("|");
}

/** Sum of a short string's character codes (a cheap content fingerprint). */
function charCodeSum(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum;
}
