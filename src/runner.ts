import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type CoreMessage, type LanguageModel, type Tool } from "ai";
import {
  isMcpToolEntry,
  parseAgents,
  matchesWebhook,
  type AgentDefinition,
  type Backend,
} from "./agents.js";
import { Vault, type VaultConfig } from "./vault.js";
import { createMcpClient, type McpClient } from "./mcp/connector.js";
import { runClaudeBackend, type ClaudeAuth } from "./backends/claude.js";
import {
  MemoryConversationStore,
  appendTurns,
  type ConversationStore,
} from "./conversation-store.js";
import type { Scheduler } from "./scheduler.js";
import type { CursorStore } from "./cursor-store.js";
import {
  VaultWatcher,
  createVaultQueryFn,
  type QueryNotes,
} from "./vault-watcher.js";
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
  /** OpenAI-compatible provider (OpenRouter, together.ai, etc.) for the default model. Optional when every agent uses the Claude backend. */
  provider?: {
    name: string;
    baseURL: string;
    apiKey: string;
  };
  /**
   * Default inference backend. Falls back to `"vercel-ai"`. Per-agent
   * overrides live in the frontmatter as `backend: "claude"`.
   */
  backend?: Backend;
  /** Auth for the Claude backend. Required only when at least one agent resolves to `backend: "claude"`. */
  claudeAuth?: ClaudeAuth;
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
  /**
   * Wire up a vault watcher for agents with `trigger.type: "vault"`. Polling
   * only — push-based firing waits on upstream vault webhooks.
   */
  vaultWatcher?: {
    cursorStore?: CursorStore;
    /** Inject a custom query implementation (tests, or a non-MCP vault transport). Defaults to `createVaultQueryFn(config.vault)`. */
    queryNotes?: QueryNotes;
    /** Defaults to `true` when `scheduler` is set — the host is long-lived. */
    autoStart?: boolean;
    /** Forwarded to the watcher for diagnostics. */
    logger?: (msg: string) => void;
  };
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
   * (pass a `MockLanguageModelV1`) or for runtime tier-switching. Only honored
   * by the Vercel AI backend.
   */
  model?: LanguageModel;
  /** Override the Claude model ID for this call. Only honored by the Claude backend. */
  claudeModel?: string;
  /**
   * Inject a Claude Agent SDK `query()` replacement — for tests that want to
   * avoid spawning the real Claude Code subprocess. Production callers should
   * use `config.claudeAuth` instead.
   */
  claudeQueryFn?: import("./backends/claude.js").ClaudeQueryFn;
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
  private _vaultWatcher: VaultWatcher | null = null;

  constructor(private readonly config: ParachuteAgentConfig) {
    this._agents = parseAgents(config.agents);
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

    const hasVaultTriggers = [...this._agents.values()].some(
      (a) => a.frontmatter.trigger.type === "vault",
    );
    const vwOpts = config.vaultWatcher;
    const wantWatcher = vwOpts !== undefined || hasVaultTriggers;
    if (hasVaultTriggers && wantWatcher) {
      const queryNotes =
        vwOpts?.queryNotes ??
        (config.vault ? createVaultQueryFn(config.vault) : undefined);
      if (!queryNotes) {
        throw new Error(
          "vault-triggered agents require either `config.vault` or `config.vaultWatcher.queryNotes`",
        );
      }
      this._vaultWatcher = new VaultWatcher({
        runner: this,
        queryNotes,
        cursorStore: vwOpts?.cursorStore,
        logger: vwOpts?.logger,
      });
      const autoStart = vwOpts?.autoStart ?? Boolean(config.scheduler);
      if (autoStart) this._vaultWatcher.start();
    }
  }

  /** Returns the internal vault watcher if one was constructed — callers use this to `stop()` on shutdown. */
  vaultWatcher(): VaultWatcher | null {
    return this._vaultWatcher;
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

    const conversationId = options.conversationId;
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    const runTrigger: RunTrigger = options.trigger ?? "manual";
    const historyLimit = options.historyLimit ?? 20;

    const backend: Backend =
      agent.frontmatter.backend ?? this.config.backend ?? "vercel-ai";

    try {
      const history = conversationId
        ? await this._conversationStore.history(conversationId, historyLimit)
        : [];

      const exec =
        backend === "claude"
          ? () => this.runClaudeBackendForAgent(agent, history, text, options)
          : () => this.runVercelAiBackendForAgent(agent, history, text, options);
      const result = await exec();

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
        toolCalls: result.toolCalls,
        error: null,
        trigger: runTrigger,
      });

      return {
        text: result.text,
        agent: agent.frontmatter.name,
        toolCalls: result.toolCalls,
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
    }
  }

  private async runVercelAiBackendForAgent(
    agent: AgentDefinition,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    text: string,
    options: AgentRunOptions,
  ): Promise<{ text: string; toolCalls: number }> {
    if (!options.model && !this.config.provider) {
      throw new Error(
        "vercel-ai backend requires `config.provider`. Set it, pass `options.model`, or use `backend: claude`.",
      );
    }
    const model: LanguageModel =
      options.model ??
      createOpenAICompatible({
        name: this.config.provider!.name,
        baseURL: this.config.provider!.baseURL,
        apiKey: this.config.provider!.apiKey,
      })(agent.frontmatter.model);

    const tools: Record<string, Tool> = { ...(this.config.tools ?? {}) };
    const mcpClients: McpClient[] = [];
    const mcpFactory = this.config.createMcpClient ?? createMcpClient;

    try {
      // Tool setup is inside the try block so that a failure while wiring up
      // MCP clients (e.g. the second factory throws) still closes any clients
      // already created by the finally below.
      const entries = agent.frontmatter.tools;
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
      return { text: result.text, toolCalls: result.toolCalls?.length ?? 0 };
    } finally {
      await Promise.allSettled(mcpClients.map((c) => c.close()));
    }
  }

  private async runClaudeBackendForAgent(
    agent: AgentDefinition,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    text: string,
    options: AgentRunOptions,
  ): Promise<{ text: string; toolCalls: number }> {
    if (!this.config.claudeAuth) {
      throw new Error(
        `agent "${agent.frontmatter.name}" uses backend: claude but config.claudeAuth is unset`,
      );
    }
    return runClaudeBackend({
      auth: this.config.claudeAuth,
      agent,
      model: options.claudeModel,
      system: agent.systemPrompt,
      messages: [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user" as const, content: text },
      ],
      vault: this.config.vault,
      maxSteps: 8,
      queryFn: options.claudeQueryFn,
    });
  }
}
