import {
  createTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";
import type { MemberCompletion, MemberMailbox } from "./mailbox.ts";

// Bounded wait window for subagent_wait. These are tool ergonomics, not user
// configuration: they intentionally stay package constants and must not enter
// the settings schema.
export const subAgentWaitMinTimeoutMS = 2500;
export const subAgentWaitMaxTimeoutMS = 120000;
export const subAgentWaitDefaultTimeoutMS = 30000;

/**
 * The manager surface subagent_wait depends on. The full AgentManager is not
 * ported yet; the tool only needs the session member mailbox.
 */
export interface SubAgentWaitManager {
  mailbox?: MemberMailbox;
}

/**
 * SubAgentWaitTool blocks the calling (lead) agent until the session member
 * mailbox reports activity or a bounded timeout elapses. It only merges the
 * caller into already-scheduled member completions; like the mailbox itself it
 * never wakes or starts a run. The result lists pending completions without
 * their payloads — content is delivered by the mailbox drain at the next
 * iteration boundary.
 */
export class SubAgentWaitTool implements Tool {
  #manager: SubAgentWaitManager;

  constructor(manager: SubAgentWaitManager) {
    this.#manager = manager;
  }

  name(): string {
    return "subagent_wait";
  }

  description(): string {
    return "Wait for expert-team member activity: blocks until a spawned member or sub-agent completion lands in the session mailbox, or the bounded timeout elapses. Returns only a pending summary (member id, status); completion content is delivered automatically at the next iteration boundary.";
  }

  promptSnippet(): string {
    return "Wait for a member completion when the critical path is blocked";
  }

  promptGuidelines(): string[] {
    return [
      "Use subagent_wait only when the critical path is blocked on a member's result; do non-overlapping local work while members run",
      "Completion content is delivered automatically after the wait returns; never call subagent_wait again immediately after a wait (no reflexive waiting)",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        timeout_ms: {
          type: "integer",
          description:
            "Maximum wait time in milliseconds (clamped to 2500-120000, default 30000)",
        },
      },
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const timeoutMS = resolveSubAgentWaitTimeoutMS(params);

    const mailbox = this.#manager.mailbox;
    if (mailbox === undefined) {
      return createSubAgentWaitResult(
        "no member mailbox is bound to this session",
        false,
        null,
      );
    }

    let timedOut = false;
    if (!mailbox.hasPending()) {
      try {
        timedOut = await mailbox.waitForActivity(ctx.signal, timeoutMS);
      } catch (err) {
        throw new Error(`subagent_wait: ${(err as Error).message}`);
      }
    }
    let message = "Wait completed.";
    if (timedOut) {
      message = "Wait timed out.";
    }
    return createSubAgentWaitResult(
      message,
      timedOut,
      mailbox.pendingSummary(),
    );
  }
}

/** Creates the subagent_wait tool. */
export function createSubAgentWaitTool(manager: SubAgentWaitManager): Tool {
  return new SubAgentWaitTool(manager);
}

/**
 * Applies the bounded wait window: default 30000, clamped to [2500, 120000]
 * when timeout_ms is provided.
 */
export function resolveSubAgentWaitTimeoutMS(
  params: Record<string, unknown>,
): number {
  let timeoutMS = subAgentWaitDefaultTimeoutMS;
  const v = params["timeout_ms"];
  if (typeof v === "number") {
    timeoutMS = Math.trunc(v);
  }
  if (timeoutMS < subAgentWaitMinTimeoutMS) {
    timeoutMS = subAgentWaitMinTimeoutMS;
  }
  if (timeoutMS > subAgentWaitMaxTimeoutMS) {
    timeoutMS = subAgentWaitMaxTimeoutMS;
  }
  return timeoutMS;
}

/** One summary entry of the wait result (never carries the payload). */
interface SubAgentWaitPending {
  member: string;
  status: string;
  display_name?: string;
  question_id?: string;
}

/**
 * Builds the wait result. The summary is read-only and omits the completion
 * payload; a pending member question carries its question ID so the lead can
 * answer it with subagent_answer even when it only inspects this projection.
 */
export function createSubAgentWaitResult(
  message: string,
  timedOut: boolean,
  pending: MemberCompletion[] | null,
): ToolResult {
  const payload: {
    message: string;
    timed_out: boolean;
    pending?: SubAgentWaitPending[];
  } = { message, timed_out: timedOut };
  if (pending !== null && pending.length > 0) {
    payload.pending = pending.map((c) => {
      const entry: SubAgentWaitPending = {
        member: c.memberId,
        status: c.status,
      };
      if (c.displayName !== "") entry.display_name = c.displayName;
      if (c.questionId !== "") entry.question_id = c.questionId;
      return entry;
    });
  }
  try {
    return createTextToolResult(JSON.stringify(payload));
  } catch {
    return createTextToolResult(
      `{"message":${JSON.stringify(message)},"timed_out":${timedOut}}`,
    );
  }
}
