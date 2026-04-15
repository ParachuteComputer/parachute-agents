export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface ConversationStore {
  append(conversationId: string, turn: ConversationTurn): Promise<void>;
  /** Returns the most recent N turns, oldest first. */
  history(conversationId: string, limit: number): Promise<ConversationTurn[]>;
  clear(conversationId: string): Promise<void>;
}

export class MemoryConversationStore implements ConversationStore {
  private readonly turns = new Map<string, ConversationTurn[]>();

  async append(conversationId: string, turn: ConversationTurn): Promise<void> {
    const existing = this.turns.get(conversationId) ?? [];
    existing.push(turn);
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
