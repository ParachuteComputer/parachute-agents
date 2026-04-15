/**
 * Pluggable scheduler for `trigger.type: cron` agents. The runtime-agnostic
 * entry exports only the interface — concrete implementations live behind
 * subpath exports so Cloudflare bundles don't pull in node-only deps.
 *
 * See `@openparachute/agent/scheduler-node` for the croner-backed
 * implementation used by Bun/Node self-hosted deployments. The Cloudflare
 * Workers cron story goes through `wrangler.toml` triggers + the DO
 * `alarm()` method and will ship with its own wrapper.
 */
export interface Scheduler {
  /** Register `handler` to fire on `cronExpr`. `id` must be unique per scheduler. */
  schedule(id: string, cronExpr: string, handler: () => Promise<void>): void;
  /** Stop and remove a single scheduled job. No-op if `id` isn't registered. */
  cancel(id: string): void;
  /** Stop and remove every scheduled job. */
  cancelAll(): void;
}
