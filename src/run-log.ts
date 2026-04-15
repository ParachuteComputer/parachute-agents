export type RunTrigger = "webhook" | "cron" | "vault" | "manual";

export interface AgentRun {
  id: string;
  agentName: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  input: { text: string; source?: string; conversationId?: string };
  /** Assistant text on success; `null` if the run errored. */
  output: string | null;
  toolCalls: number;
  /** Error message on failure; `null` on success. */
  error: string | null;
  trigger: RunTrigger;
}

export interface RunLogListOptions {
  agent?: string;
  limit?: number;
  since?: number;
}

export interface RunLogClearOptions {
  agent?: string;
  before?: number;
}

export interface RunLog {
  record(run: AgentRun): Promise<void>;
  /** Newest first. */
  list(opts: RunLogListOptions): Promise<AgentRun[]>;
  get(id: string): Promise<AgentRun | null>;
  /** Returns the number of rows removed. */
  clear(opts?: RunLogClearOptions): Promise<number>;
  close?(): void | Promise<void>;
}

/**
 * In-process run log with a per-agent cap. When `capPerAgent` is exceeded the
 * oldest runs for that agent are dropped. Use {@link SqliteRunLog} when you
 * want persistence across restarts.
 */
export class MemoryRunLog implements RunLog {
  private readonly runs: AgentRun[] = [];
  private readonly capPerAgent: number;

  constructor(options: { capPerAgent?: number } = {}) {
    this.capPerAgent = options.capPerAgent ?? 1000;
  }

  async record(run: AgentRun): Promise<void> {
    this.runs.push(run);
    // Trim only this agent's runs down to the cap, preserving others.
    let count = 0;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (this.runs[i]!.agentName === run.agentName) count++;
    }
    if (count <= this.capPerAgent) return;
    let toDrop = count - this.capPerAgent;
    for (let i = 0; i < this.runs.length && toDrop > 0; ) {
      if (this.runs[i]!.agentName === run.agentName) {
        this.runs.splice(i, 1);
        toDrop--;
      } else {
        i++;
      }
    }
  }

  async list(opts: RunLogListOptions): Promise<AgentRun[]> {
    let filtered = this.runs;
    if (opts.agent) filtered = filtered.filter((r) => r.agentName === opts.agent);
    if (opts.since !== undefined) {
      const since = opts.since;
      filtered = filtered.filter((r) => r.startedAt >= since);
    }
    const sorted = [...filtered].sort((a, b) => b.startedAt - a.startedAt);
    return opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;
  }

  async get(id: string): Promise<AgentRun | null> {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  async clear(opts: RunLogClearOptions = {}): Promise<number> {
    const before = this.runs.length;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i]!;
      if (opts.agent && r.agentName !== opts.agent) continue;
      if (opts.before !== undefined && r.startedAt >= opts.before) continue;
      this.runs.splice(i, 1);
    }
    return before - this.runs.length;
  }
}
