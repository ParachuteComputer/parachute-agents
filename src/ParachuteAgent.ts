import { Agent } from "agents";
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
 * Usable inside a Durable Object (via {@link ParachuteAgent}) or standalone.
 */
export class AgentRunner {
  private _agents: Map<string, AgentDefinition>;

  constructor(private readonly config: ParachuteAgentConfig) {
    this._agents = loadAgents(config.agents);
  }

  agents(): Map<string, AgentDefinition> {
    return this._agents;
  }

  matchWebhook(payload: { text?: string; source?: string }): AgentDefinition | undefined {
    for (const agent of this._agents.values()) {
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

/**
 * Base class for a stateful Parachute agent running as a Cloudflare Durable Object.
 * Extend in your Worker, override {@link configure}, register in wrangler.toml.
 *
 * For stateless use (no per-agent SQLite, no hibernation), use {@link AgentRunner} directly.
 */
export class ParachuteAgent<Env = unknown, State = Record<string, unknown>> extends Agent<
  Env,
  State
> {
  private _runner?: AgentRunner;

  configure(): ParachuteAgentConfig {
    throw new Error("ParachuteAgent: override configure() in your subclass");
  }

  protected runner(): AgentRunner {
    if (!this._runner) this._runner = new AgentRunner(this.configure());
    return this._runner;
  }

  matchWebhook(payload: { text?: string; source?: string }) {
    return this.runner().matchWebhook(payload);
  }

  runAgent(name: string, input: AgentRunInput) {
    return this.runner().runAgent(name, input);
  }
}
