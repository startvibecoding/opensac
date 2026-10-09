// () + main_util.go runPrint(): the CLI
// root `-P` print action. Runs one canonical durable turn through the shared
// `opensac core` over the Core Client short connection (the same host the TUI
// and the ACP bridge use) and projects the canonical run events to
// stdout/stderr (text or NDJSON). The print action never constructs Providers,
// Builders, SessionRuntimes, or ExecutionRuntimes: session identity, the
// durable run, and the print/unattended run policy are Core-owned.

import { configDir, type Settings } from "../config/mod.ts";
import { CoreClient } from "../core/client.ts";
import { resolveCoreConfig } from "../core/config.ts";
import { CORE_PROTOCOL_VERSION } from "../core/server.ts";
import { current as appVersionCurrent } from "../version/version.ts";
import { createCoreClientTUIService } from "../tui/core_service.ts";
import { tuiResumeOptions } from "./root_tui.ts";
import { isDirectoryTarget } from "../tui/tui_session.ts";
import { isSessionNotFound } from "../tui/service.ts";
import type {
  TUIDecisionRequest,
  TUIService,
  TUISessionView,
} from "../tui/service.ts";
import { coreEventToAgentEvent } from "../tui/run_event_projection.ts";
import {
  EVENT_ERROR,
  EVENT_HOSTED_ITEM,
  EVENT_RETRY,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
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
} from "../agentruntime/events.ts";

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
  /**
   * `-c` / `-r` / `--session`: continue the newest persisted session of this
   * directory, or resume one specific id/path. Print must honour the same flags
   * the TUI does, otherwise `opensac -p -c "..."` silently runs in a throwaway
   * session and the scripted follow-up loses the conversation it was meant to
   * continue.
   */
  continueSession?: boolean;
  resume?: string;
  session?: string;
  /** Stderr line writer (tests). */
  writeError?: (line: string) => void;
  /** Stdout writer (tests). */
  writeOut?: (line: string) => void;
  /** Width for markdown rendering; defaults to a fixed 80 in tests. */
  mdWidth?: number;
}

export interface PrintDeps {
  settings: Settings;
  /**
   * Injected service seam (tests). Production connects to the shared Core
   * through `createCoreClientTUIService`, exactly like the TUI entry.
   */
  service?: TUIService;
}

export interface PrintRunResult {
  output: string;
  exitCode: number;
}

/** The print run's service plus its connection teardown. */
interface PrintService {
  service: TUIService;
  close: () => Promise<void>;
}

/** Discovers or auto-starts the shared Core (like `opensac acp`/the TUI). */
async function openPrintService(
  deps: PrintDeps,
  workDir: string,
): Promise<PrintService> {
  if (deps.service !== undefined) {
    return { service: deps.service, close: () => Promise.resolve() };
  }
  const core = new CoreClient({
    stateDir: configDir(),
    version: appVersionCurrent(),
    protocolVersion: CORE_PROTOCOL_VERSION,
    config: resolveCoreConfig(deps.settings),
  });
  const discovery = await core.ensureStarted();
  if (discovery.status !== "ready") {
    await core.close();
    const hint = discovery.status === "incompatible"
      ? '; run "opensac core stop" to replace it'
      : "";
    throw new Error(`Core is not ready: ${discovery.status}${hint}`);
  }
  return {
    service: createCoreClientTUIService(core, { workDir }),
    close: () => core.close(),
  };
}

/**
 * Opens the session one print run executes in: resumed when `-c`/`-r` asked for
 * it, otherwise freshly created by the Core.
 *
 * The resume target is resolved through the same listing-and-scoped-open rule the
 * TUI uses, and an unresolvable target degrades to a fresh session with a report
 * on stderr rather than failing the whole run: a script that passes a stale `-r`
 * id still gets its answer, and the reason it did not continue is visible.
 */
