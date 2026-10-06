import type { Store } from '../db/store.ts';
import type { JobRow } from '../db/types.ts';
import { errMsg, log } from '../log.ts';

export const MAX_ATTEMPTS = 6;
/** 30 s, 1 min, 2 min, 4 min, 8 min. */
export const backoffSeconds = (attempt: number) => 30 * 2 ** (attempt - 1);

/** A handler finishes the job, or asks to run it again later without counting a failure. */
export type JobResult = 'done' | { deferSeconds: number };
export type JobHandler = (job: JobRow) => Promise<JobResult>;

/** Polls the SQLite job queue and runs due jobs with retry + backoff (SPEC §10.2). */
export class JobWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = 0;
  private stopped = false;

  constructor(
    private store: Store,
    private handler: JobHandler,
    private now: () => number,
    private opts = { concurrency: 3, pollMs: 2000 },
  ) {}

  start() {
    this.store.requeueRunningJobs(this.now());
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Run every due job once; exposed for tests and scripts. */
  async tick() {
    const free = this.opts.concurrency - this.running;
    const jobs = free > 0 ? this.store.claimJobs(this.now(), free) : [];
    await Promise.all(jobs.map((j) => this.run(j)));
    this.schedule(jobs.length ? 0 : this.opts.pollMs);
  }

  private async run(job: JobRow) {
    this.running++;
    try {
      const result = await this.handler(job);
      if (result === 'done') this.store.finishJob(job.id);
      else this.store.deferJob(job.id, this.now() + result.deferSeconds);
    } catch (err) {
      const giveUp = job.attempts >= MAX_ATTEMPTS;
      this.store.failJob(job.id, errMsg(err).slice(0, 500), giveUp ? null : this.now() + backoffSeconds(job.attempts));
      log.warn(`job ${job.kind} #${job.id} attempt ${job.attempts} failed${giveUp ? ', giving up' : ''}: ${errMsg(err).slice(0, 200)}`);
    } finally {
      this.running--;
    }
  }
}
