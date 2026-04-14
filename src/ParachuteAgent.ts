import { Agent } from "agents";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type Tool } from "ai";
import { loadSkills, matchesWebhook, type Skill } from "./skills.js";
import { Vault, type VaultConfig } from "./vault.js";

export interface ParachuteAgentConfig {
  /** Map of skill file path → raw markdown contents. Usually wired via wrangler text-loader imports. */
  skills: Record<string, string>;
  /** Vault MCP endpoint + token. If omitted, skills cannot use the `vault` tool. */
  vault?: VaultConfig;
  /** OpenAI-compatible provider (OpenRouter, together.ai, etc.) for the default model. */
  provider: {
    name: string;
    baseURL: string;
    apiKey: string;
  };
  /** Extra tools the host wants to expose to skills (e.g. `fetch_url`). */
  tools?: Record<string, Tool>;
}

export interface SkillRunInput {
  user: string;
  context?: Record<string, unknown>;
}

export interface SkillRunResult {
  text: string;
  skill: string;
  toolCalls: number;
}

/**
 * Stateless runner: loads skills, matches triggers, runs the AI SDK loop.
 * Usable inside a Durable Object (via {@link ParachuteAgent}) or standalone.
 */
export class SkillRunner {
  private _skills: Map<string, Skill>;

  constructor(private readonly config: ParachuteAgentConfig) {
    this._skills = loadSkills(config.skills);
  }

  skills(): Map<string, Skill> {
    return this._skills;
  }

  matchWebhook(payload: { text?: string; source?: string }): Skill | undefined {
    for (const skill of this._skills.values()) {
      if (matchesWebhook(skill, payload)) return skill;
    }
    return undefined;
  }

  async runSkill(name: string, input: SkillRunInput): Promise<SkillRunResult> {
    const skill = this._skills.get(name);
    if (!skill) throw new Error(`unknown skill: ${name}`);

    const provider = createOpenAICompatible({
      name: this.config.provider.name,
      baseURL: this.config.provider.baseURL,
      apiKey: this.config.provider.apiKey,
    });
    const model: LanguageModel = provider(skill.frontmatter.model);

    const tools: Record<string, Tool> = { ...(this.config.tools ?? {}) };
    if (skill.frontmatter.tools.includes("vault") && this.config.vault) {
      Object.assign(tools, await new Vault(this.config.vault).tools());
    }

    const result = await generateText({
      model,
      system: skill.systemPrompt,
      prompt: input.user,
      tools,
      maxSteps: 8,
    });

    return {
      text: result.text,
      skill: skill.frontmatter.name,
      toolCalls: result.toolCalls?.length ?? 0,
    };
  }
}

/**
 * Base class for a stateful Parachute agent running as a Cloudflare Durable Object.
 * Extend in your Worker, override {@link configure}, register in wrangler.toml.
 *
 * For stateless use (no per-agent SQLite, no hibernation), use {@link SkillRunner} directly.
 */
export class ParachuteAgent<Env = unknown, State = Record<string, unknown>> extends Agent<
  Env,
  State
> {
  private _runner?: SkillRunner;

  configure(): ParachuteAgentConfig {
    throw new Error("ParachuteAgent: override configure() in your subclass");
  }

  protected runner(): SkillRunner {
    if (!this._runner) this._runner = new SkillRunner(this.configure());
    return this._runner;
  }

  matchWebhook(payload: { text?: string; source?: string }) {
    return this.runner().matchWebhook(payload);
  }

  runSkill(name: string, input: SkillRunInput) {
    return this.runner().runSkill(name, input);
  }
}