async function openPrintSession(
  service: TUIService,
  options: PrintOptions,
  resolved: {
    workDir: string;
    providerName: string;
    modelID: string;
    mode: string;
    thinkingLevel: string;
  },
): Promise<TUISessionView> {
  const create = () =>
    service.createSession({
      workDir: resolved.workDir,
      providerName: resolved.providerName,
      modelID: resolved.modelID,
      mode: resolved.mode,
      thinkingLevel: resolved.thinkingLevel,
      source: "cli",
      approvalPolicy: "print",
      questionPolicy: "unattended",
      ...(options.multiAgent === true
        ? { capabilities: { multiAgent: true } }
        : {}),
    });
  const target = tuiResumeOptions(options);
  if (!target.continueLast && target.resumeSession === "") {
    return await create();
  }
  // `-r`/`--session` names either a directory (whose newest session is chosen)
  // or an id scoped to this working directory; `-c` always means "the newest of
  // this directory".
  const dirTarget = target.resumeSession !== "" &&
      isDirectoryTarget(target.resumeSession)
    ? target.resumeSession
    : "";
  const workDir = dirTarget !== "" ? dirTarget : resolved.workDir;
  let picked;
  try {
    const entries = await service.listPersistedSessions({ workDir });
    picked = dirTarget !== "" || target.continueLast
      ? newestFirst(entries)
      : entries.find((entry) => entry.sessionId === target.resumeSession);
    if (picked === undefined) return await create();
    return await service.openSession({
      sessionId: picked.sessionId,
      workDir,
    });
  } catch (error) {
    // Only an absent target degrades to a fresh session, so a script passing a
    // stale `-r` id still gets its answer. An unreachable or incompatible Core
    // must propagate: silently starting a new session would make a scripted
    // follow-up run against the wrong conversation with no indication why.
    if (!isSessionNotFound(error)) throw error;
    return await create();
  }
}

/**
 * The most recently modified session of one listing that actually has a
 * conversation. Aborted or never-used startups persist empty rows; "newest"
 * must mean the newest conversation, matching the TUI's `-c` selection.
 */
function newestFirst<T extends { modTime: Date; messageCount: number }>(
  entries: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const entry of entries) {
    const at = new Date(entry.modTime).getTime();
    if (!Number.isFinite(at)) continue;
    if (entry.messageCount <= 0) continue;
    if (best === undefined || at > new Date(best.modTime).getTime()) {
      best = entry;
    }
  }
  return best;
}

/**
 * Answers one Core-requested human decision unattended: a question is answered
 * empty (the `unattended` question policy) and an approval is denied so the run
 * is never wedged; the canonical approval event still fails the print run.
 */
