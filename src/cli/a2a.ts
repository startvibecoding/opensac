// Ported from cmd/mothx/main_a2a.go: the `a2a` command group.
//
// `start` runs the standalone A2A JSON-RPC server (src/a2a) with a Runtime
// agent factory; `init-config` writes the a2a.json template; `stop` and
// `status` are best-effort PID-file operations. The master-mode agent list is
// managed separately by src/a2a/master.

import {
  type Config,
  configPath,
  getListenAddr,
  initA2AConfig,
  loadConfig,
  projectConfigPath,
} from "../a2a/config.ts";
import { run } from "../a2a/server.ts";
import { current as currentVersion } from "../version/version.ts";
import type { A2AAgent, AgentFactory } from "../a2a/executor.ts";
import type { Event } from "../agent/events.ts";
import type { AgentID } from "../../sdk/agent/types.ts";
import type { AgentExecutor } from "../a2a/handler.ts";
import { createWithOptions } from "../provider/factory/factory.ts";
import { Builder } from "../agentruntime/session_runtime.ts";
import { SourceACP } from "../agentruntime/source.ts";
import { isArtifactEnabled, loadAllow, type Settings } from "../config/mod.ts";
import { normalizeThinkingLevel } from "../provider/mod.ts";

export interface A2AStartOptions {
  port: number;
  workDir: string;
  provider: string;
  model: string;
  sandbox: boolean;
  authToken: string;
  /** Injectable executor (tests avoid Runtime bootstrap). */
  executor?: AgentExecutor;
}

export function defaultA2AStartOptions(): A2AStartOptions {
  return {
    port: 0,
    workDir: "",
    provider: "",
    model: "",
    sandbox: false,
    authToken: "",
  };
}

/** Loads global + optional project overlay, applying CLI overrides. */
export function resolveA2AConfig(options: A2AStartOptions): {
  config: Config;
  path: string;
} {
  // Project config takes precedence when present (matches the serve layer).
  let configFile = configPath();
  let cfg = loadConfig(configFile);
  try {
    const projectFile = projectConfigPath();
    Deno.statSync(projectFile);
    cfg = loadConfig(projectFile);
    configFile = projectFile;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  if (options.port > 0) cfg.port = options.port;
  if (options.workDir !== "") cfg.work_dir = options.workDir;
  if (options.authToken !== "") cfg.auth_token = options.authToken;
  return { config: cfg, path: configFile };
}

/**
 * Bridges the a2a package to the shared runtime: each task gets a transient
 * agent built through `Builder.build` + `buildAgent` (the only production
 * construction path), mirroring Go's simpleAgentFactory.
 */
export class RuntimeAgentFactory implements AgentFactory {
  #settings: Settings;
  #provider: string;
  #model: string;
  #defaultWorkDir: string;
  #sandbox: boolean;

  constructor(
    settings: Settings,
    options: {
      provider: string;
      model: string;
      workDir: string;
      sandbox: boolean;
    },
  ) {
    this.#settings = settings;
    this.#provider = options.provider;
    this.#model = options.model;
    this.#defaultWorkDir = options.workDir;
    this.#sandbox = options.sandbox;
  }

  async createForA2A(workDir: string, mode: string): Promise<A2AAgent> {
    if (workDir === "") workDir = this.#defaultWorkDir;
    const created = createWithOptions(
      this.#settings,
      this.#provider,
      this.#model,
      { requireModel: true },
    );
    const sandboxLevel = this.#sandbox ? 1 : 0;
    const runtime = await new Builder(this.#settings, sandboxLevel).build(
      undefined,
      {
        // Go's simpleAgentFactory also sources the ACP path here.
        source: SourceACP,
        workDir,
        workflows: false,
        browser: false,
        artifactEnabled: isArtifactEnabled(this.#settings),
      },
    );
    const agent = runtime.buildAgent({
      provider: created.provider,
      providerName: this.#provider,
      model: created.model,
      settings: this.#settings,
      allow: loadAllow(),
      mode,
      thinkingLevel: normalizeThinkingLevel("off"),
    });
    // The transient runtime lives for the task; the agent stream owns it.
    void runtime;
    return adaptAgent(agent);
  }
}

/** Adapts a core Agent to the narrow A2AAgent contract (argument order). */
function adaptAgent(agent: {
  id(): AgentID;
  run(userMsg: string, abort?: AbortSignal): AsyncIterable<Event>;
}): A2AAgent {
  return {
    id: () => agent.id(),
    run: (signal: AbortSignal, input: string) => agent.run(input, signal),
  };
}

/** Starts the standalone A2A server with a Runtime-backed executor. */
export async function executeA2AStartWithSettings(
  options: A2AStartOptions,
  settings: Settings,
): Promise<void> {
  const { config } = resolveA2AConfig(options);
  const { DefaultExecutor } = await import("../a2a/executor.ts");
  const factory = new RuntimeAgentFactory(settings, {
    provider: options.provider,
    model: options.model,
    workDir: config.work_dir ?? "",
    sandbox: options.sandbox,
  });
  await run(config, currentVersion(), new DefaultExecutor(factory));
}

/** Writes the a2a.json template (--init-a2a-config [--force]). */
export async function executeA2AInit(
  force: boolean,
  writeError: (line: string) => void = (line) => console.error(line),
): Promise<string> {
  try {
    const path = await initA2AConfig(force);
    writeError(`Created a2a config: ${path}`);
    return path;
  } catch (err) {
    writeError(
      `Failed to create a2a config: ${(err as Error).message}`,
    );
    throw err;
  }
}

export interface A2AStatusView {
  running: boolean;
  listen: string;
  pidFile: string;
  pid: number | null;
  detail: string;
}

/**
 * Best-effort health check against the configured endpoint. No PID file is
 * written by the standalone TS server yet, so this probes `/a2a` readiness
 * with a trivial HTTP request; the executor is not invoked.
 */
export async function executeA2AStatus(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<A2AStatusView> {
  const { config } = resolveA2AConfig(defaultA2AStartOptions());
  const listen = getListenAddr(config);
  const fetcher = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
  try {
    const response = await fetcher(`http://${listen}/.well-known/agent.json`, {
      signal: controller.signal,
    });
    return {
      running: response.ok,
      listen,
      pidFile: "",
      pid: null,
      detail: response.ok ? "agent card reachable" : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      running: false,
      listen,
      pidFile: "",
      pid: null,
      detail: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}
