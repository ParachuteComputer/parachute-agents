import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentDefinition, VaultTrigger } from "./agents.js";
import { Vault, type VaultConfig } from "./vault.js";
import type { CursorStore } from "./cursor-store.js";
import { MemoryCursorStore } from "./cursor-store.js";

/**
 * Minimal note shape the watcher cares about. Extra fields from the vault
 * flow through via the catch-all — agents receive the full JSON as their
 * input text, so they see everything the vault returned.
 */
export interface VaultNote {
  id: string;
  path: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface VaultQuery {
  tags?: string[];
  notTags?: string[];
  /** Exclusive lower bound in ms since epoch. */
  since?: number;
  event: "created" | "updated";
  limit?: number;
}

export type QueryNotes = (q: VaultQuery) => Promise<VaultNote[]>;

/** The slice of AgentRunner the watcher actually uses — kept narrow for testability. */
export interface WatchableRunner {
  agents(): Map<string, AgentDefinition>;
  runAgent(
    name: string,
    input: { text: string; source?: string; meta?: unknown },
    options: { trigger: "vault" },
  ): Promise<unknown>;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface VaultWatcherConfig {
  runner: WatchableRunner;
  queryNotes: QueryNotes;
  cursorStore?: CursorStore;
  logger?: (msg: string) => void;
  /** Test hooks — default to the global timers. */
  setInterval?: (fn: () => void, ms: number) => IntervalHandle;
  clearInterval?: (h: IntervalHandle) => void;
}

/**
 * Polls the vault on behalf of agents with `trigger.type: "vault"`. One
 * interval per agent, each running at that agent's `poll_seconds`. Cursors
 * advance only after a successful agent run so a failing agent retries
 * next tick instead of silently losing the note.
 */
export class VaultWatcher {
  private readonly handles: IntervalHandle[] = [];
  private running = false;
  private readonly cursorStore: CursorStore;

  constructor(private readonly config: VaultWatcherConfig) {
    this.cursorStore = config.cursorStore ?? new MemoryCursorStore();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const si = this.config.setInterval ?? setInterval;
    for (const agent of this.config.runner.agents().values()) {
      const trigger = agent.frontmatter.trigger;
      if (trigger.type !== "vault") continue;
      const name = agent.frontmatter.name;
      const intervalMs = trigger.poll_seconds * 1000;
      const tick = () => {
        void this.pollOnce(name, trigger);
      };
      this.handles.push(si(tick, intervalMs));
    }
  }

  stop(): void {
    const ci = this.config.clearInterval ?? clearInterval;
    for (const h of this.handles) ci(h);
    this.handles.length = 0;
    this.running = false;
  }

  /**
   * One poll iteration for one agent. Exposed so tests can drive polls
   * deterministically without touching real timers.
   */
  async pollOnce(agentName: string, trigger: VaultTrigger): Promise<number> {
    let fired = 0;
    try {
      const cursor = await this.cursorStore.get(agentName);
      const since = cursor ? Number(cursor) : undefined;
      const notes = await this.config.queryNotes({
        tags: trigger.filter?.tags,
        notTags: trigger.filter?.not_tags,
        since: Number.isFinite(since) ? since : undefined,
        event: trigger.on_event,
      });
      // Fetch newest-first from the vault, but process oldest-first so the
      // cursor advances monotonically — if a later note fails, we don't want
      // earlier notes to be stranded behind a future cursor.
      const pick = (n: VaultNote): number =>
        trigger.on_event === "updated" ? n.updatedAt : n.createdAt;
      // Client-side `> since` guards against vault-side `date_from` being
      // inclusive (which would re-fire the boundary note every poll).
      const filtered = notes.filter((n) => {
        if (since === undefined) return true;
        return pick(n) > since;
      });
      const sorted = [...filtered].sort((a, b) => pick(a) - pick(b));
      for (const note of sorted) {
        try {
          await this.config.runner.runAgent(
            agentName,
            {
              text: JSON.stringify(note),
              source: "vault",
              meta: { noteId: note.id, event: trigger.on_event, tags: note.tags },
            },
            { trigger: "vault" },
          );
          await this.cursorStore.set(agentName, String(pick(note)));
          fired++;
        } catch (err) {
          // Cursor intentionally not advanced — next tick will retry this
          // note. Break so we don't skip past it with later notes.
          this.config.logger?.(
            `vault-watcher: agent ${agentName} failed on note ${note.id}: ${asMessage(err)}`,
          );
          break;
        }
      }
    } catch (err) {
      // Query itself failed — just log and let the next interval retry.
      this.config.logger?.(
        `vault-watcher: poll for ${agentName} failed: ${asMessage(err)}`,
      );
    }
    return fired;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default `queryNotes` implementation that talks to a Parachute Vault via the
 * standard `query-notes` MCP tool. Opens one raw MCP client per poll — cheap
 * at 60s intervals, and keeps us from holding a long-lived socket the DO/host
 * would have to manage. If this ever matters, add client pooling.
 */
export function createVaultQueryFn(vault: VaultConfig): QueryNotes {
  const v = new Vault(vault);
  return async (q) => {
    const client = await v.raw();
    try {
      return await runQuery(client, q);
    } finally {
      await client.close();
    }
  };
}

async function runQuery(client: McpClient, q: VaultQuery): Promise<VaultNote[]> {
  const args: Record<string, unknown> = {
    sort: "desc",
    include_metadata: true,
    include_content: true,
    limit: q.limit ?? 100,
  };
  if (q.tags && q.tags.length > 0) {
    args.tag = q.tags;
    args.tag_match = "all";
  }
  if (q.notTags && q.notTags.length > 0) args.exclude_tags = q.notTags;
  if (q.since !== undefined) args.date_from = new Date(q.since).toISOString();

  const result = (await client.callTool({
    name: "query-notes",
    arguments: args,
  })) as { content?: Array<{ type: string; text?: string }> };

  const text = result.content?.[0]?.text;
  if (!text) return [];
  const parsed = JSON.parse(text) as { notes?: unknown[] } | unknown[];
  const rows = Array.isArray(parsed) ? parsed : (parsed.notes ?? []);
  return rows.map((row) => normalizeNote(row as Record<string, unknown>));
}

function normalizeNote(row: Record<string, unknown>): VaultNote {
  const meta = (row.metadata as Record<string, unknown> | undefined) ?? {};
  const createdRaw = (row.created_at ?? meta.created_at ?? 0) as string | number;
  const updatedRaw = (row.updated_at ?? meta.updated_at ?? createdRaw) as string | number;
  const toMs = (v: string | number): number =>
    typeof v === "number" ? v : new Date(v).getTime();
  return {
    ...row,
    id: String(row.id ?? row.path ?? ""),
    path: String(row.path ?? ""),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    createdAt: toMs(createdRaw),
    updatedAt: toMs(updatedRaw),
  };
}
