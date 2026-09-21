// Ported from internal/serve/config_state.go: separates the merged runtime
// configuration from the writable file layer edited by the WebUI. CLI
// overrides (`RunOptions`) stay effective in memory but are stripped from
// persisted full-config writes, and a failed runtime application rolls the
// file back to its previous bytes. All persistence goes through a 0600
// temp-file + rename so concurrent readers never observe a partial document.

import {
  configPath,
  decodeConfigBytesInto,
  defaultServeConfig,
  loadConfigFrom,
  normalizeServeConfig,
  projectConfigPath,
  saveServeConfig,
  serializeConfig,
  type ServeConfig,
} from "./config.ts";
import {
  applyOverrides,
  applyRuntimeFeatures,
  defaultRunOptions,
  type RunOptions,
} from "./options.ts";
import * as stdPath from "@std/path";

export type ConfigLayer = "global" | "project" | "explicit";

export interface ChannelConfigPatchResponse {
  layer: ConfigLayer;
  path: string;
  platform: string;
  configured: unknown;
  effective: unknown;
  restart: unknown;
}

export type WriteAtomicFn = (path: string, data: Uint8Array) => void;

export interface ServeConfigStateOptions {
  overrides?: RunOptions;
  /** Injectable atomic writer (transaction tests); production uses fsync rename. */
  writeAtomic?: WriteAtomicFn;
}

/**
 * Owns effective config plus the writable layer identity. Construction loads
 * and normalizes the document; throws on unreadable/invalid config.
 */
export class ServeConfigState {
  effective: ServeConfig;
  readonly writablePath: string;
  readonly writableLayer: ConfigLayer;
  private overrides: RunOptions;
  private readonly explicitPath: string;
  private readonly writeAtomicImpl?: WriteAtomicFn;

  private constructor(
    effective: ServeConfig,
    writablePath: string,
    writableLayer: ConfigLayer,
    overrides: RunOptions,
    explicitPath: string,
    writeAtomicImpl?: WriteAtomicFn,
  ) {
    this.effective = effective;
    this.writablePath = writablePath;
    this.writableLayer = writableLayer;
    this.overrides = overrides;
    this.explicitPath = explicitPath;
    this.writeAtomicImpl = writeAtomicImpl;
  }

