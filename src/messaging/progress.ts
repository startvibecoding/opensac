// Ported from internal/messaging/progress.go

/**
 * ProgressBuffer collects progress lines and flushes them in batches.
 * Designed for messaging platforms with per-message reply limits (e.g., WeChat:
 * 10 replies per user message).
 *
 * Usage:
 *
 *   const buf = newProgressBuffer(maxLines, sendFunc);
 *   // During agent execution:
 *   buf.add("[read]: file.go ✅");   // buffered
 *   buf.add("[bash]: go build ✅");  // buffered, auto-flushes if full
 *   // After agent completes:
 *   buf.flush();                     // send remaining lines
 */
export class ProgressBuffer {
  private lines: string[] = [];
  private readonly maxLines: number;
  /** Lines reserved for the final summary (not counted in maxLines). */
  readonly reserve = 3;
  private readonly sendFunc: ((text: string) => void) | null;
  /** Total lines added (for logging). */
  total = 0;

  constructor(maxLines: number, sendFunc?: ((text: string) => void) | null) {
    this.maxLines = maxLines > 0 ? maxLines : 7;
    this.sendFunc = sendFunc ?? null;
  }

  /** Add adds a progress line. Auto-flushes when buffer is full. */
  add(line: string): void {
    this.lines.push(line);
    this.total++;
    if (this.lines.length >= this.maxLines) {
      this.flushLocked();
    }
  }

  /** Flush sends any remaining buffered lines. Call after agent completes. */
  flush(): void {
    this.flushLocked();
  }

  /** flushLocked sends buffered lines and clears the buffer. */
  private flushLocked(): void {
    if (this.lines.length === 0 || this.sendFunc === null) {
      return;
    }
    const combined = this.lines.join("\n");
    this.sendFunc(combined);
    this.lines = [];
  }
}

/** newProgressBuffer mirrors NewProgressBuffer. */
export function newProgressBuffer(
  maxLines: number,
  sendFunc?: ((text: string) => void) | null,
): ProgressBuffer {
  return new ProgressBuffer(maxLines, sendFunc);
}
