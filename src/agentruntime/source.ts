//
// This is the single source-of-truth resolver: the runtime source vocabulary,
// the per-run execution mode policy, and the source-precedence rules shared by
// TUI, CLI, ACP, cron, and sessions persisted with a channel binding. `Policy`
// is kept as an alias for `ExecutionPolicy`, mirroring Go.
//
// Deviations: `strings.TrimSpace` maps to String.prototype.trim; the Go
// `(resolution, mode, error)` multiple return maps to an `ExecutionPolicyResult`
// value object because TypeScript cannot return a tuple alongside a thrown
// error while preserving the partial resolution on the conflict path.

import {
  type IterationBudgetPolicy,
  normalizeIterationBudgetPolicy,
} from "../agent/iteration_budget.ts";
import { type Binding, findBindingBySessionId } from "../session/bindings.ts";
import { type Header } from "../session/entry.ts";

/** Identifies the runtime that owns a session's execution policy. */
export type RuntimeSource = string;

/** Concise compatibility alias for RuntimeSource. */
export type Source = RuntimeSource;

export const SOURCE_UNKNOWN: RuntimeSource = "";
export const SOURCE_TUI: RuntimeSource = "tui";
export const SOURCE_WE_CHAT: RuntimeSource = "wechat";
export const SOURCE_FEISHU: RuntimeSource = "feishu";
export const SOURCE_ACP: RuntimeSource = "acp";
export const SOURCE_CLI: RuntimeSource = "cli";
export const SOURCE_CRON: RuntimeSource = "cron";

export const MODE_PLAN = "plan";
export const MODE_AGENT = "agent";
export const MODE_YOLO = "yolo";
export const MODE_OS = "os";

/** Describes the mode semantics shared by all adapters for one run. */
export class ExecutionPolicy {
  source: RuntimeSource;
  defaultMode: string;
  /**
   * Governs model-requested iteration renewal for this run's conversational
   * lead. The zero value resolves to the Runtime defaults when a run is built
   * (see `resolveIterationBudget`); renewal is a lead-only capability, so
   * sub-agents and team members keep their capability ceiling.
   */
  iterationBudget: IterationBudgetPolicy;

  constructor(init?: Partial<ExecutionPolicy>) {
    this.source = init?.source ?? SOURCE_UNKNOWN;
    this.defaultMode = init?.defaultMode ?? "";
    this.iterationBudget = init?.iterationBudget ?? {
      soft: 0,
      hard: 0,
      renewFactor: 0,
      maxRenewals: 0,
      minInterval: 0,
      maxWallClock: 0,
    };
  }

  /** Reports whether a source has a non-overridable execution mode. */
  hasForcedMode(): boolean {
    return this.source === SOURCE_WE_CHAT || this.source === SOURCE_FEISHU;
  }

  /** Returns the source-mandated mode, if any. */
  forcedMode(): string {
    return this.hasForcedMode() ? MODE_YOLO : "";
  }

  /**
   * Returns the one effective mode for UI display, agent construction, run
   * records, approvals, and recovery. Bound WeChat and Feishu sessions always
   * execute in yolo mode; a request or persisted capability cannot downgrade
   * them.
   */
  resolveMode(sessionMode: string, requestedMode: string): string {
    const requested = trimSpace(requestedMode);
    // A source-forced mode is the security invariant. Ignore malformed or
    // conflicting adapter hints rather than allowing a fallback to leak an
    // unvalidated mode into an execution path.
    const forced = this.forcedMode();
    if (forced !== "") return forced;
    if (requested !== "" && !isValidMode(requested)) {
      throw new Error(`invalid mode ${JSON.stringify(requested)}`);
    }
    const session = trimSpace(sessionMode);
    if (session !== "" && !isValidMode(session)) {
      throw new Error(`invalid mode ${JSON.stringify(session)}`);
    }
    if (requested !== "") return requested;
    if (session !== "") return session;
    let defaultMode = trimSpace(this.defaultMode);
    if (defaultMode === "") defaultMode = MODE_YOLO;
    if (!isValidMode(defaultMode)) {
      throw new Error(`invalid default mode ${JSON.stringify(defaultMode)}`);
    }
    return defaultMode;
  }
}

/** Concise compatibility alias for ExecutionPolicy. */
export type Policy = ExecutionPolicy;

/**
 * Returns the normalized iteration-budget policy for a run whose soft
 * iteration limit is `soft`. It is the single owner of the budget defaults
 * (hard = 2x soft, two renewals, minimum interval = soft/10, 16h wall clock);
 * adapters only supply the soft limit and may pre-set `iterationBudget` to
 * override the defaults. The result is always enabled.
 */
export function resolveIterationBudget(
  policy: IterationBudgetPolicy,
  soft: number,
): IterationBudgetPolicy {
  return normalizeIterationBudgetPolicy(policy, soft);
}

/** Applies an execution policy consistently at every adapter boundary. */
export class ModeResolver {
  policy: ExecutionPolicy;

