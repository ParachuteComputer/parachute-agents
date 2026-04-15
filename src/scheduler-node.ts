import { Cron } from "croner";
import type { Scheduler } from "./scheduler.js";

/**
 * Node/Bun scheduler backed by [croner](https://github.com/Hexagon/croner) —
 * zero-dep, ESM-native, accepts both 5-field and 6-field cron expressions.
 * Timezone is UTC by default; pass `{timezone: "..."}` via the second
 * constructor arg if you need something else.
 */
export class NodeCronScheduler implements Scheduler {
  private readonly jobs = new Map<string, Cron>();

  constructor(private readonly options: { timezone?: string } = {}) {}

  schedule(id: string, cronExpr: string, handler: () => Promise<void>): void {
    this.cancel(id);
    const job = new Cron(
      cronExpr,
      { timezone: this.options.timezone ?? "UTC", name: id, protect: true },
      () => {
        handler().catch((err) => {
          // Surface but don't crash the scheduler loop — a single failing
          // run shouldn't stop future fires.
          console.error(`[scheduler] ${id} handler threw:`, err);
        });
      },
    );
    this.jobs.set(id, job);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Test-only: how many jobs are currently registered. */
  size(): number {
    return this.jobs.size;
  }
}
