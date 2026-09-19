// Ported from internal/agent/tool_launch.go.
//
// ToolLaunchOrder keeps the *start* of one parallel tool-call batch in the
// declared provider order without serializing or blocking the batch: calls still
// run concurrently, still wait for approvals and durable claims independently,
// and may finish in any order, but call i may not report its start before call
// i-1 has reported its own. The only wait is a one-shot handoff that is never
// held across a tool body, an approval prompt, or a durable claim.

/**
 * ToolLaunchOrder prepares the start-order chain for one batch of calls. The
 * first call is always free to start. A non-positive call count returns null,
 * which yields nil-safe handles.
 */
export class ToolLaunchOrder {
  private started: PromiseWithResolvers<void>[] = [];

  constructor(calls: number) {
    if (calls <= 0) return;
    for (let i = 0; i < calls; i++) {
      this.started.push(Promise.withResolvers<void>());
    }
    this.started[0].resolve();
  }

  /** Returns the ordering handle of one call in the batch. */
  handle(index: number): ToolLaunchHandle {
    return new ToolLaunchHandle(this, index);
  }

  /** @internal Waits until every earlier call of the batch started. */
  async waitStart(index: number): Promise<void> {
    await this.started[index].promise;
  }

  /** @internal Releases the next call's start. */
  markStarted(index: number): void {
    const next = index + 1;
    if (next < this.started.length) {
      this.started[next].resolve();
    }
  }
}

/** Creates a nil-safe ToolLaunchOrder; a non-positive count yields null. */
export function newToolLaunchOrder(calls: number): ToolLaunchOrder | null {
  if (calls <= 0) return null;
  return new ToolLaunchOrder(calls);
}

/**
 * ToolLaunchHandle owns one call's start checkpoint in a ToolLaunchOrder batch.
 * Every method is safe on a null handle.
 */
export class ToolLaunchHandle {
  private order: ToolLaunchOrder | null;
  private index: number;
  private once = false;

  constructor(order: ToolLaunchOrder | null, index: number) {
    this.order = order;
    this.index = index;
  }

  /** Blocks until every earlier call of the batch reported its start. */
  async waitStart(): Promise<void> {
    if (this.order == null) return;
    await this.order.waitStart(this.index);
  }

  /**
   * Releases the next call's start. Callers invoke it after the start event has
   * been sent so the event stream keeps the declared order.
   */
  markStarted(): void {
    if (this.order == null || this.once) return;
    this.once = true;
    this.order.markStarted(this.index);
  }

  /**
   * Reports the start checkpoint for a call that never reached it, so the calls
   * queued behind it can begin. It is idempotent.
   */
  release(): void {
    this.markStarted();
  }
}
