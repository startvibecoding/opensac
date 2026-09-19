// Ported from internal/agent/followup.go.

import type { Message } from "../provider/types.ts";
import type { MemberMailbox } from "./mailbox.ts";

const minute = 60 * 1000;

/**
 * MemberFollowUpWaitMax bounds how long a team lead waits for its still running
 * members before the run may end (35 minutes).
 */
export const MemberFollowUpWaitMax = 35 * minute;
/**
 * MemberFollowUpPoll refreshes the "any member still running" check and the
 * adapter steering probe while waiting (2 seconds).
 */
export const MemberFollowUpPoll = 2 * 1000;

/**
 * Builds a team lead's would-stop hook: it is called when a turn has no tool
 * calls and therefore would end the run.
 *
 * Order of precedence:
 *  1. adapter steering (for example a queued user message) is returned
 *     immediately;
 *  2. pending member notifications are returned;
 *  3. only when members are still running does it block — event-driven on the
 *     mailbox — until something arrives or the bounded wait expires.
 *
 * A null mailbox yields undefined so non-team sessions keep the prior loop
 * shape.
 */
export function composeFollowUps(
  mailbox: MemberMailbox | null | undefined,
  adapterSteering?: () => Message[],
): ((signal?: AbortSignal) => Promise<Message[] | null>) | undefined {
  if (mailbox == null) return undefined;
  return async (signal?: AbortSignal): Promise<Message[] | null> => {
    if (signal?.aborted) return null;
    let messages = drainAdapterSteering(adapterSteering);
    if (messages.length > 0) return messages;
    messages = mailbox.drainSteering() ?? [];
    if (messages.length > 0) return messages;
    if (!mailbox.runningChildrenRunning()) return null;

    const deadline = Date.now() + MemberFollowUpWaitMax;
    while (Date.now() < deadline) {
      try {
        await mailbox.waitForActivity(signal, MemberFollowUpPoll);
      } catch {
        // Cancelled run: let the loop reach its terminal state.
        return null;
      }
      messages = drainAdapterSteering(adapterSteering);
      if (messages.length > 0) return messages;
      messages = mailbox.drainSteering() ?? [];
      if (messages.length > 0) return messages;
      if (!mailbox.runningChildrenRunning()) return null;
    }
    return null;
  };
}

function drainAdapterSteering(
  source: (() => Message[]) | undefined,
): Message[] {
  if (source == null) return [];
  return source();
}