  constructor(policy?: ExecutionPolicy) {
    this.policy = policy ?? new ExecutionPolicy();
  }

  /** Returns the effective mode for the resolver's policy. */
  resolve(sessionMode: string, requestedMode: string): string {
    return this.policy.resolveMode(sessionMode, requestedMode);
  }
}

/** Maps persisted channel bindings to a runtime source. */
export function sourceFromChannelType(channelType: string): RuntimeSource {
  switch (trimSpace(channelType).toLowerCase()) {
    case SOURCE_WE_CHAT:
      return SOURCE_WE_CHAT;
    case SOURCE_FEISHU:
      return SOURCE_FEISHU;
    default:
      return SOURCE_UNKNOWN;
  }
}

/** Derives policy ownership from persisted session identity. */
export function sourceFromSessionHeader(
  header: Header | null | undefined,
): RuntimeSource {
  if (header === null || header === undefined) return SOURCE_UNKNOWN;
  return sourceFromChannelType(header.channelType ?? "");
}

/**
 * Reports whether a source keeps a conversational lead's run open for its
 * still-running members (see `composeFollowUps`). Only sources with an
 * attentive human in the loop qualify; on headless or asynchronous sources
 * member notifications are delivered at the next iteration or the next run
 * instead, so a single run never blocks for minutes unattended. A bound expert
 * team always waits regardless of source.
 */
export function sourceWaitsForMembers(source: RuntimeSource): boolean {
  switch (source) {
    case SOURCE_TUI:
    case SOURCE_ACP:
      return true;
    default:
      return false;
  }
}

/** Returns the default mode policy associated with a resolved source. */
export function policyForSource(
  source: RuntimeSource,
  defaultMode: string,
): ExecutionPolicy {
  return new ExecutionPolicy({ source, defaultMode: trimSpace(defaultMode) });
}

/** Reports whether mode is one of the public execution modes. */
export function isValidMode(mode: string): boolean {
  switch (trimSpace(mode)) {
    case MODE_PLAN:
    case MODE_AGENT:
    case MODE_YOLO:
    case MODE_OS:
      return true;
    default:
      return false;
  }
}

/**
 * Derives the execution mode for unattended derived runs such as ESM role
 * sub-agents. Unattended runs must never stop on interactive approval, so only
 * os is inherited from the session mode and every other session mode
 * (plan/agent/yolo/empty/unknown) falls back to yolo. Hard high-risk-command
 * protections remain mode-independent.
 */
export function resolveUnattendedMode(sessionMode: string): string {
  return trimSpace(sessionMode) === MODE_OS ? MODE_OS : MODE_YOLO;
}

/**
 * Contains all source candidates available at a runtime boundary. Persisted
 * binding and session header are authoritative for existing sessions; request
 * source is only eligible for an unbound session.
 */
export interface SourceResolutionInput {
  binding?: Binding | null;
  sessionHeader?: Header | null;
  current?: RuntimeSource;
  requested?: RuntimeSource;
}

/**
 * Describes the effective source and any contradictory persisted identity
 * discovered while resolving it.
 */
export interface SourceResolution {
  source: RuntimeSource;
  conflicted: boolean;
  diagnostics: string[];
}

/**
 * Reports contradictory persisted/runtime policy identity. Adapter entry is
 * supplied as `requested` and therefore does not conflict with an
 * authoritative binding or session header.
 */
export class SourceConflictError extends Error {
  diagnostics: string[];

