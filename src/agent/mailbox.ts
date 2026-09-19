// Ported from internal/agent/mailbox.go.

import {
  type Message,
  newSystemInjectedUserMessage,
} from "../provider/types.ts";

// Member completion statuses carried by MemberCompletion.status.
export const MemberStatusDone = "done";
export const MemberStatusError = "error";
export const MemberStatusCanceled = "canceled";
export const MemberStatusIncomplete = "incomplete";

// Member notification kinds.
export const MemberItemCompletion = "completion";
export const MemberItemQuestion = "question";

/** The status projected for MemberItemQuestion entries in summaries. */
export const MemberStatusQuestion = "question";

const memberPayloadRunes = 3500;
const memberErrorPayloadRunes = 3000;
const memberTruncationSuffix = "…[truncated]";

/** One member notification queued in a MemberMailbox. */
export interface MemberCompletion {
  kind: string; // "" (completion) | "completion" | "question"
  memberId: string;
  displayName: string;
  status: string; // "done" | "error" | "canceled" | "incomplete" | "question"
  payload: string;
  questionId: string;
  options: string[];
}

/** Creates a MemberCompletion with empty defaults. */
export function newMemberCompletion(): MemberCompletion {
  return {
    kind: "",
    memberId: "",
    displayName: "",
    status: "",
    payload: "",
    questionId: "",
    options: [],
  };
}

/**
 * MemberMailbox is the session-level in-memory queue of member completions. All
 * methods are safe on a null mailbox so callers can skip null checks.
 */
export class MemberMailbox {
  private queue: MemberCompletion[] = [];
  private waiters: Array<() => void> = [];
  private activityPending = false;
  private runningChildren?: () => boolean;

  /** Installs the "any member still running" probe. */
  setRunningPredicate(running: (() => boolean) | undefined): void {
    this.runningChildren = running;
  }

  /** Reports whether members are still running. */
  runningChildrenRunning(): boolean {
    return this.runningChildren != null && this.runningChildren();
  }

  /** Appends a completion and non-blockingly signals activity. */
  enqueue(c: MemberCompletion): void {
    this.queue.push(c);
    this.signalActivity();
  }

  /** Reports whether undelivered completions are queued. */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Removes and returns every queued completion in enqueue order, formatted as
   * system-injected steering messages. Returns null when nothing is pending.
   */
  drainSteering(): Message[] | null {
    const pending = this.queue;
    this.queue = [];
    // Drain the activity hint alongside the queue so a later wait does not
    // return on a stale signal.
    this.activityPending = false;
    if (pending.length === 0) return null;
    return pending.map((c) =>
      newSystemInjectedUserMessage(formatMemberItem(c))
    );
  }

  /** Returns a read-only snapshot of the queued completions. */
  pendingSummary(): MemberCompletion[] | null {
    if (this.queue.length === 0) return null;
    return this.queue.map((c) => ({ ...c, options: [...c.options] }));
  }

  /**
   * Blocks until the mailbox signals activity, the timeout elapses
   * (returns true), or the signal aborts (throws).
   */
  async waitForActivity(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw new Error("wait for member activity: aborted");
    }
    if (this.activityPending) {
      this.activityPending = false;
      return false;
    }
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const idx = this.waiters.indexOf(onActivity);
        if (idx >= 0) this.waiters.splice(idx, 1);
      };
      const done = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(timedOut);
      };
      const onActivity = (): void => done(false);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("wait for member activity: aborted"));
      };
      const timer = setTimeout(() => done(true), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(onActivity);
    });
  }

  private signalActivity(): void {
    this.activityPending = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/** Creates an empty mailbox. */
export function newMemberMailbox(): MemberMailbox {
  return new MemberMailbox();
}

function formatMemberItem(c: MemberCompletion): string {
  if (c.kind === MemberItemQuestion) return formatMemberQuestion(c);
  return formatMemberCompletion(c);
}

function formatMemberQuestion(c: MemberCompletion): string {
  let b = "";
  b +=
    "[MEMBER_QUESTION] 系统注入的成员提问上下文（非用户输入）。成员正在等待你的回答。\n";
  if (c.displayName !== "") {
    b += `member: ${c.memberId}（${c.displayName}）\n`;
  } else {
    b += `member: ${c.memberId}\n`;
  }
  b += `question_id: ${c.questionId}\n`;
  b += "question:\n";
  b += truncateMemberPayload(c.payload, memberPayloadRunes);
  b += "\n";
  if (c.options.length > 0) {
    b += `options: ${c.options.join(" | ")}\n`;
  }
  b += `下一步：用 subagent_answer(handle:${
    JSON.stringify(c.memberId)
  }, question_id:${
    JSON.stringify(c.questionId)
  }, answer:"…") 回答；成员会继续执行。`;
  return b;
}

function formatMemberCompletion(c: MemberCompletion): string {
  let b = "";
  b += "[MEMBER_COMPLETION] 系统注入的成员状态上下文（非用户输入）。\n";
  if (c.displayName !== "") {
    b += `member: ${c.memberId}（${c.displayName}）\n`;
  } else {
    b += `member: ${c.memberId}\n`;
  }
  b += `status: ${c.status}\n`;
  b += "payload:\n";
  if (c.status === MemberStatusError) {
    b += truncateMemberPayload(c.payload, memberErrorPayloadRunes);
    b += "\n";
    b += `下一步：如仍需该成员，用 subagent_spawn(member:${
      JSON.stringify(c.memberId)
    }, task:…) 重新派发任务。`;
  } else {
    b += truncateMemberPayload(c.payload, memberPayloadRunes);
  }
  return b;
}

function truncateMemberPayload(s: string, limit: number): string {
  const runes = [...s];
  if (runes.length <= limit) return s;
  return runes.slice(0, limit).join("") + memberTruncationSuffix;
}
