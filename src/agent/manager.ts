//
// AgentManager owns the lifecycle of every agent instance: registration,
// creation (with parent validation and sub-agent policy enforcement), status
// tracking, child bookkeeping, cancellation, and destruction. Go's
// `sync.RWMutex` is dropped (Deno is single-threaded), `context.CancelFunc`
// maps to a `() => void`, and `time.Time` maps to `Date`.
//
// The manager is a plain class whose public fields (`members`, `mailbox`,
// `expertID`) are installed once by the runtime assembly layer before any run
// starts, mirroring the Go exported fields the sub-agent tools read directly.

import type { AgentID } from "../../sdk/agent/types.ts";
import type { AllowConfig } from "../config/allow.ts";
import type { Model } from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import type { Settings } from "../config/settings.ts";
import type { AgentLoopConfig } from "./agent.ts";
import { AgentAdapter } from "./bridge.ts";
import type { AgentFactory, AgentOptions } from "./factory.ts";
import type { MemberDefRegistry } from "./memberdef.ts";
import type { MemberCompletion, MemberMailbox } from "./mailbox.ts";
import {
  appendUniqueAgentID,
  defaultSubAgentPolicy,
  isTerminalManagedState,
  removeAgentID,
  validateSubAgentPolicy,
} from "./subagent_support.ts";
import {
  createMemberCompletion,
  MEMBER_ITEM_QUESTION,
  MEMBER_STATUS_QUESTION,
} from "./mailbox.ts";

/** Captures scheduling state for an agent managed by AgentManager. */
export interface ManagedAgentStatus {
  id: AgentID;
  parentId: AgentID;
  memberId: string;
  expertId: string;
  memberDisplayName: string;
  memberEmoji: string;
  memberRole: string;
  state: string;
  result: string;
  error: string;
  startedAt?: Date;
  updatedAt?: Date;
}

/**
 * Observes lifecycle transitions of managed agents. It is invoked after the
 * manager lock is released (a no-op here, since Deno is single-threaded), so
 * listeners may call back into the manager safely.
 */
export type AgentStatusListener = (status: ManagedAgentStatus) => void;

/** Manages the lifecycle of all agent instances. */
export class AgentManager {
  agents = new Map<AgentID, AgentAdapter>();
  parentOf = new Map<AgentID, AgentID>();
  children = new Map<AgentID, AgentID[]>();
  statuses = new Map<AgentID, ManagedAgentStatus>();
  cancels = new Map<AgentID, () => void>();
  listeners: AgentStatusListener[] = [];
  factory: AgentFactory;
  counter = 0;

  /**
   * Expert-team member context, installed once by the runtime assembly layer
   * via `setMemberContext` before any run starts and treated as read-only
   * afterwards. All empty when no expert team is bound.
   */
  members?: MemberDefRegistry;
  mailbox?: MemberMailbox;
  expertID = "";

  constructor(factory: AgentFactory) {
    this.factory = factory;
    factory.manager = this;
  }

  /**
   * Installs the expert-team member context. Passing undefined/empty values
   * clears a previous binding. Callers must set it during assembly, before any
   * agent run starts.
   */
  setMemberContext(
    members: MemberDefRegistry | undefined,
    mailbox: MemberMailbox | undefined,
    expertID: string,
  ): void {
    this.members = members;
    this.mailbox = mailbox;
    this.expertID = expertID;
    if (mailbox !== undefined) {
      // The lead's follow-up hook waits for members through the mailbox; the
      // manager is the only owner of "is a child still running".
      mailbox.setRunningPredicate(() => this.hasRunningChildren());
    }
    this.factory.memberMailbox = mailbox;
  }

  /**
   * Records whether this manager's lead may hold its run open for still-running
   * members. True only for a bound expert team.
   */
  setMemberWaitEnabled(enabled: boolean): void {
    this.factory.memberWaitEnabled = enabled;
  }

  /**
   * Queues a member's blocking question for the lead. The mailbox is the only
   * wake path.
   */
  notifyMemberQuestion(
    memberID: string,
    displayName: string,
    questionID: string,
    question: string,
    options: string[],
  ): void {
    const completion = createMemberCompletion();
    completion.kind = MEMBER_ITEM_QUESTION;
    completion.memberId = memberID;
    completion.displayName = displayName;
    completion.status = MEMBER_STATUS_QUESTION;
    completion.payload = question;
    completion.questionId = questionID;
    completion.options = [...options];
    this.mailbox?.enqueue(completion);
  }

