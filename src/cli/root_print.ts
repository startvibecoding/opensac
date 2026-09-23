// () + main_util.go runPrint(): the CLI
// root `-p` print action. Runs one canonical durable turn through the shared
// runtime and streams the agent events to stdout/stderr (text or NDJSON).
// The interactive TUI action lands in the next slice; this is the command
// path that must exist for scripts and CI.

import { create } from "../provider/factory/factory.ts";
import { consumeEvents } from "../agent/eventloop.ts";
import type { Event } from "../agent/events.ts";
import {
  EVENT_HOSTED_ITEM,
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_APPROVAL_REQUEST,
  EVENT_TOOL_CALL,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
  EVENT_TOOL_RESULT,
  TASK_CANCELED,
  TASK_FAILED,
  TASK_INCOMPLETE,
} from "../agent/events.ts";
import { Builder } from "../agentruntime/session_runtime.ts";
import { SOURCE_CLI } from "../agentruntime/source.ts";
import { RunStore } from "../agentruntime/run_store.ts";
import { ExecutionRuntime } from "../agentruntime/execution.ts";
import { SessionRunEventSink } from "../agentruntime/run_event.ts";
import { acquireExecutionAdmission } from "../agentruntime/execution_admission.ts";
import type { ExecutionIntent } from "../session/execution_intent.ts";
import { generateID, runUserEntryID } from "../session/mod.ts";
import { resourceIds } from "../agentruntime/input_materializer.ts";
import { createSession } from "../agentruntime/session_lifecycle.ts";
import {
  isArtifactEnabled,
  loadAllow,
  sandboxLevelFromSettings,
  type Settings,
} from "../config/mod.ts";
import { normalizeThinkingLevel } from "../provider/mod.ts";

export interface PrintOptions {
  prompt: string;
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  workDir: string;
  json: boolean;
  multiAgent?: boolean;
  delegate?: boolean;
  workflows?: boolean;
  /** Stderr line writer (tests). */
  writeError?: (line: string) => void;
  /** Stdout writer (tests). */
  writeOut?: (line: string) => void;
  /** Width for markdown rendering; defaults to a fixed 80 in tests. */
  mdWidth?: number;
}

export interface PrintDeps {
  settings: Settings;
}

export interface PrintRunResult {
  output: string;
  exitCode: number;
}