  /** Loads the explicit/global+project document and applies CLI overrides. */
  static load(
    opts: RunOptions,
    options: ServeConfigStateOptions = {},
  ): ServeConfigState {
    const overrides = options.overrides ?? opts;
    let writablePath: string;
    let layer: ConfigLayer;
    if (overrides.configPath !== "") {
      writablePath = overrides.configPath;
      layer = "explicit";
    } else {
      const project = projectConfigPath();
      try {
        Deno.statSync(project);
        writablePath = project;
        layer = "project";
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          throw new Error(
            `inspect project serve config: ${(err as Error).message}`,
          );
        }
        writablePath = configPath();
        layer = "global";
      }
    }
    const state = new ServeConfigState(
      defaultServeConfig(),
      writablePath,
      layer,
      overrides,
      overrides.configPath,
      options.writeAtomic,
    );
    state.reload();
    return state;
  }

  /**
   * lazy ports Go's `&ServeConfigState{Effective: cfg, WritablePath: path,
   * WritableLayer: layer}` literal: the in-memory fallback used while the
   * process never loaded a config state (channelRuntime.configStateSnapshot).
   * No document is read; updates serialize the effective config as-is.
   */
  static lazy(
    effective: ServeConfig,
    writablePath: string,
    writableLayer: ConfigLayer,
  ): ServeConfigState {
    const overrides = defaultRunOptions();
    return new ServeConfigState(
      effective,
      writablePath,
      writableLayer,
      overrides,
      overrides.configPath,
    );
  }

  /** Reloads the writable layer and reapplies overrides/feature projection. */
  reload(): void {
    this.effective = this.explicitPath !== ""
      ? loadConfigFrom(this.explicitPath)
      : loadEffectiveConfig();
    applyOverrides(this.effective, this.overrides);
    applyRuntimeFeatures(this.effective);
  }

  /** Returns an isolated deep copy of the effective config. */
  snapshot(): ServeConfig {
    return cloneServeConfig(this.effective);
  }

  /**
   * Applies a whitelisted channel merge-patch, persists the writable document,
   * and invokes `apply` (which performs no file I/O of its own). The apply may
   * be asynchronous — Go's apply callback blocks on the platform startup
   * handshake, so the Deno projection awaits it inside the same file
   * transaction; a rejection restores the previous file.
   */
  async updateChannel(
    platform: string,
    body: Uint8Array | string,
    apply?: (cfg: ServeConfig) => void | Promise<void>,
  ): Promise<ChannelConfigPatchResponse> {
    const patch = parseChannelConfigPatch(platform, body);

    let oldData: Uint8Array | undefined;
    try {
      oldData = Deno.readFileSync(this.writablePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw new Error(
          `read writable serve config ${this.writablePath}: ${
            (err as Error).message
          }`,
        );
      }
    }

    const root: Record<string, unknown> = {};
    if (oldData !== undefined && oldData.length > 0) {
      const text = new TextDecoder().decode(oldData).trim();
      if (text !== "") {
        const parsed = JSON.parse(text);
        if (
          parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        ) {
          throw new Error(
            `parse writable serve config ${this.writablePath}: expected object`,
          );
        }
        Object.assign(root, parsed as Record<string, unknown>);
      }
    }
    const channelsObject = objectField(root, "channels");
    const platformObject = objectField(channelsObject, platform);
    for (const [key, value] of Object.entries(patch)) {
      platformObject[key] = value;
    }
    const featuresObject = objectField(root, "features");
    if (typeof platformObject["enabled"] === "boolean") {
      featuresObject[platform] = platformObject["enabled"];
    }
    const data = JSON.stringify(root, null, 2) + "\n";

    const candidate = cloneServeConfig(this.effective);
    applyEffectiveChannelPatch(candidate, platform, patch);
    applyOverrides(candidate, this.overrides);
    applyRuntimeFeatures(candidate);

    this.writeConfigFile(new TextEncoder().encode(data));
    if (apply !== undefined) {
      try {
        await apply(candidate);
      } catch (err) {
        this.restoreConfigFile(oldData);
        throw new Error(`apply channel config: ${(err as Error).message}`);
      }
    }
    this.effective = candidate;
    return {
      layer: this.writableLayer,
      path: this.writablePath,
      platform,
      configured: platformObject,
      effective: effectiveChannelConfig(candidate, platform),
      restart: { platform },
    };
  }

  /**
   * Persists a complete serve configuration through the same
   * serialize/apply/rollback boundary as channel updates.
   */
  async updateFull(
    body: Uint8Array | string,
    apply?: (cfg: ServeConfig) => void | Promise<void>,
  ): Promise<ServeConfig> {
    const candidate = decodeConfigBytes(body);

    let oldData: Uint8Array | undefined;
    try {
      oldData = Deno.readFileSync(this.writablePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw new Error(
          `read writable serve config ${this.writablePath}: ${
            (err as Error).message
          }`,
        );
      }
    }

    applyOverrides(candidate, this.overrides);
    applyRuntimeFeatures(candidate);
    const persisted = cloneServeConfig(candidate);
    // Full PUT commonly carries the effective document; restore CLI-only
    // fields from the on-disk base so runtime overrides stay ephemeral.
    try {
      stripRunOverrides(
        persisted,
        loadConfigFrom(this.writablePath),
        this.overrides,
      );
    } catch {
      // no base document: keep normalized defaults
    }
    this.writeConfigFile(
      new TextEncoder().encode(
        JSON.stringify(serializeConfig(persisted), null, 2) +
          "\n",
      ),
    );
    if (apply !== undefined) {
      try {
        await apply(candidate);
      } catch (err) {
        this.restoreConfigFile(oldData);
        throw new Error(`apply serve config: ${(err as Error).message}`);
      }
    }
    this.effective = candidate;
    return cloneServeConfig(candidate);
  }

  private writeConfigFile(data: Uint8Array): void {
    if (this.writeAtomicImpl !== undefined) {
      this.writeAtomicImpl(this.writablePath, data);
      return;
    }
    atomicWritePrivateFile(this.writablePath, data);
  }

  private restoreConfigFile(oldData: Uint8Array | undefined): void {
    if (oldData !== undefined) {
      this.writeConfigFile(oldData);
      return;
    }
    try {
      Deno.removeSync(this.writablePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}

/** Loads global serve.json with the project layer overlaid (Go LoadConfig). */
export function loadEffectiveConfig(): ServeConfig {
  const cfg = loadConfigFrom(configPath());
  try {
    const data = Deno.readTextFileSync(projectConfigPath());
    decodeConfigBytesInto(cfg, data);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new Error(
        `read project serve config ${projectConfigPath()}: ${
          (err as Error).message
        }`,
      );
    }
  }
  normalizeServeConfig(cfg);
  return cfg;
}

/** Loads a RunOptions-configured state without firing channels. */
export function loadServeConfigState(opts: RunOptions): ServeConfigState {
  return ServeConfigState.load(opts);
}

export function cloneServeConfig(cfg: ServeConfig): ServeConfig {
  // Round-trip through the canonical wire shape, then decode, matching the
  // Go JSON alias snapshot (normalization side effects are contained).
  const copy = defaultServeConfig();
  decodeConfigBytesInto(
    copy,
    JSON.stringify(serializeConfig(cfg)),
  );
  copy.lobsterMode = cfg.lobsterMode;
  normalizeServeConfig(copy);
  return copy;
}

export function decodeConfigBytes(body: Uint8Array | string): ServeConfig {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const cfg = defaultServeConfig();
  decodeConfigBytesInto(cfg, text);
  normalizeServeConfig(cfg);
  return cfg;
}

const CHANNEL_PATCH_FIELDS: Record<string, Record<string, string>> = {
  wechat: {
    enabled: "boolean",
    credPath: "string",
    workDir: "string",
    autoTyping: "boolean",
  },
  feishu: {
    enabled: "boolean",
    appId: "string",
    appSecret: "string",
    workDir: "string",
  },
};

/** Validates and decodes a single-channel whitelisted merge patch. */
export function parseChannelConfigPatch(
  platform: string,
  body: Uint8Array | string,
): Record<string, unknown> {
  const fields = CHANNEL_PATCH_FIELDS[platform];
  if (fields === undefined) {
    throw new Error(`unsupported channel ${JSON.stringify(platform)}`);
  }
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let patch: unknown;
  try {
    patch = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `decode ${platform} channel config: ${(err as Error).message}`,
    );
  }
  if (
    patch === null || typeof patch !== "object" || Array.isArray(patch)
  ) {
    throw new Error("channel config must be an object");
  }
  const record = patch as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const expected = fields[key];
    if (expected === undefined) {
      throw new Error(
        `unsupported ${platform} channel field ${JSON.stringify(key)}`,
      );
    }
    const actual = typeof record[key];
    if (actual !== expected) {
      throw new Error(`${key} must be a ${expected}`);
    }
  }
  return record;
}

