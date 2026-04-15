import { Database } from "bun:sqlite";
import type { CursorStore } from "./cursor-store.js";

/**
 * SQLite-backed cursor store. One row per agent. Bun-only — keep behind the
 * `@openparachute/agent/cursor-store-sqlite` subpath so the base entry stays
 * Workers-safe.
 */
export class SqliteCursorStore implements CursorStore {
  private readonly db: Database;

  constructor(path = "./.agents/cursors.db") {
    this.db = new Database(path, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        agent_name TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async get(agentName: string): Promise<string | null> {
    const row = this.db
      .query<{ cursor: string }, [string]>(
        "SELECT cursor FROM cursors WHERE agent_name = ?",
      )
      .get(agentName);
    return row ? row.cursor : null;
  }

  async set(agentName: string, cursor: string): Promise<void> {
    this.db
      .query(
        "INSERT INTO cursors (agent_name, cursor, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(agent_name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
      )
      .run(agentName, cursor, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