  /**
   * Reports whether any managed child (a spawned member or a delegated task) is
   * still running.
   */
  hasRunningChildren(): boolean {
    for (const id of this.parentOf.keys()) {
      const status = this.statuses.get(id);
      if (status === undefined) continue;
      if (status.state === "ready" || status.state === "running") return true;
    }
    return false;
  }

  /**
   * Registers a listener for terminal lifecycle transitions (an agent entering
   * the done or error state).
   */
  addStatusListener(l: AgentStatusListener): void {
    this.listeners.push(l);
  }

  /** Invokes listeners for agents that transitioned into a terminal state. */
  private fireTerminalStatuses(statuses: ManagedAgentStatus[]): void {
    if (statuses.length === 0) return;
    const listeners = [...this.listeners];
    for (const st of statuses) {
      for (const l of listeners) l(st);
    }
  }

  /**
   * Updates the factory used for future agents while keeping existing managed
   * agents untouched.
   */
  updateRuntimeConfig(
    p: Provider | undefined,
    providerName: string,
    model: Model | undefined,
    settings: Settings | undefined,
    allow: AllowConfig | undefined,
  ): void {
    this.factory = this.factory.withRuntimeConfig(
      p,
      providerName,
      model,
      settings,
      allow,
    );
  }

  /** Registers an already-created top-level agent with the manager. */
  register(a: AgentAdapter): void {
    const id = a.id();
    this.agents.set(id, a);
    if (a.parentId() !== "") {
      this.parentOf.set(id, a.parentId());
      this.children.set(
        a.parentId(),
        appendUniqueAgentID(this.children.get(a.parentId()) ?? [], id),
      );
    }
    const now = new Date();
    this.statuses.set(id, {
      id,
      parentId: a.parentId(),
      memberId: "",
      expertId: "",
      memberDisplayName: "",
      memberEmoji: "",
      memberRole: "",
      state: "ready",
      result: "",
      error: "",
      startedAt: now,
      updatedAt: now,
    });
  }

  /**
   * Creates a new agent and registers it. If `opts.parentId` is set, validates
   * the parent exists and is a top-level agent. Throws on validation failure.
   */
  create(opts: AgentOptions): AgentAdapter {
    let factory = this.factory;

    if ((opts.id ?? "") === "") {
      this.counter += 1;
      opts = { ...opts, id: `agent-${this.counter}` };
    }
    if ((opts.parentId ?? "") !== "") {
      const parentId = opts.parentId!;
      const parent = this.agents.get(parentId);
      if (parent === undefined) {
        throw new Error(`parent agent ${parentId} not found`);
      }
      const parentCfg = runtimeConfigOfManagedAgent(parent);
      if (parentCfg !== undefined) {
        factory = factory.withParentRuntimeConfig(parentCfg);
      }
      if ((opts.mode ?? "") === "") {
        opts = { ...opts, mode: modeOfManagedAgent(parent) };
      }
      if ((opts.mode ?? "") === "") {
        opts = { ...opts, mode: "yolo" };
      }
      // Decision 5: sub-agents cannot nest (only top-level agents can spawn).
      if (parent.parentId() !== "") {
        throw new Error(
          `parent agent ${parentId} is itself a sub-agent; nesting is not allowed`,
        );
      }
    }
    if ((opts.mode ?? "") === "") {
      opts = { ...opts, mode: "yolo" };
    }
    opts = {
      ...opts,
      mode: factory.resolveAgentMode(opts.session, opts.mode!),
    };
    if ((opts.parentId ?? "") !== "") {
      const policy = defaultSubAgentPolicy();
      validateSubAgentPolicy(
        policy,
        opts.parentId!,
        opts.mode!,
        (this.children.get(opts.parentId!) ?? []).length,
      );
    }

    const a = factory.create(opts);
    const id = a.id();
    this.agents.set(id, a);
    if ((opts.parentId ?? "") !== "") {
      this.parentOf.set(id, opts.parentId!);
      this.children.set(
        opts.parentId!,
        [...(this.children.get(opts.parentId!) ?? []), id],
      );
    }
    const now = new Date();
    this.statuses.set(id, {
      id,
      parentId: opts.parentId ?? "",
      memberId: opts.memberId ?? "",
      expertId: opts.expertId ?? "",
      memberDisplayName: opts.memberDisplayName ?? "",
      memberEmoji: opts.memberEmoji ?? "",
      memberRole: opts.memberRole ?? "",
      state: "ready",
      result: "",
      error: "",
      startedAt: now,
      updatedAt: now,
    });
    return a;
  }

  /** Records the active run cancel function for an agent. */
  setCancel(id: AgentID, cancel: (() => void) | undefined): void {
    if (cancel === undefined) {
      this.cancels.delete(id);
      return;
    }
    this.cancels.set(id, cancel);
  }

