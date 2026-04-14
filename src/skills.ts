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

export const skillFrontmatterSchema = z.object({
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

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface Skill {
  frontmatter: SkillFrontmatter;
  systemPrompt: string;
  source: string;
}

export function parseSkill(source: string): Skill {
  const parsed = matter(source);
  const frontmatter = skillFrontmatterSchema.parse(parsed.data);
  return {
    frontmatter,
    systemPrompt: parsed.content.trim(),
    source,
  };
}

export function loadSkills(sources: Record<string, string>): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  for (const [key, source] of Object.entries(sources)) {
    try {
      const skill = parseSkill(source);
      if (skills.has(skill.frontmatter.name)) {
        throw new Error(`duplicate skill name: ${skill.frontmatter.name}`);
      }
      skills.set(skill.frontmatter.name, skill);
    } catch (err) {
      throw new Error(`failed to parse skill ${key}: ${(err as Error).message}`);
    }
  }
  return skills;
}

export function matchesWebhook(
  skill: Skill,
  payload: { text?: string; source?: string },
): boolean {
  const trigger = skill.frontmatter.trigger;
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
