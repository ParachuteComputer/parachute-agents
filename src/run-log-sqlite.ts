import { Database } from "bun:sqlite";
import type {
  AgentRun,
  RunLog,
  RunLogClearOptions,
  RunLogListOptions,
  RunTrigger,
} from "./run-log.js";

/**
 * Bun-only run log backed by a single SQLite file. Mirror of
 * `SqliteConversationStore` — kept behind a subpath export so CF bundles
 * never touch `bun:sqlite`.
 */
interface Row {
  id: string;
  agent: string;
  started_at: number;
  ended_at: number;
  input_json: string;
  output: string | null;
  tool_calls: number;
  error: string | null;
  trigger: RunTrigger;
}

export class SqliteRunLog implements RunLog {
  private readonly db: Database;

  /**
   * @param path SQLite file. Default `./.agents/runs.db` resolves relative
   *   to `process.cwd()`; pin absolute if you want predictable placement.
   */
  constructor(path = "./.agents/runs.db") {
    this.db = new Database(path, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        output TEXT,
        tool_calls INTEGER NOT NULL,
        error TEXT,
        trigger TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_agent_started ON runs(agent, started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
    `);
  }

  async record(run: AgentRun): Promise<void> {
    this.db
      .query(
        "INSERT INTO runs (id, agent, started_at, ended_at, input_json, output, tool_calls, error, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.agentName,
        run.startedAt,
        run.endedAt,
        JSON.stringify(run.input),
        run.output,
        run.toolCalls,
        run.error,
        run.trigger,
      );
  }

  async list(opts: RunLogListOptions): Promise<AgentRun[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.agent !== undefined) {
      clauses.push("agent = ?");
      params.push(opts.agent);
    }
    if (opts.since !== undefined) {
      clauses.push("started_at >= ?");
      params.push(opts.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitSql = opts.limit !== undefined ? "LIMIT ?" : "";
    if (opts.limit !== undefined) params.push(opts.limit);
    const rows = this.db
      .query<Row, Array<string | number>>(
        `SELECT id, agent, started_at, ended_at, input_json, output, tool_calls, error, trigger FROM runs ${where} ORDER BY started_at DESC ${limitSql}`,
      )
      .all(...params);
    return rows.map(rowToRun);
  }

  async get(id: string): Promise<AgentRun | null> {
    const row = this.db
      .query<Row, [string]>(
        "SELECT id, agent, started_at, ended_at, input_json, output, tool_calls, error, trigger FROM runs WHERE id = ?",
      )
      .get(id);
    return row ? rowToRun(row) : null;
  }

  async clear(opts: RunLogClearOptions = {}): Promise<number> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.agent !== undefined) {
      clauses.push("agent = ?");
      params.push(opts.agent);
    }
    if (opts.before !== undefined) {
      clauses.push("started_at < ?");
      params.push(opts.before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = this.db
      .query<unknown, Array<string | number>>(`DELETE FROM runs ${where}`)
      .run(...params);
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRun(row: Row): AgentRun {
  return {
    id: row.id,
    agentName: row.agent,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.ended_at - row.started_at,
    input: JSON.parse(row.input_json),
    output: row.output,
    toolCalls: row.tool_calls,
    error: row.error,
    trigger: row.trigger,
  };
}
