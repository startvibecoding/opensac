//
// Constrains a shared CronStore to one session so the scheduler and API cannot
// read or mutate another session's jobs by guessing an ID.

import { asDueJobClaimer, type CronJob, type CronStore } from "./cron.ts";

/** A CronStore view scoped to a single session. */
export class SessionScopedStore implements CronStore {
  readonly base: CronStore;
  readonly sessionId: string;
  readonly workDir: string;

  constructor(base: CronStore, sessionId: string, workDir = "") {
    this.base = base;
    this.sessionId = sessionId;
    this.workDir = workDir;
  }

  list(): CronJob[] {
    return this.base.list().filter((job) => job.sessionId === this.sessionId);
  }

  get(id: string): CronJob {
    const job = this.base.get(id);
    if (job.sessionId !== this.sessionId) {
      throw new Error(`cron job "${id}" not found`);
    }
    return job;
  }

  create(job: CronJob): CronJob {
    return this.base.create({
      ...job,
      sessionId: this.sessionId,
      workDir: job.workDir || this.workDir,
    });
  }

  update(job: CronJob): void {
    if (job.sessionId !== this.sessionId) {
      throw new Error(`cron job "${job.id ?? ""}" not found`);
    }
    this.base.update(job);
  }

  delete(id: string): void {
    this.get(id);
    this.base.delete(id);
  }

  claimDue(id: string, now: Date): boolean {
    const job = this.get(id);
    const claimer = asDueJobClaimer(this.base);
    if (claimer) return claimer.claimDue(job.id ?? "", now);
    return false;
  }
}

/** Wraps a shared store in a session scope. */
export function newSessionScopedStore(
  base: CronStore,
  sessionId: string,
): CronStore {
  return new SessionScopedStore(base, sessionId, "");
}

/** Wraps a shared store in a session scope with a default work directory. */
export function newSessionScopedStoreWithWorkDir(
  base: CronStore,
  sessionId: string,
  workDir: string,
): CronStore {
  return new SessionScopedStore(base, sessionId, workDir);
}
