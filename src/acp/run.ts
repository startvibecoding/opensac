import { runtime } from "../platform/runtime.ts";
import { join } from "../compat/path.ts";
import { CoreClient } from "../core/client.ts";
import { resolveCoreConfig } from "../core/config.ts";
import {
  type PrivateCoreHandle,
  type PrivateCoreOptions,
  startPrivateCore,
} from "../core/private_core.ts";
import { CORE_PROTOCOL_VERSION } from "../core/server.ts";
import { configDir, loadSettings } from "../config/mod.ts";
import { current as appVersionCurrent } from "../version/version.ts";
import { ACPBridge } from "./bridge.ts";
import { ACPBridgeClient, type BridgeCoreClient } from "./bridge_client.ts";
import {
  ACPLineReader,
  EmptyMessageError,
  readRequest,
  validRPCID,
} from "./wire.ts";
import { type AcpServerSink } from "./server.ts";
import { type ACPRPCRequest } from "./wire.ts";

/** Process-level ACP options, retained at the Core bridge boundary. */
export interface RunOptions {
  version?: string;
  provider?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  sandbox?: boolean;
  verbose?: boolean;
  debug?: boolean;
  multiAgent?: boolean;
  delegate?: boolean;
  workflows?: boolean;
  webSearch?: boolean;
  browser?: boolean;
  artifact?: boolean;
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
  /**
   * Run against an isolated private Core instead of the shared Core. The
   * private Core owns its own state directory and is shut down when the
   * bridge exits; the shared Core is never touched.
   */
  standalone?: boolean;
}

/** ACP transport resources that may be replaced by tests. */
export interface RunTransport {
  reader: ACPLineReader;
  sink: AcpServerSink;
}

class StdoutSink implements AcpServerSink {
  write(data: string): void {
    runtime.stdout.writeSync(new TextEncoder().encode(data));
  }
}

/** Default newline-delimited ACP transport. */
export function stdioTransport(): RunTransport {
  return {
    reader: new ACPLineReader(runtime.stdin.readable),
    sink: new StdoutSink(),
  };
}

export interface ACPCoreRunDependencies {
  createClient(): BridgeCoreClient | Promise<BridgeCoreClient>;
  /**
   * Optional exit hook owning resources beyond the bridge connection. It runs
   * before `bridge.close()` so an owned private Core can be shut down while
   * its client is still usable.
   */
  dispose?: () => void | Promise<void>;
}

async function createDefaultACPCoreClient(): Promise<BridgeCoreClient> {
  const settings = loadSettings();
  const core = new CoreClient({
    stateDir: configDir(),
    version: appVersionCurrent(),
    protocolVersion: CORE_PROTOCOL_VERSION,
    config: resolveCoreConfig(settings),
  });
  const discovery = await core.ensureStarted();
  if (discovery.status !== "ready") {
    await core.close();
    const hint =
      discovery.status === "incompatible"
        ? '; run "opensac core stop" to replace it'
        : "";
    throw new Error(`Core is not ready: ${discovery.status}${hint}`);
  }
  return new ACPBridgeClient({ core });
}

/**
 * Dependencies for `opensac acp --standalone`: one isolated private Core per
 * bridge process, created on demand and closed with the bridge. The private
 * Core never registers into the shared discovery, so it cannot be confused
 * with (or replace) the user's shared Core. Test callers may override the
 * private Core lifecycle inputs.
 */
export function standaloneACPCoreDependencies(
  overrides: Partial<PrivateCoreOptions> = {},
): ACPCoreRunDependencies {
  let privateCore: PrivateCoreHandle | undefined;
  return {
    createClient: async () => {
      privateCore = await startPrivateCore({
        version: appVersionCurrent(),
        protocolVersion: CORE_PROTOCOL_VERSION,
        parentDir: join(configDir(), "standalone"),
        ...overrides,
      });
      return new ACPBridgeClient({ core: privateCore.client });
    },
    dispose: async () => {
      const handle = privateCore;
      privateCore = undefined;
      if (handle === undefined) return;
      const outcome = await handle.close();
      if (!outcome.exited) {
        // stderr only: stdout is the ACP NDJSON wire.
        runtime.stderr.writeSync(
          new TextEncoder().encode(
            "opensac acp: private Core did not exit in time; its state directory was kept\n",
          ),
        );
      }
    },
  };
}

export function defaultACPCoreDependencies(
  opts: RunOptions,
): ACPCoreRunDependencies {
  return opts.standalone === true
    ? standaloneACPCoreDependencies()
    : { createClient: createDefaultACPCoreClient };
}

function withACPCoreDefaults(
  request: ACPRPCRequest,
  opts: RunOptions,
): ACPRPCRequest {
  if (request.method !== "session/new") return request;
  const params =
    request.params !== null && typeof request.params === "object"
      ? (request.params as Record<string, unknown>)
      : {};
  const defaults: Record<string, unknown> = {};
  if (opts.provider !== undefined && params.provider === undefined) {
    defaults.provider = opts.provider;
  }
  if (opts.model !== undefined && params.model === undefined) {
    defaults.model = opts.model;
  }
  if (opts.mode !== undefined && params.mode === undefined) {
    defaults.mode = opts.mode;
  }
  if (opts.thinking !== undefined && params.thinking === undefined) {
    defaults.thinking = opts.thinking;
  }
  return Object.keys(defaults).length === 0
    ? request
    : { ...request, params: { ...params, ...defaults } };
}

/** Runs the ACP stdio bridge against a discovered Core. */
export async function runACPCore(
  opts: RunOptions = {},
  transport: RunTransport = stdioTransport(),
  dependencies?: ACPCoreRunDependencies,
): Promise<void> {
  const deps = dependencies ?? defaultACPCoreDependencies(opts);
  const client = await deps.createClient();
  const bridge = new ACPBridge({
    client,
    context: { source: "acp", workDir: runtime.cwd() },
    write: (line) => transport.sink.write(line),
  });
  try {
    await dispatchCoreLoop(bridge, transport, opts);
  } finally {
    try {
      await deps.dispose?.();
    } finally {
      await bridge.close();
    }
  }
}

async function dispatchCoreLoop(
  bridge: ACPBridge,
  transport: RunTransport,
  opts: RunOptions,
): Promise<void> {
  while (true) {
    let request: ACPRPCRequest | null;
    try {
      request = await readRequest(transport.reader);
    } catch (error) {
      if (error instanceof EmptyMessageError) continue;
      transport.sink.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        })}\n`,
      );
      continue;
    }
    if (request === null) return;
    if (request.jsonrpc !== "2.0" || !validRPCID(request.idRaw)) {
      if ((request.idRaw ?? "") !== "" || request.jsonrpc !== "2.0") {
        transport.sink.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.idRaw === null ? null : request.idRaw,
            error: { code: -32600, message: "invalid request" },
          })}\n`,
        );
      }
      continue;
    }
    await bridge.handle(withACPCoreDefaults(request, opts));
  }
}
