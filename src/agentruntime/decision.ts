// Ported from internal/agentruntime/decision.go.
//
// `DecisionService` owns pending decision identity and first-response-wins
// semantics for Approval/Question. Protocol-specific payloads and rendering
// remain in adapters. Go's `sync.Mutex` is dropped (Deno is single-threaded);
// the `(DecisionRequest, error)` multiple return maps to a returned request
// that throws on failure.

import type { DecisionRecord } from "./decision_record.ts";
import { replayDecisions } from "./decision_replay.ts";

/** Identifies an interactive decision that can pause a run. */
export type DecisionKind = string;

export const DecisionApproval: DecisionKind = "approval";
export const DecisionQuestion: DecisionKind = "question";

/** The adapter-neutral identity of a pending decision. */
export interface DecisionRequest {
  id: string;
  runId: string;
  sessionId?: string;
  kind: DecisionKind;
  /** Adapter-owned resume callback bound after registration. */
  resolve?: (value: string) => void;
}

/** The adapter-neutral result of resolving a decision. */
export interface DecisionResolution {
  id: string;
  kind?: DecisionKind;
  status: string;
  value?: string;
}

/**
 * Owns pending decision identity and first-response-wins semantics.
 */
export class DecisionService {
  #pending = new Map<string, DecisionRequest>();
  #resolvers = new Map<string, (value: string) => void>();
  #resolving = new Set<string>();
  #resolved = new Map<string, DecisionResolution>();
  #resolvedRequests = new Map<string, DecisionRequest>();

  /**
   * Restores the latest pending durable decisions without binding protocol
   * callbacks. Rehydration is idempotent for an already identical pending
   * decision.
   */
  rehydrate(records: DecisionRecord[]): DecisionRequest[] {
    const pending = replayDecisions(records);
    const ids = [...pending.keys()].sort();

    const result: DecisionRequest[] = [];
    for (const id of ids) {
      const record = pending.get(id)!;
      const request: DecisionRequest = {
        id: record.id,
        runId: record.runId,
        sessionId: record.sessionId,
        kind: record.kind,
      };
      const existing = this.#pending.get(id);
      if (existing !== undefined) {
        if (
          existing.runId !== request.runId ||
          existing.sessionId !== request.sessionId ||
          existing.kind !== request.kind
        ) {
          throw new Error(
            `rehydrated decision conflicts with pending decision: ${id}`,
          );
        }
        result.push(existing);
        continue;
      }
      this.#pending.set(id, request);
      result.push(request);
    }
    return result;
  }

  register(request: DecisionRequest): void {
    if (request.id === "" || request.runId === "") {
      throw new Error("decision ID and run ID are required");
    }
    if (
      request.kind !== DecisionApproval && request.kind !== DecisionQuestion
    ) {
      throw new Error(`unsupported decision kind: ${request.kind}`);
    }
    if (this.#pending.has(request.id)) {
      throw new Error(`decision already pending: ${request.id}`);
    }
    const prior = this.#resolved.get(request.id);
    if (prior !== undefined) {
      throw new Error(
        `decision was already resolved: ${request.id} (${prior.status})`,
      );
    }
    this.#pending.set(request.id, request);
  }

  /**
   * Associates an adapter-owned resume callback with a registered decision.
   * The callback must succeed before `resolve` consumes the pending decision.
   */
  bind(id: string, resolve: (value: string) => void): void {
    if (id === "" || resolve === undefined || resolve === null) {
      throw new Error("decision ID and resolve callback are required");
    }
    if (!this.#pending.has(id)) {
      throw new Error(`decision is not pending: ${id}`);
    }
    this.#resolvers.set(id, resolve);
  }

  resolve(resolution: DecisionResolution): DecisionRequest {
    return this.#resolveWith(resolution, undefined);
  }

  /**
   * Performs the adapter persistence commit before consuming the pending
   * request. A callback or commit failure leaves the request retryable.
   */
  resolveWith(
    resolution: DecisionResolution,
    commit?: (request: DecisionRequest) => void,
  ): DecisionRequest {
    return this.#resolveWith(resolution, commit);
  }

