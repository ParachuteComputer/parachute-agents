import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type Tool } from "ai";
import { loadAgents, matchesWebhook, type AgentDefinition } from "./agents.js";
import { Vault, type VaultConfig } from "./vault.js";

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
}

export interface AgentRunInput {
  user: string;
  context?: Record<string, unknown>;
}

export interface AgentRunResult {
  text: string;
  agent: string;
  toolCalls: number;
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

  constructor(private readonly config: ParachuteAgentConfig) {
    this._agents = loadAgents(config.agents);
    this._webhookOrder = [...this._agents.values()].sort((a, b) => {
      // Catch-alls (webhook trigger with match: always) run last so specific
      // matchers like `contains_url` claim their messages first. Array.sort is
      // stable in modern JS, so same-tier agents keep their load order.
      return wildcardRank(a) - wildcardRank(b);
    });
  }

  agents(): Map<string, AgentDefinition> {
    return this._agents;
  }

  matchWebhook(payload: { text?: string; source?: string }): AgentDefinition | undefined {
    for (const agent of this._webhookOrder) {
      if (matchesWebhook(agent, payload)) return agent;
    }
    return undefined;
  }

  async runAgent(name: string, input: AgentRunInput): Promise<AgentRunResult> {
    const agent = this._agents.get(name);
    if (!agent) throw new Error(`unknown agent: ${name}`);

    const provider = createOpenAICompatible({
      name: this.config.provider.name,
      baseURL: this.config.provider.baseURL,
      apiKey: this.config.provider.apiKey,
    });
    const model: LanguageModel = provider(agent.frontmatter.model);

    const tools: Record<string, Tool> = { ...(this.config.tools ?? {}) };
    if (agent.frontmatter.tools.includes("vault") && this.config.vault) {
      Object.assign(tools, await new Vault(this.config.vault).tools());
    }

    const result = await generateText({
      model,
      system: agent.systemPrompt,
      prompt: input.user,
      tools,
      maxSteps: 8,
    });

    return {
      text: result.text,
      agent: agent.frontmatter.name,
      toolCalls: result.toolCalls?.length ?? 0,
    };
  }
}
