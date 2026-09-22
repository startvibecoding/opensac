// Rotating-dot spinner for the TUI's running-state indicators (the busy footer
// and running tool rows).
//
// Pure and DOM-free: callers own the tick — the shell advances it on a timer
// while a run is active — so renderers stay deterministic and testable.

/** Braille dot frames: one lit dot position per frame (classic spinner). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animation cadence while a run is active. */
export const SPINNER_INTERVAL_MS = 120;

/** The spinner frame for `tick`; wraps around in both directions. */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((Math.trunc(tick) % n) + n) % n];
}
