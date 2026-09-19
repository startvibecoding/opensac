// Ported from the eventSink / `chan Event` plumbing of internal/agent/agent.go.
//
// Go's buffered `chan Event` (capacity 100) plus the race-free `eventSink` map
// to a single-threaded async channel: the run task pushes events and the
// consumer drains them. `close`/seal stops accepting pushes so a late
// child-agent forward is dropped instead of racing the terminal events.
//
// Deviation: the channel is unbounded rather than capacity 100. Go bounds the
// buffer so a producer cannot outrun a stalled consumer; here every producer
// checks the run signal before pushing (`sendEvent`) and a stalled consumer on
// an aborted run stops the loop, so the queue either drains or is discarded
// with the run. Go's `seal()` (wake blocked senders, then wait for in-flight
// sends) collapses to `close()` because there are no blocking sends.

import type { Event } from "./events.ts";

/** An in-process async event channel implementing the Go `chan<- Event` sink. */
export class EventChannel implements AsyncIterable<Event> {
  #buffer: Event[] = [];
  #waiters: Array<(result: IteratorResult<Event>) => void> = [];
  #closed = false;

  /** Pushes an event; returns false once the channel is sealed/closed. */
  push(ev: Event): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: ev, done: false });
    } else {
      this.#buffer.push(ev);
    }
    return true;
  }

  /** Seals the channel: no further pushes are accepted and readers finish. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      waiter({ value: undefined as unknown as Event, done: true });
    }
  }

  /** Reports whether the channel has been sealed. */
  get closed(): boolean {
    return this.#closed;
  }

  next(): Promise<IteratorResult<Event>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({
        value: undefined as unknown as Event,
        done: true,
      });
    }
    return new Promise<IteratorResult<Event>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return { next: () => this.next() };
  }
}