/** Runs one print-mode turn; returns the text output and process exit code. */
export async function runPrintAction(
  options: PrintOptions,
  deps: PrintDeps,
): Promise<PrintRunResult> {
  const settings = deps.settings;
  const writeError = options.writeError ??
    ((line: string) => console.error(line));
  const write = options.writeOut ?? ((line: string) => console.log(line));
  const mdWidth = options.mdWidth ?? 80;
  const workDir = options.workDir !== "" ? options.workDir : Deno.cwd();

  const created = create(settings, options.provider, options.model, {
    requireModel: true,
  });
  const providerName = options.provider !== ""
    ? options.provider
    : (settings.defaultProvider ?? "");
  const mode = options.mode || settings.defaultMode || "yolo";
  const thinkingLevel = normalizeThinkingLevel(
    options.thinking || settings.defaultThinkingLevel || "",
  ) as import("../provider/mod.ts").ThinkingLevel;

  if (options.json) {
    emitJSON({
      type: "start",
      provider: created.provider.name(),
      model: created.model.id,
      mode,
    });
  } else {
    writeError(
      `Using ${created.provider.name()}/${created.model.id} in ${mode} mode`,
    );
  }

  // Session setup: one fresh session per print run (Go setupSession default).
  const manager = createSession({ workDir });
  const header = manager.getHeader();
  const sessionId = header?.id ?? "";

  // SessionRuntime is built through the shared Builder (registry, skills,
  // sandbox, MCP): the only production construction path.
  const runtime = await new Builder(settings, levelFromSettings(settings))
    .build(
      undefined,
      {
        source: SOURCE_CLI,
        workDir,
        workflows: options.workflows === true,
        browser: false,
        artifactEnabled: isArtifactEnabled(settings),
        manager,
      },
    );

  let release: (() => void) | undefined;
  let execution: ExecutionRuntime | undefined;
  let runId = "";
  let intentId = "";
  let turnId = "";
  let submission = await runtime.acceptInput(undefined, "", options.prompt, []);
  let userMessage: import("../provider/mod.ts").Message | undefined;

  if (sessionId !== "") {
    const guard = await acquireExecutionAdmission(
      undefined,
      manager.getSessionDir(),
      sessionId,
      {},
    );
    release = () => guard.release();
    const startedAt = new Date();
    runId = `cli_${generateID()}`;
    intentId = `intent_${generateID()}`;
    turnId = `turn-${intentId}`;
    submission = await runtime.acceptInput(
      undefined,
      runId,
      options.prompt,
      [],
    );
    userMessage = runtime.buildUserMessage(undefined, submission);
    const requestSnapshot = JSON.stringify({
      message: options.prompt,
      model: created.model.id,
      mode,
      workDir,
    });
    const policySnapshot = JSON.stringify({
      source: "cli",
      mode,
      workDir,
      approvalPolicy: "print",
      questionPolicy: "unattended",
    });
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(requestSnapshot),
      ),
    );
    const fingerprint = Array.from(digest).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    const intent: ExecutionIntent = {
      id: intentId,
      sessionId,
      source: "cli",
      model: created.model.id,
      mode,
      workDir,
      requestFingerprint: `sha256:${fingerprint}`,
      request: JSON.parse(requestSnapshot),
      policy: JSON.parse(policySnapshot),
      createdAt: startedAt,
    };
    const startData = JSON.stringify({ intentId, attempt: 1 });
    execution = new ExecutionRuntime();
    execution.setRunStore(new RunStore(manager.getSessionDir()));
    execution.setEventSink(new SessionRunEventSink(manager.getSessionDir()));
    runtime.setExecution(execution);
    execution.beginIntentDurable(undefined, intent, {
      id: runId,
      sessionId,
      intentId,
      retryOf: "",
      attempt: 1,
      workDir,
      source: "cli",
      model: created.model.id,
      mode,
      status: "running",
      startedAt,
      finishedAt: null,
      error: "",
      errorInfo: {},
      progress: {},
      usage: null,
      contextUsage: null,
      inputResourceIds: resourceIds(submission),
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
      source: "cli",
      status: "running",
      model: created.model.id,
      mode,
      timestamp: startedAt,
      data: startData,
    });
  }

  const agent = runtime.buildAgent({
    provider: created.provider,
    providerName,
    model: created.model,
    settings,
    allow: loadAllow(),
    mode,
    thinkingLevel,
    extraContext: runtime.extraContext,
    ruleContent: runtime.ruleContent,
    multiAgent: options.multiAgent === true,
    delegateMode: options.delegate === true,
    workflows: options.workflows === true,
  });
  if (turnId !== "") {
    agent.setConversationTurn(turnId, intentId, runId);
    execution?.setAgent(agent);
  }

  const events = agent.runWithUserMessage(userMessage!);
  let textBuffer = "";
  let runErr: string | null = null;
  let terminalState = "completed";

  try {
    await consumeEvents(events, {
      handleAgentEvent(event: Event): void {
        switch (event.type) {
          case EVENT_TOOL_APPROVAL_REQUEST:
            throw new Error(
              `tool approval required in print mode for ${event.approvalTool}; rerun interactively, use --mode yolo, or whitelist the command`,
            );
          case EVENT_TEXT_DELTA:
            if (options.json) {
              emitJSON({ type: "text_delta", text: event.textDelta });
            } else {
              textBuffer += event.textDelta ?? "";
            }
            return;
          case EVENT_THINK_DELTA:
            if (options.json) {
              emitJSON({ type: "think_delta", think: event.thinkDelta });
            }
            return;
          case EVENT_HOSTED_ITEM:
            if (options.json && event.hostedItem) {
              emitJSON({
                type: "hosted_item",
                hostedItem: event.hostedItem,
              });
            }
            return;
          case EVENT_TOOL_CALL:
            drainText();
            if (options.json) {
              emitJSON({
                type: "tool_call",
                id: event.toolCall?.id,
                name: event.toolCall?.name,
                arguments: event.toolArgs,
              });
            } else {
              writeError(`[tool: ${event.toolCall?.name}]`);
            }
            return;
          case EVENT_TOOL_EXECUTION_START:
            if (options.json) {
              emitJSON({ type: "tool_execution_start", name: event.toolName });
            } else {
              writeError(`[running: ${event.toolName}] `);
            }
            return;
          case EVENT_TOOL_EXECUTION_END:
            if (options.json) {
              emitJSON({
                type: "tool_execution_end",
                name: event.toolName,
                error: event.toolError?.message,
              });
            } else {
              writeError(
                event.toolError ? `error: ${event.toolError.message}` : "done",
              );
            }
            return;
          case EVENT_TOOL_RESULT:
            return;
          case EVENT_RUN_FINISHED:
            drainText();
            if (event.status === TASK_FAILED) terminalState = "failed";
            else if (event.status === TASK_CANCELED) {
              terminalState = "cancelled";
            } else if (event.status === TASK_INCOMPLETE) {
              terminalState = "incomplete";
            }
            return;
          default:
            return;
        }
      },
    });
  } catch (error) {
    runErr = (error as Error).message;
    drainText();
  }

  function drainText(): void {
    if (textBuffer === "") return;
    write(wrapLines(textBuffer, mdWidth));
    textBuffer = "";
  }

  if (runErr !== null) {
    if (execution !== undefined && runId !== "") {
      execution.finishDurableWithRetry(undefined, runId, "failed", runErr, {
        sessionId,
        runId,
        eventType: "failed",
        source: "cli",
        status: "failed",
        model: created.model.id,
        mode,
        timestamp: new Date(),
      });
    }
    release?.();
    runtime.close?.();
    return { output: textBuffer, exitCode: 1 };
  }

  drainText();
  if (
    execution !== undefined && runId !== "" && terminalState !== "completed"
  ) {
    execution.finishDurableWithRetry(
      undefined,
      runId,
      terminalState,
      runErr ?? "",
      {
        sessionId,
        runId,
        eventType: terminalState,
        source: "cli",
        status: terminalState,
        model: created.model.id,
        mode,
        timestamp: new Date(),
      },
    );
  }
  release?.();
  runtime.close?.();

  if (runErr !== null) {
    return { output: "", exitCode: 1 };
  }
  return { output: textBuffer, exitCode: 0 };
}

function wrapLines(text: string, width: number): string {
  const wrapped: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      wrapped.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      wrapped.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    wrapped.push(rest);
  }
  return wrapped.join("\n");
}

interface PrintJSONEvent {
  type: string;
  provider?: string;
  model?: string;
  mode?: string;
  text?: string;
  think?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  error?: string;
  hostedItem?: unknown;
}

function emitJSON(event: PrintJSONEvent): void {
  console.log(JSON.stringify(event));
}

function levelFromSettings(settings: Settings) {
  return sandboxLevelFromSettings(settings);
}
