import {
  query as defaultQuery,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isMcpToolEntry, type AgentDefinition } from "../agents.js";
import type { VaultConfig } from "../vault.js";
import { resolveAuthHeader, type FetchLike } from "../mcp/connector.js";

/**
 * Auth bundle for the Claude Agent SDK backend.
 *
 * The SDK does not accept auth as function arguments — it reads environment
 * variables from the Claude Code process it spawns. We bridge our structured
 * `ClaudeAuth` into the SDK's `options.env`:
 *
 * - `apiKey` → `ANTHROPIC_API_KEY` (standard direct-API path)
 * - `oauthToken` → `CLAUDE_CODE_OAUTH_TOKEN` (Claude Max subscription path —
 *   authenticates as the subscription user, reusing the same token type the
 *   `claude` CLI stores after login)
 * - `baseURL` → `ANTHROPIC_BASE_URL` (proxy / fork override)
 *
 * Pass whichever fits the deployment; the SDK picks up the set vars. At least
 * one of `apiKey` or `oauthToken` must be supplied.
 *
 * TODO: reuse the OAuth token from Claude Code's keychain instead of requiring
 * the caller to extract it. Deferred until rotation + T&Cs are settled.
 */
export interface ClaudeAuth {
  apiKey?: string;
  oauthToken?: string;
  baseURL?: string;
}

/** Subset of the SDK's `query()` signature we depend on. Injectable for tests. */
export type ClaudeQueryFn = (args: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeBackendRunArgs {
  auth: ClaudeAuth;
  agent: AgentDefinition;
  /** Model ID. Falls back to `agent.frontmatter.model`. */
  model?: string;
  /** System prompt (usually the agent body). */
  system: string;
  /** Turn history, user last. History is folded into the SDK prompt as a transcript. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Cap on agent-loop iterations. Maps to SDK `maxTurns`. */
  maxSteps: number;
  /** Vault config; if set, exposed as an http MCP server named `vault`. */
  vault?: VaultConfig;
  /** Env for resolving per-agent MCP `token_env` bearer auth. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** fetch override, forwarded into OAuth token-exchange for MCP entries. */
  fetch?: FetchLike;
  /** Test hook — replace the SDK `query()` function. */
  queryFn?: ClaudeQueryFn;
}

export interface ClaudeBackendRunResult {
  text: string;
  toolCalls: number;
}

/**
 * Run the Claude Agent SDK loop. The SDK owns its own tool-use + MCP wiring,
 * so this backend is purely a config-adapter: project our auth + MCP entries
 * into `Options`, stream messages, extract the final text + tool-call count.
 */
export async function runClaudeBackend(
  args: ClaudeBackendRunArgs,
): Promise<ClaudeBackendRunResult> {
  const q = args.queryFn ?? (defaultQuery as unknown as ClaudeQueryFn);

  if (!args.auth.apiKey && !args.auth.oauthToken) {
    throw new Error("claude backend: auth requires `apiKey` or `oauthToken`");
  }

  const env = { ...(args.env ?? process.env) } as Record<string, string | undefined>;
  if (args.auth.apiKey) env.ANTHROPIC_API_KEY = args.auth.apiKey;
  if (args.auth.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = args.auth.oauthToken;
  if (args.auth.baseURL) env.ANTHROPIC_BASE_URL = args.auth.baseURL;

  const mcpServers = await buildMcpServers(args);

  const options: Options = {
    systemPrompt: args.system,
    model: args.model ?? args.agent.frontmatter.model,
    maxTurns: args.maxSteps,
    // Disable Claude Code built-ins (Read/Write/Bash/...). Only the MCP servers
    // we wire up below are available to the model.
    tools: [],
    mcpServers,
    env,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };

  const prompt = foldHistory(args.messages);

  let finalText = "";
  let toolCalls = 0;

  for await (const msg of q({ prompt, options })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content as Array<{ type: string }>) {
        if (block.type === "tool_use") toolCalls++;
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = msg.result;
      } else {
        throw new Error(
          `claude backend: query ended with ${msg.subtype}${
            msg.errors?.length ? ` — ${msg.errors.join("; ")}` : ""
          }`,
        );
      }
    }
  }

  return { text: finalText, toolCalls };
}

/**
 * Build the MCP server map the SDK expects. `vault` resolves to the framework's
 * configured Parachute Vault; each `mcp:` entry in the agent frontmatter becomes
 * an http MCP server with its bearer/OAuth header attached.
 */
async function buildMcpServers(
  args: ClaudeBackendRunArgs,
): Promise<Record<string, McpServerConfig>> {
  const env = args.env ?? process.env;
  const fetchImpl = args.fetch ?? fetch;
  const servers: Record<string, McpServerConfig> = {};

  const wantsVault = args.agent.frontmatter.tools.some((e) => e === "vault");
  if (wantsVault && args.vault) {
    servers.vault = {
      type: "http",
      url: args.vault.url,
      headers: args.vault.token ? { Authorization: `Bearer ${args.vault.token}` } : {},
    };
  }

  for (const entry of args.agent.frontmatter.tools) {
    if (!isMcpToolEntry(entry)) continue;
    const authHeader = await resolveAuthHeader(entry.mcp, env, fetchImpl);
    servers[entry.mcp.name] = {
      type: "http",
      url: entry.mcp.url,
      headers: authHeader ? { Authorization: authHeader } : {},
    };
  }

  return servers;
}

/** Fold prior turns into a single SDK prompt. Latest user turn stands alone when there's no history. */
function foldHistory(messages: Array<{ role: "user" | "assistant"; content: string }>): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0]!.content;
  const prior = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  const transcript = prior
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  return `Prior conversation:\n${transcript}\n\nCurrent message:\n${last.content}`;
}
