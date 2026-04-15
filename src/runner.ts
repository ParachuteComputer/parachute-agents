import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type CoreMessage, type LanguageModel, type Tool } from "ai";
import {
  isMcpToolEntry,
  loadAgents,
  matchesWebhook,
  type AgentDefinition,
} from "./agents.js";
import { Vault, type VaultConfig } from "./vault.js";
import { createMcpClient, type McpClient } from "./mcp/connector.js";
import {
  MemoryConversationStore,
  appendTurns,
  type ConversationStore,
} from "./conversation-store.js";
import type { Scheduler } from "./scheduler.js";
import {
  MemoryRunLog,
  type AgentRun,
  type RunLog,
  type RunLogListOptions,
  type RunTrigger,
} from "./run-log.js";

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
  /** If set, agents with `trigger.type: cron` auto-register on construction. */
  scheduler?: Scheduler;
  /** Run log for observability. Defaults to an in-process {@link MemoryRunLog}. */
  runLog?: RunLog;
  /** Test hook: override the MCP client factory so tests don't open real sockets. */
  createMcpClient?: typeof createMcpClient;
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
  /** What invoked this run. Defaults to `"manual"` — webhook/cron paths stamp the appropriate value. */
  trigger?: RunTrigger;
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
 * For the Cloudflare Durable Object wrapper, see `@openparachute/agent/cloudflare`.
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
  private _runLog: RunLog;

  constructor(private readonly config: ParachuteAgentConfig) {
    this._agents = loadAgents(config.agents);
    this._webhookOrder = [...this._agents.values()].sort((a, b) => {
      // Catch-alls (webhook trigger with match: always) run last so specific
      // matchers like `contains_url` claim their messages first. Array.sort is
      // stable in modern JS, so same-tier agents keep their load order.
      return wildcardRank(a) - wildcardRank(b);
    });
    this._conversationStore = config.conversationStore ?? new MemoryConversationStore();
    this._runLog = config.runLog ?? new MemoryRunLog();

    if (config.scheduler) {
      for (const agent of this._agents.values()) {
        const trigger = agent.frontmatter.trigger;
        if (trigger.type !== "cron") continue;
        const name = agent.frontmatter.name;
        config.scheduler.schedule(name, trigger.schedule, async () => {
          await this.runAgent(name, { text: "" }, { trigger: "cron" });
        });
      }
    }
  }

  agents(): Map<string, AgentDefinition> {
    return this._agents;
  }

  conversationStore(): ConversationStore {
    return this._conversationStore;
  }

  runLog(): RunLog {
    return this._runLog;
  }

  runs(opts: RunLogListOptions = {}): Promise<AgentRun[]> {
    return this._runLog.list(opts);
  }

  run(id: string): Promise<AgentRun | null> {
    return this._runLog.get(id);
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
    const mcpClients: McpClient[] = [];
    const mcpFactory = this.config.createMcpClient ?? createMcpClient;
    const entries = agent.frontmatter.tools;

    const conversationId = options.conversationId;
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    const runTrigger: RunTrigger = options.trigger ?? "manual";

    try {
      // Tool setup is inside the try block so that a failure while wiring up
      // MCP clients (e.g. the second factory throws) still closes any clients
      // already created by the finally below and still records a failed run.
      const wantsVault = entries.some((e) => e === "vault");
      if (wantsVault && this.config.vault) {
        Object.assign(tools, await new Vault(this.config.vault).tools());
      }
      for (const entry of entries) {
        if (!isMcpToolEntry(entry)) continue;
        const client = await mcpFactory(entry.mcp);
        mcpClients.push(client);
        Object.assign(tools, await client.tools());
      }

      const historyLimit = options.historyLimit ?? 20;
      const history = conversationId
        ? await this._conversationStore.history(conversationId, historyLimit)
        : [];

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
          { role: "user", content: text, ts: startedAt },
          { role: "assistant", content: result.text, ts: Date.now() },
        ]);
      }

      const endedAt = Date.now();
      await this._runLog.record({
        id: runId,
        agentName: agent.frontmatter.name,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        input: { text, source: input.source, conversationId },
        output: result.text,
        toolCalls: result.toolCalls?.length ?? 0,
        error: null,
        trigger: runTrigger,
      });

      return {
        text: result.text,
        agent: agent.frontmatter.name,
        toolCalls: result.toolCalls?.length ?? 0,
      };
    } catch (err) {
      const endedAt = Date.now();
      await this._runLog.record({
        id: runId,
        agentName: agent.frontmatter.name,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        input: { text, source: input.source, conversationId },
        output: null,
        toolCalls: 0,
        error: err instanceof Error ? err.message : String(err),
        trigger: runTrigger,
      });
      throw err;
    } finally {
      await Promise.allSettled(mcpClients.map((c) => c.close()));
    }
  }
}
