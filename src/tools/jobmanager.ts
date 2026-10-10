//
// Manages background processes started through `bash async=true`. Go's
// `*exec.Cmd`/`context.CancelFunc` map to a process id plus a kill callback
// supplied by the bash tool; `time.Duration` maps to milliseconds.

/** Represents a running background process. */
export class BackgroundJob {
  readonly id: number;
  readonly command: string;
  readonly pid: number;
  readonly startTime: number;
  #kill: () => void;
  done = false;
  exitCode = 0;
  stdout: Uint8Array = new Uint8Array(0);
  stderr: Uint8Array = new Uint8Array(0);
  err: Error | null = null;

  constructor(id: number, command: string, pid: number, kill: () => void) {
    this.id = id;
    this.command = command;
    this.pid = pid;
    this.startTime = Date.now();
    this.#kill = kill;
  }

  /** Marks the job finished and stores output. */
  markDone(stdout: Uint8Array, stderr: Uint8Array, err: Error | null): void {
    this.done = true;
    this.stdout = stdout;
    this.stderr = stderr;
    this.err = err;
  }

  isDone(): boolean {
    return this.done;
  }

  /** Kills the running job. */
  kill(): void {
    this.#kill();
  }

  /** Returns a string representation of the job status. */
  status(): string {
    const elapsed = formatGoDuration(Date.now() - this.startTime);
    if (this.done) {
      let status = "finished";
      if (this.exitCode !== 0) status = `exited with code ${this.exitCode}`;
      return `[${this.id}] ${status} (PID: ${this.pid}, ${this.command}, elapsed: ${elapsed})`;
    }
    return `[${this.id}] running (PID: ${this.pid}, ${this.command}, elapsed: ${elapsed})`;
  }
}

const staleJobTTL = 30 * 60 * 1000;
const gcInterval = 5 * 60 * 1000;

/** Manages background processes. */
export class JobManager {
  #jobs = new Map<number, BackgroundJob>();
  #nextID = 0;
  #lastGC = 0;

  /** Adds a new background job. */
  addJob(command: string, pid: number, kill: () => void): BackgroundJob {
    this.#gcStaleJobs();
    this.#nextID++;
    const job = new BackgroundJob(this.#nextID, command, pid, kill);
    this.#jobs.set(job.id, job);
    return job;
  }

  getJob(id: number): BackgroundJob | undefined {
    return this.#jobs.get(id);
  }

  listJobs(): BackgroundJob[] {
    return [...this.#jobs.values()];
  }

  /** Kills a running job. */
  killJob(id: number): void {
    const job = this.#jobs.get(id);
    if (!job) {
      throw new Error(`job ${id} not found`);
    }
    if (job.done) {
      throw new Error(`job ${id} already finished`);
    }
    job.kill();
  }

  /** Removes a finished job. */
  removeJob(id: number): void {
    this.#jobs.delete(id);
  }

  #gcStaleJobs(): void {
    if (Date.now() - this.#lastGC < gcInterval) return;
    this.#lastGC = Date.now();
    for (const [id, job] of this.#jobs) {
      const stale = job.done && Date.now() - job.startTime > staleJobTTL;
      if (stale) this.#jobs.delete(id);
    }
  }
}

/** Creates a new job manager. */
export function createJobManager(): JobManager {
  return new JobManager();
}

/** Formats a millisecond duration like Go's `time.Duration.String()`. */
export function formatGoDuration(totalMs: number): string {
  let ms = Math.round(totalMs / 1000) * 1000;
  if (ms === 0) return "0s";
  const negative = ms < 0;
  if (negative) ms = -ms;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  out += `${seconds}s`;
  if (hours === 0 && minutes === 0) out = `${seconds}s`;
  return negative ? "-" + out : out;
}
