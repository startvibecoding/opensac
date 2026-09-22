// Interactive TUI session state: the assembly of controller + input state +
// run lifecycle for the root interactive action, plus the CommandHost that the
// slash-command dispatcher mutates through.
//
// The session is the TUI's Runtime projection. It owns no Agent construction,
// session persistence, or tool registry: every command goes through the shared
// Runtime, config, session, and protocol modules (Builder, ExecutionRuntime,
// DecisionService, DAO-backed session listing, allow/settings persistence).

import { createWithOptions } from "../provider/factory/factory.ts";
import {
  Builder,
  type SessionRuntime,
} from "../agentruntime/session_runtime.ts";
import { SourceTUI } from "../agentruntime/source.ts";
import { ExecutionRuntime } from "../agentruntime/execution.ts";
import { RunStore } from "../agentruntime/run_store.ts";
import { SessionRunEventSink } from "../agentruntime/run_event.ts";
import { acquireExecutionAdmission } from "../agentruntime/execution_admission.ts";
import { DecisionService } from "../agentruntime/decision.ts";
import type { ExecutionIntent } from "../session/execution_intent.ts";
import { generateID, runUserEntryID } from "../session/mod.ts";
import { type Manager, type SessionDetail } from "../session/manager.ts";
import {
  createSession,
  deleteSession as deleteSessionRuntime,
  openSession,
} from "../agentruntime/session_lifecycle.ts";
import {
  isArtifactEnabled,
  isProjectDir,
  loadAllow,
  loadSettingsWithMeta,
  sandboxLevelFromSettings,
  type Settings,
} from "../config/mod.ts";
import { listManagerSessions } from "./session_commands.ts";
import {
  type Message,
  normalizeThinkingLevel,
  type ThinkingLevel,
} from "../provider/mod.ts";
import { AppController } from "./app_controller.ts";
import { TuiRun } from "./tui_run.ts";
import { localTimeZone, Translator } from "./i18n.ts";
import { InputState } from "./input_state.ts";
import { ToolModalState } from "./tool_modal.ts";
import { esmPanelLines, esmPanelWidth } from "./esm_panel.ts";
import {
  type CommandHost,
  type CommandResult,
  dispatchCommand,
} from "./commands.ts";
import { TuiCommands } from "./tui_commands.ts";
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
import { Dialog } from "./dialog.ts";
import type { AppProps } from "./app.tsx";
import type { Objective } from "../esm/state.ts";
import { Store as ESMStore } from "../esm/store.ts";
import { type KeyEvent, splitInputChunk } from "./keys.ts";
import { EventError, TaskFailed } from "../agent/events.ts";

export interface TUISessionOptions {
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  workDir: string;
  version: string;
  multiAgent?: boolean;
}

