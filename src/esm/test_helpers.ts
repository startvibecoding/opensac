// Shared test fixtures for the src/esm suite. Not production code.

import { runtime } from "../platform/runtime.ts";
import { closeAll } from "../db/mod.ts";
import { type Objective, phaseWorker, statusActive } from "./state.ts";
import { Store } from "./store.ts";
import { type RoleResult } from "./supervisor.ts";
import {
  type Role,
  type RoleRequest,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventSink,
} from "./runtime_core.ts";

/** Builds an Objective with sensible defaults for tests. */
export function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    sessionId: "sess",
    esmId: "esm",
    objective: "",
    status: statusActive,
    tokensUsed: 0,
    timeUsedMs: 0,
    blockedCount: 0,
    blockedReason: "",
    blockedRunId: "",
    completionReason: "",
    completionRunId: "",
    completionReview: "",
    phase: phaseWorker,
    progressSummary: "",
    remainingWork: [],
    rejectionCount: 0,
    rejectionRunId: "",
    recoveryCount: 0,
    recoveryReason: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** Creates a fresh Store backed by a unique temp session dir. */
export function makeStore(prefix = "opensac-esm-"): {
  store: Store;
  sessionID: string;
  sessionDir: string;
} {
  const sessionDir = runtime.makeTempDirSync({ prefix });
  return { store: new Store(sessionDir), sessionID: "esm-session", sessionDir };
}

/** Closes every managed session database connection. */
export function cleanup(): void {
  closeAll();
}

/** A minimal RuntimeAdapter fixture mirroring the Go runtimeTestAdapter. */
export class RuntimeTestAdapter implements RuntimeAdapter {
  responses: Map<Role, string>;
  roles: Role[] = [];
  prompts = new Map<Role, string>();
  requests = new Map<Role, RoleRequest>();
  observers = 0;
  roleErr: unknown = null;

  constructor(responses: Map<Role, string> | Record<string, string> = {}) {
    this.responses =
      responses instanceof Map ? responses : new Map(Object.entries(responses));
  }

  runRole(
    _signal: AbortSignal | undefined,
    req: RoleRequest,
  ): Promise<RoleResult> {
    this.roles.push(req.role);
    this.requests.set(req.role, req);
    this.prompts.set(req.role, req.prompt);
    if (this.roleErr !== null) return Promise.reject(this.roleErr);
    return Promise.resolve(
      roleResult(this.responses.get(req.role) ?? "", { toolCalls: 1 }),
    );
  }

  runRecoveryObserver(
    _signal: AbortSignal | undefined,
    _req: RoleRequest,
    _interruption: unknown,
  ): Promise<RoleResult> {
    this.observers++;
    return Promise.reject(new Error("context canceled"));
  }
}

/** Collects published ESM lifecycle events. */
export class RuntimeTestEvents implements RuntimeEventSink {
  events: RuntimeEvent[] = [];
  publishESMEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }
}

/** A RoleResult with one successful tool call. */
export function roleResult(
  response: string,
  overrides: Partial<RoleResult> = {},
): RoleResult {
  return {
    response,
    tokens: 0,
    durationMs: 0,
    toolCalls: 1,
    toolNames: new Map(),
    toolError: new Map(),
    ...overrides,
  };
}
