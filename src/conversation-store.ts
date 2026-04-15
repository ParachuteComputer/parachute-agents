export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface ConversationStore {
  append(conversationId: string, turn: ConversationTurn): Promise<void>;
  /**
   * Append multiple turns atomically when the store supports it. Default
   * implementations may loop {@link append}; storage-backed implementations
   * should use a transaction so a partial failure doesn't leave an orphan
   * user turn in history.
   */
  appendBatch?(conversationId: string, turns: ConversationTurn[]): Promise<void>;
  /** Returns the most recent N turns, oldest first. */
  history(conversationId: string, limit: number): Promise<ConversationTurn[]>;
  clear(conversationId: string): Promise<void>;
  /** Optional: release underlying resources (file handles, connections). */
  close?(): void | Promise<void>;
}

/**
 * Convenience wrapper: calls {@link ConversationStore.appendBatch} if
 * available, otherwise falls back to sequential {@link ConversationStore.append}
 * calls. Exported so the runner doesn't duplicate the branch.
 */
export async function appendTurns(
  store: ConversationStore,
  conversationId: string,
  turns: ConversationTurn[],
): Promise<void> {
  if (store.appendBatch) {
    await store.appendBatch(conversationId, turns);
    return;
  }
  for (const turn of turns) await store.append(conversationId, turn);
}

export class MemoryConversationStore implements ConversationStore {
  private readonly turns = new Map<string, ConversationTurn[]>();

  async append(conversationId: string, turn: ConversationTurn): Promise<void> {
    const existing = this.turns.get(conversationId) ?? [];
    existing.push(turn);
    this.turns.set(conversationId, existing);
  }

  async appendBatch(conversationId: string, turns: ConversationTurn[]): Promise<void> {
    const existing = this.turns.get(conversationId) ?? [];
    existing.push(...turns);
    this.turns.set(conversationId, existing);
  }

  async history(conversationId: string, limit: number): Promise<ConversationTurn[]> {
    const all = this.turns.get(conversationId) ?? [];
    return limit >= all.length ? [...all] : all.slice(all.length - limit);
  }

  async clear(conversationId: string): Promise<void> {
    this.turns.delete(conversationId);
  }
}