/** Resolves the session translator from settings (Go NewApp). */
export function tuiTranslatorFromSettings(settings: Settings): Translator {
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
  #runtime!: SessionRuntime;
  #manager: Manager;
  #settings: Settings;
  #providerName: string;
  #mode: string;
  #thinking: ThinkingLevel;
  #provider: import("../provider/mod.ts").Provider;
  #model: import("../provider/mod.ts").Model;
  #workDir: string;
  #busy = false;
  #currentExecution: ExecutionRuntime | undefined;
  #agent: import("../agent/agent.ts").Agent | undefined;
  #decisions = new DecisionService();
  #commands: TuiCommands;
  #sessionCommands: TuiSessionCommands;
  #dialog: Dialog | undefined;
  #toolModal: ToolModalState | undefined;
  #esmObjective: Objective | null = null;
  #esmOpen = false;
  #esmScroll = 0;
  #compactMode = false;
  #multiAgent: boolean;
  #reloadRequested = false;

  constructor(options: TUISessionOptions, settings: Settings) {
    this.#settings = settings;
    this.#workDir = options.workDir;
    this.#multiAgent = options.multiAgent ?? false;
    const created = createWithOptions(
      settings,
      options.provider,
      options.model,
      { requireModel: true },
    );
    this.#provider = created.provider;
    this.#providerName = options.provider !== ""
      ? options.provider
      : (settings.defaultProvider ?? "");
    this.#model = created.model;
    this.#mode = options.mode || settings.defaultMode || "yolo";
    this.#thinking = normalizeThinkingLevel(
      options.thinking || settings.defaultThinkingLevel || "",
    ) as ThinkingLevel;
    this.translator = tuiTranslatorFromSettings(settings);
    this.controller = new AppController(this.translator, {
      onMessage: () => {},
      scheduleRender: () => {},
      deliverApproval: (approvalID, approved) => {
        this.#agent?.handleApprovalResponse(approvalID, approved);
      },
      deliverQuestion: (questionID, answer) => {
        this.#agent?.handleQuestionResponse(questionID, answer);
      },
    });
    this.input = new InputState({
      width: 80,
      placeholder: "Type a message...",
      translator: this.translator,
    });
    this.#manager = createSession({ workDir: this.#workDir });
    // Assigned by start(); methods that need it run only after that.
    this.#commands = new TuiCommands(this);
    this.#sessionCommands = new TuiSessionCommands(this);
    this.header = {
      version: options.version,
      providerName: this.#providerName,
      modelName: this.#model.id,
      cwd: this.#workDir,
    };
  }

  /** Builds the shared runtime once (Builder.build: registry/skills/sandbox/MCP). */
  async start(): Promise<void> {
    this.#runtime = await new Builder(
      this.#settings,
      sandboxLevelFromSettings(this.#settings),
    ).build(undefined, {
      source: SourceTUI,
      workDir: this.#workDir,
      workflows: false,
      browser: false,
      artifactEnabled: isArtifactEnabled(this.#settings),
      manager: this.#manager,
    });
    this.#runtime.setDecisions(this.#decisions);
    this.#runtime.configureSession(
      this.#provider,
      this.#providerName,
      this.#model,
      this.#mode,
      this.#thinking,
    );
  }

  get compactMode(): boolean {
    return this.#compactMode;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get mode(): string {
    return this.#mode;
  }

  /** Pushes the current provider/model/mode/thinking binding into the Runtime. */
  #configureRuntimeSession(): void {
    if (this.#runtime === undefined) return;
    this.#runtime.configureSession(
      this.#provider,
      this.#providerName,
      this.#model,
      this.#mode,
      this.#thinking,
    );
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

  // --- CommandHost -----------------------------------------------------------

  get workDir(): string {
    return this.#workDir;
  }

  get modelID(): string {
    return this.#model.id;
  }

  get providerName(): string {
    return this.#providerName;
  }

  get running(): boolean {
    return this.#busy;
  }

  setMode(mode: string): void {
    this.#mode = mode;
    this.#configureRuntimeSession();
  }

  async setModel(modelID: string): Promise<CommandResult> {
    await Promise.resolve();
    const model = this.#provider.getModel(modelID);
    if (model === undefined) {
      return {
        message: this.translator.text(
          "commands.model.not_found",
          modelID,
          this.#provider.models().map((m) => m.id).join(", "),
        ),
        error: true,
      };
    }
    this.#model = model;
    this.#configureRuntimeSession();
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
    this.input.paste.reset();
  }

  async compact(): Promise<CommandResult> {
    return await this.#commands.compact();
  }

  listSkills(): string {
    return this.#commands.listSkills();
  }

  activateSkill(name: string): string {
    return this.#commands.activateSkill(name);
  }

  listMCPServers(): string {
    return this.#commands.listMCPServers();
  }

  initMCPConfig(scope: string, full: boolean, force: boolean): CommandResult {
    return this.#commands.initMCPConfig(scope, full, force);
  }

  listExperts(): string {
    return this.#commands.listExperts();
  }

  showExpert(id: string): string {
    return this.#commands.showExpert(id);
  }

  async bindExpert(id: string): Promise<CommandResult> {
    return await this.#commands.bindExpert(id);
  }

  async forkSwitchExpert(id: string): Promise<CommandResult> {
    return await this.#commands.forkSwitchExpert(id);
  }

  listSessions(): string {
    return this.#commands.listSessions();
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

  listEnv(): string {
    return this.#commands.listEnv();
  }

  setEnv(key: string, value: string): CommandResult {
    return this.#commands.setEnv(key, value);
  }

  unsetEnv(key: string): CommandResult {
    return this.#commands.unsetEnv(key);
  }

  clearEnv(): CommandResult {
    return this.#commands.clearEnv();
  }

  allowEditPath(parts: string[]): CommandResult {
    return this.#commands.allowEditPath(parts);
  }

  allowAutoEdit(parts: string[]): CommandResult {
    return this.#commands.allowAutoEdit(parts);
  }

  delegateMode(arg: string): CommandResult {
    return this.#commands.delegateMode(arg);
  }

  browserMode(arg: string): CommandResult {
    return this.#commands.browserMode(arg);
  }

  statusLine(parts: string[]): CommandResult {
    return this.#commands.statusLine(parts);
  }

  handleRule(parts: string[]): CommandResult {
    return this.#commands.handleRule(parts);
  }

  async handleSkillHub(parts: string[]): Promise<CommandResult> {
    return await this.#commands.handleSkillHub(parts);
  }

  async listStats(parts: string[]): Promise<CommandResult> {
    return await this.#commands.listStats(parts);
  }

  listAgents(): string {
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

  showProviders(): string {
    return this.#sessionCommands.showProviders();
  }

  // --- Interactive dialogs ---------------------------------------------------

  /** The dialog host the concrete panels mutate through. */
  get dialogHost(): DialogHost {
    return {
      translator: this.translator,
      settings: this.#settings,
      workDir: this.#workDir,
      providerName: this.#providerName,
      modelID: this.#model.id,
      allow: loadAllow(),
      sessionDir: () => this.#manager.getSessionDir(),
      currentSessionID: () => this.currentSessionID(),
      applyModel: (providerName, modelID) =>
        this.applyModelBinding(providerName, modelID),
      reloadSettings: () => this.reloadSettings(),
      switchSession: async (detail) => {
        const manager = openSession(this.#manager.getSessionDir(), detail.id);
        await this.bindManager(manager);
        this.controller.store.resetTranscriptState();
      },
      newSession: async () => {
        const manager = createSession({ workDir: this.#workDir });
        await this.bindManager(manager);
        this.controller.store.resetTranscriptState();
      },
      deleteSession: async (id) => {
        await deleteSessionRuntime(this.#manager.getSessionDir(), id);
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
    if (dialog.closed) {
      const outcome = dialog.outcome;
      if (outcome.message !== undefined && outcome.message !== "") {
        this.controller.addMessage(
          outcome.message,
          outcome.error === true ? "error" : "plain",
        );
      }
      this.#dialog = undefined;
      // Hand off to another panel (Go closeAuthDialog + openXDialog).
      if (outcome.handoff === "auth") this.openAuthDialog();
      else if (outcome.handoff === "defaultModel") {
        this.openDefaultModelDialog("global");
      } else if (outcome.handoff === "tuilang") this.openTuiLangDialog();
    }
    return true;
  }

  openModelDialog(): CommandResult {
    this.#openDialog(
      new Dialog((d) => new ModelDialog(this.dialogHost, d)),
    );
    return {};
  }

  openDefaultModelDialog(scope: string): CommandResult {
    this.#openDialog(
      new Dialog((d) => new DefaultModelDialog(this.dialogHost, d, scope)),
    );
    return {};
  }

  openEnvDialog(): CommandResult {
    this.#openDialog(new Dialog((d) => new EnvDialog(this.dialogHost, d)));
    return {};
  }

  openSessionsDialog(): CommandResult {
    this.#openDialog(new Dialog((d) => new SessionsDialog(this.dialogHost, d)));
    return {};
  }

  openAuthDialog(initialProvider?: string): CommandResult {
    this.#openDialog(
      new Dialog((d) => new AuthDialog(this.dialogHost, d, initialProvider)),
    );
    return {};
  }

  openSettingsDialog(providerID?: string): CommandResult {
    // `/settings <provider>` deep-links into that provider's auth detail (Go
    // openSettingsDialog(args)).
    if (providerID !== undefined && providerID.trim() !== "") {
      return this.openAuthDialog(providerID.trim());
    }
    this.#openDialog(new Dialog((d) => new SettingsDialog(this.dialogHost, d)));
    return {};
  }

  openTuiLangDialog(): CommandResult {
    const scope = isProjectDir(this.#workDir) ? "project" : "global";
    this.#openDialog(
      new Dialog((d) => new TuiLangDialog(this.dialogHost, d, scope)),
    );
    return {};
  }

  setDefaultModel(parts: string[]): Promise<CommandResult> {
    return Promise.resolve(this.openDefaultModelDialog(parts[1] ?? "global"));
  }

  tuiLang(parts: string[]): CommandResult {
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
      const result = await dispatchCommand(text, this);
      if (result.message !== undefined && result.message !== "") {
        this.controller.addMessage(
          result.message,
          result.error === true ? "error" : "plain",
        );
      }
      return;
    }
    await this.submitPrompt(text);
  }

  /** Submits one user message as a durable conversation-turn run. */
  async submitPrompt(text: string): Promise<void> {
    if (this.#busy || text.trim() === "") return;
    this.#busy = true;
    this.controller.isThinking = true;
    this.controller.addMessage(`> ${text}`, "plain");
    const header = this.#manager.getHeader();
    const sessionId = header?.id ?? "";
    if (sessionId === "") {
      throw new Error("session initialization failed; cannot start a run");
    }
    const guard = await acquireExecutionAdmission(
      undefined,
      this.#manager.getSessionDir(),
      sessionId,
      {},
    );
    const startedAt = new Date();
    const runId = `tui_${generateID()}`;
    const intentId = `intent_${generateID()}`;
    const turnId = `turn-${intentId}`;
    const submission = await this.#runtime.acceptInput(
      undefined,
      runId,
      text,
      [],
    );
    const userMessage: Message = this.#runtime.buildUserMessage(
      undefined,
      submission,
    );
    const requestSnapshot = JSON.stringify({
      message: text,
      model: this.#model.id,
      mode: this.#mode,
      workDir: this.#workDir,
    });
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(requestSnapshot),
      ),
    );
    const fingerprint = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const intent: ExecutionIntent = {
      id: intentId,
      sessionId,
      source: "tui",
      model: this.#model.id,
      mode: this.#mode,
      workDir: this.#workDir,
      requestFingerprint: `sha256:${fingerprint}`,
      request: JSON.parse(requestSnapshot),
      policy: JSON.parse(JSON.stringify({
        source: "tui",
        mode: this.#mode,
        workDir: this.#workDir,
        approvalPolicy: "runtime",
        questionPolicy: "runtime",
      })),
      createdAt: startedAt,
    };
    const execution = new ExecutionRuntime();
    execution.setRunStore(new RunStore(this.#manager.getSessionDir()));
    execution.setEventSink(
      new SessionRunEventSink(this.#manager.getSessionDir()),
    );
    this.#runtime.setExecution(execution);
    this.#currentExecution = execution;
    execution.beginIntentDurable(undefined, intent, {
      id: runId,
      sessionId,
      intentId,
      retryOf: "",
      attempt: 1,
      workDir: this.#workDir,
      source: "tui",
      model: this.#model.id,
      mode: this.#mode,
      status: "running",
      startedAt,
      finishedAt: null,
      error: "",
      errorInfo: {},
      progress: {},
      usage: null,
      contextUsage: null,
      inputResourceIds: [],
      submissionKeyHash: "",
      submissionScope: "",
      submissionFingerprint: "",
      assistantEntryId: "",
      userEntryId: runUserEntryID(runId),
      userMessage,
      conversationTurnId: turnId,
      conversationTurn: true,
    }, {
      sessionId,
      runId,
      eventType: "started",
      source: "tui",
      status: "running",
      model: this.#model.id,
      mode: this.#mode,
      timestamp: startedAt,
      data: JSON.stringify({ intentId, attempt: 1 }),
    });
    const run = new TuiRun({
      execution,
      decisions: this.#decisions,
      runId,
      sessionId,
      sessionDir: this.#manager.getSessionDir(),
      mode: this.#mode,
      model: this.#model.id,
    });
    this.controller.attachRun(run);
    const agent = this.#runtime.buildAgent({
      provider: this.#provider,
      providerName: this.#providerName,
      model: this.#model,
      settings: this.#settings,
      allow: loadAllow(),
      mode: this.#mode,
      thinkingLevel: this.#thinking,
      extraContext: this.#runtime.extraContext,
      ruleContent: this.#runtime.ruleContent,
    });
    agent.setConversationTurn(turnId, intentId, runId);
    this.#agent = agent;
    this.#commands.setAgent(agent);
    execution.setAgent(agent);
    const events = agent.runWithUserMessage(userMessage);
    try {
      for await (const event of events) {
        this.controller.handleAgentEvent(event);
        if (this.controller.runTerminalHandled) break;
      }
    } catch (err) {
      // A non-terminal rejection (transport error escaping the agent loop,
      // broken iterator) must not leave the durable run dangling in "running"
      // with pending decisions: terminalize it canonically as failed.
      if (!this.controller.runTerminalHandled) {
        this.controller.handleAgentEvent(
          {
            type: EventError,
            status: TaskFailed,
            error: err instanceof Error ? err : new Error(String(err)),
          } as unknown as Parameters<AppController["handleAgentEvent"]>[0],
        );
      }
      throw err;
    } finally {
      this.#busy = false;
      this.controller.isThinking = false;
      guard.release();
    }
  }

  /** Cancels the active run (ctrl+c while busy). */
  cancelRun(): void {
    this.#currentExecution?.cancel();
  }

  /** Answers the shown approval through the decision binding. */
  answerApproval(approved: boolean): void {
    const shown = this.controller.shownApproval;
    if (!shown) return;
    // Decision routing (resolve → deliver → resume) is owned by the controller,
    // which bound the resolver when the request arrived. Answering here only
    // supplies the value so identity/first-response-wins stays canonical.
    try {
      this.#decisions.resolveWith(
        {
          id: shown.approvalID,
          kind: "approval",
          status: "resolved",
          value: approved ? "true" : "false",
        },
      );
    } catch {
      // Already resolved/expired: fall back to clearing the panel below.
      this.controller.resolveApproval(shown.approvalID, approved);
    }
  }

  /** Answers the shown question with the chosen option. */
  answerQuestion(value: string): void {
    const shown = this.controller.shownQuestion;
    if (!shown) return;
    // Panel advancement (clear shown slot, surface the next queued question)
    // is owned by the controller via the resolver bound when the request
    // arrived; this mirrors the approval path.
    const advance = () => this.controller.resolveQuestion(shown.questionID);
    try {
      this.#decisions.resolveWith(
        { id: shown.questionID, kind: "question", status: "resolved", value },
      );
    } catch {
      // Already resolved/expired: still advance the panel.
      advance();
      return;
    }
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
    this.#configureRuntimeSession();
    this.controller.addMessage(
      this.translator.text("commands.mode", this.#mode.toUpperCase()),
      "plain",
    );
  }

  toggleCompactMode(): void {
    this.#compactMode = !this.#compactMode;
    this.controller.addMessage(
      this.#compactMode ? "Compact mode: ON" : "Compact mode: OFF",
      "plain",
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
    const results = this.controller.store.toolResults;
    if (results.length === 0) {
      this.controller.addMessage(
        this.translator.text("tool.modal.no_details"),
        "plain",
      );
      return;
    }
    const modal = new ToolModalState(80, 30);
    modal.setTargets(
      results.map((r, i) => ({
        id: `#${i + 1} ${r.toolName}`,
        label: r.toolName,
        kind: r.toolName,
      })),
    );
    this.#toolModal = modal;
  }

  closeToolModal(): void {
    this.#toolModal = undefined;
  }

  toolModalPageSize(): number {
    return this.#toolModal?.pageSizeFor(
      (this.#toolModal.targets.length ?? 0) > 1,
      30,
    ) ?? 1;
  }

  scrollToolModal(delta: number): void {
    const modal = this.#toolModal;
    if (!modal) return;
    const page = this.toolModalPageSize();
    modal.scroll(delta, this.#toolModalLines().length, page);
  }

  switchToolModalTarget(delta: number): void {
    this.#toolModal?.switchTarget(delta);
  }

  toolModalView(): string {
    const modal = this.#toolModal;
    if (!modal) return "";
    const lines = this.#toolModalLines();
    return modal.render(lines, this.translator, { availableHeight: 30 });
  }

  #toolModalLines(): string[] {
    const modal = this.#toolModal;
    if (!modal) return [];
    const target = modal.targets[modal.active];
    const results = this.controller.store.toolResults;
    const entry = results.find((r) =>
      `#${results.indexOf(r) + 1} ${r.toolName}` === target?.id
    );
    const chosen = entry ?? results[results.length - 1];
    if (!chosen) return [];
    const body = chosen.fullContent !== ""
      ? chosen.fullContent
      : chosen.summary;
    const header = `| ${chosen.toolName} ${chosen.status}`;
    return [header, "", ...body.split("\n")];
  }

  // --- ESM panel -------------------------------------------------------------

  get esmPanelOpen(): boolean {
    return this.#esmOpen;
  }

  openESMPanel(): void {
    try {
      const store = new ESMStore(this.#manager.getSessionDir());
      const sessionId = this.currentSessionID();
      this.#esmObjective = sessionId === "" ? null : store.get(sessionId);
    } catch {
      this.#esmObjective = null;
    }
    this.#esmOpen = true;
    this.#esmScroll = 0;
  }

  closeESMPanel(): void {
    this.#esmOpen = false;
  }

  scrollESMPanel(delta: number): void {
    const lines = this.#esmPanelLines();
    const page = 20;
    this.#esmScroll += delta;
    const max = Math.max(lines.length - page, 0);
    if (this.#esmScroll < 0) this.#esmScroll = 0;
    if (this.#esmScroll > max) this.#esmScroll = max;
  }

  esmPanelView(): string {
    const width = esmPanelWidth(100);
    const lines = this.#esmPanelLines();
    const visible = lines.slice(this.#esmScroll, this.#esmScroll + 20);
    const body = visible.map((l) => `│ ${l}`).join("\n");
    return `╭${"─".repeat(width)}╮\n${body}\n╰${"─".repeat(width)}╯`;
  }

  #esmPanelLines(): string[] {
    return esmPanelLines(
      this.#esmObjective,
      esmPanelWidth(100),
      this.translator,
      { activeAgentId: "" },
    );
  }

  /** The ESM objective currently bound to this session, if any. */
  get esmObjective(): Objective | null {
    return this.#esmObjective;
  }

  // --- Runtime accessors used by the command layer ---------------------------

  get runtime(): SessionRuntime {
    return this.#runtime;
  }

  get manager(): Manager {
    return this.#manager;
  }

  get settings(): Settings {
    return this.#settings;
  }

  get model(): import("../provider/mod.ts").Model {
    return this.#model;
  }

  get provider(): import("../provider/mod.ts").Provider {
    return this.#provider;
  }

  get decisions(): DecisionService {
    return this.#decisions;
  }

  get thinkingLevel(): ThinkingLevel {
    return this.#thinking;
  }

  get multiAgent(): boolean {
    return this.#multiAgent;
  }

  /** The canonical session ID (empty before initialization). */
  currentSessionID(): string {
    return this.#manager.getHeader()?.id ?? "";
  }

  /** Rebinds the session after a fork/switch. */
  async bindManager(manager: Manager): Promise<void> {
    this.#manager = manager;
    const header = manager.getHeader();
    if (header !== null) {
      this.#workDir = header.cwd !== "" ? header.cwd : this.#workDir;
    }
    await this.#runtime.bindSession(manager, SourceTUI);
  }

  /** Binds a provider/model pair chosen in a dialog to the live session. */
  applyModelBinding(providerName: string, modelID: string): void {
    const created = createWithOptions(
      this.#settings,
      providerName,
      modelID,
      { requireModel: true },
    );
    this.#provider = created.provider;
    this.#providerName = providerName;
    this.#model = created.model;
    this.refreshHeader();
    this.#configureRuntimeSession();
  }

  /** Re-reads settings.json and re-applies the provider/model binding. */
  reloadSettings(): void {
    const fresh = loadSettingsWithMeta().settings;
    this.#settings = fresh;
    const created = createWithOptions(
      fresh,
      this.#providerName,
      this.#model.id,
      { requireModel: false },
    );
    this.#provider = created.provider;
    this.#model = created.model;
    this.refreshHeader();
    this.#configureRuntimeSession();
  }

  /** Rebuilds the provider/model binding from settings. */
  reloadModel(): void {
    const created = createWithOptions(
      this.#settings,
      this.#providerName,
      this.#model.id,
      { requireModel: true },
    );
    this.#provider = created.provider;
    this.#model = created.model;
  }

  /** Returns the listing helper bound to this session's directory. */
  listSessionDetails(): SessionDetail[] {
    return listManagerSessions(
      this.#manager.getHeader()?.cwd ?? this.#workDir,
      this.#manager.getSessionDir(),
    );
  }

  /** Updates the header shown by the shell after a model/provider change. */
  refreshHeader(): void {
    this.header.modelName = this.#model.id;
    this.header.providerName = this.#providerName;
  }
}

/** Re-exported for the shell/tests. */
export { dispatchCommand };
export type { KeyEvent };