  constructor(diagnostics: string[] = []) {
    super(
      diagnostics.length === 0
        ? "runtime source conflict"
        : `runtime source conflict: ${diagnostics.join("; ")}`,
    );
    this.name = "SourceConflictError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Applies the source precedence required by the Runtime boundary. A persisted
 * binding wins over a session header, which wins over the current runtime
 * source, which wins over a request source. Conflicting persisted values are
 * reported instead of silently being discarded.
 */
export function resolveSource(input: SourceResolutionInput): SourceResolution {
  let binding = sourceFromChannelType("");
  if (input.binding !== null && input.binding !== undefined) {
    binding = sourceFromChannelType(input.binding.channelType);
  }
  const header = sourceFromSessionHeader(input.sessionHeader);

  const result: SourceResolution = {
    source: SOURCE_UNKNOWN,
    conflicted: false,
    diagnostics: [],
  };
  if (binding !== SOURCE_UNKNOWN) {
    result.source = binding;
  } else if (header !== SOURCE_UNKNOWN) {
    result.source = header;
  } else if (input.current !== undefined && input.current !== SOURCE_UNKNOWN) {
    result.source = input.current;
  } else {
    result.source = input.requested ?? SOURCE_UNKNOWN;
  }

  if (
    binding !== SOURCE_UNKNOWN &&
    header !== SOURCE_UNKNOWN &&
    binding !== header
  ) {
    result.conflicted = true;
    result.diagnostics.push(
      `binding source ${JSON.stringify(
        binding,
      )} conflicts with session header source ${JSON.stringify(header)}`,
    );
  }
  if (
    binding !== SOURCE_UNKNOWN &&
    input.current !== undefined &&
    input.current !== SOURCE_UNKNOWN &&
    binding !== input.current
  ) {
    result.conflicted = true;
    result.diagnostics.push(
      `binding source ${JSON.stringify(
        binding,
      )} conflicts with current runtime source ${JSON.stringify(input.current)}`,
    );
  }
  if (
    header !== SOURCE_UNKNOWN &&
    input.current !== undefined &&
    input.current !== SOURCE_UNKNOWN &&
    header !== input.current
  ) {
    result.conflicted = true;
    result.diagnostics.push(
      `session header source ${JSON.stringify(
        header,
      )} conflicts with current runtime source ${JSON.stringify(input.current)}`,
    );
  }
  return result;
}

/**
 * Loads the persisted binding before applying the source precedence rules. It
 * is intended for existing-session recovery paths.
 */
export function resolveSourceFromSession(
  sessionDir: string,
  sessionId: string,
  input: SourceResolutionInput,
): SourceResolution {
  if (trimSpace(sessionId) === "") {
    throw new Error("session ID is required");
  }
  validateSourceCandidates(input);
  const binding = findBindingBySessionId(sessionDir, sessionId);
  input = { ...input, binding };
  const resolved = resolveSource(input);
  if (resolved.conflicted) {
    throw new SourceConflictError([...resolved.diagnostics]);
  }
  return resolved;
}

function isKnownRequestedSource(source: RuntimeSource): boolean {
  switch (source) {
    case SOURCE_TUI:
    case SOURCE_WE_CHAT:
    case SOURCE_FEISHU:
    case SOURCE_ACP:
    case SOURCE_CLI:
    case SOURCE_CRON:
    case SOURCE_UNKNOWN:
      return true;
    default:
      return false;
  }
}

/** The result of resolving source and mode together. */
export interface ExecutionPolicyResult {
  resolution: SourceResolution;
  mode: string;
  error: Error | null;
}

/**
 * Resolves source and then applies the mode policy to the same identity,
 * preventing display and execution paths from selecting different sources or
 * defaults.
 */
export function resolvePolicy(
  input: SourceResolutionInput,
  sessionMode: string,
  requestedMode: string,
  defaultMode: string,
): ExecutionPolicyResult {
  try {
    validateSourceCandidates(input);
  } catch (err) {
    return {
      resolution: {
        source: SOURCE_UNKNOWN,
        conflicted: false,
        diagnostics: [],
      },
      mode: "",
      error: asError(err),
    };
  }
  const resolved = resolveSource(input);
  if (resolved.conflicted) {
    return {
      resolution: resolved,
      mode: "",
      error: new SourceConflictError([...resolved.diagnostics]),
    };
  }
  // Unknown requested sources are already rejected by `validateSourceCandidates`.
  try {
    const mode = policyForSource(resolved.source, defaultMode).resolveMode(
      sessionMode,
      requestedMode,
    );
    return { resolution: resolved, mode, error: null };
  } catch (err) {
    return { resolution: resolved, mode: "", error: asError(err) };
  }
}

/**
 * Loads authoritative binding state and resolves mode through the same policy
 * used by live Runtime instances.
 */
export function resolvePolicyFromSession(
  sessionDir: string,
  sessionId: string,
  input: SourceResolutionInput,
  sessionMode: string,
  requestedMode: string,
  defaultMode: string,
): ExecutionPolicyResult {
  let resolved: SourceResolution;
  try {
    resolved = resolveSourceFromSession(sessionDir, sessionId, input);
  } catch (err) {
    const error = asError(err);
    if (error instanceof SourceConflictError) {
      return {
        resolution: {
          source: SOURCE_UNKNOWN,
          conflicted: true,
          diagnostics: error.diagnostics,
        },
        mode: "",
        error,
      };
    }
    return {
      resolution: {
        source: SOURCE_UNKNOWN,
        conflicted: false,
        diagnostics: [],
      },
      mode: "",
      error,
    };
  }
  // Unknown requested sources are already rejected by `resolveSourceFromSession`.
  try {
    const mode = policyForSource(resolved.source, defaultMode).resolveMode(
      sessionMode,
      requestedMode,
    );
    return { resolution: resolved, mode, error: null };
  } catch (err) {
    return { resolution: resolved, mode: "", error: asError(err) };
  }
}

export function validateSourceCandidates(input: SourceResolutionInput): void {
  const candidates: Array<[string, RuntimeSource | undefined]> = [
    ["current runtime", input.current],
    ["requested", input.requested],
  ];
  for (const [name, source] of candidates) {
    if (
      source !== undefined &&
      source !== SOURCE_UNKNOWN &&
      !isKnownRequestedSource(source)
    ) {
      throw new Error(`unknown ${name} source ${JSON.stringify(source)}`);
    }
  }
}

function trimSpace(value: string): string {
  return value.trim();
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