/** Applies a validated channel patch to an effective config. */
export function applyEffectiveChannelPatch(
  cfg: ServeConfig,
  platform: string,
  patch: Record<string, unknown>,
): void {
  const stringValue = (key: string): string | undefined =>
    typeof patch[key] === "string" ? patch[key] as string : undefined;
  if (platform === "wechat") {
    if (typeof patch["enabled"] === "boolean") {
      cfg.channels.wechat.enabled = patch["enabled"] as boolean;
      cfg.features.wechat = patch["enabled"] as boolean;
    }
    const credPath = stringValue("credPath");
    if (credPath !== undefined) cfg.channels.wechat.credPath = credPath;
    const workDir = stringValue("workDir");
    if (workDir !== undefined) cfg.channels.wechat.workDir = workDir;
    if (typeof patch["autoTyping"] === "boolean") {
      cfg.channels.wechat.autoTyping = patch["autoTyping"] as boolean;
    }
  } else if (platform === "feishu") {
    if (typeof patch["enabled"] === "boolean") {
      cfg.channels.feishu.enabled = patch["enabled"] as boolean;
      cfg.features.feishu = patch["enabled"] as boolean;
    }
    const appId = stringValue("appId");
    if (appId !== undefined) cfg.channels.feishu.appId = appId;
    const appSecret = stringValue("appSecret");
    if (appSecret !== undefined) cfg.channels.feishu.appSecret = appSecret;
    const workDir = stringValue("workDir");
    if (workDir !== undefined) cfg.channels.feishu.workDir = workDir;
  } else {
    throw new Error(`unsupported channel ${JSON.stringify(platform)}`);
  }
}