async function answerUnattended(
  service: TUIService,
  request: TUIDecisionRequest,
): Promise<void> {
  try {
    if (request.kind === "approval") {
      await service.answerDecision({
        requestId: request.requestId,
        kind: "approval",
        approved: false,
      });
      return;
    }
    await service.answerDecision({
      requestId: request.requestId,
      kind: "question",
      answer: "",
    });
  } catch {
    // First response wins elsewhere; print must never block on decisions.
  }
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

  const providerName = options.provider !== ""
    ? options.provider
    : (settings.defaultProvider ?? "");
  const modelID = options.model !== ""
    ? options.model
    : (settings.defaultModel ?? "");
  const mode = options.mode || settings.defaultMode || "yolo";
  const thinkingLevel = options.thinking || settings.defaultThinkingLevel ||
    "";

  if (options.json) {
    emitJSON(write, {
      type: "start",
      provider: providerName,
      model: modelID,
      mode,
    });
  } else {
    writeError(`Using ${providerName}/${modelID} in ${mode} mode`);
  }

  const { service, close } = await openPrintService(deps, workDir);
  try {
    // Session setup: a resumed session when `-c`/`-r`/`--session` asked for one,
    // otherwise one fresh Core-owned session per print run (Go setupSession
    // default). Either way the Core mints the persisted identity and records the
    // canonical run with the print/unattended run policy.
    const session = await openPrintSession(service, options, {
      workDir,
      providerName,
      modelID,
      mode,
      thinkingLevel,
    });
    const sessionId = session.sessionId;
    if (options.delegate === true) {
      await service.setDelegate({ sessionId, enabled: true });
    }

    // Human decisions stay Core-owned; print answers them unattended so the
    // run can never block on a person.
    const stopDecisions = service.onDecisionRequest((request) => {
      void answerUnattended(service, request);
    });

    let textBuffer = "";
    let runErr: string | null = null;
    let runId = "";
    // Canonical terminal state of the Core-owned run. A failed or cancelled
    // run must surface as a message and a non-zero exit code instead of the
    // old silent success (scripts could not tell a failed turn from a
    // completed one).
    let terminalState = "completed";
    let terminalError: string | undefined;

    const drainText = (): void => {
      if (textBuffer === "") return;
      write(wrapLines(textBuffer, mdWidth));
      textBuffer = "";
    };

    try {
      const accepted = await service.prompt({
        sessionId,
        text: options.prompt,
        providerName,
        modelID,
        mode,
        thinkingLevel,
      });
      runId = accepted.runId;
      for await (
        const event of service.subscribeRunEvents(sessionId, accepted.runId)
      ) {
        const agentEvent = coreEventToAgentEvent(event);
        if (agentEvent === undefined) continue;
        switch (agentEvent.type) {
          case EVENT_TOOL_APPROVAL_REQUEST:
            throw new Error(
              `tool approval required in print mode for ${agentEvent.approvalTool}; rerun interactively, use --mode yolo, or whitelist the command`,
            );
          case EVENT_TEXT_DELTA:
            if (options.json) {
              emitJSON(write, {
                type: "text_delta",
                text: agentEvent.textDelta,
              });
            } else {
              textBuffer += agentEvent.textDelta ?? "";
            }
            continue;
          case EVENT_THINK_DELTA:
            if (options.json) {
              emitJSON(write, {
                type: "think_delta",
                think: agentEvent.thinkDelta,
              });
            }
            continue;
          case EVENT_HOSTED_ITEM:
            if (options.json && agentEvent.hostedItem) {
              emitJSON(write, {
                type: "hosted_item",
                hostedItem: agentEvent.hostedItem,
              });
            }
            continue;
          case EVENT_TOOL_CALL:
            drainText();
            if (options.json) {
              emitJSON(write, {
                type: "tool_call",
                id: agentEvent.toolCall?.id,
                name: agentEvent.toolCall?.name,
                arguments: agentEvent.toolArgs,
              });
            } else {
              writeError(`[tool: ${agentEvent.toolCall?.name}]`);
            }
            continue;
          case EVENT_TOOL_EXECUTION_START:
            if (options.json) {
              emitJSON(write, {
                type: "tool_execution_start",
                name: agentEvent.toolName,
              });
            } else {
              writeError(`[running: ${agentEvent.toolName}] `);
            }
            continue;
          case EVENT_TOOL_EXECUTION_END:
            if (options.json) {
              emitJSON(write, {
                type: "tool_execution_end",
                name: agentEvent.toolName,
                error: agentEvent.toolError?.message,
              });
            } else {
              writeError(
                agentEvent.toolError
                  ? `error: ${agentEvent.toolError.message}`
                  : "done",
              );
            }
            continue;
          case EVENT_STATUS:
            // Long retry loops must stay visible instead of silent waiting;
            // text mode reports retries on stderr, NDJSON gets every status.
            if (options.json) {
              emitJSON(write, {
                type: "status",
                ...(agentEvent.statusMessage === undefined
                  ? {}
                  : { message: agentEvent.statusMessage }),
              });
            } else if (agentEvent.retryStatus === true) {
              writeError(agentEvent.statusMessage ?? "retrying");
            }
            continue;
          case EVENT_RETRY:
          case EVENT_ERROR: {
            const message = agentEvent.statusMessage;
            if (options.json) {
              emitJSON(write, {
                type: agentEvent.type === EVENT_RETRY ? "retry" : "error",
                ...(message === undefined ? {} : { message }),
              });
            } else if (message !== undefined) {
              writeError(message);
            }
            continue;
          }
          case EVENT_TOOL_RESULT:
            continue;
          case EVENT_RUN_FINISHED:
            drainText();
            if (agentEvent.status === TASK_FAILED) terminalState = "failed";
            else if (agentEvent.status === TASK_CANCELED) {
              terminalState = "cancelled";
            } else if (agentEvent.status === TASK_INCOMPLETE) {
              terminalState = "incomplete";
            }
            terminalError ??= agentEvent.error?.message;
            continue;
          default:
            continue;
        }
      }
    } catch (error) {
      runErr = (error as Error).message;
      drainText();
    } finally {
      stopDecisions();
      if (runId !== "") {
        try {
          const view = await service.cancelRun({ sessionId, runId });
          // The run view is authoritative for the durable terminal state and
          // carries the failure reason the Core recorded for the run.
          if (view.status === "completed") terminalState = "completed";
          else if (view.status === "cancelled") terminalState = "cancelled";
          else if (view.status !== "running") terminalState = "failed";
          terminalError ??= view.error;
        } catch {
          // The run may already be terminal; closing below releases it.
        }
      }
      await service.closeSession({ sessionId });
    }

    drainText();
    if (runErr !== null) {
      if (options.json) emitJSON(write, { type: "error", message: runErr });
      else writeError(runErr);
      return { output: textBuffer, exitCode: 1 };
    }
    if (terminalState !== "completed") {
      const message = terminalError ?? `run ${terminalState}`;
      if (options.json) {
        emitJSON(write, {
          type: "run_finished",
          status: terminalState,
          ...(terminalError === undefined ? {} : { error: terminalError }),
        });
      } else {
        writeError(message);
      }
      return { output: textBuffer, exitCode: 1 };
    }
    if (options.json) {
      emitJSON(write, { type: "run_finished", status: "completed" });
    }
    return { output: textBuffer, exitCode: 0 };
  } finally {
    await close();
  }
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
  status?: string;
  message?: string;
}

function emitJSON(
  write: (line: string) => void,
  event: PrintJSONEvent,
): void {
  write(JSON.stringify(event));
}
