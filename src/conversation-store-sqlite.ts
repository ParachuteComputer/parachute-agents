import { Database } from "bun:sqlite";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";

/**
 * Bun-only conversation store backed by a single SQLite file. Not importable
 * from Cloudflare Workers — CF backing will land in a separate entry point.
 */
export class SqliteConversationStore implements ConversationStore {
  private readonly db: Database;

  /**
   * @param path SQLite file to open. Default `./.agents/conversations.db`
   *   resolves relative to `process.cwd()`, not the package root — pin it to
   *   an absolute path if you want predictable placement across invocations.
   */
  constructor(path = "./.agents/conversations.db") {
    this.db = new Database(path, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        conversation_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_conv_ts ON turns(conversation_id, ts);
    `);
  }

  async append(conversationId: string, turn: ConversationTurn): Promise<void> {
    this.db
      .query("INSERT INTO turns (conversation_id, ts, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, turn.ts, turn.role, turn.content);
  }

  async appendBatch(conversationId: string, turns: ConversationTurn[]): Promise<void> {
    const insert = this.db.query(
      "INSERT INTO turns (conversation_id, ts, role, content) VALUES (?, ?, ?, ?)",
    );
    const tx = this.db.transaction((rows: ConversationTurn[]) => {
      for (const t of rows) insert.run(conversationId, t.ts, t.role, t.content);
    });
    tx(turns);
  }

  async history(conversationId: string, limit: number): Promise<ConversationTurn[]> {
    const rows = this.db
      .query<
        { ts: number; role: "user" | "assistant"; content: string },
        [string, number]
      >(
        "SELECT ts, role, content FROM turns WHERE conversation_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
      )
      .all(conversationId, limit);
    return rows.reverse().map((r) => ({ role: r.role, content: r.content, ts: r.ts }));
  }

  async clear(conversationId: string): Promise<void> {
    this.db.query("DELETE FROM turns WHERE conversation_id = ?").run(conversationId);
  }

  close(): void {
    this.db.close();
  }
}
