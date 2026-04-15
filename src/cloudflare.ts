import { Agent } from "agents";
import {
  AgentRunner,
  type AgentRunInput,
  type ParachuteAgentConfig,
} from "./runner.js";

/**
 * Cloudflare Durable Object wrapper. Extend in your Worker, override {@link configure},
 * register in wrangler.toml. Pulls in `cloudflare/agents` + `partyserver` (needs the
 * `cloudflare:workers` virtual module), so **only import this from Workers code**.
 *
 * For self-hosted Bun/Node, use {@link AgentRunner} from the base entry point instead.
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

export { AgentRunner } from "./runner.js";
export type {
  ParachuteAgentConfig,
  AgentRunInput,
  AgentRunResult,
} from "./runner.js";
