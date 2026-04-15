import Anthropic from "@anthropic-ai/sdk";
import { Client as RawMcpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isMcpToolEntry, type AgentDefinition } from "../agents.js";
import type { VaultConfig } from "../vault.js";
import { resolveAuthHeader, type FetchLike } from "../mcp/connector.js";

/**
 * Auth bundle for the Claude Messages API.
 *
 * `apiKey` is the standard path for Anthropic-direct usage. `oauthToken` is the
 * access-token path (Claude Max, enterprise proxies); the SDK accepts it via
 * `authToken`. `baseURL` lets you point at a proxy or fork.
 *
 * TODO: OAuth-token reuse from Claude Code's keychain is a future exploration.
 * Today, pass `oauthToken` explicitly. Token rotation, expiry, and T&Cs around
 * reuse need to be resolved upstream before the framework touches the keychain.
 */
export interface ClaudeAuth {
  apiKey?: string;
  oauthToken?: string;
  baseURL?: string;
}

export interface ClaudeBackendToolOptions {
  vault?: VaultConfig;
  /** Test hook — replace the raw MCP client factory. */
  createRawMcp?: (url: string, authHeader: string) => Promise<RawMcpClient>;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export interface ClaudeBackendRunArgs {
  auth: ClaudeAuth;
  agent: AgentDefinition;
  /** Model ID to hit. Falls back to `agent.frontmatter.model`. */
  model?: string;
  system: string;
  /** Turn history from the conversation store, user last. Role-content pairs. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Max agent-loop iterations. Matches the Vercel path's `maxSteps`. */
  maxSteps: number;
  /** Max completion tokens per request. Defaults to 4096. */
  maxTokens?: number;
  /** Tool bundle to expose to Claude. Owner is responsible for closing MCP connections. */
  tools: ClaudeTool[];
  /** Test hook — inject a pre-built Anthropic client. */
  client?: Anthropic;
}

export interface ClaudeBackendRunResult {
  text: string;
  toolCalls: number;
}

/**
 * Claude-flavored tool definition. Shaped for `anthropic.messages.create` but
 * carries an `execute` hook so the backend can run the tool-use loop itself.
 */
export interface ClaudeTool {
  name: string;
  description: string | undefined;
  input_schema: Record<string, unknown>;
  execute: (args: unknown) => Promise<string>;
}

/** Keep cleanup of raw MCP clients symmetrical with how the Vercel path treats Vercel tools. */
export interface ClaudeToolBundle {
  tools: ClaudeTool[];
  close: () => Promise<void>;
}

/**
 * Build the Claude-flavored tool bundle for an agent. Opens raw MCP clients
 * for each `mcp:` tool entry + the built-in vault, then projects each MCP
 * tool into `ClaudeTool`. Owner MUST call `bundle.close()` once the run is
 * done (success or failure) to release the sockets.
 */
export async function buildClaudeTools(
  agent: AgentDefinition,
  options: ClaudeBackendToolOptions = {},
): Promise<ClaudeToolBundle> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const createRaw =
    options.createRawMcp ??
    (async (url: string, authHeader: string) => {
      const client = new RawMcpClient({ name: "parachute-agents", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: authHeader } },
      });
      await client.connect(transport);
      return client;
    });

  const clients: RawMcpClient[] = [];
  const tools: ClaudeTool[] = [];

  try {
    for (const entry of agent.frontmatter.tools) {
      if (entry === "vault") {
        if (!options.vault) continue;
        const client = await createRaw(
          options.vault.url,
          `Bearer ${options.vault.token}`,
        );
        clients.push(client);
        tools.push(...(await projectMcpTools(client)));
        continue;
      }
      if (isMcpToolEntry(entry)) {
        const authHeader = await resolveAuthHeader(entry.mcp, env, fetchImpl);
        const client = await createRaw(entry.mcp.url, authHeader);
        clients.push(client);
        tools.push(...(await projectMcpTools(client)));
        continue;
      }
      // Unknown string-form tool (e.g. `fetch_url`) isn't wired through Claude
      // in v1 — the Vercel path has host-supplied tools via `config.tools`,
      // which this backend doesn't see. Surface a clear error on use so we
      // don't silently drop tool access.
    }
    return {
      tools,
      close: async () => {
        await Promise.allSettled(clients.map((c) => c.close()));
      },
    };
  } catch (err) {
    await Promise.allSettled(clients.map((c) => c.close()));
    throw err;
  }
}

async function projectMcpTools(client: RawMcpClient): Promise<ClaudeTool[]> {
  const list = await client.listTools();
  return list.tools.map((t) => ({
    name: t.name,
    description: t.description,
    // MCP's `inputSchema` is already JSON-schema — exactly what Anthropic wants.
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    execute: async (args: unknown) => {
      const result = await client.callTool({
        name: t.name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      // MCP tool results are `{content: [{type: "text", text: "..."}, ...]}`.
      // Flatten to a string so Anthropic can consume it as `tool_result` content.
      const parts = Array.isArray(result.content) ? result.content : [];
      const texts = parts
        .map((p) => {
          if (p && typeof p === "object" && "text" in p && typeof p.text === "string") return p.text;
          return JSON.stringify(p);
        })
        .filter((s) => s.length > 0);
      return texts.join("\n");
    },
  }));
}

/** Instantiate the Anthropic client from an auth bundle. */
export function buildAnthropicClient(auth: ClaudeAuth): Anthropic {
  const init: ConstructorParameters<typeof Anthropic>[0] = {};
  if (auth.apiKey) init.apiKey = auth.apiKey;
  if (auth.oauthToken) init.authToken = auth.oauthToken;
  if (auth.baseURL) init.baseURL = auth.baseURL;
  return new Anthropic(init);
}

/**
 * Run the Claude backend's tool-use loop. Stops on `end_turn`, exhausted
 * `max_tokens`, or after `maxSteps` iterations. Matches the Vercel path's
 * return contract: final assistant text + number of tool calls executed.
 */
export async function runClaudeBackend(
  args: ClaudeBackendRunArgs,
): Promise<ClaudeBackendRunResult> {
  const client = args.client ?? buildAnthropicClient(args.auth);
  const model = args.model ?? args.agent.frontmatter.model;
  const maxTokens = args.maxTokens ?? 4096;

  type Turn = Anthropic.MessageParam;
  // Conversation history starts as plain role/content turns. After the first
  // model response, we append the assistant's content blocks directly (so
  // tool_use IDs are preserved) and feed tool_result blocks back as user turns.
  const turns: Turn[] = args.messages.map((m) => ({ role: m.role, content: m.content }));

  let toolCalls = 0;
  let finalText = "";

  for (let step = 0; step < args.maxSteps; step++) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: args.system,
      messages: turns,
      tools: args.tools.length
        ? args.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool["input_schema"],
          }))
        : undefined,
    });

    // Always record the full assistant turn so tool_use IDs survive for the next turn.
    turns.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("\n").trim();
    }

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: finalText, toolCalls };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls++;
      const tool = args.tools.find((t) => t.name === use.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `No tool named "${use.name}" is available.`,
        });
        continue;
      }
      try {
        const out = await tool.execute(use.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: out,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: err instanceof Error ? err.message : String(err),
        });
      }
    }
    turns.push({ role: "user", content: toolResults });
  }

  // Hit maxSteps without a clean stop — return whatever final text we saw.
  return { text: finalText, toolCalls };
}
