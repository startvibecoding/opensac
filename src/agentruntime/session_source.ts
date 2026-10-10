// internal/agentruntime/session_runtime.go (`resolveManagerSource` /
// `resolveManagerPolicy`).
//
// They are the one source/mode resolver over a persisted `session.Manager`, so
// `NewAgentManager` and the SessionRuntime use the same precedence rules as the
// rest of `source.ts`. Go's `(SourceResolution, error)` return maps to a
// thrown `SourceConflictError`; `(resolution, mode, error)` maps to a
// `SessionPolicyResolution` value object so a caller can read the resolved
// mode without a second pass.

import type { Manager } from "../session/manager.ts";
import {
  ExecutionPolicy,
  policyForSource,
  resolveSource,
  resolveSourceFromSession,
  SourceConflictError,
  type SourceResolution,
  type SourceResolutionInput,
  validateSourceCandidates,
} from "./source.ts";

/** The resolved source plus the effective mode for one Manager-bound session. */
export interface SessionPolicyResolution {
  resolution: SourceResolution;
  mode: string;
}

/**
 * Resolves a source for a persisted Manager, preferring the session's recorded
 * channel binding/header identity when it exists. Missing managers fall back to
 * the request/current candidates exactly like the adapter-neutral resolver.
 */
export function resolveManagerSource(
  manager: Manager | undefined | null,
  input: SourceResolutionInput,
): SourceResolution {
  validateSourceCandidates(input);
  if (manager !== undefined && manager !== null) {
    input = { ...input, sessionHeader: manager.getHeader() };
    const header = input.sessionHeader;
    if (
      header !== null &&
      header !== undefined &&
      header.id !== "" &&
      manager.getSessionDir() !== ""
    ) {
      return resolveSourceFromSession(
        manager.getSessionDir(),
        header.id,
        input,
      );
    }
  }
  const resolved = resolveSource(input);
  if (resolved.conflicted) {
    throw new SourceConflictError([...resolved.diagnostics]);
  }
  return resolved;
}

/**
 * Resolves one source/mode pair for a persisted Manager. It is the shared
 * entry point for adapters that must not re-derive session policy locally.
 */
export function resolveManagerPolicy(
  manager: Manager | undefined | null,
  input: SourceResolutionInput,
  sessionMode: string,
  requestedMode: string,
  defaultMode: string,
): SessionPolicyResolution {
  const resolution = resolveManagerSource(manager, input);
  const mode = policyForSource(resolution.source, defaultMode).resolveMode(
    sessionMode,
    requestedMode,
  );
  return { resolution, mode };
}

// Re-exported so callers that import this module alone can build a policy.
export { ExecutionPolicy, policyForSource };
