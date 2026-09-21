// Ported from internal/serve/run.go — the top-level Run() assembly: config
// state, settings, the log hub wiring, the channel runtime, and the
// openaiapi.Run delegation with the management routes and the run-complete
// bound-session observer as projections of the shared state.
//
// Deviations: Go's debug pprof startup and the VIBECODING_DEBUG env write are
// development-only surfaces without a Deno counterpart and are not reproduced;
// `config.Verbose` maps to openaiapi's setVerbose (applied inside
// openaiapi.run); Go's deferred cleanup maps to try/finally;
// `session.SubscribeRuntimeLeaseLogs` log events reuse the LogHub's ISO
// timestamps.

import {
  getSessionDir,
  loadSettings,
  type Settings,
  setVerbose,
} from "../config/settings.ts";
import { errorFromRun, startChannels } from "./channel_runtime.ts";
import {
  PLACEHOLDER_AUTH_TOKEN_WARNING,
  usesPlaceholderAuthToken,
} from "./config.ts";
import { loadServeConfigState } from "./config_state.ts";
import { installLogHub, LogHub, type ServeLogEvent } from "./logs.ts";
import { displayListenAddr, type RunOptions } from "./options.ts";
import { run as openaiapiRun } from "./openaiapi/lifecycle.ts";
import {
  getSessionMessages,
  getSessionRunEvents,
} from "./openaiapi/session_read.ts";
import type { Server } from "./openaiapi/server.ts";
import { isSuccessfulRunStatus } from "./openaiapi/events.ts";
import { serveRoutes } from "./run_handlers.ts";
import { subscribeRuntimeLeaseLogs } from "../session/runtime_lease_bus.ts";
import { watchDatabaseRebuilds } from "../session/database_recovery_notice.ts";

/**
 * run ports Go's top-level serve Run(): assemble the config state, the log
 * hub, and the channel runtime, then serve until shutdown.
 */
export async function run(opts: RunOptions, version: string): Promise<void> {
  setVerbose(opts.verbose || opts.debug);

  const configState = loadServeConfigState(opts);
  const cfg = configState.effective;
  const path = configState.writablePath;

  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    throw new Error(`load settings: ${(err as Error).message}`);
  }
  if (cfg.api.enableWebSearch) {
    settings = {
      ...settings,
      webSearch: { ...settings.webSearch, enabled: true },
    };
  }

  console.error(`MothX Serve ${version} starting`);
  const displayAddr = displayListenAddr(cfg.api.listen);
  if (cfg.features.openAIAPI) {
    console.error(
      `  OpenAI API: http://${displayAddr}/v1/chat/completions`,
    );
  } else {
    console.error("  OpenAI API: disabled");
  }
  if (cfg.webUI.enabled) {
    console.error(`  Web UI: http://${displayAddr}/`);
  } else {
    console.error("  Web UI: disabled");
  }

  const logHub = new LogHub();
  const restoreLogs = installLogHub(logHub);
  const stopLeaseLogs = subscribeRuntimeLeaseLogs((message) => {
    const ev: ServeLogEvent = {
      type: "log",
      message,
      timestamp: new Date().toISOString(),
    };
    logHub.publish(ev);
  });
  // A database another process rebuilt after a failed migration replaces the
  // file this process may still hold open; retire the cached connection (the
  // notice is logged into the serve log stream).
  const stopDatabaseWatch = watchDatabaseRebuilds(null);

  const rt = startChannels(cfg, getSessionDir(settings), version, settings);
  rt.setConfigState(configState);
  rt.logHub = logHub;
  try {
    if (cfg.lobsterMode) {
      console.error(
        "  Lobster mode: enabled (yolo, no sandbox, sub-agents on)",
      );
    }
    console.error(`  Config: ${path}`);
    // A generated template token is publicly known, so an exposed server would
    // be reachable by anyone; warn until the operator replaces it.
    if (usesPlaceholderAuthToken(cfg)) {
      console.error(PLACEHOLDER_AUTH_TOKEN_WARNING);
    }

    await openaiapiRun(
      {
        config: cfg.api,
        disableAPI: !cfg.features.openAIAPI,
        provider: opts.provider,
        model: opts.model,
        workDir: opts.workDir,
        unsafe: opts.unsafe,
        sandbox: opts.sandbox,
        multiAgent: opts.multiAgent,
        delegate: opts.delegate,
        workflows: opts.workflows,
        webSearch: opts.webSearch,
        browser: opts.browser,
        artifact: opts.artifact,
        a2aMaster: opts.a2aMaster,
        cronStore: rt.cronSnapshot() ?? undefined,
        cronScheduler: rt.cronSchedulerSnapshot() ?? undefined,
        verbose: opts.verbose,
        debug: opts.debug,
        shutdown: opts.shutdown,
        extraRoutes: serveRoutes(rt, path),
        onReady: (api: Server) => {
          rt.configureAPI(api);
          // API construction completes shared durable-run recovery before
          // this callback. Start transports only after that recovery so
          // their first inbound delivery cannot collide with a stale Run.
          rt.startPlatforms();
          opts.onReady?.(api, rt.dispatcher);
          api.setRunCompleteObserver(
            (sessionID, runID, status, errMsg) => {
              let response = "";
              if (isSuccessfulRunStatus(status)) {
                try {
                  const messages = getSessionMessages(api, sessionID);
                  for (let i = messages.length - 1; i >= 0; i--) {
                    const msg = messages[i];
                    if (
                      msg.role === "assistant" &&
                      (msg.content ?? "").trim() !== ""
                    ) {
                      response = msg.content ?? "";
                      break;
                    }
                  }
                } catch {
                  // Go ignores the message-scan error too.
                }
              }
              let message = errMsg;
              if (!isSuccessfulRunStatus(status) && message.trim() === "") {
                try {
                  const events = getSessionRunEvents(api, sessionID);
                  for (let i = events.length - 1; i >= 0; i--) {
                    const ev = events[i];
                    if (ev.runId !== runID || ev.data === undefined) continue;
                    const candidate = ev.data["error"];
                    if (
                      typeof candidate === "string" && candidate.trim() !== ""
                    ) {
                      message = candidate;
                      break;
                    }
                  }
                } catch {
                  // Go ignores the event-scan error too.
                }
              }
              void rt.pushBoundSessionResult(
                sessionID,
                response,
                errorFromRun(status, message),
              );
            },
          );
        },
      },
      version,
    );
  } finally {
    await rt.stop();
    stopDatabaseWatch();
    stopLeaseLogs();
    restoreLogs();
  }
}