  /** Returns an agent by ID. */
  get(id: AgentID): AgentAdapter | undefined {
    return this.agents.get(id);
  }

  /** Stops and removes an agent and all its children. Throws when not found. */
  destroy(id: AgentID): void {
    const a = this.agents.get(id);
    if (a === undefined) {
      throw new Error(`agent ${id} not found`);
    }

    // Recursively destroy children first.
    for (const childID of this.children.get(id) ?? []) {
      this.destroyLocked(childID);
    }

    const cancel = this.cancels.get(id);
    if (cancel !== undefined) {
      cancel();
      this.cancels.delete(id);
    }
    a.abort();

    const parentID = this.parentOf.get(id);
    if (parentID !== undefined) {
      this.children.set(
        parentID,
        removeAgentID(this.children.get(parentID) ?? [], id),
      );
    }

    this.agents.delete(id);
    this.parentOf.delete(id);
    this.children.delete(id);
    this.statuses.delete(id);
    this.cancels.delete(id);
  }

  /**
   * Removes a child from its parent's active child list while retaining the
   * child agent, parent link, and status for later inspection.
   */
  detachChild(id: AgentID): void {
    const parentID = this.parentOf.get(id);
    if (parentID !== undefined) {
      this.children.set(
        parentID,
        removeAgentID(this.children.get(parentID) ?? [], id),
      );
    }
  }

  /**
   * Unregisters a completed top-level agent and cancels any remaining children.
   * Child statuses are retained so callers can inspect why a delegated task
   * stopped. Finish must not abort the completed agent itself.
   */
  finish(id: AgentID, cause: Error | undefined): void {
    const terminal: ManagedAgentStatus[] = [];
    if (cause !== undefined) {
      for (const childID of this.children.get(id) ?? []) {
        this.finishChildLocked(childID, cause, terminal);
      }
    }
    const cancel = this.cancels.get(id);
    if (cancel !== undefined) {
      cancel();
      this.cancels.delete(id);
    }
    const parentID = this.parentOf.get(id);
    if (parentID !== undefined) {
      this.children.set(
        parentID,
        removeAgentID(this.children.get(parentID) ?? [], id),
      );
    }
    this.agents.delete(id);
    this.parentOf.delete(id);
    if (cause !== undefined) {
      this.children.delete(id);
    }
    this.statuses.delete(id);
    this.fireTerminalStatuses(terminal);
  }

  /** Destroys an agent without locking (recursive helper). */
  private destroyLocked(id: AgentID): void {
    for (const childID of this.children.get(id) ?? []) {
      this.destroyLocked(childID);
    }
    const a = this.agents.get(id);
    if (a !== undefined) {
      const cancel = this.cancels.get(id);
      if (cancel !== undefined) {
        cancel();
        this.cancels.delete(id);
      }
      a.abort();
    }
    this.agents.delete(id);
    this.parentOf.delete(id);
    this.children.delete(id);
    this.statuses.delete(id);
    this.cancels.delete(id);
  }

  private finishChildLocked(
    id: AgentID,
    cause: Error,
    terminal: ManagedAgentStatus[],
  ): ManagedAgentStatus[] {
    for (const childID of this.children.get(id) ?? []) {
      terminal = this.finishChildLocked(childID, cause, terminal);
    }
    const cancel = this.cancels.get(id);
    if (cancel !== undefined) {
      cancel();
      this.cancels.delete(id);
    }
    const a = this.agents.get(id);
    if (a !== undefined) {
      a.abort();
    }
    const st: ManagedAgentStatus = this.statuses.get(id) ?? {
      id,
      parentId: "",
      memberId: "",
      expertId: "",
      memberDisplayName: "",
      memberEmoji: "",
      memberRole: "",
      state: "",
      result: "",
      error: "",
    };
    st.id = id;
    if (st.startedAt === undefined) st.startedAt = new Date();
    const parentID = this.parentOf.get(id);
    if (parentID !== undefined) st.parentId = parentID;
    if (!isTerminalManagedState(st.state)) {
      const previous = st.state;
      st.state = "error";
      if (cause !== undefined) {
        st.error = cause.message;
      } else if (st.error === "") {
        st.error = "parent agent finished";
      }
      if (previous !== "error") {
        st.updatedAt = new Date();
        terminal.push(st);
      }
    }
    st.updatedAt = new Date();
    this.statuses.set(id, st);

    this.agents.delete(id);
    this.parentOf.delete(id);
    this.children.delete(id);
    return terminal;
  }