/** Projects one channel's effective configuration for API responses. */
export function effectiveChannelConfig(
  cfg: ServeConfig,
  platform: string,
): unknown {
  if (platform === "wechat") {
    return {
      enabled: cfg.channels.wechat.enabled,
      credPath: cfg.channels.wechat.credPath,
      workDir: cfg.channels.wechat.workDir,
      autoTyping: cfg.channels.wechat.autoTyping,
    };
  }
  if (platform === "feishu") {
    // Credentials never leave the process.
    return {
      enabled: cfg.channels.feishu.enabled,
      appId: cfg.channels.feishu.appId,
      appSecretConfigured: cfg.channels.feishu.appSecret !== "",
      workDir: cfg.channels.feishu.workDir,
    };
  }
  throw new Error(`unsupported channel ${JSON.stringify(platform)}`);
}

function stripRunOverrides(
  cfg: ServeConfig,
  base: ServeConfig,
  opts: RunOptions,
): void {
  if (opts.port !== "" || opts.unsafe) cfg.api.listen = base.api.listen;
  if (opts.unsafe) cfg.api.auth = { ...base.api.auth };
  if (opts.webUIDir !== "") {
    cfg.webUI.dir = base.webUI.dir;
    cfg.webUI.enabled = base.webUI.enabled;
    cfg.features.webUI = base.features.webUI;
  }
  if (opts.workDir !== "") {
    cfg.api.defaultWorkDir = base.api.defaultWorkDir;
    cfg.api.workingDir = base.api.workingDir;
  }
  if (opts.provider !== "") cfg.api.provider = base.api.provider;
  if (opts.model !== "") cfg.api.model = base.api.model;
  if (opts.sandbox) cfg.api.sandbox = { ...base.api.sandbox };
  if (opts.multiAgent) {
    cfg.api.enableSubAgents = base.api.enableSubAgents;
    cfg.features.multiAgent = base.features.multiAgent;
  }
  if (opts.delegate) cfg.api.enableDelegate = base.api.enableDelegate;
  if (opts.workflows) cfg.api.enableWorkflows = base.api.enableWorkflows;
  if (opts.webSearch) cfg.api.enableWebSearch = base.api.enableWebSearch;
  if (opts.browser) cfg.api.enableBrowser = base.api.enableBrowser;
  if (opts.artifact) cfg.api.enableArtifact = base.api.enableArtifact;
  if (opts.a2aMaster) cfg.api.enableA2AMaster = base.api.enableA2AMaster;
  if (opts.lobster) {
    cfg.lobsterMode = base.lobsterMode;
    cfg.api.defaultMode = base.api.defaultMode;
    cfg.api.sandbox = { ...base.api.sandbox };
    cfg.api.enableSubAgents = base.api.enableSubAgents;
    cfg.features.multiAgent = base.features.multiAgent;
  }
}

function objectField(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = parent[key];
  if (
    current !== null && typeof current === "object" && !Array.isArray(current)
  ) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

/** Writes 0600 via temp file + rename (atomicWritePrivateFile). */
export function atomicWritePrivateFile(
  filePath: string,
  data: Uint8Array,
): void {
  const dir = stdPath.dirname(filePath);
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = Deno.makeTempFileSync({ dir, prefix: ".serve-" });
  let succeeded = false;
  try {
    Deno.chmodSync(tmp, 0o600);
    Deno.writeFileSync(tmp, data, { mode: 0o600 });
    Deno.renameSync(tmp, filePath);
    succeeded = true;
  } finally {
    if (!succeeded) {
      try {
        Deno.removeSync(tmp);
      } catch {
        // best effort
      }
    }
  }
}

/** Convenience used by earlier slices / callers that persist a typed config. */
export function writeServeConfig(filePath: string, cfg: ServeConfig): void {
  saveServeConfig(filePath, cfg);
}