  #resolveWith(
    resolution: DecisionResolution,
    commit?: (request: DecisionRequest) => void,
  ): DecisionRequest {
    if (resolution.status === "") {
      resolution = { ...resolution, status: "resolved" };
    }
    const request = this.#pending.get(resolution.id);
    if (request === undefined) {
      const prior = this.#resolved.get(resolution.id);
      if (prior !== undefined) {
        if (
          (resolution.kind === undefined || resolution.kind === "" ||
            resolution.kind === prior.kind) &&
          resolution.status === prior.status &&
          (resolution.value ?? "") === (prior.value ?? "")
        ) {
          const priorRequest = this.#resolvedRequests.get(resolution.id);
          if (priorRequest !== undefined) return priorRequest;
          return { id: resolution.id, runId: "", kind: prior.kind ?? "" };
        }
        throw new Error(`decision was already resolved: ${resolution.id}`);
      }
      throw new Error(`decision is no longer pending: ${resolution.id}`);
    }
    if (
      resolution.kind !== undefined && resolution.kind !== "" &&
      resolution.kind !== request.kind
    ) {
      throw new Error(`decision kind mismatch: ${resolution.id}`);
    }
    if (this.#resolving.has(resolution.id)) {
      throw new Error(
        `decision resolution is already in progress: ${resolution.id}`,
      );
    }
    const resolver = this.#resolvers.get(resolution.id);
    this.#resolving.add(resolution.id);
    const value = resolution.value ?? "";
    if (resolver !== undefined) {
      try {
        resolver(value);
      } catch (err) {
        this.#resolving.delete(resolution.id);
        throw err;
      }
    }
    if (commit !== undefined) {
      try {
        commit(request);
      } catch (err) {
        this.#resolving.delete(resolution.id);
        throw err;
      }
    }
    this.#resolving.delete(resolution.id);
    this.#pending.delete(resolution.id);
    this.#resolvers.delete(resolution.id);
    this.#resolved.set(resolution.id, resolution);
    this.#resolvedRequests.set(resolution.id, request);
    return request;
  }

  /**
   * Removes all decisions for a Run and invokes their resolver callbacks with
   * the supplied value. Used for cancellation and timeout paths where no
   * protocol resolution is available.
   */
  clearRunWithValue(runId: string, value: string): DecisionRequest[] {
    if (runId === "") return [];
    const requests: DecisionRequest[] = [];
    const callbacks = new Map<string, (value: string) => void>();
    for (const [id, request] of this.#pending) {
      if (request.runId !== runId) continue;
      requests.push(request);
      const resolver = this.#resolvers.get(id);
      if (resolver !== undefined) callbacks.set(id, resolver);
      this.#resolving.add(id);
    }
    const cleared: DecisionRequest[] = [];
    for (const request of requests) {
      let callbackErr: Error | null = null;
      const callback = callbacks.get(request.id);
      if (callback !== undefined) {
        try {
          callback(value);
        } catch (err) {
          callbackErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      this.#resolving.delete(request.id);
      if (callbackErr === null) {
        this.#pending.delete(request.id);
        this.#resolvers.delete(request.id);
        this.#resolved.set(request.id, {
          id: request.id,
          kind: request.kind,
          status: "cancelled",
          value,
        });
        this.#resolvedRequests.set(request.id, request);
        cleared.push(request);
      }
    }
    return cleared;
  }

  clearRun(runId: string): DecisionRequest[] {
    if (runId === "") return [];
    const cleared: DecisionRequest[] = [];
    for (const [id, request] of this.#pending) {
      if (request.runId !== runId) continue;
      cleared.push(request);
      this.#pending.delete(id);
      this.#resolvers.delete(id);
      this.#resolving.delete(id);
      this.#resolved.set(id, {
        id,
        kind: request.kind,
        status: "cancelled",
      });
      this.#resolvedRequests.set(id, request);
    }
    return cleared;
  }

  pending(): DecisionRequest[] {
    return [...this.#pending.values()];
  }
}
