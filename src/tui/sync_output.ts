// Atomic frame writes for the Ink layer (DEC private mode 2026 "synchronized
// output"). Ink's log-update erases and rewrites the whole managed region on
// every live update; framing each write tells supporting terminals (kitty,
// iTerm2, WezTerm, foot, Windows Terminal, …) to present the erase+repaint as
// one frame, which removes the visible flicker while a modal shows streaming
// content. Terminals without mode 2026 ignore the markers and behave exactly
// as before.

const SYNC_BEGIN = "\u001B[?2026h";
const SYNC_END = "\u001B[?2026l";

/**
 * Wraps `inner` so every string write is framed as one atomic frame. Members
 * are delegated to the wrapped stream (bound for methods) so Ink keeps full
 * access to `columns`, events, and TTY state.
 */
export function atomicStdout<
  T extends { write(chunk: unknown, ...args: unknown[]): unknown },
>(inner: T): T {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk: unknown, ...args: unknown[]): unknown =>
          typeof chunk === "string"
            ? Reflect.apply(target.write, target, [
                SYNC_BEGIN + chunk + SYNC_END,
                ...args,
              ])
            : Reflect.apply(target.write, target, [chunk, ...args]);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