  /** Records that an agent has started processing a task. */
  markRunning(id: AgentID): void {
    this.updateStatus(id, "running", "", "");
  }

  /** Records successful completion and the last reported result. */
  markDone(id: AgentID, result: string): void {
    this.updateStatus(id, "done", result, "");
  }

  /** Records that an agent stopped before completing its objective. */
  markIncomplete(id: AgentID, err: Error | undefined): void {
    this.updateStatus(id, "incomplete", "", err?.message ?? "");
  }

  /** Records an agent failure. */
  markError(id: AgentID, err: Error | undefined): void {
    this.updateStatus(id, "error", "", err?.message ?? "");
  }

  /**
   * Records that an agent's run was canceled (user abort, timeout, or context
   * cancellation). Canceled is a terminal state distinct from error.
   */
  markCanceled(id: AgentID, err: Error | undefined): void {
    this.updateStatus(id, "canceled", "", err?.message ?? "");
  }

  private updateStatus(
    id: AgentID,
    state: string,
    result: string,
    errMsg: string,
  ): void {
    const st: ManagedAgentStatus = this.statuses.get(id) ?? {
      id,
      parentId: "",
      memberId: "",
      expertId: "",
      memberDisplayName: "",
      memberEmoji: "",
      memberRole: "",
      state: "",
      result: "",
      error: "",
    };
    st.id = id;
    if (st.startedAt === undefined) st.startedAt = new Date();
    const parentID = this.parentOf.get(id);
    if (parentID !== undefined) st.parentId = parentID;
    const previous = st.state;
    // Terminal state is sticky. Canonical EVENT_RUN_FINISHED is followed by
    // legacy EVENT_DONE/EVENT_ERROR for compatibility; those events must never
    // overwrite incomplete, canceled, error, or success with another outcome.
    if (isTerminalManagedState(previous) && previous !== state) {
      return;
    }
    st.state = state;
    if (result !== "") st.result = result;
    if (errMsg !== "") st.error = errMsg;
    st.updatedAt = new Date();
    this.statuses.set(id, st);
    if (isTerminalManagedState(state) && previous !== state) {
      this.fireTerminalStatuses([st]);
    }
  }

  /** Returns a copy of the tracked status for an agent. */
  status(id: AgentID): ManagedAgentStatus | undefined {
    return this.statuses.get(id);
  }

  /** Returns a sorted copy of all tracked agent statuses. */
  statusesList(): ManagedAgentStatus[] {
    const statuses = [...this.statuses.values()];
    statuses.sort((a, b) => {
      const at = a.startedAt?.getTime() ?? 0;
      const bt = b.startedAt?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return statuses;
  }

  /** Returns all agent IDs. */
  list(): AgentID[] {
    const ids = [...this.agents.keys()];
    ids.sort((a, b) => {
      const at = this.statuses.get(a)?.startedAt?.getTime() ?? 0;
      const bt = this.statuses.get(b)?.startedAt?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return ids;
  }

  /** Returns the children of an agent, or undefined when none are registered. */
  getChildren(id: AgentID): AgentID[] | undefined {
    const children = this.children.get(id);
    if (children === undefined) return undefined;
    return [...children];
  }

  /** Returns the parent ID of an agent. */
  /** IDs of the direct children of `id`. */
  childrenOf(id: AgentID): AgentID[] {
    return this.children.get(id) ?? [];
  }

  parent(id: AgentID): AgentID | undefined {
    return this.parentOf.get(id);
  }

  /** Returns the number of active agents. */
  count(): number {
    return this.agents.size;
  }

  /**
   * Reports whether any managed agent is currently executing or ready to
   * execute work. Completed retained agents are history, not active blockers.
   */
  hasRunning(): boolean {
    for (const id of this.agents.keys()) {
      const state = this.statuses.get(id)?.state ?? "";
      if (state === "" || state === "ready" || state === "running") return true;
    }
    return false;
  }
}

/** Creates a new agent manager. */
export function createAgentManager(factory: AgentFactory): AgentManager {
  return new AgentManager(factory);
}

function modeOfManagedAgent(a: AgentAdapter): string {
  const cfg = runtimeConfigOfManagedAgent(a);
  return cfg?.mode ?? "";
}

/** Returns the loop config of a managed agent when it is an AgentAdapter. */
export function runtimeConfigOfManagedAgent(
  a: AgentAdapter,
): AgentLoopConfig | undefined {
  if (a instanceof AgentAdapter && a.inner !== undefined) {
    return a.inner.config;
  }
  return undefined;
}

/** Re-export the completion type used by member notifications. */
export type { MemberCompletion };
