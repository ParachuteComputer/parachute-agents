/**
 * Per-agent cursor tracking for the vault watcher. A cursor is an opaque
 * string — in practice, a millisecond timestamp of the newest note the
 * watcher has already dispatched. Storing as string keeps future swaps
 * (ULID, note id, composite key) cheap.
 */
export interface CursorStore {
  get(agentName: string): Promise<string | null>;
  set(agentName: string, cursor: string): Promise<void>;
}

/**
 * In-process cursor store. Loses progress on restart — use the sqlite variant
 * (`@openparachute/agent/cursor-store-sqlite`) for persistent deployments so
 * the first post-restart poll doesn't reprocess the entire match set.
 */
export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, string>();

  async get(agentName: string): Promise<string | null> {
    return this.cursors.get(agentName) ?? null;
  }

  async set(agentName: string, cursor: string): Promise<void> {
    this.cursors.set(agentName, cursor);
  }
}
