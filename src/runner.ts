import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type CoreMessage, type LanguageModel, type Tool } from "ai";
import { loadAgents, matchesWebhook, type AgentDefinition } from "./agents.js";
import { Vault, type VaultConfig } from "./vault.js";
import {
  MemoryConversationStore,
  appendTurns,
  type ConversationStore,
} from "./conversation-store.js";

export interface ParachuteAgentConfig {
  /** Map of agent file path → raw markdown contents. Usually wired via wrangler text-loader imports or the filesystem loader. */
  agents: Record<string, string>;
  /** Vault MCP endpoint + token. If omitted, agents cannot use the `vault` tool. */
  vault?: VaultConfig;
  /** OpenAI-compatible provider (OpenRouter, together.ai, etc.) for the default model. */
  provider: {
    name: string;
    baseURL: string;
    apiKey: string;
  };
  /** Extra tools the host wants to expose to agents (e.g. `fetch_url`). */
  tools?: Record<string, Tool>;
  /** Conversation memory backing. Defaults to an in-process {@link MemoryConversationStore}. */
  conversationStore?: ConversationStore;
}

export interface AgentRunInput {
  /** The user-visible text of the incoming message. */
  text?: string;
  /** @deprecated use {@link AgentRunInput.text}. Still accepted for backcompat. */
  user?: string;
  source?: string;
  /** Opaque per-call metadata (sender, channel, platform payload, etc.). */
  meta?: unknown;
  /** @deprecated use {@link AgentRunInput.meta}. Still accepted for backcompat. */
  context?: Record<string, unknown>;
}

export interface AgentRunOptions {
  /** Thread replies by conversation. When set, prior turns are loaded from the store and the user/assistant pair is appended after the response. */
  conversationId?: string;
  /** How many prior turns to include. Defaults to 20. */
  historyLimit?: number;
  /**
   * Override the agent's configured model for this call. Useful for testing
   * (pass a `MockLanguageModelV1`) or for runtime tier-switching.
   */
  model?: LanguageModel;
}

export interface AgentRunResult {
  text: string;
  agent: string;
  toolCalls: number;
}

function resolveText(input: AgentRunInput): string {
  if (typeof input.text === "string") return input.text;
  if (typeof input.user === "string") return input.user;
  throw new Error("AgentRunInput requires `text` (or legacy `user`)");
}

/**
 * Stateless runner: loads agent definitions, matches triggers, runs the AI SDK loop.
 * Runtime-agnostic — works in CF Workers, Bun, Node, any JS runtime with `fetch`.
 *
 * For the Cloudflare Durable Object wrapper, see `@openparachute/agents/cloudflare`.
 */
function wildcardRank(agent: AgentDefinition): number {
  const t = agent.frontmatter.trigger;
  return t.type === "webhook" && t.match === "always" ? 1 : 0;
}

export class AgentRunner {
  private _agents: Map<string, AgentDefinition>;
  /** Agents in webhook-match priority order: specific matchers before `match: always` catch-alls. */
  private _webhookOrder: AgentDefinition[];
  private _conversationStore: ConversationStore;

  constructor(private readonly config: ParachuteAgentConfig) {
    this._agents = loadAgents(config.agents);
    this._webhookOrder = [...this._agents.values()].sort((a, b) => {
      // Catch-alls (webhook trigger with match: always) run last so specific
      // matchers like `contains_url` claim their messages first. Array.sort is
      // stable in modern JS, so same-tier agents keep their load order.
      return wildcardRank(a) - wildcardRank(b);
    });
    this._conversationStore = config.conversationStore ?? new MemoryConversationStore();
  }

  agents(): Map<string, AgentDefinition> {
    return this._agents;
  }

  conversationStore(): ConversationStore {
    return this._conversationStore;
  }

  /** First matching agent in load order wins; within the same priority tier, load order decides. `match: always` agents are ranked last so specific matchers claim their messages first. */
  matchWebhook(payload: { text?: string; source?: string }): AgentDefinition | undefined {
    for (const agent of this._webhookOrder) {
      if (matchesWebhook(agent, payload)) return agent;
    }
    return undefined;
  }

  async runAgent(
    name: string,
    input: AgentRunInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const agent = this._agents.get(name);
    if (!agent) throw new Error(`unknown agent: ${name}`);
    const text = resolveText(input);

    const model: LanguageModel =
      options.model ??
      createOpenAICompatible({
        name: this.config.provider.name,
        baseURL: this.config.provider.baseURL,
        apiKey: this.config.provider.apiKey,
      })(agent.frontmatter.model);

    const tools: Record<string, Tool> = { ...(this.config.tools ?? {}) };
    if (agent.frontmatter.tools.includes("vault") && this.config.vault) {
      Object.assign(tools, await new Vault(this.config.vault).tools());
    }

    const conversationId = options.conversationId;
    const historyLimit = options.historyLimit ?? 20;
    const history = conversationId
      ? await this._conversationStore.history(conversationId, historyLimit)
      : [];

    const userTs = Date.now();
    const messages: CoreMessage[] = [
      ...history.map((t) => ({ role: t.role, content: t.content }) as CoreMessage),
      { role: "user", content: text },
    ];

    const result = await generateText({
      model,
      system: agent.systemPrompt,
      messages,
      tools,
      maxSteps: 8,
    });

    if (conversationId) {
      await appendTurns(this._conversationStore, conversationId, [
        { role: "user", content: text, ts: userTs },
        { role: "assistant", content: result.text, ts: Date.now() },
      ]);
    }

    return {
      text: result.text,
      agent: agent.frontmatter.name,
      toolCalls: result.toolCalls?.length ?? 0,
    };
  }
}
