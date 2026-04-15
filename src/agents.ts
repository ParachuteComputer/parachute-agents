import matter from "gray-matter";
import { z } from "zod";

const webhookTrigger = z.object({
  type: z.literal("webhook"),
  source: z.enum(["discord", "slack", "telegram", "http", "any"]).default("http"),
  match: z.string().default("always"),
});

const cronTrigger = z.object({
  type: z.literal("cron"),
  schedule: z.string(),
});

const vaultTrigger = z.object({
  type: z.literal("vault"),
  on_event: z.enum(["created", "updated"]).default("created"),
  filter: z
    .object({
      tags: z.array(z.string()).optional(),
      not_tags: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Polling interval in seconds. Push-based firing is future work — it needs
   * vault webhooks, which aren't upstream yet. Min 10s to keep poll storms
   * off the vault while still feeling responsive.
   */
  poll_seconds: z.number().int().min(10).default(60),
});

const manualTrigger = z.object({ type: z.literal("manual") });

/**
 * MCP auth — `bearer` reads a static token (inline or from env); `oauth` runs
 * the RFC 6749 client_credentials grant and caches the returned access token.
 * Deliberately minimal — PKCE / authorization_code / refresh_token flows are
 * out of scope until an agent actually needs one.
 */
// Reject non-http(s) URLs at parse time so an agent file can't smuggle
// `file:///etc/passwd` or similar into the MCP transport / token endpoint.
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "must be an http(s) URL",
  });

const mcpBearerAuth = z
  .object({
    type: z.literal("bearer"),
    token: z.string().optional(),
    token_env: z.string().optional(),
  })
  .refine((v) => Boolean(v.token || v.token_env), {
    message: "bearer auth requires either `token` or `token_env`",
  });

const mcpOauthAuth = z.object({
  type: z.literal("oauth"),
  client_id_env: z.string(),
  client_secret_env: z.string(),
  token_url: httpUrl,
  scope: z.string().optional(),
});

// Plain union (not discriminatedUnion) because bearer is wrapped in a
// ZodEffects via `.refine`, which discriminatedUnion can't accept.
const mcpAuth = z.union([mcpBearerAuth, mcpOauthAuth]);

const mcpServerConfigSchema = z.object({
  name: z.string(),
  url: httpUrl,
  auth: mcpAuth,
});

/**
 * Structured tool entry — the `mcp:` branch attaches an external MCP server.
 * String entries (`vault`, `fetch_url`) keep the short form for built-ins.
 */
const mcpToolEntry = z.object({ mcp: mcpServerConfigSchema });

const toolEntry = z.union([z.string(), mcpToolEntry]);

export type McpBearerAuth = z.infer<typeof mcpBearerAuth>;
export type McpOauthAuth = z.infer<typeof mcpOauthAuth>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpToolEntry = z.infer<typeof mcpToolEntry>;
export type ToolEntry = z.infer<typeof toolEntry>;

export function isMcpToolEntry(entry: ToolEntry): entry is McpToolEntry {
  return typeof entry !== "string";
}

export const agentFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  trigger: z.discriminatedUnion("type", [
    webhookTrigger,
    cronTrigger,
    vaultTrigger,
    manualTrigger,
  ]),
  model: z.string().default("nvidia/nemotron-3-super-120b-a12b"),
  tools: z.array(toolEntry).default([]),
  on_save: z
    .object({
      tags: z.array(z.string()).optional(),
      path: z.string().optional(),
    })
    .optional(),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;
export type VaultTrigger = z.infer<typeof vaultTrigger>;

/**
 * A parsed agent definition — one markdown file, one agent. Renamed from `Skill`
 * in v0.0.2; composable reusable prompts will live in the vault as `agent-skill`
 * notes later, not as a separate framework concept.
 *
 * Named `AgentDefinition` rather than `Agent` to avoid collision with the
 * Cloudflare `Agent` Durable Object base class.
 */
export interface AgentDefinition {
  frontmatter: AgentFrontmatter;
  systemPrompt: string;
  source: string;
}

export function parseAgent(source: string): AgentDefinition {
  const parsed = matter(source);
  const frontmatter = agentFrontmatterSchema.parse(parsed.data);
  return {
    frontmatter,
    systemPrompt: parsed.content.trim(),
    source,
  };
}

export function loadAgents(
  sources: Record<string, string>,
): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();
  for (const [key, source] of Object.entries(sources)) {
    try {
      const agent = parseAgent(source);
      if (agents.has(agent.frontmatter.name)) {
        throw new Error(`duplicate agent name: ${agent.frontmatter.name}`);
      }
      agents.set(agent.frontmatter.name, agent);
    } catch (err) {
      throw new Error(`failed to parse agent ${key}: ${(err as Error).message}`);
    }
  }
  return agents;
}

export function matchesWebhook(
  agent: AgentDefinition,
  payload: { text?: string; source?: string },
): boolean {
  const trigger = agent.frontmatter.trigger;
  if (trigger.type !== "webhook") return false;
  if (trigger.source !== "any" && payload.source && trigger.source !== payload.source) {
    return false;
  }
  const match = trigger.match;
  const text = payload.text ?? "";
  if (match === "always") return true;
  if (match === "contains_url") return /https?:\/\/\S+/i.test(text);
  if (match.startsWith("regex:")) {
    try {
      return new RegExp(match.slice("regex:".length)).test(text);
    } catch {
      return false;
    }
  }
  return false;
}
