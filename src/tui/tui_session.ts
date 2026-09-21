// Interactive TUI session state: the assembly of controller + editor + run
// lifecycle for the root interactive action. The Ink shell (tui_shell.tsx)
// renders and feeds it keyboard events.

import { createWithOptions } from "../provider/factory/factory.ts";
import { Builder } from "../agentruntime/session_runtime.ts";
import { SourceTUI } from "../agentruntime/source.ts";
import { ExecutionRuntime } from "../agentruntime/execution.ts";
import { RunStore } from "../agentruntime/run_store.ts";
import { SessionRunEventSink } from "../agentruntime/run_event.ts";
import { acquireExecutionAdmission } from "../agentruntime/execution_admission.ts";
import type { ExecutionIntent } from "../session/execution_intent.ts";
import { generateID, runUserEntryID } from "../session/mod.ts";
import type { Manager } from "../session/manager.ts";
import { createSession } from "../agentruntime/session_lifecycle.ts";
import {
  isArtifactEnabled,
  loadAllow,
  sandboxLevelFromSettings,
  type Settings,
} from "../config/mod.ts";
import {
  type Message,
  normalizeThinkingLevel,
  type ThinkingLevel,
} from "../provider/mod.ts";
import { AppController } from "./app_controller.ts";
import { TuiRun } from "./tui_run.ts";
import { Editor } from "./components/editor/editor.ts";
import { Translator } from "./i18n.ts";
import type { AppProps } from "./app.tsx";

export interface TUISessionOptions {
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  workDir: string;
  version: string;
}

/** One interactive TUI session. */
export class TUISession {
  readonly controller: AppController;
  readonly editor: Editor;
  readonly header: NonNullable<AppProps["header"]>;
  #runtime: Awaited<ReturnType<Builder["build"]>>;
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

  constructor(options: TUISessionOptions, settings: Settings) {
    this.#settings = settings;
    this.#workDir = options.workDir;
    const created = createWithOptions(
      settings,
      options.provider,
      options.model,
      {
        requireModel: true,
      },
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
    const translator = Translator.fromConfig("").translator;
    this.controller = new AppController(translator, {
      onMessage: () => {},
      scheduleRender: () => {},
    });
    this.editor = new Editor({ width: 80, placeholder: "Type a message..." });
    this.#manager = createSession({ workDir: this.#workDir });
    this.#runtime = undefined as never;
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
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** The effective execution mode of this session. */
  get mode(): string {
    return this.#mode;
  }

  /** Submits one user message as a durable conversation-turn run. */
  async submitPrompt(text: string): Promise<void> {
    if (this.#busy || text.trim() === "") return;
    this.#busy = true;
    this.controller.isThinking = true;
    // Echo the user turn into the transcript before the run starts.
    this.controller.addMessage(`❯ ${text}`, "plain");
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
    execution.setAgent(agent);
    const events = agent.runWithUserMessage(userMessage);
    try {
      for await (const event of events) {
        this.controller.handleAgentEvent(event);
        if (this.controller.runTerminalHandled) break;
      }
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
    this.controller.resolveApproval(shown.approvalID, approved);
  }

  /** Answers the shown question with the chosen option. */
  answerQuestion(value: string): void {
    this.controller.shownQuestion = undefined;
    this.controller.waitingForQuestion = false;
    this.controller.showNextQuestion();
    void value;
  }
}
