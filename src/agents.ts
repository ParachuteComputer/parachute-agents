import matter from "gray-matter";
import { z } from "zod";

const webhookTrigger = z.object({
  type: z.literal("webhook"),
  source: z.enum(["discord", "slack", "telegram", "http"]).default("http"),
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
});

const manualTrigger = z.object({ type: z.literal("manual") });

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
  tools: z.array(z.string()).default([]),
  on_save: z
    .object({
      tags: z.array(z.string()).optional(),
      path: z.string().optional(),
    })
    .optional(),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

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
  if (payload.source && trigger.source !== "http" && trigger.source !== payload.source) {
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
